/**
 * The real-world implementations of every side effect `buildBrollPlan` needs:
 * the LLM analysis, provider searches, downloads, image preparation, Gemini
 * verification - plus the disk caches that make a re-run cheap.
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
  VERDICT_CACHE_TTL_MS,
  writeJsonCache,
} from "../lib/broll/cache";
import {
  createRateLimiter,
  defaultBrollFetch,
  fetchJson,
  type BrollFetch,
} from "../lib/broll/http";
import {
  buildCommonsSearchUrl,
  parseCommonsResponse,
  rankCommonsCandidates,
} from "../lib/broll/providers/commons";
import {
  searchStockAcrossProviders,
  trackUnsplashDownload,
  type StockKeys,
  type StockProviderId,
  type StockSearchResult,
} from "../lib/broll/providers/stock";
import { searchOpenverse } from "../lib/broll/providers/openverse";
import type { BrollCandidate } from "../lib/broll/providers/types";
import {
  makeVisionThumbnail,
  prepareCardFile,
  prepareFullscreenFile,
} from "../lib/broll/image";
import {
  verifyCardBatch,
  verifyEntityImage,
  type VisionVerdict,
} from "../lib/broll/vision";
import type {
  BrollPlanDeps,
  CardVerdict,
  PreparedBrollImage,
} from "../lib/broll/plan";

/** Wikimedia asks clients not to hammer the API; one request per second is safe. */
const commonsLimiter = createRateLimiter({ minIntervalMs: 1000 });
const openverseLimiter = createRateLimiter({ minIntervalMs: 1000 });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BrollSourceOptions {
  ai: AiProviderSettings;
  providerOrder: BrollProviderId[];
  fetcher?: BrollFetch;
}

function stockKeys(ai: AiProviderSettings): StockKeys {
  return {
    pexels: ai.pexelsApiKey,
    pixabay: ai.pixabayApiKey,
    unsplash: ai.unsplashApiKey,
  };
}

/**
 * One provider-specific search with its own cached JSON answer. The cache key
 * includes the provider and the query, so switching either gives fresh results
 * while a re-run of the same clip is instant.
 */
async function cachedProviderSearch(
  provider: BrollProviderId,
  query: string,
  loader: () => Promise<BrollCandidate[]>,
): Promise<BrollCandidate[]> {
  const key = jsonCacheKey(["search", provider, query.toLowerCase().trim()]);
  const cached = await readJsonCache<BrollCandidate[]>(key, {
    ttlMs: SEARCH_CACHE_TTL_MS,
  });
  if (cached) return cached;
  const fresh = await loader();
  if (fresh.length > 0) await writeJsonCache(key, fresh);
  return fresh;
}

export function createBrollDeps(options: BrollSourceOptions): BrollPlanDeps {
  const fetcher = options.fetcher ?? defaultBrollFetch;
  const keys = stockKeys(options.ai);
  const geminiKeys = options.ai.geminiApiKeys
    .map((key) => key.trim())
    .filter(Boolean);
  const providerOrder = options.providerOrder.filter(
    (provider): provider is StockProviderId =>
      provider !== "wikimedia" && provider !== "openverse",
  );

  return {
    visionAvailable: geminiKeys.length > 0,

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
      });
      const analysis = parseBrollAnalysis(
        result.text,
        input.clipDuration,
        input.words,
      );
      await writeJsonCache(cacheKey, analysis);
      return analysis;
    },

    async searchEntity(query: string): Promise<BrollCandidate[]> {
      let commonsError: unknown;
      try {
        const fromCommons = await cachedProviderSearch(
          "wikimedia",
          query,
          async () => {
            const payload = await commonsLimiter(() =>
              fetchJson(buildCommonsSearchUrl(query, 10), {
                fetcher,
                provider: "Wikimedia Commons",
              }),
            );
            return rankCommonsCandidates(parseCommonsResponse(payload));
          },
        );
        if (fromCommons.length > 0) return fromCommons;
      } catch (error) {
        commonsError = error;
      }

      // Commons is unreachable (or had nothing usable): fall back to Openverse.
      try {
        const fromOpenverse = await cachedProviderSearch(
          "openverse",
          query,
          () => openverseLimiter(() => searchOpenverse(query, { fetcher })),
        );
        if (fromOpenverse.length > 0) {
          console.log(
            `[broll] "${query}": using Openverse (${fromOpenverse.length} candidate(s)).`,
          );
        }
        return fromOpenverse;
      } catch (error) {
        if (commonsError) {
          throw new Error(
            `Wikimedia Commons: ${describeError(commonsError)} | Openverse: ${describeError(error)}`,
          );
        }
        return []; // Commons answered (empty); Openverse failing just means no image.
      }
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
      return cacheImage(candidate, {
        fetcher,
        provider:
          candidate.provider === "wikimedia"
            ? "Wikimedia Commons"
            : candidate.provider,
      });
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

    async thumbnail(bytes: Buffer) {
      return makeVisionThumbnail(bytes);
    },

    async verify(input): Promise<VisionVerdict> {
      const cacheKey = jsonCacheKey([
        "verdict",
        input.entityName.toLowerCase(),
        input.images.length,
        ...input.images.map((image) => image.data.length),
        input.context.slice(0, 120),
      ]);
      const cached = await readJsonCache<VisionVerdict>(cacheKey, {
        ttlMs: VERDICT_CACHE_TTL_MS,
      });
      if (cached) return cached;
      const verdict = await verifyEntityImage(input, {
        fetcher,
        keys: geminiKeys,
      });
      await writeJsonCache(cacheKey, verdict);
      return verdict;
    },

    async verifyCards(items): Promise<CardVerdict[]> {
      const cacheKey = jsonCacheKey([
        "cardverdict",
        ...items.map((item) => `${item.keyword}:${item.image.data.length}`),
      ]);
      const cached = await readJsonCache<CardVerdict[]>(cacheKey, {
        ttlMs: VERDICT_CACHE_TTL_MS,
      });
      if (cached) return cached;
      const verdicts = await verifyCardBatch(items, {
        fetcher,
        keys: geminiKeys,
      });
      await writeJsonCache(cacheKey, verdicts);
      return verdicts;
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
