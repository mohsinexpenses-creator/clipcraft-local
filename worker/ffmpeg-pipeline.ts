import fs from 'fs';
import path from 'path';
import { runFfmpeg, getVideoMetadata } from '../lib/ffmpeg';
import { DEFAULT_FILTER_PRESETS } from '../lib/presets';

export interface ProcessSegmentOptions {
  sourceVideoPath: string;
  outputPath: string;
  start: number;
  end: number;
  hookDuration: number; // e.g. 3 seconds
  filterPresetId: string;
  cropFilter: string; // e.g. "crop=607:1080:656:0"
  onProgress?: (progress: number) => void;
}

export async function processVideoSegment(options: ProcessSegmentOptions): Promise<string> {
  const {
    sourceVideoPath,
    outputPath,
    start,
    end,
    hookDuration,
    filterPresetId,
    cropFilter,
    onProgress,
  } = options;

  const segmentDuration = end - start;
  const tempDir = path.dirname(outputPath);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const baseName = path.basename(outputPath, '.mp4');
  const processedBaseClip = path.join(tempDir, `${baseName}_base.mp4`);
  const hookIntroClip = path.join(tempDir, `${baseName}_hook_intro.mp4`);

  // 1. Find color filter string
  const filterPreset = DEFAULT_FILTER_PRESETS.find((p) => p.id === filterPresetId) || DEFAULT_FILTER_PRESETS[0];
  let colorFilterStr = filterPreset.ffmpegFilter;
  if (colorFilterStr === 'null' || !colorFilterStr) {
    colorFilterStr = '';
  }

  // Combine filters: hflip -> smart crop -> color filter
  const filterComplexParts = ['hflip', cropFilter];
  if (colorFilterStr) {
    filterComplexParts.push(colorFilterStr);
  }
  const videoFilterStr = filterComplexParts.join(',');

  console.log(`[FFmpeg Pipeline] Step 1: Processing base clip (${start}s to ${end}s, dur=${segmentDuration}s)...`);
  if (onProgress) onProgress(10);

  // Pass 1: Trim, hflip, smart crop, color filter
  const pass1Args = [
    '-y',
    '-ss', start.toString(),
    '-to', end.toString(),
    '-i', sourceVideoPath,
    '-vf', videoFilterStr,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '128k',
    processedBaseClip,
  ];

  await runFfmpeg(pass1Args, {
    totalDurationSeconds: segmentDuration,
    onProgress: (p) => {
      if (onProgress && p.percent) {
        onProgress(10 + Math.floor(p.percent * 0.4)); // 10% -> 50%
      }
    },
  });

  // Step 2 & 3: Duplicate Hook Intro if hookDuration > 0
  const actualHookDur = Math.min(hookDuration, segmentDuration);
  if (actualHookDur > 0) {
    console.log(`[FFmpeg Pipeline] Step 2: Extracting ${actualHookDur}s duplicated hook intro...`);
    if (onProgress) onProgress(55);

    const hookExtractArgs = [
      '-y',
      '-ss', '0',
      '-t', actualHookDur.toString(),
      '-i', processedBaseClip,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      hookIntroClip,
    ];

    await runFfmpeg(hookExtractArgs);

    console.log(`[FFmpeg Pipeline] Step 3: Concatenating hook intro + base clip...`);
    if (onProgress) onProgress(70);

    // Create concat list file
    const concatListPath = path.join(tempDir, `${baseName}_concat.txt`);
    const concatContent = `file '${hookIntroClip}'\nfile '${processedBaseClip}'\n`;
    fs.writeFileSync(concatListPath, concatContent, 'utf-8');

    const concatArgs = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath,
    ];

    await runFfmpeg(concatArgs);

    // Clean up temporary segment clips
    try {
      if (fs.existsSync(processedBaseClip)) fs.unlinkSync(processedBaseClip);
      if (fs.existsSync(hookIntroClip)) fs.unlinkSync(hookIntroClip);
      if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
    } catch (e) {
      // ignore
    }
  } else {
    // If no hook duration, rename base processed clip to outputPath
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(processedBaseClip, outputPath);
  }

  if (onProgress) onProgress(80);
  console.log(`[FFmpeg Pipeline] Video processing complete: ${outputPath}`);
  return outputPath;
}
