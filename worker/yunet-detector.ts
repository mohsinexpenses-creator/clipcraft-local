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
 * unreliable. The pre/post-processing below mirrors OpenCV's own
 * `FaceDetectorYNImpl` (modules/objdetect/src/face_detect.cpp) EXACTLY so the
 * detections match what cv::FaceDetectorYN produces:
 *
 *   - the caller resizes the frame (aspect-preserving); we pad bottom/right to
 *     a multiple of 32,
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
 * The model file is downloaded by `npm run setup:yunet`
 * (scripts/setup-yunet.mjs) into models/yunet/ - it is NOT committed to git.
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
const DIVISOR = 32;
const CONF_THRESHOLD = 0.55;
const NMS_THRESHOLD = 0.3;
const TOP_K = 5000;

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

/**
 * Detect faces in one frame. Coordinates are returned in the FRAME's own pixel
 * space (the caller is responsible for any prior scaling of the frame).
 */
export async function detectFacesYunet(
  runtime: YuNetRuntime,
  frame: RawFrame,
  options?: { confThreshold?: number }
): Promise<DetectedFace[]> {
  const ort = optionalRequire('onnxruntime-node') as OrtModule;
  const { width: inputW, height: inputH, data } = frame;
  if (inputW < 16 || inputH < 16) return [];

  // Pad bottom/right to a multiple of 32 - exactly what padWithDivisor() does.
  const padW = (Math.floor((inputW - 1) / DIVISOR) + 1) * DIVISOR;
  const padH = (Math.floor((inputH - 1) / DIVISOR) + 1) * DIVISOR;

  // blobFromImage defaults: NCHW float32, RGB (swapRB=true), no normalization.
  const blob = new Float32Array(3 * padW * padH);
  const plane = padW * padH;
  for (let y = 0; y < inputH; y += 1) {
    for (let x = 0; x < inputW; x += 1) {
      const src = (y * inputW + x) * 4;
      const dst = y * padW + x;
      blob[dst] = data[src]; // R
      blob[plane + dst] = data[src + 1]; // G
      blob[2 * plane + dst] = data[src + 2]; // B
    }
  }

  const tensor = new ort.Tensor('float32', blob, [1, 3, padH, padW]);
  const outputs = await runtime.session.run({ [runtime.inputName]: tensor });

  const confThreshold = options?.confThreshold ?? CONF_THRESHOLD;
  const faces: Array<{ face: DetectedFace; score: number }> = [];

  for (let level = 0; level < STRIDES.length; level += 1) {
    const stride = STRIDES[level];
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
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

        const cx = (c + bboxV[idx * 4 + 0]) * stride;
        const cy = (r + bboxV[idx * 4 + 1]) * stride;
        const w = Math.exp(bboxV[idx * 4 + 2]) * stride;
        const h = Math.exp(bboxV[idx * 4 + 3]) * stride;

        const points: Array<{ x: number; y: number }> = [];
        for (let n = 0; n < 5; n += 1) {
          points.push({
            x: (kpsV[idx * 10 + 2 * n] + c) * stride,
            y: (kpsV[idx * 10 + 2 * n + 1] + r) * stride,
          });
        }

        faces.push({
          score,
          face: {
            score,
            box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
            landmarks: { points },
          },
        });
      }
    }
  }

  // Greedy NMS with the model's IoU threshold. Blob space is 1:1 with the
  // frame's pixels (padding sits outside [0..inputW)x[0..inputH)), so decoded
  // coordinates need no scaling - only clipping away padding garbage.
  faces.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];

  for (const candidate of faces) {
    if (kept.length >= TOP_K) break;
    let overlaps = false;
    for (const existing of kept) {
      if (iou(candidate.face.box, existing.box) > NMS_THRESHOLD) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    const clipped = clipToFrame(candidate.face, inputW, inputH);
    if (clipped) kept.push(clipped);
  }

  return kept;
}

/** Clip a detection to the real frame area; drop it when its centre is padding. */
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

function iou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}
