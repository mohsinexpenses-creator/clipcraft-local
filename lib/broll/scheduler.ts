import { targetBrollCountForDuration } from '../broll-count';
import type {
  BrollPlacement,
  BrollTranscriptMoment,
  ResolvedBrollAsset,
} from './types';

export { targetBrollCountForDuration };

/** Hook dip-to-black half-width matching `HOOK_TRANSITION_SECONDS` in `worker/ffmpeg-pipeline.ts`. */
const HOOK_JOIN_HALF_SECONDS = 0.5;

/**
 * Select up to `budget` well-distributed, high-priority transcript moments ahead of
 * network discovery so searches and downloads run concurrently before rendering.
 */
export function selectMomentsForDiscovery(
  moments: BrollTranscriptMoment[],
  clipDurationSeconds: number,
  extraBackupSlots = 4,
): BrollTranscriptMoment[] {
  if (moments.length === 0) return [];

  const target = targetBrollCountForDuration(clipDurationSeconds);
  const maxMoments =
    clipDurationSeconds < 15
      ? Math.max(target + 2, Math.floor(clipDurationSeconds / 1.8) + 1)
      : target + Math.max(2, extraBackupSlots);

  const bucketWidth = Math.max(1.5, clipDurationSeconds / target);
  const buckets = new Map<number, BrollTranscriptMoment[]>();
  for (const moment of moments) {
    const idx = Math.min(target - 1, Math.max(0, Math.floor(moment.mentionStart / bucketWidth)));
    const list = buckets.get(idx) ?? [];
    list.push(moment);
    buckets.set(idx, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => b.priority - a.priority || a.mentionStart - b.mentionStart);
  }

  const chosen: BrollTranscriptMoment[] = [];
  const chosenIds = new Set<string>();

  let addedInRound = true;
  let round = 0;
  while (addedInRound && chosen.length < maxMoments) {
    addedInRound = false;
    for (let b = 0; b < target && chosen.length < maxMoments; b += 1) {
      const candidate = buckets.get(b)?.[round];
      if (!candidate || chosenIds.has(candidate.id)) continue;
      chosenIds.add(candidate.id);
      chosen.push(candidate);
      addedInRound = true;
    }
    round += 1;
  }

  return chosen.sort((a, b) => a.mentionStart - b.mentionStart || b.priority - a.priority);
}

export interface MatchedMomentCandidate {
  moment: BrollTranscriptMoment;
  asset: ResolvedBrollAsset;
  query: string;
  relevanceScore: number;
  canonicalStem: string;
}

export interface ScheduleBrollOptions {
  /** Base clip duration (`end - start`) in seconds. */
  clipDurationSeconds: number;
  /** Prepended hook intro duration in seconds (`0` when hook intro is off). */
  hookDurationSeconds?: number;
  /** Explicit override for target appearance count when desired. */
  maxAppearances?: number;
  /** Minimum gap or spacing preference between start times when candidates are abundant. */
  minStartSpacingSeconds?: number;
  /** Allow reusing the exact same image within one clip only when explicitly requested. */
  allowDuplicateAssetsInClip?: boolean;
}

/**
 * Align resolved relevant images onto exact output-video timestamps matching the
 * speech intervals they illustrate, without overlap, without breaking the hook
 * dip-to-black transition, and without repeating the same image across a clip.
 */
export function scheduleBrollPlacements(
  matches: MatchedMomentCandidate[],
  options: ScheduleBrollOptions,
): BrollPlacement[] {
  const clipDuration = Math.max(0.5, options.clipDurationSeconds);
  const hookDuration = Math.max(0, options.hookDurationSeconds ?? 0);
  const hookEnabled = hookDuration > 0;
  const fadeDur = hookEnabled ? Math.min(HOOK_JOIN_HALF_SECONDS, hookDuration / 2) : 0;

  const minOutputTime = hookEnabled ? hookDuration + fadeDur : 0;
  const maxOutputTime = clipDuration + hookDuration;
  if (maxOutputTime - minOutputTime < 0.5 || matches.length === 0) {
    return [];
  }

  const targetCount = targetBrollCountForDuration(clipDuration);
  const maxAppearances =
    options.maxAppearances ??
    (clipDuration < 15
      ? Math.max(targetCount, Math.floor(clipDuration / 2))
      : Math.max(targetCount, Math.ceil(clipDuration / 6)));

  const defaultSpacing =
    options.minStartSpacingSeconds ??
    (clipDuration >= 30 ? 4.2 : Math.max(1.2, clipDuration / Math.max(2, maxAppearances + 1)));

  const usedUrls = new Set<string>();
  const usedHashes = new Set<string>();
  const usedStems = new Set<string>();

  const selected: MatchedMomentCandidate[] = [];

  const spacingPasses =
    clipDuration >= 30
      ? [defaultSpacing, Math.min(defaultSpacing, 2.6)]
      : [defaultSpacing];

  const bucketCount = Math.max(1, targetCount);
  const bucketSpan = clipDuration / bucketCount;
  const ranked = [...matches].sort(
    (a, b) => (b.moment.priority + b.relevanceScore) - (a.moment.priority + a.relevanceScore),
  );

  const orderedCandidates: MatchedMomentCandidate[] = [];
  const seenBucketWinner = new Set<number>();
  for (const item of ranked) {
    const b = Math.min(bucketCount - 1, Math.max(0, Math.floor(item.moment.mentionStart / bucketSpan)));
    if (!seenBucketWinner.has(b)) {
      seenBucketWinner.add(b);
      orderedCandidates.push(item);
    }
  }
  for (const item of ranked) {
    if (!orderedCandidates.includes(item)) orderedCandidates.push(item);
  }

  for (const minGap of spacingPasses) {
    for (const candidate of orderedCandidates) {
      if (selected.length >= maxAppearances) break;
      if (selected.includes(candidate)) continue;

      if (!options.allowDuplicateAssetsInClip) {
        if (
          usedUrls.has(candidate.asset.normalizedUrl) ||
          usedHashes.has(candidate.asset.contentHash) ||
          (candidate.canonicalStem && usedStems.has(candidate.canonicalStem))
        ) {
          continue;
        }
      }

      const tooClose = selected.some(
        (existing) =>
          existing.moment.id === candidate.moment.id ||
          Math.abs(existing.moment.mentionStart - candidate.moment.mentionStart) < minGap,
      );
      if (tooClose) continue;

      selected.push(candidate);
      usedUrls.add(candidate.asset.normalizedUrl);
      usedHashes.add(candidate.asset.contentHash);
      if (candidate.canonicalStem) usedStems.add(candidate.canonicalStem);
    }
    if (selected.length >= targetCount) break;
  }

  if (selected.length === 0) return [];

  selected.sort((a, b) => a.moment.mentionStart - b.moment.mentionStart);

  const idealDisplaySeconds =
    clipDuration >= 20
      ? Math.min(4.5, Math.max(3.0, (clipDuration / Math.max(selected.length, targetCount)) * 0.58))
      : Math.min(2.6, Math.max(0.9, (clipDuration / Math.max(1, selected.length)) * 0.55));

  const placements: BrollPlacement[] = [];

  for (let i = 0; i < selected.length; i += 1) {
    const current = selected[i];
    const next = selected[i + 1];

    const rawStart = hookDuration + Math.max(0, current.moment.mentionStart - 0.1);
    const startTime = Math.max(minOutputTime, rawStart);

    const naturalEnd = hookDuration + Math.max(current.moment.mentionEnd + 0.35, current.moment.segmentEnd);
    const desiredEnd = Math.max(
      startTime + idealDisplaySeconds,
      Math.min(startTime + idealDisplaySeconds + 1.0, naturalEnd),
    );

    const nextStartFloor = next
      ? Math.max(minOutputTime, hookDuration + Math.max(0, next.moment.mentionStart - 0.1)) - 0.25
      : maxOutputTime;

    const endTime = Math.min(maxOutputTime, nextStartFloor, desiredEnd);
    if (endTime - startTime < 0.45) continue;

    placements.push({
      assetId: current.asset.id,
      imagePath: current.asset.absolutePath,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      clipRelativeStart: Number(Math.max(0, startTime - hookDuration).toFixed(3)),
      clipRelativeEnd: Number(Math.max(0, endTime - hookDuration).toFixed(3)),
      query: current.query,
      matchedText: current.moment.segmentText,
      subjectKind: current.moment.subjectKind,
      focalX: current.asset.focalX,
      focalY: current.asset.focalY,
      width: current.asset.width,
      height: current.asset.height,
      attribution: current.asset.attribution,
      license: current.asset.license,
      relevanceScore: current.relevanceScore,
    });
  }

  return placements;
}
