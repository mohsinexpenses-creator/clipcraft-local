/**
 * The real-world implementations of every side effect `buildBrollPlan` needs:
 * the LLM analysis, provider searches, downloads and image preparation - plus
 * the disk caches that make a re-run cheap.
 *
 * Keeping them here (and not in `lib/broll/plan.ts`) is what lets the
 * orchestration be tested with fakes while this file is the only one that
 * touches the network.
 */

import fs from "node:fs/promises";
import type {
  AiProviderSettings,
  BrollEntityType,
  BrollProviderId,
  WordTimestamp,
} from "../lib/types";
import { completeWithFallback } from "../lib/llm";
import { RenderCancelledError } from "../lib/errors";
import {
  buildBrollPrompt,
  parseBrollAnalysis,
  type BrollAnalysis,
} from "../lib/broll/analysis";
import {
  cacheImage,
  jsonCacheKey,
  readJsonCache,
  SEARCH_CACHE_TTL_MS,
  writeJsonCache,
} from "../lib/broll/cache";
import {
  BrollHttpError,
  createRateLimiter,
  defaultBrollFetch,
  ProviderQuotaError,
  type BrollFetch,
} from "../lib/broll/http";
import {
  searchStockAcrossProviders,
  trackUnsplashDownload,
  type StockKeys,
  type StockProviderId,
  type StockSearchResult,
} from "../lib/broll/providers/stock";
import { findWikipediaImage } from "../lib/broll/providers/wikipedia";
import type { BrollCandidate } from "../lib/broll/providers/types";
import {
  prepareCardFile,
  prepareFullscreenFile,
} from "../lib/broll/image";
import type {
  BrollPlanDeps,
  PreparedBrollImage,
} from "../lib/broll/plan";

const wikipediaLimiter = createRateLimiter({ minIntervalMs: 250 });
/**
 * upload.wikimedia.org throttles bursts and generic clients with HTTP 429, so image
 * downloads go one at a time with a small gap (the search limiter above only
 * covers the API, not the file host).
 */
const wikimediaDownloadLimiter = createRateLimiter({ minIntervalMs: 400 });

const WIKIMEDIA_DOWNLOAD_ATTEMPTS = 3;
const WIKIMEDIA_BACKOFF_BASE_MS = 1500;
const WIKIMEDIA_BACKOFF_MAX_MS = 15_000;
const WIKIPEDIA_MISS_CACHE_TTL_MS = 15 * 60 * 1000;

/** A 429, a 5xx or a timeout is worth another try; anything else is final. */
function isTransientDownloadError(error: unknown): boolean {
  if (error instanceof ProviderQuotaError) return true;
  if (error instanceof BrollHttpError) return error.retryable;
  return false;
}

/** Run one Wikimedia-hosted image download with spacing and exponential backoff. */
async function downloadFromWikimedia<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await wikimediaDownloadLimiter(run);
    } catch (error) {
      if (
        attempt >= WIKIMEDIA_DOWNLOAD_ATTEMPTS - 1 ||
        !isTransientDownloadError(error)
      ) {
        throw error;
      }
      const hinted =
        error instanceof ProviderQuotaError ? error.retryAfterMs : undefined;
      const delay = Math.min(
        hinted ?? WIKIMEDIA_BACKOFF_BASE_MS * 2 ** attempt,
        WIKIMEDIA_BACKOFF_MAX_MS,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export interface BrollSourceOptions {
  ai: AiProviderSettings;
  providerOrder: BrollProviderId[];
  fetcher?: BrollFetch;
  /** Worker cancellation is combined with each provider's own timeout signal. */
  signal?: AbortSignal;
}

function stockKeys(ai: AiProviderSettings): StockKeys {
  return {
    pexels: ai.pexelsApiKey,
    pixabay: ai.pixabayApiKey,
    unsplash: ai.unsplashApiKey,
  };
}

export function createBrollDeps(options: BrollSourceOptions): BrollPlanDeps {
  const baseFetcher = options.fetcher ?? defaultBrollFetch;
  const fetcher: BrollFetch = async (url, init) => {
    if (options.signal?.aborted) throw new RenderCancelledError();
    const signal = options.signal
      ? init?.signal
        ? AbortSignal.any([options.signal, init.signal])
        : options.signal
      : init?.signal;
    const response = await baseFetcher(url, { ...init, ...(signal ? { signal } : {}) });
    if (options.signal?.aborted) throw new RenderCancelledError();
    return response;
  };
  const keys = stockKeys(options.ai);
  const providerOrder = options.providerOrder.filter(
    (provider): provider is StockProviderId =>
      provider !== "wikipedia",
  );

  return {
    async analyze(input: {
      clipDuration: number;
      words: WordTimestamp[];
      entityBudget: number;
      keywordBudget: number;
      keywordMin: number;
    }): Promise<BrollAnalysis> {
      const prompt = buildBrollPrompt(input);
      // The transcript is what the answer depends on, so its first/last words plus
      // the prompt length identify it; a re-run reuse is instant and free.
      const cacheKey = jsonCacheKey([
        "analysis",
        input.clipDuration.toFixed(2),
        input.words.length,
        prompt.length,
        input.keywordMin,
        input.words[0]?.word ?? "",
        input.words[input.words.length - 1]?.word ?? "",
      ]);
      const cached = await readJsonCache<BrollAnalysis>(cacheKey, {
        ttlMs: SEARCH_CACHE_TTL_MS,
      });
      if (cached) return cached;

      const result = await completeWithFallback({
        task: "B-roll planning",
        prompt,
        json: true,
        temperature: 0.3,
        maxTokens: 1200,
        signal: options.signal,
      });
      const analysis = parseBrollAnalysis(
        result.text,
        input.clipDuration,
        input.words,
      );
      await writeJsonCache(cacheKey, analysis);
      return analysis;
    },

    async findEntityImage(title: string): Promise<BrollCandidate | null> {
      const normalizedTitle = title.trim();
      const cacheKey = jsonCacheKey(["wikipedia", normalizedTitle.toLowerCase()]);
      const missCacheKey = jsonCacheKey(["wikipedia-miss-v2", normalizedTitle.toLowerCase()]);
      const cached = await readJsonCache<BrollCandidate>(cacheKey, {
        ttlMs: SEARCH_CACHE_TTL_MS,
      });
      if (cached) return cached;
      const cachedMiss = await readJsonCache<boolean>(missCacheKey, {
        ttlMs: WIKIPEDIA_MISS_CACHE_TTL_MS,
      });
      if (cachedMiss) return null;

      const candidate = await wikipediaLimiter(() =>
        findWikipediaImage(normalizedTitle, { fetcher }),
      );
      if (candidate) await writeJsonCache(cacheKey, candidate);
      else await writeJsonCache(missCacheKey, true);
      return candidate;
    },

    async searchStock(query: string): Promise<StockSearchResult> {
      const key = jsonCacheKey([
        "stock",
        query.toLowerCase().trim(),
        providerOrder.join(","),
        // Which providers have keys decides the answer, so it is part of the key.
        Object.entries(keys)
          .map(([name, value]) => `${name}:${value ? 1 : 0}`)
          .join(","),
      ]);
      const cached = await readJsonCache<StockSearchResult>(key, {
        ttlMs: SEARCH_CACHE_TTL_MS,
      });
      if (cached) {
        const first = cached.candidates[0];
        if (cached.provider === "unsplash" && keys.unsplash && first) {
          await trackUnsplashDownload(first, keys.unsplash, { fetcher });
        }
        return cached;
      }

      const result = await searchStockAcrossProviders(query, {
        fetcher,
        providerOrder,
        keys,
      });
      const first = result.candidates[0];
      if (first) {
        await writeJsonCache(key, result);
        if (result.provider === "unsplash" && keys.unsplash) {
          await trackUnsplashDownload(first, keys.unsplash, { fetcher });
        }
      }
      return result;
    },

    async download(candidate: BrollCandidate) {
      if (candidate.provider !== "wikipedia") {
        return cacheImage(candidate, { fetcher, provider: candidate.provider });
      }
      const source = candidate.thumbUrl ? { ...candidate, imageUrl: candidate.thumbUrl } : candidate;
      return downloadFromWikimedia(() =>
        cacheImage(source, { fetcher, provider: "Wikipedia image" }),
      );
    },

    async prepareFullscreen(
      bytes: Buffer,
      entityType: BrollEntityType,
      cacheKey: string,
    ): Promise<PreparedBrollImage> {
      // `sourceFile` comes from `download()`; the plan builder fills it in.
      return prepareFullscreenFile(bytes, { cacheKey, entityType });
    },

    async prepareCard(
      bytes: Buffer,
      cacheKey: string,
    ): Promise<PreparedBrollImage> {
      return prepareCardFile(bytes, { cacheKey });
    },

  };
}

/** Ensure the cache directory exists before the first download. */
export async function ensureBrollCacheReady(): Promise<void> {
  const { ensureBrollCacheDirs } = await import("../lib/broll/cache");
  await ensureBrollCacheDirs();
  await fs.mkdir(
    await import("../lib/broll/cache").then((module) => module.brollImageDir()),
    {
      recursive: true,
    },
  );
}
