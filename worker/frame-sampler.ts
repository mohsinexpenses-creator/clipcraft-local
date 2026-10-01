import fs from "fs";
import path from "path";
import { AppError } from "../lib/errors";
import { runFfmpeg } from "../lib/ffmpeg";

/**
 * Frame sampling + pan-math helpers for the 9:16 speaker layout.
 *
 * Face detection itself lives in `worker/yunet-detector.ts` (OpenCV YuNet on
 * onnxruntime-node) and the speaker decision in `worker/asd/`. This module
 * holds the detector-agnostic pieces: extracting mirrored sample frames for
 * the tracker, and the smoothing/decimation that turns per-sample face
 * centres into a camera-like pan (see `worker/layout.ts`).
 */

/** Clamp a dimension to an even integer (FFmpeg crop/scale need even sizes). */
export function evenSize(value: number, minimum = 2): number {
  return Math.max(minimum, Math.floor(value / 2) * 2);
}

/** One smoothed keyframe of the face track; t in seconds RELATIVE to the segment start. */
export interface FaceTrackPoint {
  t: number;
  /** Face centre X in MIRRORED source pixels (the crop filter works in mirrored space). */
  x: number;
  /** Face centre Y in mirrored source pixels. */
  y: number;
}

export interface SampledFrames {
  frames: string[];
  /** The fps actually used (frames are at 0, 1/fps, 2/fps, ...). */
  fps: number;
}

export async function sampleSegmentFrames(
  videoPath: string,
  start: number,
  duration: number,
  targetFps: number,
  maxFrames: number,
  tmpPrefix = "frames",
): Promise<SampledFrames> {
  const safeDuration = Math.max(0.5, duration);
  const fps = Math.max(0.5, Math.min(targetFps, maxFrames / safeDuration));

  const tempFramesDir = path.join(
    process.cwd(),
    ".tmp",
    `${tmpPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tempFramesDir, { recursive: true });

  const frameArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    start.toFixed(3),
    "-t",
    safeDuration.toFixed(3),
    "-i",
    videoPath,
    // hflip FIRST: sample exactly what the crop filter will see.
    // fps=<fps> limits the decode work - without it ffmpeg decodes every
    // frame of the segment and only -frames:v caps the output (slow).
    "-vf",
    `hflip,scale=640:-2,fps=${fps.toFixed(3)}`,
    "-frames:v",
    String(maxFrames),
    path.join(tempFramesDir, "frame_%03d.jpg"),
  ];

  await runFfmpeg(frameArgs, { label: "sample-frames" });

  const frames = fs
    .readdirSync(tempFramesDir)
    .filter((file) => file.toLowerCase().endsWith(".jpg"))
    .sort()
    .map((file) => path.join(tempFramesDir, file));

  if (frames.length === 0) {
    throw new AppError("Frame sampling produced no frames.", {
      details: `start=${start}, duration=${safeDuration}`,
      resolution:
        "Check the clip timestamps and verify FFmpeg can decode the source video.",
    });
  }

  return { frames, fps };
}

/** Remove a sampled-frames directory (caller passes the dir it sampled into). */
export function cleanupSampledFrames(tempFramesDir: string): void {
  try {
    if (fs.existsSync(tempFramesDir))
      fs.rmSync(tempFramesDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

/**
 * Remove keyframes that add no curve: the crop expression interpolates X as a
 * function of TIME, after clamping - so "collinear" here means: does b.x sit
 * within `tolerancePx` of the straight time-linear interpolation between its
 * neighbours' CLAMPED x values? A smooth pan therefore collapses to a handful
 * of keyframes; only real direction changes (speaker switches) and the clamp
 * kinks survive. Keeps first/last and applies a hard cap for safety.
 */
export function decimateTrack(
  points: FaceTrackPoint[],
  clampX?: (x: number) => number,
  tolerancePx = 0.5,
  maxPoints = 48,
): FaceTrackPoint[] {
  if (points.length <= 3 || points.length <= maxPoints) return points;
  const cx = clampX ?? ((x: number) => x);

  const kept: FaceTrackPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = kept[kept.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const xa = cx(a.x);
    const xb = cx(b.x);
    const xc = cx(c.x);
    const frac = (b.t - a.t) / Math.max(1e-6, c.t - a.t);
    const deviation = Math.abs(xb - (xa + (xc - xa) * frac));
    if (deviation > tolerancePx) kept.push(b);
  }
  kept.push(points[points.length - 1]);

  if (kept.length <= maxPoints) return kept;
  // Still too many (rapid oscillation): keep the first/last plus evenly spaced.
  const stride = Math.ceil((kept.length - 2) / (maxPoints - 2));
  const capped: FaceTrackPoint[] = [kept[0]];
  for (let i = 1; i < kept.length - 1; i += 1) {
    if (i % stride === 0) capped.push(kept[i]);
  }
  capped.push(kept[kept.length - 1]);
  return capped;
}

/**
 * Turn raw per-sample face centres into a pan:
 *   1. exponential moving average (kills per-frame jitter),
 *   2. slew limit (a "camera pan" never teleports - it moves at most
 *      MAX_PAN_PX_PER_SEC between samples).
 */
export const MAX_PAN_PX_PER_SEC = 8000;
const EMA_ALPHA = 0.9;

export function smoothTrack(
  raw: FaceTrackPoint[],
  videoWidth: number,
): FaceTrackPoint[] {
  if (raw.length === 0) return [];
  if (raw.length === 1) return raw;

  const out: FaceTrackPoint[] = [];
  let sx = raw[0].x;
  let sy = raw[0].y;

  for (let i = 0; i < raw.length; i += 1) {
    const p = raw[i];
    if (i === 0) {
      out.push(p);
      continue;
    }
    const dt = Math.max(1 / 30, p.t - raw[i - 1].t);

    // 1) EMA
    sx = EMA_ALPHA * sx + (1 - EMA_ALPHA) * p.x;
    sy = EMA_ALPHA * sy + (1 - EMA_ALPHA) * p.y;

    // 2) slew limit (max pan speed * time since last sample)
    const maxStep = Math.min(videoWidth, MAX_PAN_PX_PER_SEC * dt);
    const stepX = Math.max(-maxStep, Math.min(maxStep, sx - out[i - 1].x));
    const stepY = Math.max(-maxStep, Math.min(maxStep, sy - out[i - 1].y));
    sx = out[i - 1].x + stepX;
    sy = out[i - 1].y + stepY;

    out.push({ t: p.t, x: sx, y: sy });
  }
  return out;
}
