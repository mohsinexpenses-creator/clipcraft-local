import { hashVisualTranscript } from './visual-transcript';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getClip, getClipRecordSync, getDatabase, getVideo, updateClipRecordSync } from './db';
import { resolveVisualProviderSettings } from './app-settings';
import { completeVisualJson } from './llm';
import { createVisualApiBudget, DEFAULT_VISUAL_BUDGET_MS, type VisualApiBudget } from './gemini-pool';
import { planSentenceVisuals } from './visual-planner';
import { mapVisualMomentToOutputTimeline, isNamedPersonKeywordPop } from './contextual-visuals';
import { pruneVisualCacheDirectory, resolveVisualOverlaysForClip } from './visual-providers';
import { resolveHookTiming } from '../worker/hook-timing';
import { log } from './logger';
import { appendVisualPrefetchTiming } from './timings';
import type { ClipRecord, ClipVisualOverlay, RenderDefaults, TranscriptData, VisualPrefetchStats } from './types';

export { hashVisualTranscript } from './visual-transcript';

 function visualPrefetchFingerprint(clip: ClipRecord, transcript: TranscriptData, settings: Partial<RenderDefaults>): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 6, transcript: hashVisualTranscript(transcript, clip.start, clip.end), start: clip.start, end: clip.end,
    max: settings.maxVisualMoments, score: settings.visualizableScoreThreshold ?? 6, vision: settings.visualVisionScoreThreshold ?? 7,
    strictness: settings.visualRelevanceStrictness ?? 'strict', providers: settings.visualProviders, priority: settings.visualProviderPriority,
    entities: clip.aiAnalysis?.visualMoments?.filter((ov) => ['person', 'place', 'named_event'].includes(ov.category)),
    edited: clip.visualsUseEditedMoments ? clip.visualOverlays?.map((ov) => ({ id: ov.id, quote: ov.quote, meaning: ov.sentenceMeaningEn, subject: ov.visualIntent, queries: ov.searchQueries, negatives: ov.negativeCues, category: ov.category, entity: ov.entityName, start: ov.sourceStart, end: ov.sourceEnd, removed: ov.status === 'removed', kind: ov.kind })) : undefined,
  })).digest('hex');
}

function remap(overlays: ClipVisualOverlay[], clip: ClipRecord): ClipVisualOverlay[] {
  const hook = resolveHookTiming({ enabled: clip.hookDuration > 0, clipStart: clip.start, clipEnd: clip.end,
    fallbackDuration: clip.hookDuration, hookTimestampStart: clip.aiAnalysis?.hook_line_analysis.hook_timestamp.start,
    hookTimestampEnd: clip.aiAnalysis?.hook_line_analysis.hook_timestamp.end });
  return overlays.map((ov) => ({ ...ov, outputWindows: mapVisualMomentToOutputTimeline({ sourceStart: ov.sourceStart, sourceEnd: ov.sourceEnd,
    clipStart: clip.start, clipEnd: clip.end, placement: 'main', hookTiming: hook, allowDuplicateHookReplay: false }).outputWindows }));
}

interface PrefetchCache { overlays: ClipVisualOverlay[]; reason?: string; debug?: unknown }
function safeWrite(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2)); fs.renameSync(temp, file);
}

/** Called only by a per-clip queue job. No whole-video await, no render-time network. */
export async function runVisualPrefetch(clipId: string, options: { cacheDir?: string; timeoutMs?: number } = {}): Promise<{ cancelled: boolean; stats: VisualPrefetchStats }> {
  const started = performance.now();
  const budget: VisualApiBudget = createVisualApiBudget(options.timeoutMs ?? DEFAULT_VISUAL_BUDGET_MS);
  const clip = await getClip(clipId);
  const stats = (): VisualPrefetchStats => ({ geminiCalls: [...budget.geminiCalls], plannerCalls: budget.plannerCalls, visionCalls: budget.visionCalls, attempts: budget.attempts, geminiMs: Math.round(budget.geminiMs), cacheHits: budget.cacheHits, prefetchMs: Math.round(performance.now() - started) });
  if (!clip || clip.cancelling || clip.error === 'Cancelled by user.') return { cancelled: true, stats: stats() };
  if (getDatabase().prepare("SELECT id FROM jobs WHERE type = 'clip-processing' AND clip_id = ? AND status IN ('queued','running')").get(clipId)) return { cancelled: true, stats: stats() };
  const video = await getVideo(clip.videoId);
  const providers = await resolveVisualProviderSettings();
  const render = { ...providers.render, ...clip.visualPrefetchSettings };
  let overlays: ClipVisualOverlay[] = clip.visualOverlays ?? [];
  let reason: string | undefined;
  let fingerprint: string | undefined;
  let transcriptHash: string | undefined;
  let cacheFile: string | undefined;
  let debug: unknown;
  let wholeCacheHit = false;
  const debugFile = path.resolve('data/visual-debug', `${path.basename(clipId)}.json`);
  try {
    if (clip.autoVisuals === false || !render.autoVisuals) {
      reason = 'Automatic photos disabled for this clip';
      overlays = overlays.filter((ov) => ov.kind === 'keyword-pop' || ov.kind === 'zoom-beat');
    } else {
      if (!video?.transcript) throw new Error('Source transcript unavailable');
      transcriptHash = hashVisualTranscript(video.transcript, clip.start, clip.end);
      fingerprint = visualPrefetchFingerprint(clip, video.transcript, render);
      cacheFile = path.join(options.cacheDir ?? path.resolve('data/visual-prefetch'), `${crypto.createHash('sha256').update(JSON.stringify([fingerprint, providers.geminiApiKeys, providers.pexelsApiKey, providers.pixabayApiKey, providers.unsplashAccessKey, providers.geminiRequestsPerMinute])).digest('hex')}.json`);
      let cached: PrefetchCache | undefined;
      try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as PrefetchCache; } catch { /* first attempt */ }
      if (cached && !cached.reason?.startsWith('Visual prefetch unavailable') && !cached.overlays?.some((ov) => ov.status === 'skipped' && /unavailable|quota|network|deadline|key|HTTP/i.test(ov.skipReason ?? '')) && Array.isArray(cached.overlays)) {
        budget.cacheHits++;
        wholeCacheHit = true;
        overlays = cached.overlays.map((ov) => ov.status === 'resolved' && ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat' && (!ov.localFilePath || !fs.existsSync(ov.localFilePath))
          ? { ...ov, status: 'skipped', localFilePath: undefined, skipReason: 'Cached verified frame missing; no API call on replay' } : ov);
        reason = cached.reason;
        debug = cached.debug;
      } else {
        if (!clip.visualsUseEditedMoments) {
          const photos = await planSentenceVisuals({ transcript: video.transcript, clipStart: clip.start, clipEnd: clip.end,
            cacheDir: options.cacheDir ? path.join(options.cacheDir, 'plans') : undefined,
            maxVisualMoments: render.maxVisualMoments, threshold: render.visualizableScoreThreshold ?? 6, animation: render.visualAnimation,
            complete: (request) => completeVisualJson(request, { keys: providers.geminiApiKeys, rpm: providers.geminiRequestsPerMinute, budget }),
            hookTiming: resolveHookTiming({ enabled: clip.hookDuration > 0, clipStart: clip.start, clipEnd: clip.end, fallbackDuration: clip.hookDuration,
              hookTimestampStart: clip.aiAnalysis?.hook_line_analysis.hook_timestamp.start, hookTimestampEnd: clip.aiAnalysis?.hook_line_analysis.hook_timestamp.end }),
          });
          overlays = [ ...overlays.filter((ov) => ov.kind === 'keyword-pop' || ov.kind === 'zoom-beat'), ...photos.map((photo) => {
            const entity = clip.visualOverlays?.find((ov) => ['person', 'place', 'named_event'].includes(ov.category) && ov.sourceStart < photo.sourceEnd && ov.sourceEnd > photo.sourceStart);
            const quote = photo.segmentIds?.map((id) => video.transcript!.segments[id - 1]?.text ?? '').join(' ') || photo.quote;
            return { ...photo, quote, ...(!photo.primaryEntity && entity ? { category: entity.category, entityName: entity.entityName, framing: entity.framing, emotionalPolarity: entity.emotionalPolarity } : {}) };
          }) ];
        }
        overlays = await resolveVisualOverlaysForClip(overlays, { ...providers, renderSettings: render, clipId, videoId: clip.videoId,
          budget, cacheNamespace: fingerprint });
        if (!overlays.some((ov) => ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat')) reason = 'No sufficiently photographable sentence beats above the score threshold';
        try { debug = JSON.parse(fs.readFileSync(debugFile, 'utf8')); } catch { /* empty planner */ }
      }
      overlays = remap(overlays, clip);
    }
  } catch (error) {
    reason = `Visual prefetch unavailable: ${error instanceof Error ? error.message : 'unknown network/API error'}`;
    log.warn(`${clipId}: ${reason}`);
    // A transient API/network failure must not erase frames that are already
    // verified on disk: render revalidates transcript/settings hashes before
    // using them. Only planned or unresolved beats are downgraded.
    overlays = overlays.map((ov) => ov.status === 'removed' || ov.kind === 'keyword-pop' || ov.kind === 'zoom-beat'
      || (ov.status === 'resolved' && ov.localFilePath && fs.existsSync(ov.localFilePath))
      ? ov
      : { ...ov, status: 'skipped', localFilePath: undefined, skipReason: reason });
  }
  overlays = overlays.filter((ov) => !isNamedPersonKeywordPop(ov, [...overlays, ...(clip.visualOverlays ?? [])]));
  const floor = Math.ceil((clip.end - clip.start) * 7 / 60);
  const resolvedCount = overlays.filter((ov) => ov.status === 'resolved' && ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat').length;
  if (clip.autoVisuals !== false && render.autoVisuals && resolvedCount < floor) reason = [reason, `Image floor shortfall: ${resolvedCount}/${floor}; relevance/identity/face/vision/budget gates take priority, no irrelevant padding`].filter(Boolean).join('; ');
  const reasons = overlays.filter((ov) => ov.status === 'skipped' || ov.skipReason).map((ov) => ov.skipReason).filter(Boolean);
  reason = [...new Set([reason, ...reasons].filter(Boolean))].join('; ') || undefined;
  const timing = stats();
  if (!debug) debug = { clipId, videoId: clip.videoId, beats: [], reason };
  safeWrite(debugFile, { ...(debug as object), reason, stats: timing });
  // One line per clip so the worker log shows where the budget went instead of
  // only the final fail-closed reason.
  log.detail(`${clipId}: ${resolvedCount}/${overlays.filter((ov) => ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat' && ov.status !== 'removed').length} visual(s) resolved in ${timing.prefetchMs}ms (gemini ${timing.geminiMs}ms, ${timing.attempts} attempt(s))${reason ? ` · ${reason.split('; ')[0].slice(0, 140)}` : ''}`);
  if (cacheFile && !wholeCacheHit && !reason?.startsWith('Visual prefetch unavailable') && !overlays.some((ov) => ov.status === 'skipped' && /unavailable|quota|network|deadline|key|HTTP/i.test(ov.skipReason ?? ''))) safeWrite(cacheFile, { overlays, reason, debug } satisfies PrefetchCache);
  // Never resurrect a deleted/cancelled clip or overwrite edits/a manual render.
  let cancelled = false;
  const db = getDatabase();
  db.transaction(() => {
    const current = getClipRecordSync(db, clipId);
    if (!current) { cancelled = true; return; }
    const rendering = db.prepare("SELECT id FROM jobs WHERE type = 'clip-processing' AND clip_id = ? AND status IN ('queued','running')").get(clipId);
    if (current.cancelling || current.error === 'Cancelled by user.' || rendering || current.start !== clip.start || current.end !== clip.end || (fingerprint && video?.transcript && visualPrefetchFingerprint(current, video.transcript, render) !== fingerprint)) { cancelled = true; return; }
    updateClipRecordSync(db, { ...current, visualPrefetchSettings: render, visualOverlays: overlays, visualsSkippedReason: reason,
      visualsPrefetchedAt: new Date().toISOString(), visualsPrefetchFingerprint: fingerprint, visualsTranscriptHash: transcriptHash, visualsPrefetchStats: timing });
  }).immediate();
  appendVisualPrefetchTiming({ timestamp: new Date().toISOString(), phase: 'visual-prefetch', clipId, videoId: clip.videoId, ...timing, cancelled });
  pruneVisualCacheDirectory();
  return { cancelled, stats: timing };
}
