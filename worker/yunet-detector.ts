import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { toErrorMessage } from '../lib/errors';
import { log } from '../lib/logger';

/**
 * YuNet face detection (`face_detection_yunet_2023mar.onnx` from the OpenCV
 * model zoo) running on onnxruntime-node.
 *
 * This replaces the old face-api/tfjs detector (tiny_face_detector) which was
 * unreliable. The decode math below mirrors OpenCV's own `FaceDetectorYNImpl`
 * (modules/objdetect/src/face_detect.cpp) EXACTLY so the detections match what
 * cv::FaceDetectorYN produces:
 *
 *   - blobFromImage defaults: float32 NCHW, RGB (swapRB), NO mean/std scaling
 *     (raw 0-255 pixel values),
 *   - the 2023mar (v2) model returns 12 feature maps:
 *     cls_8/16/32, obj_8/16/32, bbox_8/16/32, kps_8/16/32,
 *   - decode per cell: score = sqrt(clamp(cls) * clamp(obj)),
 *     cx = (c + bbox0) * stride, cy = (r + bbox1) * stride,
 *     w = exp(bbox2) * stride, h = exp(bbox3) * stride,
 *     landmark n = (kps[n] + (c or r)) * stride,
 *   - greedy NMS (IoU 0.3, topK 5000).
 *
 * PRE-PROCESSING (what differs from a naive port - and why it matters):
 *
 *   The 2023mar ONNX has a STATIC 640x640 input, so every image the model sees
 *   is exactly that size. OpenCV pads (never stretches) the frame to fit; the
 *   old code here SQUASHED a 16:9 frame into the square, which distorts faces
 *   (1.78x taller) and shrinks them further - and a podcast wide shot has faces
 *   only ~35px wide in a 640px sample. The model then scored them poorly (or the
 *   old 40px size filter threw them away), the tracker saw "1 person" and the
 *   split screen silently collapsed.
 *
 *   Now each detection region is LETTERBOXED (uniform scale, zero padding), and
 *   wide frames are scanned with several overlapping square TILES (side = frame
 *   height) plus one full-frame pass:
 *     - a tile is upscaled to fill the 640x640 input, so a small face lands in
 *       the model's sweet spot (a 100px face in 1080p detects at 0.9 instead of
 *       0.7, and 45px faces that a full-frame pass cannot see at all are found),
 *     - the full-frame pass still catches big faces / close-ups that straddle a
 *       tile seam.
 *   Duplicates across passes are merged with NMS (+ containment), and faces cut
 *   by an inner tile seam are discarded (another pass sees them whole).
 *
 * The model file is downloaded by `npm run setup:yunet`
 * (scripts/setup-yunet.mjs) into models/yunet/.
 */

function projectRequire(): NodeJS.Require {
  if (typeof __filename === 'string' && __filename.startsWith(process.cwd())) {
    return createRequire(__filename);
  }
  return createRequire(path.join(process.cwd(), 'noop.js'));
}
const nodeRequire = projectRequire();

export const YUNET_MODEL_RELPATH = path.join('models', 'yunet', 'face_detection_yunet_2023mar.onnx');

/** Official OpenCV Zoo file - verified by SHA-256 in scripts/setup-yunet.mjs. */
export const YUNET_MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4';

const STRIDES = [8, 16, 32] as const;
/**
 * The 2023mar ONNX has a STATIC 640x640 input (onnxruntime rejects 640x384 /
 * 320x192 with "Got invalid dimensions for input ... Expected: 640"). Every
 * detection region is letterboxed into this square.
 */
const YUNET_INPUT_SIZE = 640;
/**
 * Score gate. YuNet rejects walls/hands/textures well below real faces: on
 * square tiles real faces score 0.8-0.95 even when small, so 0.65 keeps
 * profile / slightly turned faces (0.65-0.75) that 0.7 used to lose, without
 * letting low-confidence junk through (the tracker + layout re-filter anyway).
 */
const CONF_THRESHOLD = 0.65;
const NMS_THRESHOLD = 0.3;
const TOP_K = 5000;
/**
 * Smallest face the DETECTOR keeps, as a fraction of the frame width.
 *
 * This used to be an absolute 40px in the 640px model space - i.e. 120px in a
 * 1920px source. Hosts in a podcast wide shot have faces of 80-120px, so the
 * filter silently deleted the very people the split screen needs ("frames=2/480").
 * 1.4% (27px of 1920) only removes specks; deciding who is a real on-screen
 * person is the layout planner's job (it sees screen time + speaker data).
 */
const MIN_FACE_FRACTION = 0.014;
/** Frames at least this wide (long side / short side) are scanned with tiles. */
const TILE_MIN_ASPECT = 1.4;
/** Neighbouring tiles overlap by at least 20% of the tile side. */
const TILE_MAX_STEP = 0.8;
/** A tile detection that touches an INNER seam within this fraction is a cut-off face. */
const SEAM_MARGIN = 0.02;
/** A box mostly inside a higher-scoring box is the same face seen at another scale. */
const CONTAINMENT_THRESHOLD = 0.8;

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceLandmarks {
  /** Landmark order matches YuNet: right eye, left eye, nose tip, right mouth corner, left mouth corner. */
  points: Array<{ x: number; y: number }>;
}

export interface DetectedFace {
  box: FaceBox;
  landmarks: FaceLandmarks;
  score: number;
}

export interface YuNetRuntime {
  session: OrtSession;
  inputName: string;
  unavailableReason?: undefined;
}

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

let runtimePromise: Promise<YuNetRuntime | null> | null = null;
let unavailableReason: string | null = null;

export function getYunetUnavailableReason(): string | null {
  return unavailableReason;
}

export function yunetModelPath(): string {
  return process.env.YUNET_MODEL_PATH?.trim() || path.join(process.cwd(), YUNET_MODEL_RELPATH);
}

export function yunetModelPresent(): boolean {
  try {
    const stat = fs.statSync(yunetModelPath());
    return stat.isFile() && stat.size > 100_000;
  } catch {
    return false;
  }
}

/** Load the ONNX session once per process. Returns null (never throws) when unavailable. */
export async function loadYuNet(): Promise<YuNetRuntime | null> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    if (!yunetModelPresent()) {
      unavailableReason =
        `YuNet model not found at ${yunetModelPath()} - run "npm run setup:yunet" to download it`;
      return null;
    }

    try {
      const ort = optionalRequire('onnxruntime-node') as OrtModule | null;
      if (!ort?.InferenceSession) {
        unavailableReason = 'onnxruntime-node is not installed (npm i onnxruntime-node)';
        return null;
      }

      const session = await ort.InferenceSession.create(yunetModelPath(), {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      if (!session.inputNames?.length || !session.outputNames?.length) {
        unavailableReason = 'the YuNet ONNX session exposed no inputs/outputs';
        return null;
      }

      // v2 (2023mar) exposes 12 outputs; 3 outputs means the old v1 export
      // which this decoder does not support.
      if (session.outputNames.length < 12) {
        unavailableReason =
          `the YuNet model has ${session.outputNames.length} outputs - expected the 2023mar (v2) model with 12 outputs`;
        return null;
      }

      log.ok('YuNet face detection enabled (face_detection_yunet_2023mar.onnx + onnxruntime-node).');
      return { session, inputName: session.inputNames[0] };
    } catch (error) {
      unavailableReason = toErrorMessage(error);
      log.warn(`YuNet model failed to load: ${unavailableReason}`);
      return null;
    }
  })();

  return runtimePromise;
}

function optionalRequire(moduleName: string): unknown {
  try {
    const loaded = nodeRequire(moduleName) as { default?: unknown } | null;
    if (!loaded) return null;
    return typeof loaded === 'object' && 'default' in loaded && loaded.default ? loaded.default : loaded;
  } catch {
    return null;
  }
}

/** Which output tensor belongs to which head, when names cannot be matched. */
const CANONICAL_OUTPUT_ORDER = [
  'cls_8', 'cls_16', 'cls_32',
  'obj_8', 'obj_16', 'obj_32',
  'bbox_8', 'bbox_16', 'bbox_32',
  'kps_8', 'kps_16', 'kps_32',
];

function pickOutput(outputs: Record<string, OrtTensor>, name: string, canonicalIndex: number): OrtTensor {
  if (outputs[name]) return outputs[name];
  // Fall back to OpenCV's canonical head order (net.forward(output_blobs, names)).
  const ordered = Object.values(outputs);
  return outputs[CANONICAL_OUTPUT_ORDER[canonicalIndex]] ?? ordered[canonicalIndex] ?? ordered[0];
}

export interface RawFrame {
  /** RGBA pixels, e.g. from Jimp. */
  data: Buffer | Uint8Array;
  width: number;
  height: number;
}

export interface DetectOptions {
  /** Score gate (default 0.65). */
  confThreshold?: number;
  /** Smallest face to keep, as a fraction of the frame width (default 1.4%). */
  minFaceFraction?: number;
  /**
   * `auto` (default): wide/tall frames are scanned with overlapping square tiles
   * plus a full-frame pass. `off`: a single letterboxed full-frame pass.
   */
  tiling?: 'auto' | 'off';
}

/** One rectangle of the frame that is fed to the model as a 640x640 letterboxed image. */
export interface DetectRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which sides of this region are INTERNAL seams (a face touching one is cut off). */
  seams: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

/**
 * The regions the model scans for a frame: always the whole frame, plus - for
 * wide (or tall) frames - overlapping SQUARE tiles whose side is the frame's
 * short side. A tile is upscaled to the model input, so small faces become
 * large enough for YuNet to score them confidently; neighbouring tiles overlap
 * by >= 20% so a face is whole in at least one of them.
 */
export function planDetectionRegions(
  frameW: number,
  frameH: number,
  tiling: 'auto' | 'off' = 'auto'
): DetectRegion[] {
  const noSeams = { left: false, right: false, top: false, bottom: false };
  const regions: DetectRegion[] = [{ x: 0, y: 0, w: frameW, h: frameH, seams: noSeams }];
  if (tiling === 'off') return regions;

  const long = Math.max(frameW, frameH);
  const short = Math.min(frameW, frameH);
  if (short <= 0 || long / short < TILE_MIN_ASPECT) return regions;

  const count = Math.max(2, Math.ceil((long - short) / (TILE_MAX_STEP * short)) + 1);
  const span = long - short;
  const horizontal = frameW >= frameH;
  for (let i = 0; i < count; i += 1) {
    const offset = Math.round((span * i) / (count - 1));
    regions.push(
      horizontal
        ? {
            x: offset,
            y: 0,
            w: short,
            h: short,
            seams: { left: i > 0, right: i < count - 1, top: false, bottom: false },
          }
        : {
            x: 0,
            y: offset,
            w: short,
            h: short,
            seams: { left: false, right: false, top: i > 0, bottom: i < count - 1 },
          }
    );
  }
  return regions;
}

/** Bilinear sample positions along one axis (pixel-centre mapping, clamped edges). */
function axisTable(
  origin: number,
  scale: number,
  outLen: number,
  srcLen: number
): { i0: Int32Array; i1: Int32Array; f: Float32Array } {
  const i0 = new Int32Array(outLen);
  const i1 = new Int32Array(outLen);
  const f = new Float32Array(outLen);
  for (let o = 0; o < outLen; o += 1) {
    const s = origin + (o + 0.5) / scale - 0.5;
    const base = Math.floor(s);
    i0[o] = Math.min(srcLen - 1, Math.max(0, base));
    i1[o] = Math.min(srcLen - 1, i0[o] + 1);
    f[o] = s - base;
  }
  return { i0, i1, f };
}

/**
 * Letterbox a region of the frame into the model's 640x640 NCHW float32 blob:
 * uniform scale (aspect preserved), content in the top-left, zero padding - the
 * same thing OpenCV's FaceDetectorYN does (it pads, it never stretches).
 * blobFromImage defaults: RGB (swapRB), raw 0-255 values, no normalisation.
 */
function buildBlob(frame: RawFrame, region: DetectRegion): { blob: Float32Array; scale: number } {
  const { width: frameW, height: frameH, data } = frame;
  const size = YUNET_INPUT_SIZE;
  const plane = size * size;
  const blob = new Float32Array(3 * plane);

  const scale = Math.min(size / region.w, size / region.h);
  const outW = Math.min(size, Math.max(1, Math.round(region.w * scale)));
  const outH = Math.min(size, Math.max(1, Math.round(region.h * scale)));
  const xs = axisTable(region.x, scale, outW, frameW);
  const ys = axisTable(region.y, scale, outH, frameH);

  for (let y = 0; y < outH; y += 1) {
    const rowTop = ys.i0[y] * frameW * 4;
    const rowBot = ys.i1[y] * frameW * 4;
    const fy = ys.f[y];
    let dst = y * size;
    for (let x = 0; x < outW; x += 1) {
      const x0 = xs.i0[x] * 4;
      const x1 = xs.i1[x] * 4;
      const fx = xs.f[x];
      for (let c = 0; c < 3; c += 1) {
        const top = data[rowTop + x0 + c] * (1 - fx) + data[rowTop + x1 + c] * fx;
        const bottom = data[rowBot + x0 + c] * (1 - fx) + data[rowBot + x1 + c] * fx;
        blob[c * plane + dst] = top * (1 - fy) + bottom * fy;
      }
      dst += 1;
    }
  }
  return { blob, scale };
}

/** Decode the 12 YuNet feature maps of ONE region into faces in FRAME pixel space. */
function decodeRegion(
  outputs: Record<string, OrtTensor>,
  region: DetectRegion,
  scale: number,
  confThreshold: number
): DetectedFace[] {
  const size = YUNET_INPUT_SIZE;
  const faces: DetectedFace[] = [];

  for (let level = 0; level < STRIDES.length; level += 1) {
    const stride = STRIDES[level];
    const cols = Math.floor(size / stride);
    const rows = Math.floor(size / stride);
    const cells = rows * cols;

    const cls = pickOutput(outputs, `cls_${stride}`, level);
    const obj = pickOutput(outputs, `obj_${stride}`, STRIDES.length + level);
    const bbox = pickOutput(outputs, `bbox_${stride}`, STRIDES.length * 2 + level);
    const kps = pickOutput(outputs, `kps_${stride}`, STRIDES.length * 3 + level);

    const clsV = cls.data as Float32Array;
    const objV = obj.data as Float32Array;
    const bboxV = bbox.data as Float32Array;
    const kpsV = kps.data as Float32Array;

    if (clsV.length < cells || bboxV.length < cells * 4) continue;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;

        // score = sqrt(clamp(cls) * clamp(obj)) - OpenCV's exact combination.
        const clsScore = Math.min(Math.max(clsV[idx], 0), 1);
        const objScore = Math.min(Math.max(objV[idx], 0), 1);
        const score = Math.sqrt(clsScore * objScore);
        if (score < confThreshold) continue;

        // Decode in model space (640x640), then map to FRAME pixels:
        // undo the letterbox scale and add the region's offset.
        const cx = region.x + ((c + bboxV[idx * 4 + 0]) * stride) / scale;
        const cy = region.y + ((r + bboxV[idx * 4 + 1]) * stride) / scale;
        const w = (Math.exp(bboxV[idx * 4 + 2]) * stride) / scale;
        const h = (Math.exp(bboxV[idx * 4 + 3]) * stride) / scale;

        const points: Array<{ x: number; y: number }> = [];
        for (let n = 0; n < 5; n += 1) {
          points.push({
            x: region.x + ((kpsV[idx * 10 + 2 * n] + c) * stride) / scale,
            y: region.y + ((kpsV[idx * 10 + 2 * n + 1] + r) * stride) / scale,
          });
        }

        faces.push({
          score,
          box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
          landmarks: { points },
        });
      }
    }
  }
  return faces;
}

/**
 * A detection from a TILE that touches one of the tile's INNER seams is a face
 * the seam cut in half (YuNet happily boxes a partial face). Drop it: the
 * neighbouring tile (they overlap) or the full-frame pass sees it whole.
 */
function isCutBySeam(face: DetectedFace, region: DetectRegion): boolean {
  const { seams } = region;
  if (!seams.left && !seams.right && !seams.top && !seams.bottom) return false;
  const marginX = region.w * SEAM_MARGIN;
  const marginY = region.h * SEAM_MARGIN;
  const { x, y, width, height } = face.box;
  if (seams.left && x <= region.x + marginX) return true;
  if (seams.right && x + width >= region.x + region.w - marginX) return true;
  if (seams.top && y <= region.y + marginY) return true;
  if (seams.bottom && y + height >= region.y + region.h - marginY) return true;
  return false;
}

/**
 * Detect faces in one frame. Coordinates are returned in the FRAME's own pixel
 * space (the caller is responsible for any prior scaling of the frame).
 */
export async function detectFacesYunet(
  runtime: YuNetRuntime,
  frame: RawFrame,
  options?: DetectOptions
): Promise<DetectedFace[]> {
  const ort = optionalRequire('onnxruntime-node') as OrtModule;
  const { width: inputW, height: inputH } = frame;
  if (inputW < 16 || inputH < 16) return [];

  const confThreshold = options?.confThreshold ?? CONF_THRESHOLD;
  const minWidth = inputW * (options?.minFaceFraction ?? MIN_FACE_FRACTION);
  const regions = planDetectionRegions(inputW, inputH, options?.tiling ?? 'auto');
  const size = YUNET_INPUT_SIZE;

  const candidates: DetectedFace[] = [];
  for (const region of regions) {
    const { blob, scale } = buildBlob(frame, region);
    const tensor = new ort.Tensor('float32', blob, [1, 3, size, size]);
    const outputs = await runtime.session.run({ [runtime.inputName]: tensor });
    for (const face of decodeRegion(outputs, region, scale, confThreshold)) {
      if (!isCutBySeam(face, region)) candidates.push(face);
    }
  }

  // Greedy NMS across ALL passes: highest score first; a candidate is a
  // duplicate when it overlaps a kept face (IoU) or sits mostly inside it
  // (the same face seen at another scale / a partial box).
  candidates.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];

  for (const candidate of candidates) {
    if (kept.length >= TOP_K) break;
    let duplicate = false;
    for (const existing of kept) {
      if (
        iou(candidate.box, existing.box) > NMS_THRESHOLD ||
        containment(candidate.box, existing.box) > CONTAINMENT_THRESHOLD
      ) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    const clipped = clipToFrame(candidate, inputW, inputH);
    if (!clipped) continue;

    // Specks are never real faces. The bar is RELATIVE to the frame (a face
    // narrower than ~1.4% of the frame width), not a fixed pixel size: an
    // absolute floor in model space used to delete the hosts of a wide shot.
    if (clipped.box.width < minWidth) continue;

    kept.push(clipped);
  }

  return kept;
}

/** Clip a detection to the frame bounds; drop it when its centre is outside. */
function clipToFrame(face: DetectedFace, frameW: number, frameH: number): DetectedFace | null {
  const cx = face.box.x + face.box.width / 2;
  const cy = face.box.y + face.box.height / 2;
  if (cx < 0 || cy < 0 || cx >= frameW || cy >= frameH) return null;

  const x1 = Math.max(0, face.box.x);
  const y1 = Math.max(0, face.box.y);
  const x2 = Math.min(frameW, face.box.x + face.box.width);
  const y2 = Math.min(frameH, face.box.y + face.box.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 8 || height <= 8) return null;

  return {
    score: face.score,
    box: { x: x1, y: y1, width, height },
    landmarks: face.landmarks,
  };
}

function intersection(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function iou(a: FaceBox, b: FaceBox): number {
  const inter = intersection(a, b);
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** Share of the SMALLER box that lies inside the other one (1 = fully contained). */
function containment(a: FaceBox, b: FaceBox): number {
  const inter = intersection(a, b);
  if (inter <= 0) return 0;
  return inter / Math.max(1e-6, Math.min(a.width * a.height, b.width * b.height));
}
