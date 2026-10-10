import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { DEFAULT_FILTER_PRESETS } from '../lib/presets';
import {
  buildProfanityAudioFilter,
  buildProfanityWindows,
  getProfanityAudioMode,
} from '../lib/profanity';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { log } from '../lib/logger';
import {
  LayoutPlan,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  buildSingleFilterParts,
  buildSplitFilterStatements,
} from './layout';

export interface OverlayFrameSequence {
  /** Short label used in FFmpeg diagnostics. */
  name: string;
  /** Image2 input pattern, e.g. `/tmp/clip/ov_%05d.png`. */
  inputPattern: string;
  /** Time on the final output timeline where frame 1 appears. */
  startAtSeconds: number;
}

export interface ProcessSegmentOptions {
  sourceVideoPath: string;
  /** Final deliverable path: crop, captions, overlays and audio are encoded in this one pass. */
  outputPath: string;
  start: number;
  end: number;
  /** Exact duration of the duplicated hook range, in seconds. */
  hookDuration: number;
  /** Start of that range relative to the selected clip start. */
  hookStart: number;
  filterPresetId: string;
  /**
   * The rendering plan built from the ASD result: either a single time-varying
   * 9:16 window following the active speaker, or an adaptive 2/3/4-person
   *  split-screen grid. Drives the final FFmpeg filter graph.
   */
  plan: LayoutPlan;
  /** Mirrored source size (expression clamping bounds). */
  sourceWidth: number;
  sourceHeight: number;
  /** Output frame rate (CFR). */
  targetFps: number;
  /** True when ffprobe rates show VFR; branches are normalized before hook concat. */
  sourceIsVariableFrameRate?: boolean;
  /** Input video's ffprobe start_time, used to interpret preserved probe PTS. */
  videoStartTimeSeconds?: number;
  /** Audio stream start time relative to the video stream, seconds. */
  audioStartOffsetSeconds?: number;
  /** False when the source has no audio stream -> a silent track is muxed in. */
  sourceHasAudio: boolean;
  /** Transparent PNG overlays composited before the final H.264 encode. */
  overlays?: OverlayFrameSequence[];
  /**
   * NATIVE caption engine only: an ASS file burned straight onto the composed
   * video (below the PNG overlays) with libass. The native engine cannot
   * rasterize transparent caption PNGs - libass never writes the alpha
   * channel and the transparent `color` canvas comes out opaque on FFmpeg 7 -
   * so the captions ride the video itself instead.
   */
  assFilePath?: string;
  /** Original segment-relative words, used only for render-time profanity audio handling. */
  words?: Array<{ word: string; start: number; end: number }>;
  /** Keep a pre-caption/pre-overlay debug encode when SAVE_PRECAPTION_DEBUG=1. */
  debugOutputPath?: string;
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

const VIDEO_PRESETS = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium',
  'slow', 'slower', 'veryslow', 'placebo',
]);

/** Final-output H.264 settings. Invalid env values fall back to quality-first defaults. */
export function getVideoEncodeSettings(
  env: Record<string, string | undefined> = process.env
): { crf: number; preset: string } {
  const rawCrf = Number(env.VIDEO_CRF?.trim());
  const crf = Number.isFinite(rawCrf) && rawCrf >= 16 && rawCrf <= 18
    ? Math.round(rawCrf)
    : 17;
  const rawPreset = env.VIDEO_PRESET?.trim().toLowerCase();
  const preset = rawPreset && VIDEO_PRESETS.has(rawPreset) ? rawPreset : 'slow';
  return { crf, preset };
}

/** Pure overlay filter builder shared by both caption engines and unit tests. */
export function buildVfrNormalizationFilters(targetFps: number): string[] {
  return [`fps=fps=${ffmpegFpsArg(normalizeFps(targetFps))}:round=near`, 'setpts=PTS-STARTPTS'];
}

export function buildAudioTimestampReset(audioStartOffsetSeconds = 0): string {
  const offset = Number.isFinite(audioStartOffsetSeconds) ? audioStartOffsetSeconds : 0;
  const shift = Math.abs(offset) < 0.000001 ? '' : `${offset >= 0 ? '+' : ''}${offset.toFixed(6)}/TB`;
  // Rebase to the video clock, then let libswresample insert/drop leading
  // samples as needed so every concat segment begins at PTS 0.
  return `asetpts=PTS-STARTPTS${shift},aresample=async=1000:first_pts=0`;
}

export function buildOverlayFilterStatements(
  overlays: OverlayFrameSequence[],
  inputIndices: number[],
  baseLabel = 'vbase'
): string[] {
  if (overlays.length !== inputIndices.length) {
    throw new Error(`Overlay input mismatch: ${overlays.length} sequences, ${inputIndices.length} input indices.`);
  }
  let lastVideoLabel = baseLabel;
  const statements: string[] = [];
  overlays.forEach((overlay, index) => {
    const input = inputIndices[index];
    const overlayLabel = `overlay${index}`;
    const outputLabel = index === overlays.length - 1 ? 'v' : `vcomp${index}`;
    const start = Math.max(0, overlay.startAtSeconds);
    statements.push(
      start > 0
        ? `[${input}:v]setpts=PTS+${start.toFixed(4)}/TB,format=rgba[${overlayLabel}]`
        : `[${input}:v]format=rgba[${overlayLabel}]`
    );
    statements.push(
      `[${lastVideoLabel}][${overlayLabel}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0:shortest=0[${outputLabel}]`
    );
    lastVideoLabel = outputLabel;
  });
  if (overlays.length === 0) statements.push(`[${baseLabel}]null[v]`);
  return statements;
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
export function computeSeekPhase(firstFramePts: number, requestedTime: number, videoStartTime = 0): number {
  const offset = firstFramePts - (requestedTime + videoStartTime);
  // A VFR source can have a longer-than-average frame interval, so do not cap
  // this at 1 / nominal-fps. A grossly different PTS means the probe was rebased.
  return Number.isFinite(offset) && offset >= 0 && offset < 1 ? offset : 0;
}

export async function probeFirstFrameOffset(
  sourceVideoPath: string,
  seekTo: number,
  videoStartTime = 0
): Promise<number> {
  try {
    const { stderr } = await runFfmpeg(
      [
        '-hide_banner',
        '-nostats',
        '-copyts',
        '-accurate_seek',
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
    const firstFramePts = match ? Number(match[1]) : Number.NaN;
    return computeSeekPhase(firstFramePts, seekTo, videoStartTime);
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
    sourceIsVariableFrameRate = false,
    videoStartTimeSeconds = 0,
    audioStartOffsetSeconds = 0,
    sourceHasAudio,
    overlays = [],
    assFilePath,
    words = [],
    debugOutputPath,
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
  // The output canvas is ALWAYS 1080x1920; both layout modes tile it exactly
  // before the final H.264 output pass.
  const outWidth = OUTPUT_WIDTH;
  const outHeight = OUTPUT_HEIGHT;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // The hook intro replays the complete detected interval, so duration/offset
  // must fit inside the selected base segment. Do not silently clamp either one:
  // that would create a partial hook while the timestamp response looked correct.
  const actualHookDur = Number.isFinite(hookDuration) ? Math.max(0, hookDuration) : 0;
  const hookEnabled = actualHookDur > 0;
  const requestedHookOffset = Number.isFinite(hookStart) ? hookStart : 0;
  const hookOffset = hookEnabled ? Math.max(0, requestedHookOffset) : 0;
  const HOOK_WINDOW_EPSILON_SECONDS = 0.001;
  if (
    hookEnabled &&
    (requestedHookOffset < -HOOK_WINDOW_EPSILON_SECONDS ||
      hookOffset + actualHookDur > segmentDuration + HOOK_WINDOW_EPSILON_SECONDS)
  ) {
    throw new AppError('The complete detected hook interval does not fit inside the selected clip window.', {
      status: 400,
      details:
        `hook=${hookOffset.toFixed(3)}s-${(hookOffset + actualHookDur).toFixed(3)}s, ` +
        `clip=0.000s-${segmentDuration.toFixed(3)}s`,
      resolution:
        'Adjust the clip start/end so the complete hook timestamp interval is inside the selected clip, then render again.',
    });
  }
  // Dip-to-black at the join (see HOOK_TRANSITION_SECONDS): the last half second of
  // the hook fades to black (+ silence), the first half second of the clip fades in.
  const fadeDur = Math.min(HOOK_TRANSITION_SECONDS, actualHookDur / 2);
  const fadeSt = Math.max(0, actualHookDur - fadeDur);
  const totalDuration = segmentDuration + (hookEnabled ? actualHookDur : 0);

  // Captions, hook and CTA are transparent PNG overlays composited below; the
  // deliverable therefore sees exactly ONE H.264 generation, straight from the
  // source frames. Defaults target high quality without forcing placebo-speed
  // encoding; VIDEO_CRF (16-18) and VIDEO_PRESET can be tuned in .env.local.
  const encodeSettings = getVideoEncodeSettings();
  const videoArgs = [
    '-c:v', 'libx264',
    '-preset', encodeSettings.preset,
    '-crf', String(encodeSettings.crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', ffmpegFpsArg(fps),
    // FFmpeg 7 removed the old -vsync alias; -fps_mode is supported since 5.1.
    '-fps_mode', 'cfr',
    '-movflags', '+faststart',
    '-flags', '+global_header',
  ];
  const audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];

  // `-ss` before `-i` seeks by timestamp; pair it with `-t` (duration), NOT `-to`
  // (ffmpeg warns that "-to and -t are mutually exclusive and -to takes precedence"
  // and the meaning of `-to` after an input seek is version-dependent).
  // The hook intro is a SECOND, independent seek into the same source: no hook-extract
  // encode, and no frames buffered while the clip waits for its turn in the concat.
  // Each cut is snapped to the first frame at/after the requested time (see
  // probeFirstFrameOffset). The clip then begins at most one frame later than asked.
  const [mainPhase, hookPhase] = await Promise.all([
    probeFirstFrameOffset(sourceVideoPath, start, videoStartTimeSeconds),
    hookEnabled
      ? probeFirstFrameOffset(sourceVideoPath, start + hookOffset, videoStartTimeSeconds)
      : Promise.resolve(0),
  ]);
  const snap = (time: number, phase: number): string =>
    Math.max(0, time + phase - SEEK_GUARD_SECONDS).toFixed(4);

    // Native-engine captions are burned through a RELATIVE path: libass would
    // otherwise need filter-graph escaping for OS-specific absolute paths
    // (Windows drive letters and backslashes). The composite runs with the ASS
    // file's directory as its cwd; every other path in the command is absolute,
    // so nothing else resolves differently.
    const assFileName = assFilePath ? path.basename(assFilePath) : undefined;
    const assWorkDir = assFilePath ? path.dirname(assFilePath) : undefined;

    const inputArgs: string[] = [];
    let nextInput = 0;
    const hookInput = hookEnabled ? nextInput++ : -1;
  if (hookEnabled) {
    inputArgs.push('-accurate_seek', '-ss', snap(start + hookOffset, hookPhase), '-t', actualHookDur.toFixed(6), '-i', sourceVideoPath);
  }
  const mainInput = nextInput++;
  inputArgs.push('-accurate_seek', '-ss', snap(start, mainPhase), '-t', segmentDuration.toFixed(3), '-i', sourceVideoPath);

  const overlayInputIndices: number[] = [];
  for (const overlay of overlays) {
    overlayInputIndices.push(nextInput++);
    inputArgs.push(
      '-framerate', ffmpegFpsArg(fps),
      '-start_number', '1',
      '-i', overlay.inputPattern
    );
  }

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
        if (sourceIsVariableFrameRate) parts.push(...buildVfrNormalizationFilters(fps));
        statements.push(`[${input}:v]${parts.join(',')}[${label}]`);
      } else {
        const splitOutput = sourceIsVariableFrameRate ? `${prefix}vfrraw` : label;
        statements.push(
          ...buildSplitFilterStatements(plan, sourceWidth, sourceHeight, colorFilterStr, {
            input: `${input}:v`,
            output: splitOutput,
            prefix,
            timeOffset,
            windowSeconds,
          })
        );
        if (sourceIsVariableFrameRate) {
          statements.push(`[${splitOutput}]${buildVfrNormalizationFilters(fps).join(',')}[${label}]`);
        }
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
        statements.push(
          `[${input}:a]${buildAudioTimestampReset(audioStartOffsetSeconds)},` +
          `aformat=channel_layouts=stereo${suffix}[${label}]`
        );
      } else {
        statements.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds.toFixed(3)}${suffix}[${label}]`);
      }
    };

    // Audio profanity handling is part of the same output graph. It must not
    // trigger a later audio-only remux (or alter the video encode a second time).
    const profanityWindows = sourceHasAudio
      ? buildProfanityWindows(words, hookOffset, actualHookDur, segmentDuration)
      : [];
    const profanityMode = getProfanityAudioMode();
    const audioPlan = sourceHasAudio
      ? buildProfanityAudioFilter(profanityWindows, profanityMode, totalDuration, nextInput, 'a')
      : null;

    if (hookEnabled) {
      videoBranch(hookInput, 'h_', 'hv', hookOffset, actualHookDur);
      statements.push(`[hv]fade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)},format=yuv420p[v0]`);
      videoBranch(mainInput, 'b_', 'bv', 0);
      statements.push(`[bv]fade=t=in:st=0:d=${fadeDur.toFixed(3)}[v1]`);
      // A dip - not a crossfade - keeps the total duration EXACTLY hook + clip, so the
      // caption timeline (which assumes that sum) stays in sync.
      statements.push('[v0][v1]concat=n=2:v=1:a=0[vbase]');
      // afade out reaches 0 gain exactly at the join and afade in starts from 0, so both
      // sides are fully silent across the whole dip - no floating audio under the black.
      audioBranch(hookInput, 'a0', actualHookDur, `afade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)}`);
      audioBranch(mainInput, 'a1', segmentDuration, `afade=t=in:st=0:d=${fadeDur.toFixed(3)}`);
      statements.push('[a0][a1]concat=n=2:v=0:a=1[a]');
    } else {
      videoBranch(mainInput, 'b_', 'vbase', 0);
      audioBranch(mainInput, 'a', segmentDuration, '');
    }

    if (audioPlan) statements.push(...audioPlan.filters);

    // A diagnostic output and the final video both need the pre-overlay base.
    // Split pads explicitly rather than consuming one labeled pad twice (which
    // FFmpeg rejects). Audio is split the same way after profanity processing.
    let overlayBaseLabel = debugOutputPath ? 'vforoverlay' : 'vbase';
    const debugVideoLabel = debugOutputPath ? '[vprecap]' : '';
    if (debugOutputPath) statements.push('[vbase]split=2[vprecap][vforoverlay]');
    if (assFileName) {
      // Native-engine captions: burned onto the (opaque) video below the PNG
      // overlays - see assFilePath on the options for why not as PNGs.
      statements.push(`[${overlayBaseLabel}]ass=${assFileName}[vcaptioned]`);
      overlayBaseLabel = 'vcaptioned';
    }
    statements.push(...buildOverlayFilterStatements(overlays, overlayInputIndices, overlayBaseLabel));

    const sourceAudioLabel = audioPlan?.audioLabel ?? '[a]';
    const debugAudioLabel = debugOutputPath ? '[adebug]' : '';
    const finalAudioLabel = debugOutputPath ? '[afinal]' : sourceAudioLabel;
    if (debugOutputPath) statements.push(`${sourceAudioLabel}asplit=2[adebug][afinal]`);

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-stats',
      ...inputArgs,
      ...(audioPlan?.extraArgs ?? []),
      '-filter_complex', statements.join(';'),
    ];

    // Optional diagnostic output is a side branch from the SAME filter graph.
    // The deliverable below is still encoded once from the original sources;
    // this extra file exists only when SAVE_PRECAPTION_DEBUG=1 is requested.
    if (debugOutputPath) {
      args.push(
        '-map', debugVideoLabel,
        '-map', debugAudioLabel,
        ...videoArgs,
        ...audioArgs,
        debugOutputPath
      );
    }
    args.push(
      '-map', '[v]',
      '-map', finalAudioLabel,
      ...videoArgs,
      ...audioArgs,
      outputPath
    );

    await runFfmpeg(args, {
      label: 'trim+mirror+crop+color+overlays+encode',
      ...(assWorkDir ? { cwd: assWorkDir } : {}),
      totalDurationSeconds: totalDuration,
      isCancelled,
      onProgress: (progress) => {
        if (onProgress && progress.percent) onProgress(10 + Math.floor(progress.percent * 0.68));
      },
    });

    assertUsableFile(outputPath, 'final rendered clip');
    if (debugOutputPath) assertUsableFile(debugOutputPath, 'pre-caption debug clip');

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
