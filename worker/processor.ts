import path from 'path';
import fs from 'fs';
import { JobData, ClipRecord } from '../lib/types';
import { getClip, saveClip, getVideo, getCaptionPreset } from '../lib/db';
import { detectFaceCropWindow } from './face-detector';
import { processVideoSegment } from './ffmpeg-pipeline';
import { renderCaptionsAndOverlays } from './remotion-renderer';
import { DEFAULT_CAPTION_PRESETS } from '../lib/presets';

export async function processClipJob(
  jobData: JobData,
  onProgress?: (progress: number) => void
): Promise<ClipRecord> {
  const { clipId, videoId, start, end, hookDuration, hookText, filterPreset, captionPresetId } = jobData;

  console.log(`[Job Processor] Starting job for clipId=${clipId}, videoId=${videoId} (${start}s -> ${end}s)...`);

  const clip = await getClip(clipId);
  if (!clip) {
    throw new Error(`Clip record ${clipId} not found in database.`);
  }

  const video = await getVideo(videoId);
  if (!video || !fs.existsSync(video.filePath)) {
    throw new Error(`Source video ${videoId} or file missing at ${video?.filePath}.`);
  }

  clip.status = 'processing';
  clip.progress = 5;
  await saveClip(clip);

  try {
    const outputDir = path.join(process.cwd(), 'generated-clips', videoId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const intermediateVideoPath = path.join(outputDir, `${clipId}_processed.mp4`);
    const finalVideoPath = path.join(outputDir, `${clipId}.mp4`);

    // 1. Detect Smart Crop window using face detection
    console.log('[Job Processor] Step 1: Running smart face crop detection...');
    if (onProgress) onProgress(10);

    const segmentDuration = end - start;
    const cropResult = await detectFaceCropWindow(
      video.filePath,
      start,
      segmentDuration,
      video.width || 1920,
      video.height || 1080
    );

    clip.cropData = {
      x: cropResult.cropX,
      y: cropResult.cropY,
      width: cropResult.cropW,
      height: cropResult.cropH,
    };
    clip.progress = 20;
    await saveClip(clip);

    // 2. FFmpeg Pipeline: Trim, hflip, smart crop, color filter, duplicate hook intro
    console.log('[Job Processor] Step 2: Running FFmpeg processing chain...');
    await processVideoSegment({
      sourceVideoPath: video.filePath,
      outputPath: intermediateVideoPath,
      start,
      end,
      hookDuration,
      filterPresetId: filterPreset || 'vibrant',
      cropFilter: cropResult.cropFilter,
      onProgress: (p) => {
        clip.progress = p;
        saveClip(clip);
        if (onProgress) onProgress(p);
      },
    });

    // 3. Prepare transcript words for clip segment
    const allWords = video.transcript?.words || [];
    const clipWords = allWords
      .filter((w) => w.start >= start - 0.5 && w.end <= end + 0.5)
      .map((w) => ({
        ...w,
        start: Math.max(0, w.start - start),
        end: Math.max(0.1, w.end - start),
      }));

    // 4. Fetch caption preset
    const preset = (await getCaptionPreset(captionPresetId)) || DEFAULT_CAPTION_PRESETS[0];

    // 5. Render Captions & Hook Overlay
    console.log('[Job Processor] Step 3: Rendering captions & overlays...');
    await renderCaptionsAndOverlays({
      videoPath: intermediateVideoPath,
      outputPath: finalVideoPath,
      hookText: hookText || clip.hookText || 'WATCH THIS FIRST',
      hookDuration,
      words: clipWords,
      preset,
      onProgress: (p) => {
        clip.progress = p;
        saveClip(clip);
        if (onProgress) onProgress(p);
      },
    });

    // Clean up intermediate file
    try {
      if (fs.existsSync(intermediateVideoPath)) {
        fs.unlinkSync(intermediateVideoPath);
      }
    } catch (e) {
      // ignore
    }

    // 6. Complete job
    clip.status = 'done';
    clip.progress = 100;
    clip.outputPath = `/generated-clips/${videoId}/${clipId}.mp4`;
    await saveClip(clip);

    console.log(`[Job Processor] Successfully finished clip ${clipId} -> ${finalVideoPath}`);
    return clip;
  } catch (err: any) {
    console.error(`[Job Processor] Job failed for clip ${clipId}:`, err);
    clip.status = 'failed';
    clip.error = err.message || String(err);
    await saveClip(clip);
    throw err;
  }
}
