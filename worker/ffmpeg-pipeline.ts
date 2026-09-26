import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { DEFAULT_FILTER_PRESETS } from '../lib/presets';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { log } from '../lib/logger';

export interface ProcessSegmentOptions {
  sourceVideoPath: string;
  outputPath: string;
  start: number;
  end: number;
  hookDuration: number;
  /** Where in the clip (seconds, relative to the clip start) the hook intro is cut from. 0 = the first N seconds (legacy behaviour). */
  hookStart: number;
  filterPresetId: string;
  cropFilter: string;
  /** Width/height of the crop window, used to size the output canvas. */
  cropWidth: number;
  cropHeight: number;
  /** fps the Remotion composition will use; the intermediate is normalised to it. */
  targetFps: number;
  /** False when the source has no audio stream -> a silent track is muxed in. */
  sourceHasAudio: boolean;
  onProgress?: (progress: number) => void;
}

/** The composition is 1080x1920; never upscale past it, never exceed it. */
const MAX_OUTPUT_WIDTH = 1080;
const MAX_OUTPUT_HEIGHT = 1920;

/** libx264 refuses odd widths/heights, and `crop` happily produces them. */
export function evenSize(value: number, minimum = 2): number {
  const rounded = Math.floor(value / 2) * 2;
  return Math.max(minimum, rounded);
}

/**
 * Snap an arbitrary source fps to a value that is both a sane composition fps and
 * well supported by encoders/players. Keeps 23.976/29.97/59.94 NTSC rates intact.
 */
export function normalizeFps(sourceFps: number): number {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return 30;

  const candidates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  let best = candidates[0];
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const delta = Math.abs(candidate - sourceFps);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }

  // Anything exotic (e.g. 12fps screen capture) falls back to 30.
  return bestDelta <= 1.5 ? best : 30;
}

/**
 * Output canvas for the processed clip: ALWAYS the full 1080x1920 composition
 * canvas. The smart crop produces a 9:16 window (full source height, e.g.
 * 606x1080 from a 16:9 source); we UPSCALE it to exactly 1080x1920 so the
 * Remotion composition is a 1:1 blit with NO black bars around the video.
 * (The old "never upscale" behaviour left the clip at 606x1080 centred on a
 * black 1080x1920 canvas - the user saw a small clip with pillarboxing.)
 */
export function computeOutputSize(cropWidth: number, cropHeight: number): { width: number; height: number } {
  /**
   * Validate BEFORE evenSize(): evenSize(0) clamps up to 2, so a 0x0 crop used to
   * produce a 2x2 output canvas instead of falling back to 1080x1920.
   */
  if (
    !Number.isFinite(cropWidth) ||
    !Number.isFinite(cropHeight) ||
    cropWidth < 16 ||
    cropHeight < 16
  ) {
    return { width: MAX_OUTPUT_WIDTH, height: MAX_OUTPUT_HEIGHT };
  }

  return { width: MAX_OUTPUT_WIDTH, height: MAX_OUTPUT_HEIGHT };
}

/**
 * The concat demuxer treats `'` specially, and Windows paths contain backslashes it
 * also interprets. Forward slashes + single-quote escaping covers both.
 */
function concatListEntry(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return `file '${normalized.replace(/'/g, "'\\''")}'`;
}

function assertUsableFile(filePath: string, step: string): void {
  if (!fs.existsSync(filePath)) {
    throw new AppError(`FFmpeg finished "${step}" without creating ${filePath}.`, {
      resolution: 'Inspect the FFmpeg command and stderr printed in the worker log, then retry.',
    });
  }

  const { size } = fs.statSync(filePath);
  if (size < 1024) {
    throw new AppError(`FFmpeg produced an empty file during "${step}".`, {
      details: `${filePath} (${size} bytes)`,
      resolution:
        'The clip window is probably too short or the crop/filter chain is invalid - check the timestamps and retry.',
    });
  }
}

export async function processVideoSegment(options: ProcessSegmentOptions): Promise<string> {
  const {
    sourceVideoPath,
    outputPath,
    start,
    end,
    hookDuration,
    hookStart,
    filterPresetId,
    cropFilter,
    cropWidth,
    cropHeight,
    targetFps,
    sourceHasAudio,
    onProgress,
  } = options;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
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
      details: `Available: ${DEFAULT_FILTER_PRESETS.map((p) => p.id).join(', ')}`,
      resolution: 'Select one of the available filter presets from the dashboard and retry.',
    });
  }

  const segmentDuration = end - start;
  const fps = normalizeFps(targetFps);
  const { width: outWidth, height: outHeight } = computeOutputSize(cropWidth, cropHeight);

  if (outWidth < 16 || outHeight < 16 || !cropFilter.trim()) {
    throw new AppError('Cannot build the FFmpeg filter chain without a valid crop window.', {
      status: 400,
      details: `crop=${cropWidth}x${cropHeight}, output=${outWidth}x${outHeight}, cropFilter="${cropFilter}"`,
      resolution:
        'The smart crop returned an unusable window - re-run the render, and check the [FaceDetector] line in the worker log.',
    });
  }

  const tempDir = path.dirname(outputPath);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const baseName = path.basename(outputPath, '.mp4');
  const processedBaseClip = path.join(tempDir, `${baseName}_base.mp4`);
  const hookIntroClip = path.join(tempDir, `${baseName}_hook_intro.mp4`);
  const concatListPath = path.join(tempDir, `${baseName}_concat.txt`);

  // Shared encoder settings. `+global_header` keeps SPS/PPS in the avcC box
  // (standard for MP4, needed by the compositor's strict MP4 parser).
  const videoArgs = [
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', String(fps),
    // FFmpeg 7 REMOVED -vsync (deprecated alias since 5.1) - the equivalent is
    // -fps_mode. ffmpeg-static bundles FFmpeg 7.x, so '-vsync cfr' died with
    // "Unrecognized option 'vsync'". (-fps_mode exists since FFmpeg 5.1.)
    '-fps_mode', 'cfr',
    '-movflags', '+faststart',
    '-fflags', '+genpts',
    '-flags', '+global_header',
  ];

  /**
   * ALL inputs must be declared before -filter_complex. When the source has no audio
   * we add an `anullsrc` input so the output always carries an AAC track - otherwise
   * the concat step and the Remotion audio track both break on a video-only file.
   */
  const inputArgs = [
    // `-ss` before `-i` seeks by timestamp; pair it with `-t` (duration), NOT `-to`.
    // ffmpeg warns that "-to and -t are mutually exclusive and -to takes precedence"
    // and the meaning of `-to` after an input seek is version-dependent.
    '-ss', start.toFixed(3),
    '-t', segmentDuration.toFixed(3),
    '-i', sourceVideoPath,
    ...(sourceHasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
  ];
  const audioInputIndex = sourceHasAudio ? '0' : '1';
  const audioArgs = ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2'];

  try {
    let colorFilterStr = filterPreset.ffmpegFilter.trim();
    if (colorFilterStr === 'null' || colorFilterStr === '') colorFilterStr = '';

    /**
     * Order matters: `hflip` runs BEFORE `crop`, so the crop coordinates must be
     * expressed in MIRRORED space. worker/face-detector.ts now samples frames with
     * `hflip` already applied, which is what makes `cropFilter` line up with the
     * subject. (Previously the detector measured un-mirrored frames, so the crop
     * window landed on the opposite side of the speaker.)
     *
     * The trailing `scale` guarantees an exact, even output size so the Remotion
     * composition never sees black bars or a resolution mismatch.
     */
    const filterParts = ['hflip', cropFilter];
    if (colorFilterStr) filterParts.push(colorFilterStr);
    filterParts.push(`scale=${outWidth}:${outHeight}:flags=lanczos`);
    filterParts.push('format=yuv420p');

    log.detail(
      `Pass 1/3 · base clip ${start}s → ${end}s ` +
      `(dur=${segmentDuration.toFixed(2)}s, fps=${fps}, out=${outWidth}x${outHeight}, audio=${sourceHasAudio ? 'source' : 'silent'})`
    );
    if (onProgress) onProgress(10);

    const pass1Args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-stats',
      ...inputArgs,
      '-vf', filterParts.join(','),
      '-map', '0:v:0',
      '-map', `${audioInputIndex}:a:0`,
      ...videoArgs,
      ...audioArgs,
      ...(sourceHasAudio ? [] : ['-shortest']),
      processedBaseClip,
    ];

    await runFfmpeg(pass1Args, {
      label: 'trim+mirror+crop+color',
      totalDurationSeconds: segmentDuration,
      onProgress: (progress) => {
        if (onProgress && progress.percent) onProgress(10 + Math.floor(progress.percent * 0.4));
      },
    });

    assertUsableFile(processedBaseClip, 'trim+mirror+crop+color');

    const actualHookDur = Math.min(Math.max(Number(hookDuration) || 0, 0), segmentDuration);

    if (actualHookDur > 0) {
      log.detail(`Pass 2/3 · extracting ${actualHookDur.toFixed(2)}s duplicated hook intro`);
      if (onProgress) onProgress(55);

      // Re-encode (not `-c copy`) so the hook intro starts on a keyframe and its
      // encoder parameters are byte-identical to the base clip -> clean concat.
      // `hookStart` is the (LLM-detected) most gripping moment of the clip; 0
      // keeps the legacy behaviour of duplicating the first N seconds.
      // Clamp: the hook window must fit inside the base clip.
      const hookOffset = Math.max(0, Math.min(Number(hookStart) || 0, actualHookDur));
      const hookExtractArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', hookOffset.toFixed(3),
        '-t', actualHookDur.toFixed(3),
        '-i', processedBaseClip,
        '-map', '0:v:0',
        '-map', '0:a:0',
        ...videoArgs,
        ...audioArgs,
        hookIntroClip,
      ];

      await runFfmpeg(hookExtractArgs, { label: 'hook-intro' });
      assertUsableFile(hookIntroClip, 'hook intro extraction');

      log.detail('Pass 3/3 · concatenating hook intro + base clip (re-encode)');
      if (onProgress) onProgress(70);

      fs.writeFileSync(
        concatListPath,
        `${concatListEntry(hookIntroClip)}\n${concatListEntry(processedBaseClip)}\n`,
        'utf-8'
      );

      // RE-ENCODE, do not stream-copy: stitching two independently encoded MP4s
      // with `-c copy` produces a file whose second segment's sample table /
      // timestamps are only good enough for ffmpeg itself. Remotion's compositor
      // (its own strict MP4 parser) then fails with "No frame found at position N"
      // for every frame after the hook segment. A fresh CFR encode guarantees one
      // clean, contiguous frame timeline. Cost: a few extra seconds.
      const concatArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        ...videoArgs,
        ...audioArgs,
        outputPath,
      ];

      await runFfmpeg(concatArgs, { label: 'concat' });
    } else {
      log.detail('Pass 2/3 · skipped (hookDuration=0) - using the base clip as the output');
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      fs.copyFileSync(processedBaseClip, outputPath);
    }

    assertUsableFile(outputPath, 'final processed clip');

    // Fail loudly here instead of handing Remotion a broken file.
    const meta = await getVideoMetadata(outputPath);
    log.ok(
      `Processed clip ready: ${meta.width}x${meta.height} @ ${meta.fps}fps, ` +
      `${meta.duration.toFixed(2)}s, audio=${meta.hasAudio ? 'yes' : 'no'}`
    );

    if (onProgress) onProgress(80);
    return outputPath;
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError('FFmpeg video processing failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the FFmpeg command in the worker log, verify the source clip exists and the crop window is inside the frame, and retry.',
    });
  } finally {
    for (const temp of [processedBaseClip, hookIntroClip, concatListPath]) {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
