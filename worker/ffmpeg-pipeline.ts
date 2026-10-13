import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { AppError, toErrorMessage } from "../lib/errors";
import { DEFAULT_FILTER_PRESETS } from "../lib/presets";
import {
  buildProfanityAudioFilter,
  buildProfanityWindows,
  getProfanityAudioMode,
} from "../lib/profanity";
import { getFfmpegPath, getVideoMetadata, runFfmpeg } from "../lib/ffmpeg";
import { log } from "../lib/logger";
import {
  LayoutPlan,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  buildSingleFilterParts,
  buildSplitFilterStatements,
} from "./layout";
import { VisualOverlayAnimation } from "../lib/types";

export interface OverlayFrameSequence {
  /** Short label used in FFmpeg diagnostics. */
  name: string;
  /** Image2 input pattern, e.g. `/tmp/clip/ov_%05d.png`. */
  inputPattern: string;
  /** Time on the final output timeline where frame 1 appears. */
  startAtSeconds: number;
}

export interface StillVisualOverlayInput {
  id: string;
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  animation: VisualOverlayAnimation;
  border?: boolean;
  cornerRadius?: number;
}

export interface SfxCueInput {
  t: number;
  sfx: string;
  gain: number;
  filePath: string;
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
  /** Contextual still-image visual overlays composited in the same FFmpeg pass. */
  visualOverlays?: StillVisualOverlayInput[];
  /** Sound effect cues mixed on the output timeline in the same FFmpeg pass. */
  sfxCues?: SfxCueInput[];
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
 * renderer (worker/remotion-renderer.ts) blanks all captions/overlays across
 * this 1s window - import this constant instead of re-hard-coding 0.5.
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
    [23.976, "24000/1001"],
    [29.97, "30000/1001"],
    [59.94, "60000/1001"],
  ];
  for (const [value, fraction] of ntsc) {
    if (Math.abs(fps - value) < 0.0005) return fraction;
  }
  return String(fps);
}

const VIDEO_PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
  "placebo",
]);

export type VideoEncoderChoice = "x264" | "nvenc" | "qsv";

const VIDEO_ENCODERS = new Set<VideoEncoderChoice>(["x264", "nvenc", "qsv"]);

let sessionEncoderOverride: VideoEncoderChoice | null = null;

/** Final-output H.264 settings. Invalid env values fall back to quality-first defaults. */
export function getVideoEncodeSettings(
  env: Record<string, string | undefined> = process.env,
): { crf: number; preset: string } {
  const rawCrf = Number(env.VIDEO_CRF?.trim());
  const crf =
    Number.isFinite(rawCrf) && rawCrf >= 16 && rawCrf <= 18
      ? Math.round(rawCrf)
      : 17;
  const rawPreset = env.VIDEO_PRESET?.trim().toLowerCase();
  const preset = rawPreset && VIDEO_PRESETS.has(rawPreset) ? rawPreset : "medium";
  return { crf, preset };
}

export function getConfiguredVideoEncoder(
  env: Record<string, string | undefined> = process.env,
): VideoEncoderChoice {
  const raw = env.VIDEO_ENCODER?.trim().toLowerCase() as VideoEncoderChoice | undefined;
  return raw && VIDEO_ENCODERS.has(raw) ? raw : "x264";
}

export function getActiveVideoEncoder(
  env: Record<string, string | undefined> = process.env,
): VideoEncoderChoice {
  return sessionEncoderOverride ?? getConfiguredVideoEncoder(env);
}

export function setSessionVideoEncoderOverride(
  encoder: VideoEncoderChoice | null,
): void {
  sessionEncoderOverride = encoder;
}

export function buildVideoCodecArgs(
  encoder: VideoEncoderChoice,
  env: Record<string, string | undefined> = process.env,
): { encoder: VideoEncoderChoice; presetLabel: string; args: string[] } {
  if (encoder === "nvenc") {
    return {
      encoder: "nvenc",
      presetLabel: "p6",
      args: [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p6",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "19",
        "-b:v",
        "0",
        "-spatial-aq",
        "1",
        "-temporal-aq",
        "1",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
      ],
    };
  }

  if (encoder === "qsv") {
    return {
      encoder: "qsv",
      presetLabel: "slower",
      args: [
        "-c:v",
        "h264_qsv",
        "-preset",
        "slower",
        "-global_quality",
        "20",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
      ],
    };
  }

  const encodeSettings = getVideoEncodeSettings(env);
  return {
    encoder: "x264",
    presetLabel: encodeSettings.preset,
    args: [
      "-c:v",
      "libx264",
      "-preset",
      encodeSettings.preset,
      "-crf",
      String(encodeSettings.crf),
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
    ],
  };
}

export interface VideoEncoderProbeResult {
  requested: VideoEncoderChoice;
  active: VideoEncoderChoice;
  presetLabel: string;
  availableEncoders: string[];
  fallbackReason?: string;
}

function runFfmpegQuickProbe(
  ffmpegBin: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: stderr || "Timed out" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/**
 * Probe the configured FFmpeg binary (including any `Settings -> ffmpegPath` override)
 * with `-encoders` and a 1-second `lavfi` test encode. If a hardware encoder (`nvenc` or
 * `qsv`) was requested and fails the probe, logs a warning and falls back to `x264` for
 * the session.
 */
export async function probeVideoEncoder(options?: {
  ffmpegPath?: string;
  env?: Record<string, string | undefined>;
  activateForSession?: boolean;
}): Promise<VideoEncoderProbeResult> {
  const env = options?.env ?? process.env;
  const requested = getConfiguredVideoEncoder(env);
  const ffmpegBin = options?.ffmpegPath || getFfmpegPath();

  const encodersRes = await runFfmpegQuickProbe(ffmpegBin, [
    "-hide_banner",
    "-encoders",
  ]);
  const encodersText = `${encodersRes.stdout}\n${encodersRes.stderr}`;
  const availableEncoders = ["libx264", "h264_nvenc", "h264_qsv"].filter((name) =>
    new RegExp(`\\b${name}\\b`).test(encodersText),
  );

  if (requested === "x264") {
    if (options?.activateForSession !== false) {
      sessionEncoderOverride = "x264";
    }
    const { presetLabel } = buildVideoCodecArgs("x264", env);
    return {
      requested,
      active: "x264",
      presetLabel,
      availableEncoders,
    };
  }

  const ffmpegCodecName = requested === "nvenc" ? "h264_nvenc" : "h264_qsv";
  if (!availableEncoders.includes(ffmpegCodecName)) {
    const fallbackReason = `${ffmpegCodecName} is not compiled into ${ffmpegBin}`;
    if (options?.activateForSession !== false) {
      sessionEncoderOverride = "x264";
      log.warn(
        `VIDEO_ENCODER=${requested} unavailable (${fallbackReason}) — falling back to libx264.`,
      );
    }
    const { presetLabel } = buildVideoCodecArgs("x264", env);
    return {
      requested,
      active: "x264",
      presetLabel,
      availableEncoders,
      fallbackReason,
    };
  }

  const codecSpec = buildVideoCodecArgs(requested, env);
  const testRes = await runFfmpegQuickProbe(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=128x128:d=1:r=30",
    "-vf",
    "format=yuv420p",
    ...codecSpec.args,
    "-f",
    "null",
    "-",
  ]);

  if (!testRes.ok) {
    const detail = (testRes.stderr || testRes.stdout || "lavfi test encode failed")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2)
      .join(" | ");
    const fallbackReason = `1s lavfi test encode with ${ffmpegCodecName} failed (${detail})`;
    if (options?.activateForSession !== false) {
      sessionEncoderOverride = "x264";
      log.warn(
        `VIDEO_ENCODER=${requested} failed hardware test (${fallbackReason}) — falling back to libx264.`,
      );
    }
    const { presetLabel } = buildVideoCodecArgs("x264", env);
    return {
      requested,
      active: "x264",
      presetLabel,
      availableEncoders,
      fallbackReason,
    };
  }

  if (options?.activateForSession !== false) {
    sessionEncoderOverride = requested;
    log.ok(`Hardware encoder active: ${ffmpegCodecName} (${codecSpec.presetLabel})`);
  }
  return {
    requested,
    active: requested,
    presetLabel: codecSpec.presetLabel,
    availableEncoders,
  };
}

/** Pure overlay filter builder shared by the pipeline and unit tests. */
export function buildVfrNormalizationFilters(targetFps: number): string[] {
  return [
    `fps=fps=${ffmpegFpsArg(normalizeFps(targetFps))}:round=near`,
    "setpts=PTS-STARTPTS",
  ];
}

export function buildAudioTimestampReset(audioStartOffsetSeconds = 0): string {
  const offset = Number.isFinite(audioStartOffsetSeconds)
    ? audioStartOffsetSeconds
    : 0;
  const shift =
    Math.abs(offset) < 0.000001
      ? ""
      : `${offset >= 0 ? "+" : ""}${offset.toFixed(6)}/TB`;
  // Rebase to the video clock, then let libswresample insert/drop leading
  // samples as needed so every concat segment begins at PTS 0.
  return `asetpts=PTS-STARTPTS${shift},aresample=async=1000:first_pts=0`;
}

export interface SfxAudioFilterPlan {
  extraArgs: string[];
  filters: string[];
  audioLabel: string;
}

/**
 * Builds the single-pass FFmpeg audio mix for SFX cues on the output timeline:
 * - Adds each unique SFX file once as an input (`-i <filePath>`).
 * - Applies `aformat`, `volume`, and `adelay=<ms>:all=1` per cue.
 * - Mixes all SFX streams with the base speech stream via `amix=inputs=N:duration=first:dropout_transition=0:normalize=0`
 *   followed by a 0.96 headroom trim so speech + SFX never clip.
 */
export function buildSfxAudioFilterStatements(
  cues: SfxCueInput[],
  firstSfxInputIndex: number,
  baseAudioLabel = "[a]",
  totalDurationSeconds = Number.POSITIVE_INFINITY,
  outputAudioLabel = "[asfx]",
): SfxAudioFilterPlan {
  const normalizedBase = baseAudioLabel.startsWith("[")
    ? baseAudioLabel
    : `[${baseAudioLabel}]`;

  const eligible = (cues ?? []).filter(
    (cue) =>
      cue &&
      typeof cue.filePath === "string" &&
      cue.filePath.trim().length > 0 &&
      Number.isFinite(cue.t) &&
      cue.t >= 0 &&
      cue.t < totalDurationSeconds - 0.02 &&
      Number.isFinite(cue.gain) &&
      cue.gain > 0,
  );

  if (eligible.length === 0) {
    return {
      extraArgs: [],
      filters: [],
      audioLabel: normalizedBase,
    };
  }

  const inputIndexByFile = new Map<string, number>();
  const extraArgs: string[] = [];
  let nextIdx = firstSfxInputIndex;

  for (const cue of eligible) {
    if (!inputIndexByFile.has(cue.filePath)) {
      inputIndexByFile.set(cue.filePath, nextIdx++);
      extraArgs.push("-i", cue.filePath);
    }
  }

  const filters: string[] = [];
  const cueLabels: string[] = [];

  eligible.forEach((cue, cueIndex) => {
    const inputIdx = inputIndexByFile.get(cue.filePath)!;
    const delayMs = Math.max(1, Math.round(cue.t * 1000));
    const gain = Math.max(0.01, Math.min(0.65, cue.gain)).toFixed(4);
    const label = `[sfx_${cueIndex}]`;
    cueLabels.push(label);
    filters.push(
      `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gain},adelay=${delayMs}:all=1${label}`,
    );
  });

  const normalizedOut = outputAudioLabel.startsWith("[")
    ? outputAudioLabel
    : `[${outputAudioLabel}]`;
  filters.push(
    `${normalizedBase}${cueLabels.join("")}amix=inputs=${cueLabels.length + 1}:duration=first:dropout_transition=0:normalize=0,volume=0.96${normalizedOut}`,
  );

  return {
    extraArgs,
    filters,
    audioLabel: normalizedOut,
  };
}

export function buildVisualOverlayFilterStatements(
  visualOverlays: StillVisualOverlayInput[],
  visualInputIndices: number[],
  baseLabel = "vbase",
  outputFinalLabel = "vvis",
): { statements: string[]; lastLabel: string } {
  if (visualOverlays.length !== visualInputIndices.length) {
    throw new Error(
      `Visual overlay input mismatch: ${visualOverlays.length} visuals, ${visualInputIndices.length} input indices.`,
    );
  }
  if (visualOverlays.length === 0) {
    return { statements: [], lastLabel: baseLabel };
  }

  let lastVideoLabel = baseLabel;
  const statements: string[] = [];

  visualOverlays.forEach((visual, index) => {
    const input = visualInputIndices[index];
    const visLabel = `visimg${index}`;
    const outLabel =
      index === visualOverlays.length - 1 ? outputFinalLabel : `vvis${index}`;
    const w = evenSize(visual.width, 64);
    const h = evenSize(visual.height, 64);
    const showBorder = visual.border !== false;
    const borderPx = showBorder ? 4 : 0;
    const innerW = Math.max(64, w - borderPx * 2);
    const innerH = Math.max(64, h - borderPx * 2);
    const x = Math.round(visual.x);
    const y = Math.round(visual.y);
    const st = Math.max(0, visual.start);
    const en = Math.max(st + 0.3, visual.end);
    const dur = Math.max(0.3, en - st);
    const fadeInDur = Math.min(0.18, dur / 4);
    const fadeOutDur = Math.min(0.28, dur / 3);
    const fadeOutSt = Math.max(st, en - fadeOutDur);

    // Static 1.08x overscan scale + time-expression crop drift (constant output dimensions
    // on every frame so pad/fade never reconfigure mid-stream), optional thin border via pad,
    // and soft alpha fade in/out.
    const overscanW = evenSize(Math.round(innerW * 1.08), 64);
    const overscanH = evenSize(Math.round(innerH * 1.08), 64);
    const progressExpr = `min(1,max(0,(t-${st.toFixed(3)})/${dur.toFixed(3)}))`;
    const cropXExpr = `trunc((iw-${innerW})/2)`;
    const cropYExpr = `trunc((ih-${innerH})*(0.5-0.35*${progressExpr}))`;
    const borderFilter = showBorder
      ? `,pad=${w}:${h}:${borderPx}:${borderPx}:color=white@0.88`
      : "";

    statements.push(
      `[${input}:v]scale=${overscanW}:${overscanH}:force_original_aspect_ratio=increase,` +
        `crop=w=${innerW}:h=${innerH}:x='${cropXExpr}':y='${cropYExpr}'${borderFilter},format=rgba,` +
        `fade=t=in:st=${st.toFixed(3)}:d=${fadeInDur.toFixed(3)}:alpha=1,` +
        `fade=t=out:st=${fadeOutSt.toFixed(3)}:d=${fadeOutDur.toFixed(3)}:alpha=1[${visLabel}]`,
    );

    // Pop / slide-up entrance with slight spring overshoot settling onto y
    const dt = `(t-${st.toFixed(3)})`;
    let yExpr = String(y);
    if (visual.animation === "slide-up") {
      yExpr = `if(lt(${dt},0.18),${y}+44-52*${dt}/0.18,if(lt(${dt},0.26),${y}-8+8*(${dt}-0.18)/0.08,${y}))`;
    } else if (
      visual.animation === "pop" ||
      visual.animation === "subtle-zoom"
    ) {
      yExpr = `if(lt(${dt},0.14),${y}+24-30*${dt}/0.14,if(lt(${dt},0.22),${y}-6+6*(${dt}-0.14)/0.08,${y}))`;
    }

    statements.push(
      `[${lastVideoLabel}][${visLabel}]overlay=x=${x}:y='${yExpr}':format=auto:` +
        `enable='between(t,${st.toFixed(3)},${en.toFixed(3)})':eof_action=pass:shortest=0[${outLabel}]`,
    );
    lastVideoLabel = outLabel;
  });

  return { statements, lastLabel: lastVideoLabel };
}

export function buildOverlayFilterStatements(
  overlays: OverlayFrameSequence[],
  inputIndices: number[],
  baseLabel = "vbase",
  visualOverlays: StillVisualOverlayInput[] = [],
  visualInputIndices: number[] = [],
): string[] {
  if (overlays.length !== inputIndices.length) {
    throw new Error(
      `Overlay input mismatch: ${overlays.length} sequences, ${inputIndices.length} input indices.`,
    );
  }
  const statements: string[] = [];
  let lastVideoLabel = baseLabel;

  if (visualOverlays.length > 0) {
    const targetVisLabel = overlays.length === 0 ? "v" : "vvis";
    const visGraph = buildVisualOverlayFilterStatements(
      visualOverlays,
      visualInputIndices,
      baseLabel,
      targetVisLabel,
    );
    statements.push(...visGraph.statements);
    lastVideoLabel = visGraph.lastLabel;
  }

  overlays.forEach((overlay, index) => {
    const input = inputIndices[index];
    const overlayLabel = `overlay${index}`;
    const outputLabel = index === overlays.length - 1 ? "v" : `vcomp${index}`;
    const start = Math.max(0, overlay.startAtSeconds);
    statements.push(
      start > 0
        ? `[${input}:v]setpts=PTS+${start.toFixed(4)}/TB,format=rgba[${overlayLabel}]`
        : `[${input}:v]format=rgba[${overlayLabel}]`,
    );
    statements.push(
      `[${lastVideoLabel}][${overlayLabel}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0:shortest=0[${outputLabel}]`,
    );
    lastVideoLabel = outputLabel;
  });
  if (overlays.length === 0 && visualOverlays.length === 0) {
    statements.push(`[${baseLabel}]null[v]`);
  }
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
export function computeSeekPhase(
  firstFramePts: number,
  requestedTime: number,
  videoStartTime = 0,
): number {
  const offset = firstFramePts - (requestedTime + videoStartTime);
  // A VFR source can have a longer-than-average frame interval, so do not cap
  // this at 1 / nominal-fps. A grossly different PTS means the probe was rebased.
  return Number.isFinite(offset) && offset >= 0 && offset < 1 ? offset : 0;
}

export async function probeFirstFrameOffset(
  sourceVideoPath: string,
  seekTo: number,
  videoStartTime = 0,
): Promise<number> {
  try {
    const { stderr } = await runFfmpeg(
      [
        "-hide_banner",
        "-nostats",
        "-copyts",
        "-accurate_seek",
        "-ss",
        Math.max(0, seekTo).toFixed(3),
        "-i",
        sourceVideoPath,
        "-an",
        "-sn",
        "-frames:v",
        "1",
        "-vf",
        "showinfo",
        "-f",
        "null",
        "-",
      ],
      { label: "probe-first-frame", timeoutMs: 120_000 },
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
export function computeOutputSize(
  cropWidth: number,
  cropHeight: number,
): { width: number; height: number } {
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
    throw new AppError(
      `FFmpeg finished "${step}" without creating ${filePath}.`,
      {
        resolution:
          "Inspect the FFmpeg command and stderr printed in the worker log, then retry.",
      },
    );
  }

  const { size } = fs.statSync(filePath);
  if (size < 1024) {
    throw new AppError(`FFmpeg produced an empty file during "${step}".`, {
      details: `${filePath} (${size} bytes)`,
      resolution:
        "The clip window is probably too short or the crop/filter chain is invalid - check the timestamps and retry.",
    });
  }
}

export async function processVideoSegment(
  options: ProcessSegmentOptions,
): Promise<string> {
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
    visualOverlays = [],
    sfxCues = [],
    words = [],
    debugOutputPath,
    onProgress,
    isCancelled,
  } = options;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError("Clip end time must be greater than clip start time.", {
      status: 400,
      details: `start=${start}, end=${end}`,
      resolution: "Pick a valid clip window before rendering.",
    });
  }

  const filterPreset = DEFAULT_FILTER_PRESETS.find(
    (preset) => preset.id === filterPresetId,
  );
  if (!filterPreset) {
    throw new AppError(`Unknown filter preset: ${filterPresetId}.`, {
      status: 400,
      details: `Available: ${DEFAULT_FILTER_PRESETS.map((p) => p.id).join(", ")}`,
      resolution:
        "Select one of the available filter presets from the dashboard and retry.",
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
  const actualHookDur = Number.isFinite(hookDuration)
    ? Math.max(0, hookDuration)
    : 0;
  const hookEnabled = actualHookDur > 0;
  const requestedHookOffset = Number.isFinite(hookStart) ? hookStart : 0;
  const hookOffset = hookEnabled ? Math.max(0, requestedHookOffset) : 0;
  const HOOK_WINDOW_EPSILON_SECONDS = 0.001;
  if (
    hookEnabled &&
    (requestedHookOffset < -HOOK_WINDOW_EPSILON_SECONDS ||
      hookOffset + actualHookDur >
        segmentDuration + HOOK_WINDOW_EPSILON_SECONDS)
  ) {
    throw new AppError(
      "The complete detected hook interval does not fit inside the selected clip window.",
      {
        status: 400,
        details:
          `hook=${hookOffset.toFixed(3)}s-${(hookOffset + actualHookDur).toFixed(3)}s, ` +
          `clip=0.000s-${segmentDuration.toFixed(3)}s`,
        resolution:
          "Adjust the clip start/end so the complete hook timestamp interval is inside the selected clip, then render again.",
      },
    );
  }
  // Dip-to-black at the join (see HOOK_TRANSITION_SECONDS): the last half second of
  // the hook fades to black (+ silence), the first half second of the clip fades in.
  const fadeDur = Math.min(HOOK_TRANSITION_SECONDS, actualHookDur / 2);
  const fadeSt = Math.max(0, actualHookDur - fadeDur);
  const totalDuration = segmentDuration + (hookEnabled ? actualHookDur : 0);

  // Captions, hook and CTA are transparent PNG overlays composited below; the
  // deliverable therefore sees exactly ONE H.264 generation, straight from the
  // source frames. Supports x264 (default medium, CRF 16-18), nvenc, or qsv.
  const activeEncoder = getActiveVideoEncoder();
  const codecSpec = buildVideoCodecArgs(activeEncoder);
  const videoArgs = [
    ...codecSpec.args,
    "-r",
    ffmpegFpsArg(fps),
    // FFmpeg 7 removed the old -vsync alias; -fps_mode is supported since 5.1.
    "-fps_mode",
    "cfr",
    "-movflags",
    "+faststart",
    "-flags",
    "+global_header",
  ];
  const audioArgs = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];

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
      ? probeFirstFrameOffset(
          sourceVideoPath,
          start + hookOffset,
          videoStartTimeSeconds,
        )
      : Promise.resolve(0),
  ]);
  const snap = (time: number, phase: number): string =>
    Math.max(0, time + phase - SEEK_GUARD_SECONDS).toFixed(4);

  const inputArgs: string[] = [];
  let nextInput = 0;
  const hookInput = hookEnabled ? nextInput++ : -1;
  if (hookEnabled) {
    inputArgs.push(
      "-accurate_seek",
      "-ss",
      snap(start + hookOffset, hookPhase),
      "-t",
      actualHookDur.toFixed(6),
      "-i",
      sourceVideoPath,
    );
  }
  const mainInput = nextInput++;
  inputArgs.push(
    "-accurate_seek",
    "-ss",
    snap(start, mainPhase),
    "-t",
    segmentDuration.toFixed(3),
    "-i",
    sourceVideoPath,
  );

  const overlayInputIndices: number[] = [];
  for (const overlay of overlays) {
    overlayInputIndices.push(nextInput++);
    inputArgs.push(
      "-framerate",
      ffmpegFpsArg(fps),
      "-start_number",
      "1",
      "-i",
      overlay.inputPattern,
    );
  }

  const visualInputIndices: number[] = [];
  for (const visual of visualOverlays) {
    visualInputIndices.push(nextInput++);
    const loopDuration = Math.min(
      totalDuration + 0.5,
      Math.max(0.5, visual.end + 0.5),
    );
    inputArgs.push(
      "-framerate",
      ffmpegFpsArg(fps),
      "-loop",
      "1",
      "-t",
      loopDuration.toFixed(3),
      "-i",
      visual.imagePath,
    );
  }

  try {
    let colorFilterStr = filterPreset.ffmpegFilter.trim();
    if (colorFilterStr === "null" || colorFilterStr === "") colorFilterStr = "";

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
        `(dur=${segmentDuration.toFixed(2)}s${hookEnabled ? ` + ${actualHookDur.toFixed(1)}s hook` : ""}, fps=${fps}, ` +
        `out=${outWidth}x${outHeight}, layout=${plan.mode}${plan.mode === "split" ? ` (${plan.cells.length} cells)` : ""}, ` +
        `audio=${sourceHasAudio ? "source" : "silent"})`,
    );
    if (onProgress) onProgress(10);

    const statements: string[] = [];
    /** One 1080x1920 video branch of the graph, from input `input`, ending in `[label]`. */
    const videoBranch = (
      input: number,
      prefix: string,
      label: string,
      timeOffset: number,
      windowSeconds?: number,
    ): void => {
      if (plan.mode === "single") {
        const parts = buildSingleFilterParts(
          plan,
          sourceWidth,
          sourceHeight,
          outWidth,
          outHeight,
          colorFilterStr,
          timeOffset,
          windowSeconds,
        );
        if (sourceIsVariableFrameRate)
          parts.push(...buildVfrNormalizationFilters(fps));
        statements.push(`[${input}:v]${parts.join(",")}[${label}]`);
      } else {
        const splitOutput = sourceIsVariableFrameRate
          ? `${prefix}vfrraw`
          : label;
        statements.push(
          ...buildSplitFilterStatements(
            plan,
            sourceWidth,
            sourceHeight,
            colorFilterStr,
            {
              input: `${input}:v`,
              output: splitOutput,
              prefix,
              timeOffset,
              windowSeconds,
            },
          ),
        );
        if (sourceIsVariableFrameRate) {
          statements.push(
            `[${splitOutput}]${buildVfrNormalizationFilters(fps).join(",")}[${label}]`,
          );
        }
      }
    };
    /**
     * One audio branch. The clock restarts at 0 (as the video's does) and the layout is
     * normalised to stereo so the two segments of the concat always match. A source
     * without audio gets generated silence of exactly the segment's length - the
     * concat and the caption pass both need an audio track.
     */
    const audioBranch = (
      input: number,
      label: string,
      seconds: number,
      tail: string,
    ): void => {
      const suffix = tail ? `,${tail}` : "";
      if (sourceHasAudio) {
        statements.push(
          `[${input}:a]${buildAudioTimestampReset(audioStartOffsetSeconds)},` +
            `aformat=channel_layouts=stereo${suffix}[${label}]`,
        );
      } else {
        statements.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds.toFixed(3)}${suffix}[${label}]`,
        );
      }
    };

    // Audio profanity handling is part of the same output graph. It must not
    // trigger a later audio-only remux (or alter the video encode a second time).
    const profanityWindows = sourceHasAudio
      ? buildProfanityWindows(words, hookOffset, actualHookDur, segmentDuration)
      : [];
    const profanityMode = getProfanityAudioMode();
    const audioPlan = sourceHasAudio
      ? buildProfanityAudioFilter(
          profanityWindows,
          profanityMode,
          totalDuration,
          nextInput,
          "a",
        )
      : null;

    if (hookEnabled) {
      videoBranch(hookInput, "h_", "hv", hookOffset, actualHookDur);
      statements.push(
        `[hv]fade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)},format=yuv420p[v0]`,
      );
      videoBranch(mainInput, "b_", "bv", 0);
      statements.push(`[bv]fade=t=in:st=0:d=${fadeDur.toFixed(3)}[v1]`);
      // A dip - not a crossfade - keeps the total duration EXACTLY hook + clip, so the
      // caption timeline (which assumes that sum) stays in sync.
      statements.push("[v0][v1]concat=n=2:v=1:a=0[vbase]");
      // afade out reaches 0 gain exactly at the join and afade in starts from 0, so both
      // sides are fully silent across the whole dip - no floating audio under the black.
      audioBranch(
        hookInput,
        "a0",
        actualHookDur,
        `afade=t=out:st=${fadeSt.toFixed(3)}:d=${fadeDur.toFixed(3)}`,
      );
      audioBranch(
        mainInput,
        "a1",
        segmentDuration,
        `afade=t=in:st=0:d=${fadeDur.toFixed(3)}`,
      );
      statements.push("[a0][a1]concat=n=2:v=0:a=1[a]");
    } else {
      videoBranch(mainInput, "b_", "vbase", 0);
      audioBranch(mainInput, "a", segmentDuration, "");
    }

    if (audioPlan) {
      statements.push(...audioPlan.filters);
      if (audioPlan.extraArgs.length > 0) {
        nextInput += 1;
      }
    }

    const postProfanityAudioLabel = audioPlan?.audioLabel ?? "[a]";
    const sfxPlan = buildSfxAudioFilterStatements(
      sfxCues,
      nextInput,
      postProfanityAudioLabel,
      totalDuration,
      "[asfx]",
    );
    if (sfxPlan.filters.length > 0) {
      statements.push(...sfxPlan.filters);
    }

    // A diagnostic output and the final video both need the pre-overlay base.
    // Split pads explicitly rather than consuming one labeled pad twice (which
    // FFmpeg rejects). Audio is split the same way after profanity processing.
    const overlayBaseLabel = debugOutputPath ? "vforoverlay" : "vbase";
    const debugVideoLabel = debugOutputPath ? "[vprecap]" : "";
    if (debugOutputPath)
      statements.push("[vbase]split=2[vprecap][vforoverlay]");
    statements.push(
      ...buildOverlayFilterStatements(
        overlays,
        overlayInputIndices,
        overlayBaseLabel,
        visualOverlays,
        visualInputIndices,
      ),
    );

    const sourceAudioLabel = sfxPlan.audioLabel;
    const debugAudioLabel = debugOutputPath ? "[adebug]" : "";
    const finalAudioLabel = debugOutputPath ? "[afinal]" : sourceAudioLabel;
    if (debugOutputPath)
      statements.push(`${sourceAudioLabel}asplit=2[adebug][afinal]`);

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-stats",
      ...inputArgs,
      ...(audioPlan?.extraArgs ?? []),
      ...sfxPlan.extraArgs,
      "-filter_complex",
      statements.join(";"),
    ];

    // Optional diagnostic output is a side branch from the SAME filter graph.
    // The deliverable below is still encoded once from the original sources;
    // this extra file exists only when SAVE_PRECAPTION_DEBUG=1 is requested.
    if (debugOutputPath) {
      args.push(
        "-map",
        debugVideoLabel,
        "-map",
        debugAudioLabel,
        ...videoArgs,
        ...audioArgs,
        debugOutputPath,
      );
    }
    args.push(
      "-map",
      "[v]",
      "-map",
      finalAudioLabel,
      ...videoArgs,
      ...audioArgs,
      outputPath,
    );

    await runFfmpeg(args, {
      label: "trim+mirror+crop+color+overlays+encode",
      totalDurationSeconds: totalDuration,
      isCancelled,
      onProgress: (progress) => {
        if (onProgress && progress.percent)
          onProgress(10 + Math.floor(progress.percent * 0.68));
      },
    });

    assertUsableFile(outputPath, "final rendered clip");
    if (debugOutputPath)
      assertUsableFile(debugOutputPath, "pre-caption debug clip");

    const meta = await getVideoMetadata(outputPath);
    log.ok(
      `Processed clip ready: ${meta.width}x${meta.height} @ ${meta.fps}fps, ` +
        `${meta.duration.toFixed(2)}s, audio=${meta.hasAudio ? "yes" : "no"}`,
    );

    if (onProgress) onProgress(80);
    return outputPath;
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError("FFmpeg video processing failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the FFmpeg command in the worker log, verify the source clip exists and the crop window is inside the frame, and retry.",
    });
  }
}
