import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { toErrorMessage } from "../lib/errors";
import { log } from "../lib/logger";

/**
 * Person (body) detection with YOLOX-nano on onnxruntime-node - the safety net
 * for the one failure the face detector cannot survive: a person who TURNS AWAY,
 * looks down at notes, or holds a hand/mic across their face for a second.
 *
 * License: YOLOX is Apache-2.0 (Megvii-BaseDetection/YOLOX), deliberately NOT
 * Ultralytics YOLOv8 (AGPL-3.0), so a local app can ship it. Weights come from
 * the official Megvii release and are downloaded by `npm run setup:yolox`
 * (scripts/setup-yolox.mjs) into `models/yolox/` - never committed.
 *
 * COST MODEL (this is the whole point):
 *   - the model runs ONLY on a sampled frame in which a tracked face was LOST,
 *   - and only at `PERSON_DETECT_MAX_FPS` (default 3) on those gap frames,
 *   - with a hard per-window budget,
 *   - and only for the person class.
 * A normal clip with visible faces never loads it at all.
 *
 * WHAT IT MAY DO: extend an EXISTING track through the gap (the body is still on
 * screen where the face was), so the identity, the camera lock and the speaker
 * continuity survive. It can never create a track: a body-only frame cannot add a
 * person, inflate the person count, or add a split-screen pane.
 *
 * Everything except `loadYolox`/`detectPersonsYolox` is pure logic, so the gap
 * trigger and the track extension are unit-tested without the weights.
 */

function projectRequire(): NodeJS.Require {
  if (typeof __filename === "string" && __filename.startsWith(process.cwd())) {
    return createRequire(__filename);
  }
  return createRequire(path.join(process.cwd(), "noop.js"));
}
const nodeRequire = projectRequire();

export const YOLOX_MODEL_RELPATH = path.join("models", "yolox", "yolox_nano.onnx");

/**
 * Official Megvii release asset (`YOLOX` 0.1.1rc0). Megvii does not publish a
 * digest, so the setup script verifies the exact byte size and reports the
 * SHA-256 it computed; a local file can be pinned with YOLOX_ONNX_SHA256.
 */
export const YOLOX_MODEL_BYTES = 3_659_407;

/** YOLOX's exported ONNX expects a 32-multiple letterboxed square. */
const YOLOX_DEFAULT_INPUT_SIZE = 416;
/** YOLOX's own demo pads with this grey. */
const YOLOX_PAD_VALUE = 114;
/** COCO class 0 is "person". */
const PERSON_CLASS_INDEX = 0;
const CONF_THRESHOLD = 0.35;
const NMS_IOU_THRESHOLD = 0.45;
/** A person box smaller than this fraction of the frame is not worth a hold. */
const MIN_PERSON_FRACTION = 0.04;

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
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: number[],
  ) => OrtTensor;
  InferenceSession: {
    create: (
      path: string,
      options?: Record<string, unknown>,
    ) => Promise<OrtSession>;
  };
};

export interface PersonBox {
  /** Frame-space top-left corner + size (the caller's pixel space). */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface YoloxRuntime {
  session: OrtSession;
  inputName: string;
  /** Letterbox side length the model declares (416 by default). */
  inputSize: number;
}

export interface RawFrameLike {
  data: Buffer | Uint8Array;
  width: number;
  height: number;
}

/**
 * Loaded sessions, keyed by the resolved model path so a changed
 * `YOLOX_MODEL_PATH` (tests, or an operator pointing at another copy) is honoured
 * instead of silently reusing the previous graph.
 */
const runtimeCache = new Map<string, Promise<YoloxRuntime | null>>();
let unavailableReason: string | null = null;
let warnedOnce = false;

export function getYoloxUnavailableReason(): string | null {
  return unavailableReason;
}

export function yoloxModelPath(): string {
  return (
    process.env.YOLOX_MODEL_PATH?.trim() ||
    path.join(process.cwd(), YOLOX_MODEL_RELPATH)
  );
}

export function yoloxModelPresent(): boolean {
  try {
    const stat = fs.statSync(yoloxModelPath());
    // No size gate: the loader below validates the graph itself (input signature
    // and a single decoded output), which is the check that actually matters - a
    // size floor would only reject a legitimately pruned or test graph.
    return stat.isFile() && stat.size > 1024;
  } catch {
    return false;
  }
}

function optionalRequire(moduleName: string): unknown {
  try {
    const loaded = nodeRequire(moduleName) as { default?: unknown } | null;
    if (!loaded) return null;
    return typeof loaded === "object" && "default" in loaded && loaded.default
      ? loaded.default
      : loaded;
  } catch {
    return null;
  }
}

function configuredInputSize(): number {
  const configured = Number(process.env.YOLOX_INPUT_SIZE?.trim());
  if (Number.isFinite(configured) && configured >= 128 && configured <= 1024) {
    return Math.round(configured / 32) * 32;
  }
  return YOLOX_DEFAULT_INPUT_SIZE;
}

/** What the loaded session says its input is, when onnxruntime exposes it. */
function declaredInputSize(session: OrtSession & {
  inputMetadata?: Array<{ dimensions?: number[]; dims?: number[] }>;
}): number | null {
  const meta = session.inputMetadata?.[0];
  const dims = meta?.dimensions ?? meta?.dims;
  if (!dims || dims.length !== 4) return null;
  const height = dims[2];
  const width = dims[3];
  if (!Number.isFinite(height) || !Number.isFinite(width)) return null;
  // Square, static models only; anything else falls back to the configured size.
  if (height <= 0 || width <= 0 || height !== width) return null;
  return height;
}

/**
 * Load the YOLOX session once per process. Returns null (never throws) when the
 * model or onnxruntime is missing - the caller then keeps today's behaviour.
 */
export async function loadYolox(): Promise<YoloxRuntime | null> {
  const modelPath = yoloxModelPath();
  const cached = runtimeCache.get(modelPath);
  if (cached) return cached;

  const pending = (async () => {
    if (!yoloxModelPresent()) {
      unavailableReason =
        `YOLOX model not found at ${modelPath} - run "npm run setup:yolox" to enable ` +
        "person detection for turned-away faces";
      return null;
    }

    try {
      const ort = optionalRequire("onnxruntime-node") as OrtModule | null;
      if (!ort?.InferenceSession) {
        unavailableReason = "onnxruntime-node is not installed";
        return null;
      }

      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
      if (!session.inputNames?.length || !session.outputNames?.length) {
        unavailableReason = "the YOLOX ONNX session exposed no inputs/outputs";
        return null;
      }

      const inputSize = declaredInputSize(session as never) ?? configuredInputSize();
      // A YOLOX export (the official one included) has ONE decoded output. Yunet,
      // LR-ASD and friends have several: refusing them here is what keeps a wrong
      // file from being read as a row of "people".
      if (session.outputNames.length !== 1) {
        unavailableReason =
          `the model at ${modelPath} has ${session.outputNames.length} outputs - ` +
          'expected the decoded single-output YOLOX export';
        log.warn(`Person detection disabled: ${unavailableReason}`);
        return null;
      }
      log.ok(
        `YOLOX person detection enabled (yolox_nano.onnx @ ${inputSize}px) - used ONLY for frames where a tracked face is lost.`,
      );
      return { session, inputName: session.inputNames[0], inputSize };
    } catch (error) {
      unavailableReason = toErrorMessage(error);
      log.warn(`YOLOX model failed to load: ${unavailableReason}`);
      return null;
    }
  })();

  runtimeCache.set(modelPath, pending);
  return pending;
}

/** Bilinear sample positions along one axis (pixel-centre mapping). */
function axisTable(
  scale: number,
  offset: number,
  outLen: number,
  srcLen: number,
): { i0: Int32Array; i1: Int32Array; f: Float32Array } {
  const i0 = new Int32Array(outLen);
  const i1 = new Int32Array(outLen);
  const f = new Float32Array(outLen);
  for (let o = 0; o < outLen; o += 1) {
    const s = (o + 0.5 - offset) / scale - 0.5;
    const base = Math.floor(s);
    i0[o] = Math.min(srcLen - 1, Math.max(0, base));
    i1[o] = Math.min(srcLen - 1, i0[o] + 1);
    f[o] = s - base;
  }
  return { i0, i1, f };
}

/**
 * YOLOX letterbox: uniform scale (aspect preserved) onto a square canvas, centred,
 * padded with grey 114, RGB, raw 0-255 values - exactly what YOLOX's official
 * demo feeds the exported model (it does NOT divide by 255).
 */
export function buildLetterboxBlob(
  frame: RawFrameLike,
  size: number,
): { blob: Float32Array; scale: number; padX: number; padY: number } {
  const plane = size * size;
  const blob = new Float32Array(3 * plane).fill(YOLOX_PAD_VALUE);
  const scale = Math.min(size / frame.width, size / frame.height);
  const scaledW = Math.max(1, Math.round(frame.width * scale));
  const scaledH = Math.max(1, Math.round(frame.height * scale));
  const padX = Math.floor((size - scaledW) / 2);
  const padY = Math.floor((size - scaledH) / 2);
  const xs = axisTable(scale, 0, scaledW, frame.width);
  const ys = axisTable(scale, 0, scaledH, frame.height);

  for (let y = 0; y < scaledH; y += 1) {
    const rowTop = ys.i0[y] * frame.width * 4;
    const rowBot = ys.i1[y] * frame.width * 4;
    const fy = ys.f[y];
    let dst = (y + padY) * size + padX;
    for (let x = 0; x < scaledW; x += 1) {
      const x0 = xs.i0[x] * 4;
      const x1 = xs.i1[x] * 4;
      const fx = xs.f[x];
      for (let c = 0; c < 3; c += 1) {
        const top =
          frame.data[rowTop + x0 + c] * (1 - fx) +
          frame.data[rowTop + x1 + c] * fx;
        const bottom =
          frame.data[rowBot + x0 + c] * (1 - fx) +
          frame.data[rowBot + x1 + c] * fx;
        blob[c * plane + dst] = top * (1 - fy) + bottom * fy;
      }
      dst += 1;
    }
  }
  return { blob, scale, padX, padY };
}

function intersection(a: PersonBox, b: PersonBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function iou(a: PersonBox, b: PersonBox): number {
  const inter = intersection(a, b);
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/**
 * Decode a YOLOX ONNX output `(1, N, 5 + numClasses)` in LETTERBOXED pixel space
 * into frame-space person boxes.
 *
 * The official export runs `decode_in_inference=True`, so every row already is
 * `[cx, cy, w, h, obj, cls...]` in input-image pixels - no grid/stride maths here.
 * A row's person score is `obj * cls[0]`, the same product YOLOX's demo uses.
 */
export function decodeYoloxPersons(
  output: ArrayLike<number>,
  shape: readonly number[],
  letterbox: { scale: number; padX: number; padY: number },
  options: { confThreshold?: number; minWidthFraction?: number; frameWidth?: number } = {},
): PersonBox[] {
  // Anchors are filtered before the heads are concatenated, so the export's row
  // count is a THRESHOLD and must never be trusted for indexing: the real amount
  // of data is the buffer length. (Trusting the declared dims on a graph that
  // reports a different row count reads past the end of the tensor and invents
  // detections - observed, and the reason this is length-driven.)
  const rows = shape.length >= 3 ? shape[1] : Math.floor(output.length / 85);
  const cols = shape.length >= 2 ? shape[shape.length - 1] : 85;
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || cols < 6) return [];
  const stride = cols;
  const usable = Math.floor(output.length / stride);
  if (usable < rows) return [];

  const conf = options.confThreshold ?? CONF_THRESHOLD;
  const minWidth = (options.minWidthFraction ?? MIN_PERSON_FRACTION) * (options.frameWidth ?? 0);
  const candidates: PersonBox[] = [];

  for (let r = 0; r < usable; r += 1) {
    const base = r * stride;
    const objectness = output[base + 4];
    if (!(objectness > 0)) continue;
    const score = objectness * output[base + 5 + PERSON_CLASS_INDEX];
    if (!(score >= conf)) continue;

    // Undo the letterbox: model pixels -> frame pixels.
    const cx = (output[base] - letterbox.padX) / letterbox.scale;
    const cy = (output[base + 1] - letterbox.padY) / letterbox.scale;
    const w = output[base + 2] / letterbox.scale;
    const h = output[base + 3] / letterbox.scale;
    if (!Number.isFinite(cx) || !Number.isFinite(w) || w <= 0 || h <= 0) continue;
    if (minWidth > 0 && w < minWidth) continue;
    candidates.push({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept: PersonBox[] = [];
  for (const candidate of candidates) {
    if (kept.some((existing) => iou(existing, candidate) > NMS_IOU_THRESHOLD)) continue;
    kept.push(candidate);
  }
  return kept;
}

/** Detect PERSON bodies in one frame. Returns [] (never throws) on any doubt. */
export async function detectPersonsYolox(
  runtime: YoloxRuntime,
  frame: RawFrameLike,
  options: { confThreshold?: number } = {},
): Promise<PersonBox[]> {
  const ort = optionalRequire("onnxruntime-node") as OrtModule | null;
  if (!ort?.Tensor) return [];
  const size = runtime.inputSize;
  if (frame.width < 16 || frame.height < 16) return [];

  const letterbox = buildLetterboxBlob(frame, size);
  const tensor = new ort.Tensor("float32", letterbox.blob, [1, 3, size, size]);
  let outputs: Record<string, OrtTensor>;
  try {
    outputs = await runtime.session.run({ [runtime.inputName]: tensor });
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true;
      log.warn(
        `YOLOX inference failed (person detection disabled for this run): ${toErrorMessage(error)}`,
      );
    }
    unavailableReason = toErrorMessage(error);
    return [];
  }

  // Decoded single-tensor export only. Anything else is a model we do not know
  // how to read, and guessing would silently invent people.
  const names = runtime.session.outputNames ?? Object.keys(outputs);
  if (names.length !== 1) {
    if (!warnedOnce) {
      warnedOnce = true;
      log.warn(
        `YOLOX model exposes ${names.length} outputs - expected the decoded single-output export; person detection stays off.`,
      );
    }
    unavailableReason = "not a decoded single-output YOLOX export";
    return [];
  }
  const output = outputs[names[0]] ?? Object.values(outputs)[0];
  if (!output) return [];

  return decodeYoloxPersons(
    output.data as Float32Array,
    output.dims ?? [],
    letterbox,
    { confThreshold: options.confThreshold, frameWidth: frame.width },
  );
}

// ---------------------------------------------------------------------------
// Gap trigger (pure)
// ---------------------------------------------------------------------------

export interface PersonDetectorSettings {
  /** Person detection is on by default; `PERSON_DETECTION=0` turns it off. */
  enabled: boolean;
  /** Max gap-frame samples per second (default 3). */
  maxFps: number;
  /** Max gap frames per analysis window (default 60). */
  maxFrames: number;
  /** How long a body box may keep a lost face track alive (default 4 s). */
  holdSeconds: number;
  /** Body score gate (default 0.35). */
  confThreshold: number;
}

function disabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getPersonDetectorSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersonDetectorSettings {
  const fps = Number(env.PERSON_DETECT_MAX_FPS?.trim());
  const frames = Number(env.PERSON_DETECT_MAX_FRAMES?.trim());
  const hold = Number(env.PERSON_TRACK_HOLD_SECONDS?.trim());
  const conf = Number(env.YOLOX_CONF_THRESHOLD?.trim());
  return {
    enabled: !disabled(env.PERSON_DETECTION),
    maxFps: Number.isFinite(fps) ? clamp(fps, 0.5, 8) : 3,
    maxFrames: Number.isFinite(frames) ? Math.floor(clamp(frames, 0, 600)) : 60,
    holdSeconds: Number.isFinite(hold) ? clamp(hold, 0.5, 15) : 4,
    confThreshold: Number.isFinite(conf) ? clamp(conf, 0.05, 0.95) : CONF_THRESHOLD,
  };
}

export interface GapTriggerInput {
  /** Clip-relative time of this sampled frame. */
  t: number;
  /** Faces the face detector found in this frame. */
  facesFound: number;
  /** Tracks that are still alive (visible or in their grace period). */
  openTracks: number;
  /** When the person detector last ran in this window, or null. */
  lastRunAt: number | null;
  /** Max runs per second on gap frames. */
  maxFps: number;
  /** Runs already spent in this window. */
  framesUsed: number;
  /** Hard cap for this window. */
  maxFrames: number;
  /** Set when the model/runtime is unavailable or the user disabled it. */
  enabled: boolean;
}

/**
 * Run the body detector on THIS frame only when a face that was being tracked is
 * missing from it - not on empty scenes, not on frames where every track already
 * has a face, and never faster than `maxFps` or past the window budget.
 */
export function shouldRunPersonDetectorForGap(input: GapTriggerInput): boolean {
  if (!input.enabled) return false;
  if (input.facesFound >= input.openTracks) return false;
  if (input.openTracks <= 0) return false;
  if (input.framesUsed >= input.maxFrames) return false;
  const interval = 1 / Math.max(0.5, input.maxFps);
  if (input.lastRunAt !== null && input.t - input.lastRunAt < interval - 1e-6) {
    return false;
  }
  return true;
}

/** The area of a body box where this person's face must be (upper body). */
export function personBoxToFaceEstimate(box: PersonBox): {
  cx: number;
  cy: number;
  w: number;
  h: number;
} {
  const faceH = Math.max(8, box.height * 0.3);
  const faceW = Math.max(8, faceH * 0.8);
  return {
    cx: box.x + box.width / 2,
    cy: box.y + faceH * 0.55,
    w: faceW,
    h: faceH,
  };
}

/** Only what the matcher needs from a track (keeps the module pure/testable). */
export interface LostTrackHint {
  id: number;
  cx: number;
  cy: number;
  w: number;
  vx: number;
  vy: number;
  lastT: number;
}

export interface PersonHoldMatch {
  trackId: number;
  box: PersonBox;
  face: { cx: number; cy: number; w: number; h: number };
  /** Normalised distance between the predicted face and the body's face area. */
  cost: number;
}

/**
 * Match body boxes to tracks whose face is missing RIGHT NOW.
 *
 * A body box continues a track when the person's estimated face area contains (or
 * nearly contains) the face position predicted from the track's own velocity. One
 * body can serve only one track, and one track only one body - so a two-person
 * shot can never have both people held by a single detected body.
 */
export function matchPersonsToLostTracks(
  tracks: LostTrackHint[],
  boxes: PersonBox[],
  t: number,
  options: { toleranceFactor?: number } = {},
): PersonHoldMatch[] {
  const tolerance = options.toleranceFactor ?? 0.75;
  type Pair = { trackId: number; box: PersonBox; face: PersonHoldMatch["face"]; cost: number };
  const pairs: Pair[] = [];

  for (const track of tracks) {
    const dt = Math.max(0, t - track.lastT);
    // Predict where the face would be if nothing had changed; a person who walks
    // out of frame keeps moving, so the prediction follows them out.
    const px = track.cx + track.vx * dt;
    const py = track.cy + track.vy * dt;
    for (const box of boxes) {
      const face = personBoxToFaceEstimate(box);
      const dx = Math.abs(face.cx - px);
      const dy = Math.abs(face.cy - py);
      const gateX = Math.max(face.w, track.w) * tolerance + face.w * 0.5;
      const gateY = Math.max(face.h, track.w) * tolerance + face.h * 0.5;
      if (dx > gateX || dy > gateY) continue;
      const cost = Math.hypot(dx / Math.max(1, face.w), dy / Math.max(1, face.h));
      pairs.push({ trackId: track.id, box, face, cost });
    }
  }

  pairs.sort((a, b) => a.cost - b.cost);
  const usedTracks = new Set<number>();
  const usedBoxes = new Set<PersonBox>();
  const matches: PersonHoldMatch[] = [];
  for (const pair of pairs) {
    if (usedTracks.has(pair.trackId) || usedBoxes.has(pair.box)) continue;
    usedTracks.add(pair.trackId);
    usedBoxes.add(pair.box);
    matches.push({
      trackId: pair.trackId,
      box: pair.box,
      face: pair.face,
      cost: pair.cost,
    });
  }
  return matches;
}
