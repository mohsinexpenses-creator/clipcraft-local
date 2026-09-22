import fs from 'fs';
import path from 'path';
import { getCaptionPreset, getClip, getVideo, saveClip } from '../lib/db';
import { AppError, toErrorMessage } from '../lib/errors';
import { ClipRecord, JobData } from '../lib/types';
import { detectFaceCropWindow } from './face-detector';
import { processVideoSegment } from './ffmpeg-pipeline';
import { renderCaptionsAndOverlays } from './remotion-renderer';

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

  console.log(`[Job Processor] Starting job for clipId=${clipId}, videoId=${videoId} (${start}s -> ${end}s)...`);

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

  try {
    const outputDir = path.join(process.cwd(), 'generated-clips', videoId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const intermediateVideoPath = path.join(outputDir, `${clipId}_processed.mp4`);
    const finalVideoPath = path.join(outputDir, `${clipId}.mp4`);

    console.log('[Job Processor] Step 1: Running smart face crop detection...');
    if (onProgress) onProgress(10);

    const segmentDuration = end - start;
    const cropResult = await detectFaceCropWindow(
      video.filePath,
      start,
      segmentDuration,
      video.width,
      video.height
    );

    clip.cropData = {
      x: cropResult.cropX,
      y: cropResult.cropY,
      width: cropResult.cropW,
      height: cropResult.cropH,
    };
    clip.progress = 20;
    await saveClip(clip);

    console.log('[Job Processor] Step 2: Running FFmpeg processing chain...');
    await processVideoSegment({
      sourceVideoPath: video.filePath,
      outputPath: intermediateVideoPath,
      start,
      end,
      hookDuration,
      filterPresetId: filterPreset,
      cropFilter: cropResult.cropFilter,
      onProgress: (progress) => {
        clip.progress = progress;
        saveClip(clip);
        if (onProgress) onProgress(progress);
      },
    });

    const allWords = video.transcript?.words || [];
    const clipWords = allWords
      .filter((word) => word.start >= start - 0.5 && word.end <= end + 0.5)
      .map((word) => ({
        ...word,
        start: Math.max(0, word.start - start),
        end: Math.max(0.1, word.end - start),
      }));

    if (clipWords.length === 0) {
      throw new AppError('No transcript words were found for this clip window.', {
        status: 400,
        resolution:
          'Re-run transcription or choose a segment that overlaps spoken audio before rendering.',
      });
    }

    const preset = await getCaptionPreset(captionPresetId);
    if (!preset) {
      throw new AppError(`Caption preset ${captionPresetId} was not found.`, {
        status: 404,
        resolution: 'Select an existing caption preset from the dashboard and retry rendering.',
      });
    }

    const resolvedHookText = hookText?.trim() || clip.hookText?.trim();
    if (!resolvedHookText) {
      throw new AppError('Clip rendering cannot continue because hook text is empty.', {
        status: 400,
        resolution: 'Generate the clip again from AI analysis or enter a manual hook text before rendering.',
      });
    }

    const resolvedCtaText = ctaText?.trim() || clip.ctaText?.trim();
    if (!resolvedCtaText) {
      throw new AppError('Clip rendering cannot continue because CTA text is empty.', {
        status: 400,
        resolution: 'Regenerate the clip CTA or enter a manual CTA before rendering.',
      });
    }

    console.log('[Job Processor] Step 3: Rendering captions & overlays...');
    await renderCaptionsAndOverlays({
      videoPath: intermediateVideoPath,
      outputPath: finalVideoPath,
      hookText: resolvedHookText,
      hookDuration,
      ctaText: resolvedCtaText,
      ctaDuration: ctaDuration ?? clip.ctaDuration ?? 2.5,
      words: clipWords,
      preset,
      onProgress: (progress) => {
        clip.progress = progress;
        saveClip(clip);
        if (onProgress) onProgress(progress);
      },
    });

    try {
      if (fs.existsSync(intermediateVideoPath)) {
        fs.unlinkSync(intermediateVideoPath);
      }
    } catch {
      // Ignore cleanup errors.
    }

    clip.status = 'done';
    clip.progress = 100;
    clip.hookText = resolvedHookText;
    clip.ctaText = resolvedCtaText;
    clip.ctaDuration = ctaDuration ?? clip.ctaDuration ?? 2.5;
    clip.outputPath = `/generated-clips/${videoId}/${clipId}.mp4`;
    clip.error = undefined;
    await saveClip(clip);

    console.log(`[Job Processor] Successfully finished clip ${clipId} -> ${finalVideoPath}`);
    return clip;
  } catch (error) {
    console.error(`[Job Processor] Job failed for clip ${clipId}:`, error);
    clip.status = 'failed';
    clip.error = toErrorMessage(error);
    await saveClip(clip);
    throw error;
  }
}
