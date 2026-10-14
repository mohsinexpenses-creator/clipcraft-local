import fs from 'fs';
import path from 'path';
import {
  getCaptionPreset,
  getClip,
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  getOverlayStylePreset,
  getVideo,
  updateClip,
} from '../lib/db';
import { AppError, RenderCancelledError, toErrorMessage } from '../lib/errors';
import { resolveClipsDir } from '../lib/paths';
import { resolveCaptionThemeOverlayStyle } from '../lib/caption-theme-styles';

import { getVideoMetadata } from '../lib/ffmpeg';
import { getCaptionOffsetMs, shiftCaptionWords } from './caption-timing';
import { ClipLayout, ClipRecord, JobData, OverlayStylePreset } from '../lib/types';
import { detectSpeakerTimeline } from './asd';
import { buildLayoutPlan, getSplitFramingSettings } from './layout';
import {
  VisualDisplayMode,
  adaptOverlaysToLayout,
  chooseVisualDisplayMode,
  describePlacements,
  planVisualCardPlacement,
} from './overlay-layout';
import { color, log } from '../lib/logger';
import {
  HOOK_TRANSITION_SECONDS,
  StillVisualOverlayInput,
  buildVideoCodecArgs,
  getActiveVideoEncoder,
  normalizeFps,
  processVideoSegment,
} from './ffmpeg-pipeline';
import { DEFAULT_HOOK_FALLBACK_SECONDS, resolveHookTiming } from './hook-timing';
import {
  prepareRemotionCaptionOverlays,
  type PreparedCaptionOverlays,
} from './remotion-renderer';
import { resolveVisualProviderSettings } from '../lib/app-settings';
import {
  buildClipCreditsManifest,
  ensureDensePhotoMomentsForClip,
  planClipVisualMoments,
} from '../lib/contextual-visuals';
import type { KeywordPopOverlayItem } from '../lib/types';
import {
  findMatchingImageBankEntry,
  getProviderOrderForMoment,
  getVisualAssetDedupKeys,
  hasAnyVisualAssetDedupKey,
  preScaleCachedVisualImage,
  registerVisualAssetDedupKeys,
  resolveVisualOverlaysForClip,
} from '../lib/visual-providers';
import { appendClipTimingRecord, formatClipTimingSummary } from '../lib/timings';
import { buildSfxCueSheet, filterPlayableSfxCues } from '../lib/sfx-cues';

/** How far either side of the window we still accept transcript words. */
const WORD_SLACK_SECONDS = 0.5;

/**
 * Last-resort overlay copy. A render should never die just because an LLM call was
 * skipped or returned nothing - the user can always re-render with better text.
 */
function deriveOverlayText(words: Array<{ word: string }>, maxWords: number, fallback: string): string {
  const text = words
    .slice(0, maxWords)
    .map((entry) => entry.word)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  return text || fallback;
}

/** Resolve an explicit overlay id, or use the current database default only when absent. */
async function resolveOverlayStyle(
  id: string | undefined,
  kind: 'hook' | 'cta'
): Promise<OverlayStylePreset> {
  if (id?.trim()) {
    const preset = await getOverlayStylePreset(id.trim());
    if (!preset || preset.kind !== kind) {
      throw new AppError(`Overlay style preset ${id} was not found for ${kind}.`, {
        status: 404,
        resolution: 'Select an existing overlay style preset from the dashboard and retry rendering.',
      });
    }
    return preset;
  }

  const preset = await getDefaultOverlayStylePreset(kind);
  if (!preset) {
    throw new AppError(`No default ${kind.toUpperCase()} style preset is configured.`, {
      status: 500,
      resolution: 'Choose a database default for Hook and CTA in preset settings.',
    });
  }
  return preset;
}

export async function processClipJob(
  jobData: JobData,
  onProgress?: (progress: number) => void
): Promise<ClipRecord> {
  const {
    clipId,
    videoId,
    start,
    end,
    hookDuration,
    hookText,
    ctaText,
    ctaDuration,
    filterPreset,
    captionPresetId,
  } = jobData;

  log.section(
    `Render ${color.bold(clipId)}` +
      color.gray(`  ·  video ${videoId}  ·  ${start}s → ${end}s`)
  );

  const reportProgress = async (value: number): Promise<void> => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (onProgress) await onProgress(clamped);
  };

  const clip = await getClip(clipId);
  if (!clip) {
    throw new AppError(`Clip record ${clipId} was not found in SQLite.`, {
      status: 404,
      resolution: 'Create the clip again from viral detection before attempting to render it.',
    });
  }

  const video = await getVideo(videoId);
  if (!video) {
    throw new AppError(`Source video record ${videoId} was not found in SQLite.`, {
      status: 404,
      resolution: 'Upload the source video again before rendering clips.',
    });
  }

  if (!fs.existsSync(video.filePath)) {
    throw new AppError('The source video file is missing from disk.', {
      status: 404,
      details: video.filePath,
      resolution: 'Upload the video again so ClipCraft can rebuild the source file.',
    });
  }

  clip.status = 'processing';
  clip.progress = 5;
  clip.error = undefined;
  // A re-render starts fresh: a stale cancelling flag (from a previous
  // cancelled render) must not abort this new job on its first poll.
  clip.cancelling = false;
  if (!(await updateClip(clip))) {
    throw new RenderCancelledError('Clip was deleted before rendering started.');
  }
  await reportProgress(5);

  // Output folder mirrors the uploaded video's stored name (e.g. 001_my_recording);
  // pre-convention uploads fall back to the video id. The root comes from
  // Settings -> Paths & binaries (default: ./generated-clips), while the stored
  // outputPath keeps its logical /generated-clips/ prefix for the media route.
  const outputBase = video.fileBase || videoId;
  const outputDir = path.join(resolveClipsDir(), outputBase);
  // Optional pre-caption diagnostic branch (SAVE_PRECAPTION_DEBUG=1). The normal
  // final render goes directly from the source into the title-named deliverable.
  const intermediateVideoPath = path.join(outputDir, `${clipId}_precaption.mp4`);
  const clipFileBase = sanitizeClipFileName(clip.aiAnalysis?.viral_packaging.video_title) || clipId;
  const finalVideoPath = uniqueClipPath(outputDir, clipFileBase);

  // Cancellation: the UI flips clip.cancelling (POST /api/clips/<id>/cancel).
  // A watcher polls the DB every 500ms; the FFmpeg passes check the flag
  // continuously and each step boundary aborts immediately.
  let cancelFlag = false;
  let cancelWatcher: NodeJS.Timeout | null = null;
  try {
    cancelWatcher = setInterval(() => {
      void getClip(clipId)
        .then((fresh) => {
          // A deleted clip or failed/cancelled clip is a cancellation signal; updateClip() is update-only
          // and prevents this worker from recreating its database row.
          if (!fresh || fresh.cancelling || fresh.status === 'failed') cancelFlag = true;
        })
        .catch(() => undefined);
    }, 500);
    const checkCancelled = (): void => {
      if (cancelFlag) throw new RenderCancelledError();
    };

    const clipRenderStartMs = performance.now();
    const prepStartMs = performance.now();

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    /**
     * Probe the SOURCE once: FFprobe's average/base rates identify VFR inputs,
     * the stream starts keep audio aligned to video, and fps selects the CFR
     * overlay/output cadence. Missing ffprobe is reported by getVideoMetadata().
     */
    const sourceMeta = await getVideoMetadata(video.filePath);
    const renderFps = normalizeFps(sourceMeta.fps);
    const sourceVariableFrameRate = sourceMeta.isVariableFrameRate === true;
    const audioStartOffsetSeconds = sourceMeta.audioStartTime === null
      ? 0
      : sourceMeta.audioStartTime - sourceMeta.videoStartTime;
    const rateDetail = sourceMeta.averageFrameRate && sourceMeta.nominalFrameRate
      ? `avg/r=${sourceMeta.averageFrameRate}/${sourceMeta.nominalFrameRate}`
      : 'FFprobe frame rates unavailable';
    log.detail(
      `Source ${sourceMeta.width}x${sourceMeta.height} @ ${sourceMeta.fps}fps ` +
      `(${rateDetail}${sourceVariableFrameRate ? ', VFR → CFR normalize' : ''}; render @ ${renderFps}fps), ` +
      `audio=${sourceMeta.hasAudio ? 'yes' : 'no'}, ${sourceMeta.duration.toFixed(1)}s`
    );
    if (sourceMeta.hasAudio && Math.abs(audioStartOffsetSeconds) > 0.001) {
      log.detail(`Audio stream starts ${audioStartOffsetSeconds >= 0 ? '+' : ''}${audioStartOffsetSeconds.toFixed(3)}s from video; preserving this offset.`);
    }

    const segmentDuration = Math.max(0.1, end - start);

    // Compute the clip's words UP FRONT: captions need them, the hook-moment
    // detector needs them, and a window without spoken words should fail fast
    // before we waste an FFmpeg encode on it.
    const allWords = video.transcript?.words || [];
    const clipWords = allWords
      .filter(
        (word) =>
          word.end >= start - WORD_SLACK_SECONDS && word.start <= end + WORD_SLACK_SECONDS
      )
      .map((word) => ({
        ...word,
        // Relative to the segment start; the composition adds hookDuration back on.
        start: Math.max(0, word.start - start),
        end: Math.max(0.1, word.end - start),
      }));

    if (clipWords.length === 0) {
      throw new AppError('No transcript words were found for this clip window.', {
        status: 400,
        details: `window=${start}s-${end}s, transcriptWords=${allWords.length}`,
        resolution:
          'Re-run transcription, or pick a segment that overlaps spoken audio - captions need word timings.',
      });
    }

    // This adjustment is deliberately caption-only. The audio filter and profanity
    // windows below continue to use the original transcript timestamps.
    const captionOffsetMs = getCaptionOffsetMs();
    const captionWords = shiftCaptionWords(clipWords, captionOffsetMs);
    if (captionOffsetMs !== 0) {
      log.detail(`Caption offset ${captionOffsetMs > 0 ? '+' : ''}${captionOffsetMs}ms (positive = captions later; audio unchanged).`);
    }

    // hookDuration/ctaDuration are optional on the job payload; never pass undefined
    // into the FFmpeg/Remotion stages or the timeline maths silently breaks.
    // A positive hookDuration means "hook intro enabled". When viral analysis has
    // a valid hook_timestamp, its complete start→end interval is the actual intro
    // duration; the 3s value is only a fallback for older/invalid analysis data.
    const rawHookDuration = Number.isFinite(hookDuration) && (hookDuration ?? 0) >= 0
      ? (hookDuration as number)
      : DEFAULT_HOOK_FALLBACK_SECONDS;
    const hookOff = rawHookDuration < 0.15;

    // Replay the exact detected hook interval at the beginning, then play the
    // complete selected clip. Both timestamps are absolute video times; the
    // resolver converts the start to the clip-relative FFmpeg/caption timeline.
    // A valid interval outside the selected clip is an error, not a silently
    // shifted or truncated intro. Clips without usable timestamps retain the
    // legacy first-seconds fallback.
    const hook = clip.aiAnalysis?.hook_line_analysis;
    const hookTiming = resolveHookTiming({
      enabled: !hookOff,
      clipStart: start,
      clipEnd: end,
      hookTimestampStart: hook?.hook_timestamp.start,
      hookTimestampEnd: hook?.hook_timestamp.end,
      fallbackDuration: rawHookDuration,
    });
    const safeHookDuration = hookTiming.duration;
    const hookStart = hookTiming.start;

    if (hookTiming.source === 'timestamps') {
      log.ok(
        `Hook moment (from viral prompt): ${hookTiming.startAbsolute!.toFixed(1)}s → ` +
        `${hookTiming.endAbsolute!.toFixed(1)}s (${safeHookDuration.toFixed(2)}s)` +
        (hook?.hook_line ? `  ("${hook.hook_line}")` : '')
      );
    } else if (hookTiming.source === 'fallback') {
      log.detail(
        `No usable hook timestamp range on this clip - using a ${safeHookDuration.toFixed(2)}s fallback.`
      );
    }

    log.step('Step 1/3 · Face tracking + active speaker detection');
    const layout: ClipLayout = jobData.layout === 'split-screen' ? 'split-screen' : 'speaker-focus';
    clip.layout = layout;

    // No fallbacks by design: detectSpeakerTimeline throws an informative
    // error when it finds no face in the window (or YuNet is unavailable),
    // and the render STOPS - no static-centre crop, no legacy skin track.
    const asd = await detectSpeakerTimeline(
      video.filePath,
      start,
      segmentDuration,
      sourceMeta.width,
      sourceMeta.height,
      { hasAudio: sourceMeta.hasAudio }
    );
    const splitFraming = getSplitFramingSettings();
    const plan = buildLayoutPlan(asd, layout, sourceMeta.width, sourceMeta.height, splitFraming);
    if (layout === 'split-screen') {
      log.detail(
        `Split framing: face target ${(splitFraming.faceTargetFrac * 100).toFixed(0)}% of pane height, ` +
        `maximum crop zoom ${splitFraming.zoom.toFixed(1)}x.`
      );
    }
    checkCancelled();

    // Say what was ACTUALLY produced. A split request must never quietly turn
    // into something else: when only one person is found the planner renders a
    // single speaker window, and that is reported loudly here and on the clip.
    // Persist an empty string to clear any note from a previous render.
    clip.layoutNote = '';
    if (layout === 'split-screen') {
      if (plan.mode === 'split') {
        log.ok(
          `Split screen: ${plan.cells.length} panes - ` +
          plan.cells
            .map((cell, i) => `pane ${i + 1} = person#${cell.trackId}`)
            .join(', ')
        );
      } else {
        clip.layoutNote = plan.splitFallbackReason ?? 'Split screen could not be applied; rendered a single speaker window.';
        log.warn(`SPLIT SCREEN NOT APPLIED - ${clip.layoutNote}`);
      }
    }

    if (plan.mode === 'single') {
      clip.cropData = {
        x: 0,
        y: 0,
        width: plan.cropW,
        height: plan.cropH,
      };
    }
    clip.progress = 20;
    if (!(await updateClip(clip))) {
      throw new RenderCancelledError('Clip was deleted while render planning was in progress.');
    }
    await reportProgress(20);

    const requestedCaptionPresetId =
      typeof captionPresetId === 'string' && captionPresetId.trim()
        ? captionPresetId.trim()
        : clip.captionPresetId?.trim() || undefined;
    const defaultCaptionPreset = requestedCaptionPresetId
      ? null
      : await getDefaultCaptionPreset();
    const resolvedCaptionPresetId = requestedCaptionPresetId ?? defaultCaptionPreset?._id;
    if (!resolvedCaptionPresetId) {
      throw new AppError('No caption preset is selected and no database default is configured.', {
        status: 500,
        resolution: 'Choose a default caption preset in preset settings before rendering.',
      });
    }
    const preset = await getCaptionPreset(resolvedCaptionPresetId);
    if (!preset) {
      throw new AppError(`Caption preset ${resolvedCaptionPresetId} was not found.`, {
        status: 404,
        resolution: 'Select an existing caption preset from the dashboard and retry rendering.',
      });
    }

    // hookDuration 0 means the hook intro/overlay was turned off for this clip
    // (detection ran with the hook-text switch off) - don't derive text that
    // would only be ignored by the overlay.
    const hookOverlayEnabled = safeHookDuration > 0;
    const resolvedHookText = !hookOverlayEnabled
      ? ''
      : hookText?.trim() ||
        clip.hookText?.trim() ||
        deriveOverlayText(clipWords, 8, 'WATCH THIS');
    if (!hookOverlayEnabled) {
      log.detail('Hook overlay disabled for this clip (hookDuration=0) - rendering without hook text.');
    } else if (!hookText?.trim() && !clip.hookText?.trim()) {
      log.warn(`No hook text supplied - derived "${resolvedHookText}" from the transcript.`);
    }

    // ctaDuration 0 means the CTA card was turned off for this clip (detection
    // ran with the CTA switch off) - don't derive text that would only be
    // ignored by the overlay. An explicit job-payload ctaDuration > 0 re-enables
    // it for a re-render.
    const rawCtaDuration = Number.isFinite(ctaDuration)
      ? (ctaDuration as number)
      : (clip.ctaDuration ?? 2.5);
    const ctaOverlayEnabled = rawCtaDuration > 0;
    const resolvedCtaText = !ctaOverlayEnabled
      ? ''
      : ctaText?.trim() || clip.ctaText?.trim() || deriveOverlayText(clipWords.slice(-10), 8, 'FOLLOW FOR MORE');
    if (!ctaOverlayEnabled) {
      log.detail('CTA overlay disabled for this clip (ctaDuration=0) - rendering without CTA text.');
    } else if (!ctaText?.trim() && !clip.ctaText?.trim()) {
      log.warn(`No CTA text supplied - derived "${resolvedCtaText}" from the transcript.`);
    }

    const resolvedCtaDuration = ctaOverlayEnabled ? rawCtaDuration : 0;

    // Overlay STYLE presets (font/colors/card/animation) - per clip, falling
    // back to the seeded defaults. The TEXT above stays prompt-generated.
    const requestedHookStylePresetId = [
      jobData.hookStylePresetId,
      clip.hookStylePresetId,
    ].find((id) => typeof id === 'string' && id.trim())?.trim();
    const requestedCtaStylePresetId = [
      jobData.ctaStylePresetId,
      clip.ctaStylePresetId,
    ].find((id) => typeof id === 'string' && id.trim())?.trim();
    const hookStyle = await resolveOverlayStyle(requestedHookStylePresetId, 'hook');
    const ctaStyle = await resolveOverlayStyle(requestedCtaStylePresetId, 'cta');

    // Persist the resolved ids so legacy clips keep the exact presets used by
    // this render even if the database defaults change before a later rerender.
    clip.captionPresetId = resolvedCaptionPresetId;
    clip.hookStylePresetId = hookStyle._id;
    clip.ctaStylePresetId = ctaStyle._id;
    if (!(await updateClip(clip))) {
      throw new RenderCancelledError('Clip was deleted while presets were being resolved.');
    }

    // A selected caption theme also skins the Hook and CTA card typography,
    // palette and motion. Keep the saved standalone presets intact; these are
    // render-time variants used identically by the preview and the worker.
    const themedHookStyle = resolveCaptionThemeOverlayStyle(preset, hookStyle);
    const themedCtaStyle = resolveCaptionThemeOverlayStyle(preset, ctaStyle);

    // Where the captions / hook / CTA go depends on the layout. In a split screen
    // the preset positions would land on the two faces, so they are re-placed from
    // where the heads really are (speaker focus keeps the presets unchanged).
    const overlayLayout = adaptOverlaysToLayout({
      plan,
      // When the timed overlays are on screen (base-clip seconds): the hook card
      // shows over the replayed hook moment, minus the dip-to-black window; the CTA
      // over the last seconds of the clip.
      timing: {
        clipDuration: segmentDuration,
        hookStart,
        hookVisibleSeconds: Math.max(0, safeHookDuration - Math.min(HOOK_TRANSITION_SECONDS, safeHookDuration / 2)),
        ctaDuration: resolvedCtaDuration,
      },
      caption: preset,
      hook: hookOverlayEnabled ? { style: themedHookStyle, text: resolvedHookText } : null,
      cta: ctaOverlayEnabled ? { style: themedCtaStyle, text: resolvedCtaText } : null,
    });
    if (overlayLayout.adapted) {
      log.detail(`Overlay layout (split screen): ${describePlacements(overlayLayout)}`);
      for (const note of overlayLayout.notes) log.detail(`  · ${note}`);
    }
    const captionPresetForRender = overlayLayout.caption;
    const hookStyleForRender = overlayLayout.hookStyle ?? themedHookStyle;
    const ctaStyleForRender = overlayLayout.ctaStyle ?? themedCtaStyle;

    checkCancelled();
    const prepMs = performance.now() - prepStartMs;
    const totalDuration = segmentDuration + safeHookDuration;
    let visualsResolveMs = 0;
    let remotionOverlayMs = 0;
    let ffmpegEncodeMs = 0;

    // Resolve contextual visual overlays before Remotion & FFmpeg so keyword-pop beats
    // (including any photo moment that falls back when no local image is ready) render
    // directly inside the single Remotion overlay composition.
    const visualsStartMs = performance.now();
    const ffmpegVisualOverlays: StillVisualOverlayInput[] = [];
    const keywordPops: KeywordPopOverlayItem[] = [];
    let effectiveRenderSettings = (await resolveVisualProviderSettings()).render;
    try {
      const visualSettings = await resolveVisualProviderSettings();
      effectiveRenderSettings = visualSettings.render;
      const autoVisualsEnabled =
        (jobData.autoVisuals ?? clip.autoVisuals ?? visualSettings.render.autoVisuals) !== false;

      if (autoVisualsEnabled) {
        // Merge jobData.visualOverlays and clip.visualOverlays, preferring whichever
        // entry already has a resolved localFilePath on disk.
        const fromJob = jobData.visualOverlays ?? [];
        const fromClip = clip.visualOverlays ?? [];
        const baseList = fromClip.length >= fromJob.length ? fromClip : fromJob;
        const otherById = new Map(
          (baseList === fromClip ? fromJob : fromClip).map((ov) => [ov.id, ov])
        );
        let planned = baseList.map((ov) => {
          const alt = otherById.get(ov.id);
          if (
            (!ov.localFilePath || !fs.existsSync(ov.localFilePath)) &&
            alt?.localFilePath &&
            fs.existsSync(alt.localFilePath)
          ) {
            return { ...ov, ...alt };
          }
          return ov;
        });

        if (planned.length === 0 && clip.aiAnalysis?.visualMoments?.length) {
          planned = planClipVisualMoments({
            rawMoments: clip.aiAnalysis.visualMoments,
            clipStart: start,
            clipEnd: end,
            transcript: video.transcript,
            hookTiming: {
              start: hookStart,
              duration: safeHookDuration,
            },
            options: {
              autoVisuals: true,
              maxVisualMoments: visualSettings.render.maxVisualMoments,
              confidenceThreshold: visualSettings.render.visualConfidenceThreshold,
              minDuration: visualSettings.render.visualMinDuration,
              defaultDuration: visualSettings.render.visualDefaultDuration,
              defaultAnimation: visualSettings.render.visualAnimation,
              fillDensityGaps: true,
            },
          });
        }

        // Ensure dense, relevant photo moments every ~5-6s across the clip without duplicate queries
        planned = ensureDensePhotoMomentsForClip({
          overlays: planned,
          clipStart: start,
          clipEnd: end,
          transcript: video.transcript,
          hookTiming: {
            start: hookStart,
            duration: safeHookDuration,
          },
          maxVisualMoments: visualSettings.render.maxVisualMoments,
          minDuration: visualSettings.render.visualMinDuration,
          defaultDuration: visualSettings.render.visualDefaultDuration,
          defaultAnimation: visualSettings.render.visualAnimation,
        });

        if (planned.length > 0) {
          // 1. Check existing local files and SQLite image_bank first, strictly deduplicating
          // so the same image is never assigned to two moments in the same clip.
          const usedAssetKeys = new Set<string>();
          let resolvedVisuals = planned.map((item) => {
            if (item.status === 'removed') return item;
            if (item.localFilePath && fs.existsSync(item.localFilePath)) {
              const converted = preScaleCachedVisualImage(
                item.localFilePath,
                item.width ?? 1200,
                item.height ?? 1200
              );
              const itemKeys = getVisualAssetDedupKeys({
                provider: item.attribution?.provider,
                assetId: item.attribution?.assetId,
                localFilePath: converted,
                contentHash: item.contentHash,
                imageUrl: item.attribution?.imageUrl,
              });
              if (!hasAnyVisualAssetDedupKey(usedAssetKeys, itemKeys)) {
                registerVisualAssetDedupKeys(usedAssetKeys, itemKeys);
                return {
                  ...item,
                  kind: 'photo-card' as const,
                  status: 'resolved' as const,
                  localFilePath: converted,
                  mediaUrl: `/api/media/visual-cache/${path.basename(converted)}`,
                };
              }
            }
            const allowedProviders = getProviderOrderForMoment({
              moment: item,
              renderSettings: visualSettings.render,
              hasPexelsKey: Boolean(visualSettings.pexelsApiKey),
              hasPixabayKey: Boolean(visualSettings.pixabayApiKey),
              hasUnsplashKey: Boolean(visualSettings.unsplashAccessKey),
            });
            const bankHit = findMatchingImageBankEntry({
              moment: item,
              allowedProviders,
              usedAssetIds: usedAssetKeys,
            });
            if (bankHit && fs.existsSync(bankHit.localPath)) {
              return {
                ...item,
                kind: 'photo-card' as const,
                status: 'resolved' as const,
                localFilePath: bankHit.localPath,
                mediaUrl: `/api/media/visual-cache/${path.basename(bankHit.localPath)}`,
                contentHash: bankHit.contentHash,
                width: bankHit.width,
                height: bankHit.height,
                attribution: bankHit.attribution,
              };
            }
            return {
              ...item,
              localFilePath: undefined,
              mediaUrl: undefined,
              kind: 'photo-card' as const,
              status: 'planned' as const,
            };
          });

          // 2. If any moment still lacks a local image, resolve from cached search results / providers.
          const needsProviderResolve = resolvedVisuals.some(
            (item) =>
              item.status !== 'removed' &&
              (!item.localFilePath || !fs.existsSync(item.localFilePath))
          );
          if (needsProviderResolve) {
            resolvedVisuals = await resolveVisualOverlaysForClip(resolvedVisuals, {
              renderSettings: { ...visualSettings.render, visualVisionVerify: false },
              geminiApiKeys: visualSettings.geminiApiKeys,
              pexelsApiKey: visualSettings.pexelsApiKey,
              pixabayApiKey: visualSettings.pixabayApiKey,
              unsplashAccessKey: visualSettings.unsplashAccessKey,
              openverseClientId: visualSettings.openverseClientId,
              openverseClientSecret: visualSettings.openverseClientSecret,
              wikimediaUserAgent: visualSettings.wikimediaUserAgent,
            });
          }

          const finalDedupKeys = new Set<string>();
          resolvedVisuals = resolvedVisuals.map((item) => {
            if (item.status === 'removed') return item;
            if (item.localFilePath && fs.existsSync(item.localFilePath)) {
              const converted = preScaleCachedVisualImage(
                item.localFilePath,
                item.width ?? 1200,
                item.height ?? 1200
              );
              const keys = getVisualAssetDedupKeys({
                provider: item.attribution?.provider,
                assetId: item.attribution?.assetId,
                localFilePath: converted,
                contentHash: item.contentHash,
                imageUrl: item.attribution?.imageUrl,
              });
              if (!hasAnyVisualAssetDedupKey(finalDedupKeys, keys)) {
                registerVisualAssetDedupKeys(finalDedupKeys, keys);
                return {
                  ...item,
                  kind: 'photo-card' as const,
                  status: 'resolved' as const,
                  localFilePath: converted,
                  mediaUrl: `/api/media/visual-cache/${path.basename(converted)}`,
                };
              }
            }
            return {
              ...item,
              localFilePath: undefined,
              mediaUrl: undefined,
              status: 'skipped' as const,
              skipReason: item.skipReason ?? 'No unique relevant local image available.',
            };
          });

          clip.visualOverlays = resolvedVisuals;
          await updateClip(clip).catch(() => undefined);

          // Mix full-screen (1080x1920 behind captions) and face-safe behind-captions card placements.
          const behindCaptionsPlacement = planVisualCardPlacement({
            plan,
            captionBand: overlayLayout.placements.caption,
            hookBand: overlayLayout.placements.hook,
            ctaBand: overlayLayout.placements.cta,
            cardAspect: visualSettings.render.visualCardAspect ?? 'portrait',
            placeBehindCaptions: true,
          });
          const fullScreenPlacement = planVisualCardPlacement({
            plan,
            fullScreen: true,
          });

          const chosenModes: VisualDisplayMode[] = [];
          const renderedImageKeys = new Set<string>();

          for (const item of resolvedVisuals) {
            if (item.status === 'removed' || item.status === 'skipped') continue;
            const hasLocalPhoto = Boolean(item.localFilePath && fs.existsSync(item.localFilePath));

            if (hasLocalPhoto && item.localFilePath) {
              const itemKeys = getVisualAssetDedupKeys({
                provider: item.attribution?.provider,
                assetId: item.attribution?.assetId,
                localFilePath: item.localFilePath,
                contentHash: item.contentHash,
              });
              if (hasAnyVisualAssetDedupKey(renderedImageKeys, itemKeys)) {
                continue;
              }
              const win = item.outputWindows.find((w) => w.end - w.start >= 0.5);
              if (!win) continue;

              registerVisualAssetDedupKeys(renderedImageKeys, itemKeys);
              const mode = chooseVisualDisplayMode(
                chosenModes.length,
                `${clip._id}:${item.id}`,
                chosenModes
              );
              chosenModes.push(mode);
              const placement =
                mode === 'fullscreen' ? fullScreenPlacement : behindCaptionsPlacement;

              ffmpegVisualOverlays.push({
                id: `${item.id}_${win.segment}`,
                imagePath: item.localFilePath,
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
                start: win.start,
                end: win.end,
                animation: item.animation,
                border:
                  mode === 'fullscreen'
                    ? false
                    : (visualSettings.render.visualCardBorder ?? true),
              });
            }
          }

          if (ffmpegVisualOverlays.length > 0) {
            const manifest = buildClipCreditsManifest({
              clipId: clip._id,
              videoId: clip.videoId,
              clipTitle: clip.aiAnalysis?.viral_packaging.video_title || clip.videoTitle,
              visualOverlays: resolvedVisuals,
            });
            const creditsPath = `${finalVideoPath.replace(/\.mp4$/i, '')}.credits.txt`;
            fs.writeFileSync(creditsPath, manifest.plainText, 'utf8');
          }
        }
      }
    } catch (visualError) {
      log.warn(
        `Contextual visuals skipped for ${clipId}: ${toErrorMessage(visualError)}`
      );
    }
    visualsResolveMs = performance.now() - visualsStartMs;

    log.step(
      `Step 2/3 · Render transparent overlays (Remotion)  ${color.gray(`(${clipWords.length} words, ${keywordPops.length} keyword pop(s), preset "${preset.name}")`)}`
    );
    const overlayProgressSink = (progress: number): void => {
      if (cancelFlag) return;
      const scaled = 20 + Math.max(0, Math.min(100, progress)) * 0.1;
      clip.progress = Math.max(clip.progress ?? 0, Math.round(scaled));
      void updateClip(clip)
        .then(() => {
          if (clip.cancelling) cancelFlag = true;
        })
        .catch((error) => log.warn('progress save failed: ' + toErrorMessage(error)));
      void reportProgress(scaled);
    };

    const remotionStartMs = performance.now();
    const preparedOverlays: PreparedCaptionOverlays = await prepareRemotionCaptionOverlays({
      fps: renderFps,
      totalDuration,
      hookText: resolvedHookText,
      hookDuration: safeHookDuration,
      hookStart,
      hookTransitionDuration: safeHookDuration > 0
        ? Math.min(HOOK_TRANSITION_SECONDS, safeHookDuration / 2)
        : 0,
      ctaText: resolvedCtaText,
      ctaDuration: resolvedCtaDuration,
      words: captionWords,
      preset: captionPresetForRender,
      hookStyle: hookStyleForRender,
      ctaStyle: ctaStyleForRender,
      captionLiftScale: overlayLayout.captionLiftScale,
      keywordPops,
      onProgress: overlayProgressSink,
      isCancelled: () => cancelFlag,
    });
    remotionOverlayMs = performance.now() - remotionStartMs;

    let renderResult: {
      fps: number;
      width: number;
      height: number;
      durationSeconds: number;
      fileSizeBytes: number;
    };
    try {
      checkCancelled();

      const sfxVisualWindows = [
        ...ffmpegVisualOverlays.map((ov) => ({
          id: ov.id,
          kind: 'photo-card' as const,
          start: ov.start,
          end: ov.end,
          animation: ov.animation,
        })),
        ...keywordPops.map((kp) => ({
          id: kp.id,
          kind: 'keyword-pop' as const,
          start: kp.start,
          end: kp.end,
          animation: kp.animation,
        })),
      ];

      const sfxCues = filterPlayableSfxCues(
        buildSfxCueSheet({
          segmentDuration,
          hookDuration: safeHookDuration,
          hookTransitionDuration:
            safeHookDuration > 0
              ? Math.min(HOOK_TRANSITION_SECONDS, safeHookDuration / 2)
              : 0,
          hookText: resolvedHookText,
          hookAnimationStyle: hookStyleForRender.animationStyle,
          hookSfxChoice: hookStyleForRender.sfxChoice,
          ctaDuration: resolvedCtaDuration,
          ctaText: resolvedCtaText,
          ctaAnimationStyle: ctaStyleForRender.animationStyle,
          ctaSfxChoice: ctaStyleForRender.sfxChoice,
          visualWindows: sfxVisualWindows,
          sfxEnabled: effectiveRenderSettings.sfxEnabled ?? true,
          sfxVolumeDb: effectiveRenderSettings.sfxVolume ?? -14,
        })
      );

      log.step(
        `Step 3/3 · FFmpeg crop + hook + overlays + one final encode ` +
        color.gray(
          `(${preparedOverlays.sequences.length} transparent layer(s), ${ffmpegVisualOverlays.length} visual card(s), ${sfxCues.length} SFX cue(s))`
        )
      );
      const progressSink = (progress: number): void => {
        if (cancelFlag) return;
        const scaled = 30 + Math.max(0, Math.min(80, progress)) * 0.85;
        clip.progress = Math.max(clip.progress ?? 0, Math.round(scaled));
        void updateClip(clip)
          .then(() => {
            if (clip.cancelling) cancelFlag = true;
          })
          .catch((error) => log.warn('progress save failed: ' + toErrorMessage(error)));
        void reportProgress(scaled);
      };

      const ffmpegStartMs = performance.now();
      await processVideoSegment({
        sourceVideoPath: video.filePath,
        outputPath: finalVideoPath,
        start,
        end,
        hookDuration: safeHookDuration,
        hookStart,
        filterPresetId: filterPreset,
        plan,
        sourceWidth: sourceMeta.width,
        sourceHeight: sourceMeta.height,
        targetFps: renderFps,
        sourceHasAudio: sourceMeta.hasAudio,
        overlays: preparedOverlays.sequences,
        visualOverlays: ffmpegVisualOverlays,
        sfxCues,
        words: clipWords,
        debugOutputPath: process.env.SAVE_PRECAPTION_DEBUG?.trim() === '1'
          ? intermediateVideoPath
          : undefined,
        isCancelled: () => cancelFlag,
        sourceIsVariableFrameRate: sourceVariableFrameRate,
        videoStartTimeSeconds: sourceMeta.videoStartTime,
        audioStartOffsetSeconds,
        onProgress: progressSink,
      });

      const outputMeta = await getVideoMetadata(finalVideoPath);
      ffmpegEncodeMs = performance.now() - ffmpegStartMs;
      renderResult = {
        fps: outputMeta.fps,
        width: outputMeta.width,
        height: outputMeta.height,
        durationSeconds: outputMeta.duration,
        fileSizeBytes: fs.statSync(finalVideoPath).size,
      };
    } finally {
      try { fs.rmSync(preparedOverlays.workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    const totalMs = performance.now() - clipRenderStartMs;
    const activeEncoder = getActiveVideoEncoder();
    const codecSpec = buildVideoCodecArgs(activeEncoder);
    const timingRecord = {
      timestamp: new Date().toISOString(),
      clipId,
      videoId,
      durationSeconds: renderResult.durationSeconds,
      encoder: activeEncoder,
      preset: codecSpec.presetLabel,
      prepMs,
      visualsResolveMs,
      remotionOverlayMs,
      ffmpegEncodeMs,
      totalMs,
    };
    try {
      appendClipTimingRecord(timingRecord);
    } catch (timingError) {
      log.warn(`Could not write timings.jsonl: ${toErrorMessage(timingError)}`);
    }
    log.info(formatClipTimingSummary(timingRecord));

    clip.status = 'done';
    clip.progress = 100;
    clip.hookText = resolvedHookText;
    clip.ctaText = resolvedCtaText;
    clip.ctaDuration = resolvedCtaDuration;
    clip.captionPresetId = resolvedCaptionPresetId;
    clip.captionPreset = preset;
    clip.hookStylePresetId = hookStyle._id;
    clip.ctaStylePresetId = ctaStyle._id;
    clip.outputPath = `/generated-clips/${outputBase}/${path.basename(finalVideoPath)}`;
    clip.outputFileSize = renderResult.fileSizeBytes;
    clip.outputFps = renderResult.fps;
    clip.error = undefined;
    if (!(await updateClip(clip))) {
      throw new RenderCancelledError('Clip was deleted while rendering was finishing.');
    }
    await reportProgress(100);

    log.ok(
      `Rendered ${color.bold(clipId)}: ${renderResult.width}x${renderResult.height} @ ` +
      `${renderResult.fps}fps, ${renderResult.durationSeconds.toFixed(2)}s, ` +
      `${(renderResult.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`
    );
    log.detail(`→ ${finalVideoPath}`);
    return clip;
  } catch (error) {
    if (error instanceof RenderCancelledError) {
      // A cancel is not a failure: persist the cancelled state, end the job
      // cleanly (no rethrow -> no retry).
      log.warn(`Render cancelled by user: ${color.bold(clipId)}`);
      clip.status = 'failed';
      clip.error = 'Cancelled by user.';
      clip.cancelling = false;
      await updateClip(clip).catch((saveError) =>
        log.error('Could not persist the cancelled state: ' + toErrorMessage(saveError))
      );
      return clip;
    }
    log.error(`Render failed for ${color.bold(clipId)}: ${toErrorMessage(error)}`);
    clip.status = 'failed';
    clip.error = toErrorMessage(error);
    clip.cancelling = false;
    await updateClip(clip).catch((saveError) =>
      log.error('Could not persist the failure state: ' + toErrorMessage(saveError))
    );
    throw error;
  } finally {
    if (cancelWatcher) clearInterval(cancelWatcher);
  }
}

/**
 * Turn a clip title into a safe file name (Windows + macOS friendly):
 * characters illegal in file names become spaces, whitespace is collapsed,
 * and the result is capped at 80 chars so long LLM titles cannot overflow
 * path limits. Returns '' when nothing usable remains (caller falls back
 * to the clip id).
 */
function sanitizeClipFileName(title: string | undefined): string {
  if (!title) return '';
  const cleaned = title
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 80).trim();
}

/** Same-title clips must not overwrite each other: append -2, -3, ... if needed. */
function uniqueClipPath(dir: string, base: string): string {
  let candidate = path.join(dir, `${base}.mp4`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${suffix}.mp4`);
    suffix += 1;
  }
  return candidate;
}
