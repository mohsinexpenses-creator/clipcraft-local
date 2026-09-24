import fs from 'fs';
import path from 'path';
import { getCaptionPreset, getClip, getVideo, saveClip } from '../lib/db';
import { AppError, toErrorMessage } from '../lib/errors';
import { getVideoMetadata } from '../lib/ffmpeg';
import { ClipRecord, JobData } from '../lib/types';
import { detectFaceCropWindow } from './face-detector';
import { normalizeFps, processVideoSegment } from './ffmpeg-pipeline';
import { renderCaptionsAndOverlays } from './remotion-renderer';

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

  console.log(
    `[Job Processor] Starting clipId=${clipId}, videoId=${videoId} (${start}s -> ${end}s)...`
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

  const outputDir = path.join(process.cwd(), 'generated-clips', videoId);
  const intermediateVideoPath = path.join(outputDir, `${clipId}_processed.mp4`);
  const finalVideoPath = path.join(outputDir, `${clipId}.mp4`);

  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    /**
     * Probe the SOURCE once: fps decides the composition fps (a hard-coded 30fps
     * desynced captions on 25/50/60fps sources) and hasAudio decides whether the
     * FFmpeg stage must mux in a silent track.
     */
    const sourceMeta = await getVideoMetadata(video.filePath);
    const renderFps = normalizeFps(sourceMeta.fps);
    console.log(
      `[Job Processor] Source ${sourceMeta.width}x${sourceMeta.height} @ ${sourceMeta.fps}fps ` +
      `(render @ ${renderFps}fps), audio=${sourceMeta.hasAudio ? 'yes' : 'no'}, ${sourceMeta.duration.toFixed(1)}s`
    );

    const segmentDuration = Math.max(0.1, end - start);

    // hookDuration/ctaDuration are optional on the job payload; never pass undefined
    // into the FFmpeg/Remotion stages or the timeline maths silently breaks.
    const resolvedHookDuration = Number.isFinite(hookDuration) && (hookDuration ?? 0) >= 0
      ? (hookDuration as number)
      : 3;
    if (resolvedHookDuration > segmentDuration) {
      console.warn(
        `[Job Processor] hookDuration (${resolvedHookDuration}s) exceeds the clip length ` +
        `(${segmentDuration.toFixed(1)}s) - clamping it to half the clip.`
      );
    }
    const safeHookDuration = Math.min(resolvedHookDuration, segmentDuration / 2);

    console.log('[Job Processor] Step 1/3: smart crop detection...');
    const cropResult = await detectFaceCropWindow(
      video.filePath,
      start,
      segmentDuration,
      sourceMeta.width,
      sourceMeta.height
    );

    clip.cropData = {
      x: cropResult.cropX,
      y: cropResult.cropY,
      width: cropResult.cropW,
      height: cropResult.cropH,
    };
    clip.progress = 20;
    await saveClip(clip);
    await reportProgress(20);

    console.log('[Job Processor] Step 2/3: FFmpeg mirror + crop + colour + hook intro...');
    await processVideoSegment({
      sourceVideoPath: video.filePath,
      outputPath: intermediateVideoPath,
      start,
      end,
      hookDuration: safeHookDuration,
      filterPresetId: filterPreset,
      cropFilter: cropResult.cropFilter,
      cropWidth: cropResult.cropW,
      cropHeight: cropResult.cropH,
      targetFps: renderFps,
      sourceHasAudio: sourceMeta.hasAudio,
      onProgress: (progress) => {
        // ffmpeg stage owns 20% -> 80% of the overall bar.
        const scaled = 20 + Math.max(0, Math.min(80, progress)) * 0.75;
        clip.progress = Math.round(scaled);
        // Deliberately not awaited: this fires many times per second and the DB write
        // must never slow the encode down. Errors are logged, not thrown.
        void saveClip(clip).catch((error) =>
          console.warn('[Job Processor] progress save failed:', toErrorMessage(error))
        );
        void reportProgress(scaled);
      },
    });

    await reportProgress(80);

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

    const preset = await getCaptionPreset(captionPresetId);
    if (!preset) {
      throw new AppError(`Caption preset ${captionPresetId} was not found.`, {
        status: 404,
        resolution: 'Select an existing caption preset from the dashboard and retry rendering.',
      });
    }

    const resolvedHookText =
      hookText?.trim() ||
      clip.hookText?.trim() ||
      deriveOverlayText(clipWords, 8, 'WATCH THIS');
    if (!hookText?.trim() && !clip.hookText?.trim()) {
      console.warn(
        `[Job Processor] No hook text supplied - derived "${resolvedHookText}" from the transcript.`
      );
    }

    const resolvedCtaText =
      ctaText?.trim() || clip.ctaText?.trim() || deriveOverlayText(clipWords.slice(-10), 8, 'FOLLOW FOR MORE');
    if (!ctaText?.trim() && !clip.ctaText?.trim()) {
      console.warn(
        `[Job Processor] No CTA text supplied - derived "${resolvedCtaText}" from the transcript.`
      );
    }

    const resolvedCtaDuration =
      Number.isFinite(ctaDuration) && (ctaDuration ?? 0) > 0
        ? (ctaDuration as number)
        : (clip.ctaDuration ?? 2.5);

    console.log(
      `[Job Processor] Step 3/3: Remotion captions & overlays (${clipWords.length} words, preset "${preset.name}")...`
    );
    const renderResult = await renderCaptionsAndOverlays({
      videoPath: intermediateVideoPath,
      outputPath: finalVideoPath,
      hookText: resolvedHookText,
      hookDuration: safeHookDuration,
      ctaText: resolvedCtaText,
      ctaDuration: resolvedCtaDuration,
      words: clipWords,
      preset,
      onProgress: (progress) => {
        clip.progress = Math.max(clip.progress ?? 0, Math.round(progress));
        void saveClip(clip).catch((error) =>
          console.warn('[Job Processor] progress save failed:', toErrorMessage(error))
        );
        void reportProgress(progress);
      },
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
    clip.outputPath = `/generated-clips/${videoId}/${clipId}.mp4`;
    clip.outputFileSize = renderResult.fileSizeBytes;
    clip.outputFps = renderResult.fps;
    clip.error = undefined;
    await saveClip(clip);
    await reportProgress(100);

    console.log(
      `[Job Processor] Finished clip ${clipId}: ${renderResult.width}x${renderResult.height} @ ` +
      `${renderResult.fps}fps, ${renderResult.durationSeconds.toFixed(2)}s, ` +
      `${(renderResult.fileSizeBytes / 1024 / 1024).toFixed(2)} MB -> ${finalVideoPath}`
    );
    return clip;
  } catch (error) {
    console.error(`[Job Processor] Job failed for clip ${clipId}:`, error);
    clip.status = 'failed';
    clip.error = toErrorMessage(error);
    await saveClip(clip).catch((saveError) =>
      console.error('[Job Processor] Could not persist the failure state:', saveError)
    );
    throw error;
  }
}
