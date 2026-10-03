import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { DEFAULT_FILTER_PRESETS } from '../lib/presets';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { log } from '../lib/logger';
import {
  LayoutPlan,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  buildSingleFilterParts,
  buildSplitFilterStatements,
} from './layout';

export interface ProcessSegmentOptions {
  sourceVideoPath: string;
  outputPath: string;
  start: number;
  end: number;
  hookDuration: number;
  /** Where in the clip (seconds, relative to the clip start) the hook intro is cut from. 0 = the first N seconds (legacy behaviour). */
  hookStart: number;
  filterPresetId: string;
  /**
   * The rendering plan built from the ASD result: either a single time-varying
   * 9:16 window following the active speaker, or an adaptive 2/3/4-person
   * split-screen grid. Drives the pass-1 filter chain.
   */
  plan: LayoutPlan;
  /** Mirrored source size (expression clamping bounds). */
  sourceWidth: number;
  sourceHeight: number;
  /** fps the Remotion composition will use; the intermediate is normalised to it. */
  targetFps: number;
  /** False when the source has no audio stream -> a silent track is muxed in. */
  sourceHasAudio: boolean;
  onProgress?: (progress: number) => void;
  /** Poll for a user-requested cancel; the running FFmpeg child is killed. */
  isCancelled?: () => boolean;
}

/** The composition is 1080x1920; never upscale past it, never exceed it. */
const MAX_OUTPUT_WIDTH = 1080;
const MAX_OUTPUT_HEIGHT = 1920;

/**
 * Length (s) of the dip-to-black transition between the hook intro and the
 * base clip: the last 0.5s of the hook fades to black (+ silence) and the
 * first 0.5s of the base clip fades in from black (+ silence). The caption
 * engines (worker/remotion-renderer.ts, worker/captions-ass.ts) blank all
 * captions/overlays across this 1s window - import this constant instead of
 * re-hard-coding 0.5.
 */
export const HOOK_TRANSITION_SECONDS = 0.5;

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
 * `-r` / `-framerate` value for a normalised fps. The NTSC rates are written as the
 * exact fractions a source really has (24000/1001, not 23.976), so the output reports
 * the source's own frame rate instead of a rounded cousin of it.
 */
export function ffmpegFpsArg(fps: number): string {
  const ntsc: Array<[number, string]> = [
    [23.976, '24000/1001'],
    [29.97, '30000/1001'],
    [59.94, '60000/1001'],
  ];
  for (const [value, fraction] of ntsc) {
    if (Math.abs(fps - value) < 0.0005) return fraction;
  }
  return String(fps);
}

/**
 * How far past `seekTo` the first decoded video frame lies (0 <= x < one frame period).
 *
 * A cut at an arbitrary time almost never lands on a frame boundary: the first frame
 * of the clip sits a fraction of a frame later, while the audio starts exactly at the
 * cut. Knowing the gap lets the cut be SNAPPED to that frame, so picture and sound
 * start together (lip-sync is exact) and no frame has to be invented or duplicated to
 * fill the gap. Any failure returns 0 - the caller then just cuts where it was told to.
 */
export async function probeFirstFrameOffset(sourceVideoPath: string, seekTo: number): Promise<number> {
  try {
    const { stderr } = await runFfmpeg(
      [
        '-hide_banner',
        '-nostats',
        '-ss', Math.max(0, seekTo).toFixed(3),
        '-i', sourceVideoPath,
        '-an',
        '-sn',
        '-frames:v', '1',
        '-vf', 'showinfo',
        '-f', 'null',
        '-',
      ],
      { label: 'probe-first-frame', timeoutMs: 120_000 }
    );
    const match = stderr.match(/pts_time:\s*(-?\d+(?:\.\d+)?)/);
    const offset = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(offset) && offset >= 0 && offset < 0.25 ? offset : 0;
  } catch {
    return 0;
  }
}

/** Seek a hair BEFORE the frame so float rounding can never skip it (2 ms << one frame). */
const SEEK_GUARD_SECONDS = 0.002;

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
    plan,
    sourceWidth,
    sourceHeight,
    targetFps,
    sourceHasAudio,
    onProgress,
    isCancelled,
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
  // The output canvas is ALWAYS the full 1080x1920 composition canvas - both
  // layout modes tile it exactly, so Remotion does a 1:1 blit with no bars.
  const outWidth = OUTPUT_WIDTH;
  const outHeight = OUTPUT_HEIGHT;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // The hook intro replays a moment of the clip. Clamp: the hook window must fit
  // INSIDE the clip, i.e. the offset is bounded by clip length MINUS the hook length
  // (clamping to the hook length itself used to force every hook onto seconds 0-3
  // regardless of where the gripping moment actually was). `hookStart` is the moment
  // the clip was built around (the viral prompt's hookLineStart); 0 = the first N seconds.
  const actualHookDur = Math.min(Math.max(Number(hookDuration) || 0, 0), segmentDuration);
  const hookEnabled = actualHookDur > 0;
  const hookOffset = Math.max(0, Math.min(Number(hookStart) || 0, Math.max(0, segmentDuration - actualHookDur)));
  // Dip-to-black at the join (see HOOK_TRANSITION_SECONDS): the last half second of
  // the hook fades to black (+ silence), the first half second of the clip fades in.
  const fadeDur = Math.min(HOOK_TRANSITION_SECONDS, actualHookDur / 2);
  const fadeSt = Math.max(0, actualHookDur - fadeDur);
  const totalDuration = segmentDuration + (hookEnabled ? actualHookDur : 0);

  // QUALITY: this is an INTERMEDIATE - the caption burn encodes the footage once more -
  // so it runs at CRF 10 (`veryfast`; a temp file that is deleted after the render).
  // Everything - cut, mirror, crop, colour, hook intro, dip-to-black - happens in ONE
  // pass, so the footage is encoded exactly once before the final deliverable (it used
  // to be three times, four for the hook). Measured against a lossless render of the
  // same split graph (VMAF / PSNR, final file at CRF 18):
  //   old  CRF 14 -> 14 -> 18 (3 generations)  96.8 / 47.3 dB
  //   one generation less, CRF 14 -> 18        97.2 / 47.9 dB
  //   CRF 10 -> 18 (this)                      97.5 / 48.5 dB   (final file no bigger)
  // Lowering the FINAL crf instead buys almost nothing (CRF 16: +0.2 dB for +30% size) -
  // the loss is set by the first encode, so that is where the bits go.
  // `-r` is the source's own frame rate (the NTSC rates as exact fractions).
  const videoArgs = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '10',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', ffmpegFpsArg(fps),
    // FFmpeg 7 REMOVED -vsync (deprecated alias since 5.1) - the equivalent is
    // -fps_mode. ffmpeg-static bundles FFmpeg 7.x, so '-vsync cfr' died with
    // "Unrecognized option 'vsync'". (-fps_mode exists since FFmpeg 5.1.)
    '-fps_mode', 'cfr',
    '-movflags', '+faststart',
    '-flags', '+global_header',
  ];
  // The source's sample rate is kept (the old fixed 44.1 kHz resampled the usual
  // 48 kHz audio); 256k because the caption pass encodes it once more.
  const audioArgs = ['-c:a', 'aac', '-b:a', '256k', '-ac', '2'];

  // `-ss` before `-i` seeks by timestamp; pair it with `-t` (duration), NOT `-to`
  // (ffmpeg warns that "-to and -t are mutually exclusive and -to takes precedence"
  // and the meaning of `-to` after an input seek is version-dependent).
  // The hook intro is a SECOND, independent seek into the same source: no hook-extract
  // encode, and no frames buffered while the clip waits for its turn in the concat.
  // Each cut is snapped to the first frame at/after the requested time (see
  // probeFirstFrameOffset). The clip then begins at most one frame later than asked.
  const [mainPhase, hookPhase] = await Promise.all([
    probeFirstFrameOffset(sourceVideoPath, start),
    hookEnabled ? probeFirstFrameOffset(sourceVideoPath, start + hookOffset) : Promise.resolve(0),
  ]);
  const snap = (time: number, phase: number): string =>
    Math.max(0, time + phase - SEEK_GUARD_SECONDS).toFixed(4);

  const inputArgs: string[] = [];
  let nextInput = 0;
  const hookInput = hookEnabled ? nextInput++ : -1;
  if (hookEnabled) {
    inputArgs.push('-ss', snap(start + hookOffset, hookPhase), '-t', actualHookDur.toFixed(3), '-i', sourceVideoPath);
  }
  const mainInput = nextInput++;
  inputArgs.push('-ss', snap(start, mainPhase), '-t', segmentDuration.toFixed(3), '-i', sourceVideoPath);

  try {
    let colorFilterStr = filterPreset.ffmpegFilter.trim();
    if (colorFilterStr === 'null' || colorFilterStr === '') colorFilterStr = '';

    /**
     * Order matters: `hflip` runs BEFORE `crop`, so the crop coordinates must be
     * expressed in MIRRORED space. worker/frame-sampler.ts samples frames with
     * `hflip` already applied, which is what makes the crop expressions line up
     * with the tracked people.
     *
     * The plan decides the geometry:
     *  - single  -> one time-varying 9:16 window following the active speaker
     *  - split   -> a 2/3/4-person grid, each pane a locked crop of its person
     */
    log.detail(
      `Pass 1/1 · ${start}s → ${end}s ` +
      `(dur=${segmentDuration.toFixed(2)}s${hookEnabled ? ` + ${actualHookDur.toFixed(1)}s hook` : ''}, fps=${fps}, ` +
      `out=${outWidth}x${outHeight}, layout=${plan.mode}${plan.mode === 'split' ? ` (${plan.cells.length} cells)` : ''}, ` +
      `audio=${sourceHasAudio ? 'source' : 'silent'})`
    );
    if (onProgress) onProgress(10);

    const statements: string[] = [];
    /** One 1080x1920 video branch of the graph, from input `input`, ending in `[label]`. */
    const videoBranch = (
      input: number,
      prefix: string,
      label: string,
      timeOffset: number,
      windowSeconds?: number
    ): void => {
      if (plan.mode === 'single') {
        const parts = buildSingleFilterParts(
          plan, sourceWidth, sourceHeight, outWidth, outHeight, colorFilterStr, timeOffset, windowSeconds
        );
        statements.push(`[${input}:v]${parts.join(',')}[${label}]`);
      } else {
        statements.push(
          ...buildSplitFilterStatements(plan, sourceWidth, sourceHeight, colorFilterStr, {
            input: `${input}:v`,
            output: label,
            prefix,
            timeOffset,
            windowSeconds,
          })
        );
      }
    };
    /**
     * One audio branch. The clock restarts at 0 (as the video's does) and the layout is
     * normalised to stereo so the two segments of the concat always match. A source
     * without audio gets generated silence of exactly the segment's length - the
     * concat and the caption pass both need an audio track.
     */
    const audioBranch = (input: number, label: string, seconds: number, tail: string): void => {
      const suffix = tail ? `,${tail}` : '';
      if (sourceHasAudio) {
        statements.push(`[${input}:a]asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo${suffix}[${label}]`);
      } else {
        statements.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds.toFixed(3)}${suffix}[${label}]`);
      }
    };

    if (hookEnabled) {
      videoBranch(hookInput, 'h_', 'hv', hookOffset, actualHookDur);
      statements.push(`[hv]fade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)},format=yuv420p[v0]`);
      videoBranch(mainInput, 'b_', 'bv', 0);
      statements.push(`[bv]fade=t=in:st=0:d=${fadeDur.toFixed(3)}[v1]`);
      // A dip - not a crossfade - keeps the total duration EXACTLY hook + clip, so the
      // caption timeline (which assumes that sum) stays in sync.
      statements.push('[v0][v1]concat=n=2:v=1:a=0[v]');
      // afade out reaches 0 gain exactly at the join and afade in starts from 0, so both
      // sides are fully silent across the whole dip - no floating audio under the black.
      audioBranch(hookInput, 'a0', actualHookDur, `afade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)}`);
      audioBranch(mainInput, 'a1', segmentDuration, `afade=t=in:st=0:d=${fadeDur.toFixed(3)}`);
      statements.push('[a0][a1]concat=n=2:v=0:a=1[a]');
    } else {
      videoBranch(mainInput, 'b_', 'v', 0);
      audioBranch(mainInput, 'a', segmentDuration, '');
    }

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-stats',
      ...inputArgs,
      '-filter_complex', statements.join(';'),
      '-map', '[v]',
      '-map', '[a]',
      ...videoArgs,
      ...audioArgs,
      outputPath,
    ];

    await runFfmpeg(args, {
      label: 'trim+mirror+crop+color+hook',
      totalDurationSeconds: totalDuration,
      isCancelled,
      onProgress: (progress) => {
        if (onProgress && progress.percent) onProgress(10 + Math.floor(progress.percent * 0.68));
      },
    });

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
  }
}
