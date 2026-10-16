import type { ClipRecord, ClipVisualOverlay } from './types';
import type { ClipRenderTimingRecord, VisualPrefetchTimingRecord } from './timings';

export interface VisualDebugBeat {
  momentId: string; time?: number; sentence?: string; queriesTried?: string[];
  chosenQuery?: string; chosenTitle?: string; visionScore?: number; decision?: string; reason?: string;
  top3?: Array<{ candidateId: string; title?: string; textScore?: number; visionScore?: number | null }>;
}
export type TimingRow = Partial<ClipRenderTimingRecord & VisualPrefetchTimingRecord>;
const photo = (ov: ClipVisualOverlay) => ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat' && ov.status !== 'removed';

export function evaluateVisualClips(clips: ClipRecord[], debug: Map<string, VisualDebugBeat[]> = new Map(), exists: (file: string) => boolean = () => true) {
  const details = clips.map((clip) => {
    const overlays = (clip.visualOverlays ?? []).filter(photo);
    const beats = overlays.map((ov) => {
      const trace = debug.get(clip._id)?.find((beat) => beat.momentId === ov.id);
      const missing = ov.status === 'resolved' && (!ov.localFilePath || !ov.visualVerificationHash || !ov.preparedContentHash || !exists(ov.localFilePath));
      return { clipId: clip._id, momentId: ov.id, sourceTime: ov.sourceStart, sourceEnd: ov.sourceEnd,
        sentence: ov.quote, meaning: ov.sentenceMeaningEn ?? trace?.sentence ?? ov.quote,
        query: ov.chosenQuery ?? trace?.chosenQuery ?? ov.searchQueries[0] ?? '',
        queriesTried: trace?.queriesTried ?? ov.searchQueries,
        title: ov.attribution?.title ?? trace?.chosenTitle ?? '',
        visionScore: ov.visionScore ?? trace?.visionScore ?? null,
        decision: missing ? 'skipped' : ov.status === 'resolved' ? 'accepted' : 'skipped',
        reason: missing ? 'Verified local frame missing, incomplete or modified' : ov.skipReason ?? trace?.reason ?? (ov.status === 'resolved' ? '' : 'No verified frame; render skips without network'), candidates: trace?.top3 ?? [] };
    });
    const buckets = Math.max(0, Math.ceil((clip.end - clip.start) / 5.4));
    const accepted = beats.filter((beat) => beat.decision === 'accepted').length;
    return { clipId: clip._id, videoId: clip.videoId, buckets, accepted, fillRate: buckets ? accepted / buckets : null,
      reason: clip.visualsSkippedReason, prefetch: clip.visualsPrefetchStats, beats };
  });
  const buckets = details.reduce((sum, clip) => sum + clip.buckets, 0);
  const accepted = details.reduce((sum, clip) => sum + clip.accepted, 0);
  const fillRate = buckets ? accepted / buckets : null;
  return { clips: details.length, buckets, accepted, fillRate, target: 0.7, targetMet: fillRate === null ? null : fillRate >= 0.7, details };
}

export function readTimingLines(text: string): { rows: TimingRow[]; malformed: number } {
  const rows: TimingRow[] = []; let malformed = 0;
  for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
    try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as TimingRow); else malformed++; }
    catch { malformed++; }
  }
  return { rows, malformed };
}
function distribution(values: Array<number | undefined>) {
  const sorted = values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}
const render = (row: TimingRow) => !row.phase && typeof row.totalMs === 'number' && typeof row.clipId === 'string';
function latestRenders(rows: TimingRow[]) {
  const result = new Map<string, TimingRow>();
  for (const row of rows.filter(render)) if (!result.has(row.clipId!) || (row.timestamp ?? '') > (result.get(row.clipId!)?.timestamp ?? '')) result.set(row.clipId!, row);
  return result;
}

export function evaluateVisualTimings(rows: TimingRow[], baseline: TimingRow[] = []) {
  const renders = [...latestRenders(rows).values()];
  const prefetches = rows.filter((row) => row.phase === 'visual-prefetch' && !row.cancelled);
  const uncached = prefetches.filter((row) => (row.attempts ?? 0) > 0);
  const before = latestRenders(baseline);
  const pairs = renders.flatMap((after) => {
    const old = before.get(after.clipId!);
    if (!old || after.encoder !== old.encoder || after.preset !== old.preset || after.durationSeconds !== old.durationSeconds || (after.timestamp ?? '') <= (old.timestamp ?? '') || !old.totalMs) return [];
    return [{ clipId: after.clipId!, beforeMs: old.totalMs, afterMs: after.totalMs!, deltaPercent: (after.totalMs! / old.totalMs - 1) * 100 }];
  });
  return {
    render: { totalMs: distribution(renders.map((r) => r.totalMs)), ffmpegMs: distribution(renders.map((r) => r.ffmpegEncodeMs)), remotionMs: distribution(renders.map((r) => r.remotionOverlayMs)), visualsResolveMs: distribution(renders.map((r) => r.visualsResolveMs)) },
    prefetch: { records: prefetches.length, uncachedMs: distribution(uncached.map((r) => r.prefetchMs)), cacheReplays: prefetches.filter((r) => r.attempts === 0 && (r.cacheHits ?? 0) > 0).length,
      plannerCalls: prefetches.reduce((n, r) => n + (r.plannerCalls ?? 0), 0), visionCalls: prefetches.reduce((n, r) => n + (r.visionCalls ?? 0), 0), httpAttempts: prefetches.reduce((n, r) => n + (r.attempts ?? 0), 0),
      geminiCumulativeMs: distribution(uncached.map((r) => r.geminiMs)),
      plannerElapsedMs: distribution(prefetches.flatMap((r) => (r.geminiCalls ?? []).filter((c) => c.task === 'planner').map((c) => c.elapsedMs))),
      visionElapsedMs: distribution(prefetches.flatMap((r) => (r.geminiCalls ?? []).filter((c) => c.task === 'vision').map((c) => c.elapsedMs))) },
    baseline: { pairedClips: pairs.length, pairs, meanDeltaPercent: pairs.length ? pairs.reduce((n, p) => n + p.deltaPercent, 0) / pairs.length : null },
  };
}
