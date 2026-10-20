import fs from 'fs';
import { log } from '../logger';
import { toErrorMessage } from '../errors';
import { resolveBrollCacheDir } from '../paths';
import type { TranscriptData, ViralClip, WordTimestamp } from '../types';
import {
  ensureCachedBrollAsset,
  findRelevantCachedAssetsForQuery,
  searchWithPersistentCache,
} from './image-cache';
import {
  extractBrollMomentsFromTranscript,
  maybeEnrichMomentsWithFreeLlm,
} from './query-extractor';
import {
  scheduleBrollPlacements,
  selectMomentsForDiscovery,
  targetBrollCountForDuration,
  type MatchedMomentCandidate,
} from './scheduler';
import { canonicalizeMediaStem, type FetchLike } from './wikimedia';
import type { BrollPlacement, BrollSearchCandidate } from './types';

export * from './types';
export {
  WIKIMEDIA_COMMONS_API_URL,
  WIKIPEDIA_ENGLISH_API_URL,
  WMF_STANDARD_THUMB_WIDTH,
  WIKIMEDIA_USER_AGENT,
  ALLOWED_BROLL_MIME_TYPES,
  MIN_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
  MIN_RELEVANCE_SCORE,
  DEFAULT_MAX_IMAGE_BYTES,
  normalizeImageUrl,
  buildStandardWikimediaThumbUrl,
  canonicalizeMediaStem,
  cleanCommonsMetadataText,
  scoreCandidateRelevance,
  parseAndValidateWikimediaResults,
  deduplicateSearchCandidates,
  buildWikimediaSearchUrl,
  buildWikipediaPageImagesUrl,
  searchWikimediaCommons,
} from './wikimedia';
export {
  DEFAULT_FOCAL_X,
  DEFAULT_FOCAL_Y,
  inspectAndValidateImageBuffer,
  resolveSafeCachedImagePath,
  ensureCachedBrollAsset,
  searchWithPersistentCache,
  findRelevantCachedAssetsForQuery,
} from './image-cache';
export {
  extractClipWordsForWindow,
  extractBrollMomentsFromTranscript,
  planClipBrollCount,
  maybeEnrichMomentsWithFreeLlm,
} from './query-extractor';
export {
  targetBrollCountForDuration,
  selectMomentsForDiscovery,
  scheduleBrollPlacements,
} from './scheduler';

/** Bounded parallel executor tuned for Wikimedia CDN limits & 8 GB RAM (default concurrency 2). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(6, Math.floor(concurrency)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runSlot = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, items.length) }, () => runSlot()),
  );
  return results;
}

export interface ResolveClipBrollOptions {
  transcript?: TranscriptData;
  clipWords: WordTimestamp[];
  clipStart: number;
  clipEnd: number;
  hookDurationSeconds?: number;
  aiAnalysis?: ViralClip;
  cacheDir?: string;
  fetchImpl?: FetchLike;
  /** Max concurrent search/download requests (default 2, honoring WMF per-IP connection limits). */
  concurrency?: number;
  requestTimeoutMs?: number;
  maxImageBytes?: number;
  detectFaces?: boolean;
  enableLlmFallback?: boolean;
  isCancelled?: () => boolean;
}

/**
 * Discover, validate, download/reuse from local persistent cache, and schedule
 * relevant B-roll placements for a clip. Never throws: on any partial or total
 * search/network failure, returns the usable relevant placements (or `[]`) so
 * clip rendering always succeeds.
 */
export async function resolveBrollForClip(
  options: ResolveClipBrollOptions,
): Promise<BrollPlacement[]> {
  const abortController = new AbortController();
  const abortIfCancelled = (): boolean => {
    if (options.isCancelled?.()) {
      abortController.abort();
      return true;
    }
    return false;
  };

  try {
    if (abortIfCancelled()) return [];

    const activeCacheDir = resolveBrollCacheDir(options.cacheDir);
    const clipDuration = Math.max(0.5, options.clipEnd - options.clipStart);
    const targetCount = targetBrollCountForDuration(clipDuration);
    const concurrency = options.concurrency ?? 2;

    // 1) Fast local phrase & entity extraction from timestamped speech + existing AI analysis
    let moments = extractBrollMomentsFromTranscript({
      transcript: options.transcript,
      clipWords: options.clipWords,
      clipStart: options.clipStart,
      clipEnd: options.clipEnd,
      aiAnalysis: options.aiAnalysis,
    });

    // Single-pass free Gemini cue enrichment when configured & bucket coverage < targetCount
    if (options.enableLlmFallback !== false) {
      moments = await maybeEnrichMomentsWithFreeLlm({
        transcript: options.transcript,
        clipWords: options.clipWords,
        clipStart: options.clipStart,
        clipEnd: options.clipEnd,
        existingMoments: moments,
        targetCount,
      });
    }

    if (moments.length === 0 || abortIfCancelled()) {
      log.detail(`B-roll discovery found 0 visual subjects in ${clipDuration.toFixed(1)}s transcript`);
      return [];
    }

    const discoveryMoments = selectMomentsForDiscovery(moments, clipDuration, 4);
    log.detail(
      `B-roll searching ${discoveryMoments.length} timestamped subject(s) ` +
        `(target ${targetCount}, cache=${activeCacheDir}): ` +
        discoveryMoments.map((m) => `"${m.queries[0]}"@${m.mentionStart.toFixed(1)}s`).join(', '),
    );

    // 2) Deduplicate identical search strings across moments so each unique query runs AT MOST ONCE
    const uniqueQueries = new Map<
      string,
      { query: string; subjectKind: (typeof discoveryMoments)[number]['subjectKind'] }
    >();
    for (const moment of discoveryMoments) {
      for (const query of moment.queries.slice(0, 2)) {
        const norm = query.trim().toLowerCase();
        if (norm && !uniqueQueries.has(norm)) {
          uniqueQueries.set(norm, { query, subjectKind: moment.subjectKind });
        }
      }
    }

    const searchMap = new Map<string, BrollSearchCandidate[]>();
    await mapWithConcurrency(
      [...uniqueQueries.entries()],
      concurrency,
      async ([normKey, entry]) => {
        if (abortIfCancelled()) return;
        const { candidates } = await searchWithPersistentCache(entry.query, {
          subjectKind: entry.subjectKind,
          limit: 12,
          timeoutMs: options.requestTimeoutMs ?? 8_000,
          maxImageBytes: options.maxImageBytes,
          fetchImpl: options.fetchImpl,
          signal: abortController.signal,
        });
        searchMap.set(normKey, candidates);
      },
    );

    if (abortIfCancelled()) return [];

    // 3) Match each moment to distinct candidate images across the clip, downloading with bounded concurrency
    const claimedUrls = new Set<string>();
    const claimedStems = new Set<string>();
    const claimOrderMoments = [...discoveryMoments].sort(
      (a, b) => b.priority - a.priority || a.mentionStart - b.mentionStart,
    );

    const plannedDownloads: Array<{
      moment: (typeof discoveryMoments)[number];
      query: string;
      candidate?: BrollSearchCandidate;
      offlineAsset?: ReturnType<typeof findRelevantCachedAssetsForQuery>[number];
    }> = [];

    for (const moment of claimOrderMoments) {
      let pickedQuery = '';
      let pickedCandidate: BrollSearchCandidate | undefined;

      for (const query of moment.queries.slice(0, 2)) {
        const candidates = searchMap.get(query.trim().toLowerCase()) ?? [];
        const available = candidates.find(
          (c) =>
            !claimedUrls.has(c.normalizedUrl) &&
            (!c.canonicalStem || !claimedStems.has(c.canonicalStem)),
        );
        if (available) {
          pickedQuery = query;
          pickedCandidate = available;
          claimedUrls.add(available.normalizedUrl);
          if (available.canonicalStem) claimedStems.add(available.canonicalStem);
          break;
        }
      }

      if (pickedCandidate) {
        plannedDownloads.push({
          moment,
          query: pickedQuery,
          candidate: pickedCandidate,
        });
        continue;
      }

      // Offline / network-failure fallback: reuse matching previously-cached local images
      for (const query of moment.queries.slice(0, 2)) {
        const localMatches = findRelevantCachedAssetsForQuery(query, {
          cacheDir: activeCacheDir,
          subjectKind: moment.subjectKind,
        });
        const localPick = localMatches.find(
          (m) =>
            !claimedUrls.has(m.asset.normalizedUrl) &&
            (!m.canonicalStem || !claimedStems.has(m.canonicalStem)),
        );
        if (localPick) {
          claimedUrls.add(localPick.asset.normalizedUrl);
          if (localPick.canonicalStem) claimedStems.add(localPick.canonicalStem);
          plannedDownloads.push({
            moment,
            query,
            offlineAsset: localPick,
          });
          break;
        }
      }
    }

    const resolvedMatches: MatchedMomentCandidate[] = [];
    await mapWithConcurrency(plannedDownloads, concurrency, async (item) => {
      if (abortIfCancelled()) return;

      if (item.offlineAsset) {
        resolvedMatches.push({
          moment: item.moment,
          asset: item.offlineAsset.asset,
          query: item.query,
          relevanceScore: item.offlineAsset.score,
          canonicalStem: item.offlineAsset.canonicalStem,
        });
        return;
      }

      if (!item.candidate) return;

      const queryPool = searchMap.get(item.query.trim().toLowerCase()) ?? [item.candidate];
      const backups = queryPool.filter(
        (c) => c.normalizedUrl === item.candidate!.normalizedUrl || !claimedUrls.has(c.normalizedUrl),
      );

      for (const candidate of backups.slice(0, 3)) {
        if (abortIfCancelled()) return;
        const asset = await ensureCachedBrollAsset(candidate, {
          searchTerms: [item.query, item.moment.primarySubject],
          cacheDir: activeCacheDir,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.requestTimeoutMs ?? 12_000,
          maxImageBytes: options.maxImageBytes,
          detectFaces: options.detectFaces,
          signal: abortController.signal,
        });
        if (asset && fs.existsSync(asset.absolutePath)) {
          claimedUrls.add(candidate.normalizedUrl);
          if (candidate.canonicalStem) claimedStems.add(candidate.canonicalStem);
          resolvedMatches.push({
            moment: item.moment,
            asset,
            query: item.query,
            relevanceScore: candidate.relevanceScore,
            canonicalStem:
              candidate.canonicalStem || canonicalizeMediaStem(asset.title || asset.localPath),
          });
          break;
        }
      }
    });

    if (resolvedMatches.length === 0 || abortIfCancelled()) {
      log.warn(`B-roll resolved 0 usable images across ${plannedDownloads.length} candidate(s)`);
      return [];
    }

    const scheduled = scheduleBrollPlacements(resolvedMatches, {
      clipDurationSeconds: clipDuration,
      hookDurationSeconds: options.hookDurationSeconds ?? 0,
    });

    const cacheHits = resolvedMatches.filter((m) => m.asset.cacheHit).length;
    log.ok(
      `B-roll ready: ${scheduled.length} full-screen image(s) scheduled across ${clipDuration.toFixed(1)}s ` +
        `(${cacheHits}/${resolvedMatches.length} local cache hit(s)) -> ` +
        scheduled.map((p) => `[${p.startTime.toFixed(1)}s-${p.endTime.toFixed(1)}s "${p.query}"]`).join(' '),
    );
    return scheduled;
  } catch (error) {
    log.warn(`B-roll discovery degraded gracefully (continuing render without failing): ${toErrorMessage(error)}`);
    return [];
  }
}
