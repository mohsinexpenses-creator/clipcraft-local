import fs from 'fs';
import path from 'path';
import { getCaptionPreset, getClip, getOverlayStylePreset, getVideo, saveClip } from '../lib/db';
import { AppError, toErrorMessage } from '../lib/errors';

import { getVideoMetadata } from '../lib/ffmpeg';
import { CaptionEngine, ClipLayout, ClipRecord, JobData, OverlayStylePreset } from '../lib/types';
import { DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import { detectFaceTrack } from './frame-sampler';
import { detectSpeakerTimeline } from './asd';
import { LayoutPlan, buildLayoutPlan, buildSinglePlan } from './layout';
import { color, log } from '../lib/logger';
import { normalizeFps, processVideoSegment } from './ffmpeg-pipeline';
import { renderNativeCaptions } from './native-captions';
import { renderCaptionsAndOverlays, type RenderCaptionsResult } from './remotion-renderer';

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

/**
 * Resolve an overlay STYLE preset id to a full preset. Missing/unknown ids fall
 * back to the seeded default for that overlay kind - a render never fails just
 * because a style was deleted.
 */
async function resolveOverlayStyle(
  id: string | undefined,
  kind: 'hook' | 'cta'
): Promise<OverlayStylePreset> {
  const fallback =
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === kind && p.isDefault) ??
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === kind)!;
  if (id) {
    try {
      const preset = await getOverlayStylePreset(id);
      if (preset && preset.kind === kind) return preset;
    } catch {
      // fall through to the default below
    }
  }
  return fallback;
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
    captionEngine,
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
    throw new AppError(`Clip record ${clipId} was not found in MongoDB.`, {
      status: 404,
      resolution: 'Create the clip again from viral detection before attempting to render it.',
    });
  }

  const video = await getVideo(videoId);
  if (!video) {
    throw new AppError(`Source video record ${videoId} was not found in MongoDB.`, {
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
  await saveClip(clip);
  await reportProgress(5);

  // Output folder mirrors the uploaded video's stored name (e.g. 001_my_recording);
  // pre-convention uploads fall back to the video id.
  const outputBase = video.fileBase || videoId;
  const outputDir = path.join(process.cwd(), 'generated-clips', outputBase);
  // Intermediate keeps the stable clip id; the FINAL file is named after the
  // clip's title: generated-clips/001_my_recording/<clip title>.mp4
  const intermediateVideoPath = path.join(outputDir, `${clipId}_processed.mp4`);
  const clipFileBase = sanitizeClipFileName(clip.title) || clipId;
  const finalVideoPath = uniqueClipPath(outputDir, clipFileBase);

  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    /**
     * Probe the SOURCE once: fps decides the composition fps (a hard-coded 30fps
     * desynced captions on 25/50/60fps sources) and hasAudio decides whether the
     * FFmpeg stage must mux in a silent track.
     */
    const sourceMeta = await getVideoMetadata(video.filePath);
    const renderFps = normalizeFps(sourceMeta.fps);
    log.detail(
      `Source ${sourceMeta.width}x${sourceMeta.height} @ ${sourceMeta.fps}fps ` +
      `(render @ ${renderFps}fps), audio=${sourceMeta.hasAudio ? 'yes' : 'no'}, ${sourceMeta.duration.toFixed(1)}s`
    );

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

    // hookDuration/ctaDuration are optional on the job payload; never pass undefined
    // into the FFmpeg/Remotion stages or the timeline maths silently breaks.
    const resolvedHookDuration = Number.isFinite(hookDuration) && (hookDuration ?? 0) >= 0
      ? (hookDuration as number)
      : 3;
    if (resolvedHookDuration > segmentDuration) {
      log.warn(
        `hookDuration (${resolvedHookDuration}s) exceeds the clip length ` +
        `(${segmentDuration.toFixed(1)}s) - clamping it to half the clip.`
      );
    }
    const safeHookDuration = Math.min(resolvedHookDuration, segmentDuration / 2);

    // Suspense hook: duplicate the gripping moment INSIDE the clip to the
    // start (the viewer sees the best beat first, then watches the clip build
    // back up to it).
    //
    // The moment comes from the VIRAL DETECTION prompt, which already returns
    // the hook line's transcript timestamps (hookLineStart/hookLineEnd) for
    // every clip. Calling a second LLM here to "re-discover" the moment was
    // pure waste (an extra ~10s + tokens per render) and could even pick a
    // DIFFERENT moment than the one the clip was packaged around - so it is
    // gone. Clips created before that data existed fall back to the first N
    // seconds.
    const hookLineStartAbs = Number.isFinite(clip.hookLineStart)
      ? (clip.hookLineStart as number)
      : undefined;
    const hookStart =
      hookLineStartAbs !== undefined
        ? Math.max(0, Math.min(hookLineStartAbs - start, Math.max(0, segmentDuration - safeHookDuration)))
        : 0;
    if (hookLineStartAbs !== undefined && hookStart > 0.05) {
      const hookLineEndAbs = Number.isFinite(clip.hookLineEnd) ? (clip.hookLineEnd as number) : hookLineStartAbs;
      log.ok(
        `Hook moment (from viral prompt): ${hookLineStartAbs.toFixed(1)}s → ${hookLineEndAbs.toFixed(1)}s` +
        (clip.hookLine ? `  ("${clip.hookLine}")` : '')
      );
    } else if (safeHookDuration > 0) {
      log.detail('No hook line timestamps on this clip - duplicating the first N seconds.');
    }

    log.step('Step 1/3 · Face tracking + active speaker detection');
    const layout: ClipLayout = jobData.layout === 'split-screen' ? 'split-screen' : 'speaker-focus';
    clip.layout = layout;

    let plan: LayoutPlan;
    try {
      const asd = await detectSpeakerTimeline(
        video.filePath,
        start,
        segmentDuration,
        sourceMeta.width,
        sourceMeta.height,
        { hasAudio: sourceMeta.hasAudio }
      );
      plan = buildLayoutPlan(asd, layout, sourceMeta.width, sourceMeta.height);
      if (asd.tracks.length === 0) {
        log.warn('No faces detected in the clip - using a static centred 9:16 crop.');
      }
    } catch (error) {
      // Defensive: if ASD cannot run at all (no ffmpeg frames, bad audio...),
      // fall back to the legacy single-track smart crop so the render still works.
      log.warn(`Speaker detection failed (${toErrorMessage(error)}) - using the legacy face track.`);
      const legacy = await detectFaceTrack(
        video.filePath,
        start,
        segmentDuration,
        sourceMeta.width,
        sourceMeta.height
      );
      plan = {
        ...buildSinglePlan(
          { tracks: [], speakerSegments: [], speakerCount: 0, method: 'skin+audio', hasLandmarks: false, hasAudio: false, maxFacesSeen: 0, framesUsed: 0, framesTotal: 0, sampleFps: 0, voicedRatio: 0 },
          sourceMeta.width,
          sourceMeta.height,
          0.5
        ),
        // Legacy behaviour: X pans along the tracked face, Y stays centred.
        points: legacy.points.map((pt) => ({ t: pt.t, x: pt.x, y: sourceMeta.height / 2 })),
        cropW: legacy.cropW,
        cropH: legacy.cropH,
        faceAnchorY: 0.5,
      };
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
    await saveClip(clip);
    await reportProgress(20);

    log.step(
      `Step 2/3 · FFmpeg mirror + ${plan.mode === 'split' ? `split-screen (${plan.cells.length})` : 'speaker crop'} + colour + hook intro`
    );
    await processVideoSegment({
      sourceVideoPath: video.filePath,
      outputPath: intermediateVideoPath,
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
      onProgress: (progress) => {
        // ffmpeg stage owns 20% -> 80% of the overall bar.
        const scaled = 20 + Math.max(0, Math.min(80, progress)) * 0.75;
        clip.progress = Math.round(scaled);
        // Deliberately not awaited: this fires many times per second and the DB write
        // must never slow the encode down. Errors are logged, not thrown.
        void saveClip(clip).catch((error) =>
          log.warn('progress save failed: ' + toErrorMessage(error))
        );
        void reportProgress(scaled);
      },
    });

    await reportProgress(80);

    const preset = await getCaptionPreset(captionPresetId);
    if (!preset) {
      throw new AppError(`Caption preset ${captionPresetId} was not found.`, {
        status: 404,
        resolution: 'Select an existing caption preset from the dashboard and retry rendering.',
      });
    }

    // Caption engine: explicit job payload wins, then the persisted clip
    // choice, then the (slow but smoothest) Remotion default.
    const engine: CaptionEngine = (captionEngine ?? clip.captionEngine ?? 'remotion') === 'native'
      ? 'native'
      : 'remotion';

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
    const hookStyle = await resolveOverlayStyle(
      jobData.hookStylePresetId ?? clip.hookStylePresetId,
      'hook'
    );
    const ctaStyle = await resolveOverlayStyle(
      jobData.ctaStylePresetId ?? clip.ctaStylePresetId,
      'cta'
    );

    log.step(
      `Step 3/3 · Captions & overlays  ${color.gray(`(${engine === 'native' ? 'native FFmpeg ASS burn' : 'Remotion'}, ` +
      `${clipWords.length} words, preset "${preset.name}")`)}`
    );
    const progressSink = (progress: number): void => {
      clip.progress = Math.max(clip.progress ?? 0, Math.round(progress));
      void saveClip(clip).catch((error) =>
        log.warn('progress save failed: ' + toErrorMessage(error))
      );
      void reportProgress(progress);
    };

    const renderResult: RenderCaptionsResult =
      engine === 'native'
        ? await renderNativeCaptions({
            videoPath: intermediateVideoPath,
            outputPath: finalVideoPath,
            hookText: resolvedHookText,
            hookDuration: safeHookDuration,
            hookStart,
            ctaText: resolvedCtaText,
            ctaDuration: resolvedCtaDuration,
            words: clipWords,
            preset,
            onProgress: progressSink,
          })
        : await renderCaptionsAndOverlays({
            videoPath: intermediateVideoPath,
            outputPath: finalVideoPath,
            hookText: resolvedHookText,
            hookDuration: safeHookDuration,
            hookStart,
            ctaText: resolvedCtaText,
            ctaDuration: resolvedCtaDuration,
            words: clipWords,
            preset,
            hookStyle,
            ctaStyle,
            onProgress: progressSink,
          });

    try {
      if (fs.existsSync(intermediateVideoPath)) fs.unlinkSync(intermediateVideoPath);
    } catch {
      // Ignore cleanup errors - a leftover intermediate is not worth failing a render.
    }

    clip.status = 'done';
    clip.progress = 100;
    clip.hookText = resolvedHookText;
    clip.ctaText = resolvedCtaText;
    clip.ctaDuration = resolvedCtaDuration;
    clip.captionPreset = preset;
    clip.captionEngine = engine;
    clip.hookStylePresetId = hookStyle._id;
    clip.ctaStylePresetId = ctaStyle._id;
    clip.outputPath = `/generated-clips/${outputBase}/${path.basename(finalVideoPath)}`;
    clip.outputFileSize = renderResult.fileSizeBytes;
    clip.outputFps = renderResult.fps;
    clip.error = undefined;
    await saveClip(clip);
    await reportProgress(100);

    log.ok(
      `Rendered ${color.bold(clipId)}: ${renderResult.width}x${renderResult.height} @ ` +
      `${renderResult.fps}fps, ${renderResult.durationSeconds.toFixed(2)}s, ` +
      `${(renderResult.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`
    );
    log.detail(`→ ${finalVideoPath}`);
    return clip;
  } catch (error) {
    log.error(`Render failed for ${color.bold(clipId)}: ${toErrorMessage(error)}`);
    clip.status = 'failed';
    clip.error = toErrorMessage(error);
    await saveClip(clip).catch((saveError) =>
      log.error('Could not persist the failure state: ' + toErrorMessage(saveError))
    );
    throw error;
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
