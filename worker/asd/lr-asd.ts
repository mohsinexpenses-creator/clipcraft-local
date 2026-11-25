import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { toErrorMessage } from '../../lib/errors';
import { log } from '../../lib/logger';
import { computeMfcc, mfccForVideoFrame } from './mfcc';

/**
 * LR-ASD - audio-visual active speaker detection (Liao et al., IJCV 2025).
 *
 * `worker/asd/speaker.ts` decides the speaker from cheap, explainable cues
 * (voice-gated motion, energy, prominence, continuity). Those cues are excellent
 * when one person is clearly talking and blind when two people BOTH move with the
 * audio - a listener nodding, or two similar faces in a split screen. LR-ASD
 * settles exactly those windows: it looks at each face's mouth AND listens to the
 * shared audio, which no single-frame cue can do.
 *
 * License: the code AND the released weights are MIT
 * (https://github.com/Junhua-Liao/LR-ASD, license vendored at
 * docs/licenses/LR-ASD-LICENSE.txt). The ONNX graphs are produced once by
 * `scripts/export-asd-onnx.py` (`npm run setup:asd`) - this app never runs Python.
 *
 * COST CONTROL (mandatory - the target machine is a GTX 1070 / CPU):
 *   - it runs ONLY on windows where the cheap fusion is AMBIGUOUS,
 *   - only for the at-most-two people in contention,
 *   - with a global window budget and a hard per-window frame cap,
 *   - and it is skipped entirely when the model or the audio is missing.
 *
 * PREPROCESSING (matches the reference `Columbia_test.py` / `dataLoader.py`):
 *   - 13-coefficient MFCC at 16 kHz, winlen 0.025 s, winstep 0.010 s (100
 *     frames/second => 4 per video frame at 25 fps);
 *   - 112x112 grayscale crops at 25 fps from a square of
 *     `0.7 * max(w, h)` centred on the face and shifted DOWN by `0.2 * max(w, h)`,
 *     padded with 110;
 *   - normalisation happens inside the exported graph: (x / 255 - 0.4161) / 0.1688.
 *
 * Scores come out as the raw class-1 logit per frame (what the reference's
 * `lossAV.forward(..., labels=None)` yields): > 0 means speaking.
 */

function projectRequire(): NodeJS.Require {
  if (typeof __filename === 'string' && __filename.startsWith(process.cwd())) {
    return createRequire(__filename);
  }
  return createRequire(path.join(process.cwd(), 'noop.js'));
}
const nodeRequire = projectRequire();

export const LR_ASD_FRONTEND_RELPATH = path.join('models', 'lr-asd', 'lr-asd-frontend.onnx');
export const LR_ASD_BACKEND_RELPATH = path.join('models', 'lr-asd', 'lr-asd-backend.onnx');

/** The reference pipeline's video frame rate for the model itself. */
export const LR_ASD_FPS = 25;
/** 4 MFCC frames per 25 fps video frame. */
const MFCC_PER_FRAME = 4;
/** Crop geometry from the reference `crop_video`. */
export const LR_ASD_CROP_SIZE = 112;
const CROP_SIDE_FACTOR = 0.7;
const CROP_DOWN_SHIFT = 0.2;
const CROP_PAD = 110;
/** Recurrent-backend ensembling windows (the reference `durationSet`). */
const BACKEND_WINDOWS_SEC = [1, 2, 3, 4, 5, 6];
/** Smoothing half-width, matching the reference visualisation (±2 frames). */
const SMOOTH_FRAMES = 2;

type OrtTensor = {
  data: Float32Array | BigInt64Array | Int32Array | Uint8Array;
  dims: number[];
  type: string;
};

type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
};

type OrtModule = {
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create: (path: string, options?: Record<string, unknown>) => Promise<OrtSession>;
  };
};

export interface LrAsdRuntime {
  frontend: OrtSession;
  backend: OrtSession;
}

let runtimePromise: Promise<LrAsdRuntime | null> | null = null;
let unavailableReason: string | null = null;

export function getLrAsdUnavailableReason(): string | null {
  return unavailableReason;
}

export function lrAsdModelPath(kind: 'frontend' | 'backend'): string {
  const override =
    kind === 'frontend'
      ? process.env.LR_ASD_FRONTEND_PATH?.trim()
      : process.env.LR_ASD_BACKEND_PATH?.trim();
  const relpath = kind === 'frontend' ? LR_ASD_FRONTEND_RELPATH : LR_ASD_BACKEND_RELPATH;
  return override || path.join(process.cwd(), relpath);
}

export function lrAsdModelPresent(): boolean {
  try {
    for (const kind of ['frontend', 'backend'] as const) {
      const stat = fs.statSync(lrAsdModelPath(kind));
      if (!stat.isFile() || stat.size < 100_000) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function optionalRequire(moduleName: string): unknown {
  try {
    const loaded = nodeRequire(moduleName) as { default?: unknown } | null;
    if (!loaded) return null;
    return typeof loaded === 'object' && 'default' in loaded && loaded.default
      ? loaded.default
      : loaded;
  } catch {
    return null;
  }
}

/** Load both graphs once per process. Returns null (never throws) when absent. */
export async function loadLrAsd(): Promise<LrAsdRuntime | null> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (!lrAsdModelPresent()) {
      unavailableReason =
        `LR-ASD ONNX models not found in ${path.dirname(lrAsdModelPath('frontend'))} - ` +
        'run "npm run setup:asd" to export them once';
      return null;
    }
    try {
      const ort = optionalRequire('onnxruntime-node') as OrtModule | null;
      if (!ort?.InferenceSession) {
        unavailableReason = 'onnxruntime-node is not installed';
        return null;
      }
      const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
      const [frontend, backend] = await Promise.all([
        ort.InferenceSession.create(lrAsdModelPath('frontend'), options),
        ort.InferenceSession.create(lrAsdModelPath('backend'), options),
      ]);
      if (!frontend.inputNames?.length || !backend.inputNames?.length) {
        unavailableReason = 'an LR-ASD ONNX graph exposed no inputs';
        return null;
      }
      log.ok('LR-ASD active-speaker model enabled (ambiguous windows only).');
      return { frontend, backend };
    } catch (error) {
      unavailableReason = toErrorMessage(error);
      log.warn(`LR-ASD model failed to load: ${unavailableReason}`);
      return null;
    }
  })();
  return runtimePromise;
}

// ---------------------------------------------------------------------------
// Preprocessing (pure)
// ---------------------------------------------------------------------------

/**
 * The reference crop: a SQUARE of `0.7 * max(w, h)` centred on the face centre,
 * moved DOWN by `0.2 * max(w, h)` so the mouth region dominates - the network
 * was trained on that framing, and a "nicer" head-and-shoulders crop measurably
 * changes its output.
 */
export function lrAsdCropBox(face: {
  cx: number;
  cy: number;
  w: number;
  h: number;
}): { x: number; y: number; side: number } {
  const side = CROP_SIDE_FACTOR * Math.max(face.w, face.h);
  return {
    x: face.cx - side / 2,
    y: face.cy - side / 2 + CROP_DOWN_SHIFT * Math.max(face.w, face.h),
    side,
  };
}

/**
 * Bilinear grayscale 112x112 crop of one frame, padded with 110 outside the
 * picture (the reference pads the image before cropping).
 */
export function cropFaceGray(
  frame: { data: ArrayLike<number>; width: number; height: number },
  face: { cx: number; cy: number; w: number; h: number },
): Float32Array {
  const box = lrAsdCropBox(face);
  const out = new Float32Array(LR_ASD_CROP_SIZE * LR_ASD_CROP_SIZE);
  const { width, height, data } = frame;
  const scale = LR_ASD_CROP_SIZE / Math.max(1, box.side);
  for (let oy = 0; oy < LR_ASD_CROP_SIZE; oy += 1) {
    const sy = box.y + (oy + 0.5) / scale - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const y0c = Math.min(height - 1, Math.max(0, y0));
    const y1c = Math.min(height - 1, Math.max(0, y0 + 1));
    const insideY = y0 >= 0 && y0 + 1 < height;
    for (let ox = 0; ox < LR_ASD_CROP_SIZE; ox += 1) {
      const sx = box.x + (ox + 0.5) / scale - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const x0c = Math.min(width - 1, Math.max(0, x0));
      const x1c = Math.min(width - 1, Math.max(0, x0 + 1));
      const insideX = x0 >= 0 && x0 + 1 < width;
      let value = CROP_PAD;
      if (insideX && insideY) {
        const i00 = (y0c * width + x0c) * 4;
        const i01 = (y0c * width + x1c) * 4;
        const i10 = (y1c * width + x0c) * 4;
        const i11 = (y1c * width + x1c) * 4;
        const gray = (i: number) =>
          (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        const top = gray(i00) * (1 - fx) + gray(i01) * fx;
        const bottom = gray(i10) * (1 - fx) + gray(i11) * fx;
        value = top * (1 - fy) + bottom * fy;
      }
      out[oy * LR_ASD_CROP_SIZE + ox] = value;
    }
  }
  return out;
}

/** Seconds of video the model needs for a window plus its smoothing tail. */
export function lrAsdSampleCount(seconds: number): number {
  return Math.max(1, Math.round(seconds * LR_ASD_FPS));
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export interface LrAsdSegmentInput {
  /** Clip-relative window start (seconds). */
  start: number;
  /** Window length (seconds). */
  duration: number;
  /** 16 kHz mono PCM starting at clip time 0. */
  pcm: Int16Array;
  /** Sample rate of `pcm`. */
  sampleRate: number;
  /** MFCC of `pcm`, computed ONCE per clip by the caller (it is expensive). */
  mfcc?: { features: Float32Array; frames: number };
  /** Per-contending-person sampled frames + face boxes (source pixels). */
  candidates: Array<{
    trackId: number;
    frames: Array<{ t: number; cx: number; cy: number; w: number; h: number }>;
  }>;
}

export interface LrAsdScores {
  /** Mean logit inside the window per track (> 0 = speaking). */
  byTrack: Map<number, number>;
  /** Frames actually scored per track (diagnostics/cost accounting). */
  frames: number;
}

function smooth(scores: Float32Array): number[] {
  const out: number[] = new Array(scores.length);
  for (let i = 0; i < scores.length; i += 1) {
    const from = Math.max(0, i - SMOOTH_FRAMES);
    const to = Math.min(scores.length, i + SMOOTH_FRAMES + 1);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += scores[j];
    out[i] = sum / (to - from);
  }
  return out;
}

/** One track (one sequence of crops + its audio) -> per-frame logits. */
async function scoreTrack(
  runtime: LrAsdRuntime,
  crops: Float32Array[],
  mfcc: { features: Float32Array; frames: number },
  startFrame: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const ort = optionalRequire('onnxruntime-node') as OrtModule;
  const frames = crops.length;
  const video = new Float32Array(frames * LR_ASD_CROP_SIZE * LR_ASD_CROP_SIZE);
  for (let i = 0; i < frames; i += 1) {
    video.set(crops[i], i * LR_ASD_CROP_SIZE * LR_ASD_CROP_SIZE);
  }
  const audio = new Float32Array(frames * MFCC_PER_FRAME * 13);
  for (let i = 0; i < frames; i += 1) {
    audio.set(mfccForVideoFrame(mfcc.features, mfcc.frames, startFrame + i), i * MFCC_PER_FRAME * 13);
  }

  const videoTensor = new ort.Tensor('float32', video, [1, frames, LR_ASD_CROP_SIZE, LR_ASD_CROP_SIZE]);
  const audioTensor = new ort.Tensor('float32', audio, [1, frames * MFCC_PER_FRAME, 13]);
  const frontendOut = await runtime.frontend.run({
    audio: audioTensor,
    video: videoTensor,
  });
  const embedA = frontendOut.embedA ?? Object.values(frontendOut)[0];
  const embedV = frontendOut.embedV ?? Object.values(frontendOut)[1];
  if (!embedA || !embedV) return new Array(frames).fill(0);

  const sum = new Float64Array(frames);
  let passes = 0;
  for (const seconds of BACKEND_WINDOWS_SEC) {
    const window = seconds * LR_ASD_FPS;
    for (let from = 0; from < frames; from += window) {
      if (signal?.aborted) return smooth(Float32Array.from(sum));
      const length = Math.min(window, frames - from);
      const sliceA = (embedA.data as Float32Array).slice(from * 128, (from + length) * 128);
      const sliceV = (embedV.data as Float32Array).slice(from * 128, (from + length) * 128);
      const out = await runtime.backend.run({
        embedA: new ort.Tensor('float32', Float32Array.from(sliceA), [1, length, 128]),
        embedV: new ort.Tensor('float32', Float32Array.from(sliceV), [1, length, 128]),
      });
      const scores = (out.scoresAV ?? Object.values(out)[0]).data as Float32Array;
      for (let i = 0; i < length; i += 1) sum[from + i] += scores[i] ?? 0;
    }
    passes += 1;
    if (window >= frames) break;
  }
  const avg = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) avg[i] = sum[i] / Math.max(1, passes);
  return smooth(avg);
}

/**
 * Score the contending people inside one ambiguous window.
 *
 * Returns null (caller keeps the cheap decision) when the window has no usable
 * crops, the runtime is missing, or nothing could be scored.
 */
export type FrameLookup = (
  t: number,
) =>
  | { data: ArrayLike<number>; width: number; height: number }
  | null
  | Promise<{ data: ArrayLike<number>; width: number; height: number } | null>;

export async function scoreLrAsdWindow(
  runtime: LrAsdRuntime,
  input: LrAsdSegmentInput,
  frameAt: FrameLookup,
  options: { signal?: AbortSignal; maxFrames?: number } = {},
): Promise<LrAsdScores | null> {
  const maxFrames = Math.max(8, Math.min(400, options.maxFrames ?? 100));
  const startFrame = Math.round(input.start * LR_ASD_FPS);
  // The MFCC of the whole analysed window is computed once per clip by the caller
  // (it is O(clip length)); recomputing it per ambiguous window would quietly turn
  // a cheap tie-breaker into the most expensive stage of the render.
  const mfcc = input.mfcc ?? computeMfcc(input.pcm, input.sampleRate, 0.025, 0.010);
  const byTrack = new Map<number, number>();
  let framesScored = 0;

  for (const candidate of input.candidates) {
    if (options.signal?.aborted) break;
    const frames = [...candidate.frames]
      .sort((a, b) => a.t - b.t)
      .slice(0, maxFrames);
    const crops: Float32Array[] = [];
    for (const sample of frames) {
      const image = await frameAt(sample.t);
      if (!image) {
        crops.push(new Float32Array(LR_ASD_CROP_SIZE * LR_ASD_CROP_SIZE).fill(CROP_PAD));
        continue;
      }
      crops.push(cropFaceGray(image, sample));
    }
    if (crops.length === 0) continue;
    const scores = await scoreTrack(runtime, crops, mfcc, startFrame, options.signal);
    if (scores.length === 0) continue;
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    byTrack.set(candidate.trackId, mean);
    framesScored += crops.length;
  }

  if (byTrack.size === 0) return null;
  return { byTrack, frames: framesScored };
}

/**
 * Turn the model's per-person mean logits into a likelihood in 0..1, so it can be
 * fused with the existing cues instead of replacing them.
 *
 * LR-ASD's own decision boundary is 0 (`score >= 0` = speaking), so a logistic
 * with a gentle 1.5 slope is used: it ranks the two contenders the same way the
 * model does, and keeps "just barely speaking" from becoming a confident vote.
 */
export function lrAsdLikelihood(meanLogit: number): number {
  if (!Number.isFinite(meanLogit)) return 0.5;
  const value = 1 / (1 + Math.exp(-1.5 * meanLogit));
  return Math.max(0, Math.min(1, value));
}
