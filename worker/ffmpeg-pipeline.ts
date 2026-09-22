import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { DEFAULT_FILTER_PRESETS } from '../lib/presets';
import { runFfmpeg } from '../lib/ffmpeg';

export interface ProcessSegmentOptions {
  sourceVideoPath: string;
  outputPath: string;
  start: number;
  end: number;
  hookDuration: number;
  filterPresetId: string;
  cropFilter: string;
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

  if (end <= start) {
    throw new AppError('Clip end time must be greater than clip start time.', {
      status: 400,
      details: `start=${start}, end=${end}`,
      resolution: 'Pick a valid clip window before rendering.',
    });
  }

  const filterPreset = DEFAULT_FILTER_PRESETS.find((preset) => preset.id === filterPresetId);
  if (!filterPreset) {
    throw new AppError(`Unknown filter preset: ${filterPresetId}.`, {
      status: 400,
      resolution: 'Select one of the available filter presets from the dashboard and retry.',
    });
  }

  const segmentDuration = end - start;
  const tempDir = path.dirname(outputPath);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const baseName = path.basename(outputPath, '.mp4');
  const processedBaseClip = path.join(tempDir, `${baseName}_base.mp4`);
  const hookIntroClip = path.join(tempDir, `${baseName}_hook_intro.mp4`);
  const concatListPath = path.join(tempDir, `${baseName}_concat.txt`);

  try {
    let colorFilterStr = filterPreset.ffmpegFilter;
    if (colorFilterStr === 'null' || !colorFilterStr) {
      colorFilterStr = '';
    }

    const filterComplexParts = ['hflip', cropFilter];
    if (colorFilterStr) {
      filterComplexParts.push(colorFilterStr);
    }
    const videoFilterStr = filterComplexParts.join(',');

    console.log(`[FFmpeg Pipeline] Step 1: Processing base clip (${start}s to ${end}s, dur=${segmentDuration}s)...`);
    if (onProgress) onProgress(10);

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
      onProgress: (progress) => {
        if (onProgress && progress.percent) {
          onProgress(10 + Math.floor(progress.percent * 0.4));
        }
      },
    });

    const actualHookDur = Math.min(Math.max(hookDuration, 0), segmentDuration);
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

      console.log('[FFmpeg Pipeline] Step 3: Concatenating hook intro + base clip...');
      if (onProgress) onProgress(70);

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
    } else {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      fs.renameSync(processedBaseClip, outputPath);
    }

    if (!fs.existsSync(outputPath)) {
      throw new AppError('FFmpeg pipeline completed without producing the processed clip file.', {
        resolution: 'Inspect the FFmpeg logs for the trim/crop/concat steps and retry rendering.',
      });
    }

    if (onProgress) onProgress(80);
    console.log(`[FFmpeg Pipeline] Video processing complete: ${outputPath}`);
    return outputPath;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('FFmpeg video processing failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the FFmpeg pipeline logs, verify the source clip exists, and retry rendering.',
    });
  } finally {
    try {
      if (fs.existsSync(processedBaseClip)) fs.unlinkSync(processedBaseClip);
      if (fs.existsSync(hookIntroClip)) fs.unlinkSync(hookIntroClip);
      if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
