import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { AppError, toErrorMessage } from '../lib/errors';
import { runFfmpeg } from '../lib/ffmpeg';
import { log } from '../lib/logger';

/**
 * `createRequire` that works in both ways this code can run:
 * - the worker (tsx): `__filename` is a real path, so use it;
 * - Next.js dev (Turbopack): `__filename` is a VIRTUAL path like
 *   `/ROOT/lib/startup-validation.ts` that does not exist on disk, so requiring
 *   from it can never find node_modules (both Remotion packages were falsely
 *   reported as "not installed").
 * `process.cwd()` is the project root in every supported invocation, so it is
 * the safe fallback base.
 */
function projectRequire(): NodeJS.Require {
  if (typeof __filename === 'string' && __filename.startsWith(process.cwd())) {
    return createRequire(__filename);
  }
  return createRequire(path.join(process.cwd(), 'noop.js'));
}
const nodeRequire = projectRequire();

export interface CropWindowResult {
  cropW: number;
  cropH: number;
  cropX: number;
  cropY: number;
  cropFilter: string;
  /** Which detector produced the crop - useful in the worker log. */
  method: 'face-api' | 'skin-heuristic' | 'center-fallback';
  /** Average detector confidence (0-1) when available. */
  confidence?: number;
}

const FACE_MODELS_DIR = path.join('models', 'face');
const FACE_MODEL_MANIFEST = 'tiny_face_detector_model-weights_manifest.json';
const TARGET_ASPECT = 9 / 16;
const MAX_SAMPLED_FRAMES = 40;

type FaceApiModule = {
  nets: {
    tinyFaceDetector: {
      loadFromDisk: (dir: string) => Promise<void>;
      isLoaded: boolean;
    };
  };
  TinyFaceDetectorOptions: new (options: { inputSize: number; scoreThreshold: number }) => unknown;
  detectAllFaces: (input: unknown, options: unknown) => Promise<Array<{ box: { x: number; y: number; width: number; height: number }; score: number }>>;
};

type TfjsModule = {
  setBackend: (backend: string) => Promise<boolean>;
  ready: () => Promise<boolean>;
  tensor3d: (data: Uint8Array | number[], shape: [number, number, number]) => unknown;
};

let faceApiPromise: Promise<{ faceapi: FaceApiModule; tf: TfjsModule } | null> | null = null;
let faceApiUnavailableReason: string | null = null;

function evenSize(value: number, minimum = 2): number {
  return Math.max(minimum, Math.floor(value / 2) * 2);
}

/** Load an optional package without TypeScript needing its types to exist. */
function optionalRequire(moduleName: string): unknown {
  try {
    const loaded = nodeRequire(moduleName) as { default?: unknown } | null;
    if (!loaded) return null;
    return typeof loaded === 'object' && 'default' in loaded && loaded.default ? loaded.default : loaded;
  } catch {
    return null;
  }
}

function faceModelsPresent(): boolean {
  const dir = path.join(process.cwd(), FACE_MODELS_DIR);
  return fs.existsSync(path.join(dir, FACE_MODEL_MANIFEST));
}

/**
 * OPTIONAL real face detection.
 *
 * `@vladmandic/face-api` is the maintained fork of
 * face-api.js. It needs a tfjs backend, which is NOT a hard dependency of this
 * project (tfjs-node requires node-gyp/Visual Studio Build Tools on Windows), so
 * everything here is dynamically imported and every failure falls back to the
 * skin-tone heuristic instead of killing the render.
 *
 * To enable it:
 *   npm i @tensorflow/tfjs-core@^4 @tensorflow/tfjs-backend-cpu@^4
 * (models are already committed under models/face/)
 */
async function loadFaceApi(): Promise<{ faceapi: FaceApiModule; tf: TfjsModule } | null> {
  if (faceApiPromise) return faceApiPromise;

  faceApiPromise = (async () => {
    if (!faceModelsPresent()) {
      faceApiUnavailableReason = `no models in ${FACE_MODELS_DIR}`;
      return null;
    }

    try {
      // require() (not import()) so TypeScript never tries to resolve these
      // optional packages - they are deliberately NOT in dependencies.
      const faceapi = optionalRequire('@vladmandic/face-api') as FaceApiModule | null;
      if (!faceapi) {
        faceApiUnavailableReason = '@vladmandic/face-api is not installed';
        return null;
      }

      const tf = optionalRequire('@tensorflow/tfjs-core') as TfjsModule | null;
      if (!tf) {
        faceApiUnavailableReason = '@tensorflow/tfjs-core is not installed';
        return null;
      }

      await tf.setBackend('cpu');
      await tf.ready();

      const modelsDir = path.join(process.cwd(), FACE_MODELS_DIR);
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir);

      log.ok('Real face detection enabled (@vladmandic/face-api + tfjs cpu backend).');
      return { faceapi, tf };
    } catch (error) {
      faceApiUnavailableReason = toErrorMessage(error);
      log.warn(
        `Falling back to the skin-tone heuristic: ${faceApiUnavailableReason}. ` +
        'To enable real face detection run: npm run setup:faceapi'
      );
      return null;
    }
  })();

  return faceApiPromise;
}

interface FrameSample {
  path: string;
  width: number;
  height: number;
}

async function readFrame(framePath: string): Promise<FrameSample | null> {
  try {
    const image = await Jimp.read(framePath);
    return { path: framePath, width: image.bitmap.width, height: image.bitmap.height };
  } catch {
    return null;
  }
}

/**
 * Neural detection on one frame. Returns the horizontal face centre in the
 * frame's own pixel space, or null.
 */
async function detectWithFaceApi(
  runtime: { faceapi: FaceApiModule; tf: TfjsModule },
  framePath: string
): Promise<{ centerX: number; score: number; width: number } | null> {
  const { faceapi, tf } = runtime;

  try {
    const image = await Jimp.read(framePath);
    const { width, height, data } = image.bitmap;

    // Jimp gives RGBA; tinyFaceDetector expects an RGB tensor.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }

    const tensor = tf.tensor3d(rgb, [height, width, 3]);
    const detections = await faceapi.detectAllFaces(
      tensor,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
    );

    // Dispose via any() to avoid importing the tfjs type surface.
    const disposable = tensor as { dispose?: () => void };
    disposable.dispose?.();

    if (!detections || detections.length === 0) return null;

    const best = detections.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      centerX: best.box.x + best.box.width / 2,
      score: best.score,
      width,
    };
  } catch (error) {
    console.warn(`[FaceDetector] face-api failed on ${path.basename(framePath)}: ${toErrorMessage(error)}`);
    return null;
  }
}

/**
 * Fallback detector: centroid of skin-coloured pixels. Crude (it also reacts to
 * wood, warm backgrounds and hands) but it needs no ML runtime at all.
 */
async function detectWithSkinHeuristic(
  framePath: string
): Promise<{ centerX: number; score: number; width: number } | null> {
  try {
    const image = await Jimp.read(framePath);
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    const data = image.bitmap.data;

    // Bucket the frame into 32 horizontal columns and score each by skin pixels.
    const columns = 32;
    const counts = new Array<number>(columns).fill(0);
    let skinPixels = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Classic RGB skin rule (Peer et al.) - cheap and reasonably robust.
        const isSkin =
          r > 95 && g > 40 && b > 20 &&
          Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
          Math.abs(r - g) > 15 && r > g && r > b;

        if (!isSkin) continue;
        skinPixels += 1;
        counts[Math.min(columns - 1, Math.floor((x / width) * columns))] += 1;
      }
    }

    const minPixels = Math.max(50, Math.floor(width * height * 0.002));
    if (skinPixels < minPixels) return null;

    // Weighted centroid over columns, ignoring columns that are clearly noise.
    const threshold = Math.max(...counts) * 0.15;
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < columns; i += 1) {
      if (counts[i] < threshold) continue;
      weightedSum += counts[i] * ((i + 0.5) / columns) * width;
      weightTotal += counts[i];
    }
    if (weightTotal === 0) return null;

    // Confidence is how concentrated the skin mass is (a single face -> high).
    const concentration = Math.max(...counts) / Math.max(1, skinPixels / columns);
    return {
      centerX: weightedSum / weightTotal,
      score: Math.min(1, 0.3 + concentration * 0.35),
      width,
    };
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Drop readings that are wildly far from the median (a hand or a warm prop). */
function rejectOutliers(values: number[]): number[] {
  if (values.length < 5) return values;

  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations) || 1;
  const tolerance = Math.max(60, mad * 3);

  const kept = values.filter((v) => Math.abs(v - med) <= tolerance);
  return kept.length >= Math.ceil(values.length * 0.4) ? kept : values;
}

function applyMovingAverage(values: number[], windowSize: number): number[] {
  if (values.length === 0) return [];

  const result: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(values.length, i + Math.floor(windowSize / 2) + 1);
    const window = values.slice(start, end);
    result.push(window.reduce((sum, value) => sum + value, 0) / window.length);
  }
  return result;
}

/**
 * Compute the 9:16 smart-crop window for a segment.
 *
 * IMPORTANT: the ffmpeg chain is `hflip,crop=...`, i.e. the picture is mirrored
 * BEFORE it is cropped. The frames sampled here therefore have `hflip` applied too,
 * so the returned cropX is already in mirrored space. Sampling un-mirrored frames
 * (the old behaviour) put the crop window on the opposite side of the speaker.
 */
export async function detectFaceCropWindow(
  videoPath: string,
  start: number,
  duration: number,
  videoWidth: number,
  videoHeight: number
): Promise<CropWindowResult> {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    throw new AppError('Cannot compute a smart crop without a valid source resolution.', {
      status: 400,
      details: `width=${videoWidth}, height=${videoHeight}`,
      resolution: 'Re-upload the video so FFmpeg can read its resolution.',
    });
  }

  // Largest 9:16 window that fits inside the source, with even dimensions.
  let cropH = evenSize(videoHeight);
  let cropW = evenSize(cropH * TARGET_ASPECT);

  if (cropW > videoWidth) {
    cropW = evenSize(videoWidth);
    cropH = evenSize(cropW / TARGET_ASPECT);
  }

  cropW = Math.min(cropW, evenSize(videoWidth));
  cropH = Math.min(cropH, evenSize(videoHeight));

  const tempFramesDir = path.join(
    process.cwd(),
    '.tmp',
    `frames_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    fs.mkdirSync(tempFramesDir, { recursive: true });

    // Keep the frame count bounded on long segments.
    const safeDuration = Math.max(0.5, duration);
    const sampleFps = Math.max(0.5, Math.min(2, MAX_SAMPLED_FRAMES / safeDuration));

    const frameArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-t', safeDuration.toFixed(3),
      '-i', videoPath,
      // hflip FIRST: sample exactly what the crop filter will see.
      // fps=<sampleFps> is what actually limits the decode work - without it ffmpeg
      // decodes every frame of the segment and only -frames:v caps the output, which
      // is slow on long clips.
      '-vf', `hflip,scale=640:-2,fps=${sampleFps.toFixed(3)}`,
      '-frames:v', String(MAX_SAMPLED_FRAMES),
      path.join(tempFramesDir, 'frame_%03d.jpg'),
    ];

    await runFfmpeg(frameArgs, { label: 'sample-frames' });

    const frameFiles = fs
      .readdirSync(tempFramesDir)
      .filter((file) => file.toLowerCase().endsWith('.jpg'))
      .sort();

    if (frameFiles.length === 0) {
      throw new AppError('Smart crop failed because no sample frames were extracted.', {
        details: `start=${start}, duration=${safeDuration}`,
        resolution: 'Check the clip timestamps and verify FFmpeg can decode the source video.',
      });
    }

    const runtime = await loadFaceApi();
    const centres: number[] = [];
    const scores: number[] = [];
    let method: CropWindowResult['method'] = runtime ? 'face-api' : 'skin-heuristic';

    for (const frameFile of frameFiles) {
      const framePath = path.join(tempFramesDir, frameFile);
      const sample = await readFrame(framePath);
      if (!sample) continue;

      let detection = runtime ? await detectWithFaceApi(runtime, framePath) : null;
      if (!detection) {
        detection = await detectWithSkinHeuristic(framePath);
        if (detection && runtime) method = 'skin-heuristic';
      }
      if (!detection) continue;

      // Scale from the sampled 640px-wide frame back to source pixels.
      const scaleFactor = videoWidth / Math.max(1, detection.width);
      centres.push(detection.centerX * scaleFactor);
      scores.push(detection.score);
    }

    let avgCenterX: number;
    let confidence: number | undefined;

    if (centres.length === 0) {
      /**
       * No detection at all: fall back to a centred crop instead of failing the job.
       * (Previously this threw, so any landscape/b-roll segment could never render.)
       */
      console.warn(
        '[FaceDetector] No subject detected in the sampled frames - using a centred 9:16 crop.'
      );
      method = 'center-fallback';
      avgCenterX = videoWidth / 2;
    } else {
      const cleaned = rejectOutliers(centres);
      const smoothed = applyMovingAverage(cleaned, 3);
      avgCenterX = smoothed.reduce((sum, value) => sum + value, 0) / smoothed.length;
      confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;
    }

    let cropX = Math.round(avgCenterX - cropW / 2);
    cropX = evenSize(Math.max(0, Math.min(videoWidth - cropW, cropX)), 0);
    // Keep the vertical centre; for a landscape source this is normally 0 anyway.
    const cropY = evenSize(Math.max(0, Math.floor((videoHeight - cropH) / 2)), 0);

    log.ok(
      `crop=${cropW}:${cropH}:${cropX}:${cropY} (method=${method}, ` +
      `frames=${centres.length}/${frameFiles.length}, center=${avgCenterX.toFixed(1)}px` +
      `${confidence !== undefined ? `, confidence=${confidence.toFixed(2)}` : ''})`
    );

    return {
      cropW,
      cropH,
      cropX,
      cropY,
      cropFilter: `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
      method,
      confidence,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError('Smart crop detection failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the sampled-frame FFmpeg command in the worker log, confirm the segment is inside the video, and retry.',
    });
  } finally {
    try {
      if (fs.existsSync(tempFramesDir)) fs.rmSync(tempFramesDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/** Exposed for the startup-validation page and for debugging. */
export function getFaceDetectionStatus(): {
  modelsPresent: boolean;
  modelsDir: string;
  runtimeLoaded: boolean;
  unavailableReason: string | null;
} {
  return {
    modelsPresent: faceModelsPresent(),
    modelsDir: path.join(process.cwd(), FACE_MODELS_DIR),
    runtimeLoaded: Boolean(faceApiPromise) && faceApiUnavailableReason === null,
    unavailableReason: faceApiUnavailableReason,
  };
}
