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

/** One smoothed keyframe of the face track; t in seconds RELATIVE to the segment start. */
export interface FaceTrackPoint {
  t: number;
  /** Face centre X in MIRRORED source pixels (the crop filter works in mirrored space). */
  x: number;
  /** Face centre Y in mirrored source pixels. */
  y: number;
}

export interface FaceTrackResult extends Omit<CropWindowResult, 'cropX' | 'cropFilter'> {
  /** Smoothed per-time face centres; empty = static centred crop. */
  points: FaceTrackPoint[];
  /** Average centre (for the DB record / logs). */
  staticCropX: number;
  /** How many faces were visible in the busiest sampled frame. */
  maxFacesSeen: number;
  /** How many sampled frames yielded a detection. */
  framesUsed: number;
  framesTotal: number;
}

const FACE_MODELS_DIR = path.join('models', 'face');
const FACE_MODEL_MANIFEST = 'tiny_face_detector_model-weights_manifest.json';
/** Committed 68-landmark weights (mouth-open cue for active speaker detection). */
const LANDMARK_MODELS_DIR = path.join('models', 'face-landmarks');
const TARGET_ASPECT = 9 / 16;
const MAX_SAMPLED_FRAMES = 100;

type FaceApiModule = {
  nets: {
    tinyFaceDetector: {
      loadFromDisk: (dir: string) => Promise<void>;
      isLoaded: boolean;
      isNetLoaded?: boolean;
    };
    faceLandmark68Net?: {
      loadFromDisk: (dir: string) => Promise<void>;
      isLoaded?: boolean;
      isNetLoaded?: boolean;
    };
  };
  TinyFaceDetectorOptions: new (options: { inputSize: number; scoreThreshold: number }) => unknown;
  detectAllFaces: (
    input: unknown,
    options: unknown
  ) => Promise<
    Array<{
      box: { x: number; y: number; width: number; height: number };
      score: number;
      landmarks?: { positions: Array<[number, number]> };
    }>
  >;
};

type TfjsModule = {
  setBackend: (backend: string) => Promise<boolean>;
  ready: () => Promise<boolean>;
  tensor3d: (data: Uint8Array | number[], shape: [number, number, number]) => unknown;
};

let faceApiPromise: Promise<{ faceapi: FaceApiModule; tf: TfjsModule } | null> | null = null;
let faceApiUnavailableReason: string | null = null;

export function evenSize(value: number, minimum = 2): number {
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
export async function loadFaceApi(): Promise<{ faceapi: FaceApiModule; tf: TfjsModule } | null> {
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

export interface FaceDetection {
  /** Face centre in the frame's own pixel space. */
  centerX: number;
  centerY: number;
  /** Detected face box width (the person nearest the camera has the largest). */
  faceWidth: number;
  score: number;
  /** The sampled frame's width in pixels (for scaling back to source). */
  frameWidth: number;
  /**
   * Normalised mouth openness (inner-lip height / face-box height), 0..~0.35.
   * Present when the 68-landmark net ran; the ASD fusion treats null as
   * "no visual articulation cue" and falls back to prominence + audio.
   */
  mouthOpen?: number | null;
}

/**
 * Neural detection on one frame: returns EVERY detected face (a two-person
 * conversation shows two faces) in the frame's own pixel space.
 */
async function detectWithFaceApi(
  runtime: { faceapi: FaceApiModule; tf: TfjsModule },
  framePath: string
): Promise<FaceDetection[]> {
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

    if (!detections || detections.length === 0) return [];

    return detections.map((d) => ({
      centerX: d.box.x + d.box.width / 2,
      centerY: d.box.y + d.box.height / 2,
      faceWidth: d.box.width,
      score: d.score,
      frameWidth: width,
    }));
  } catch (error) {
    log.warn(`face-api failed on ${path.basename(framePath)}: ${toErrorMessage(error)}`);
    return [];
  }
}

/**
 * Load the 68-landmark net once (optional). Returns true when it is ready.
 * The weights are committed under models/face-landmarks/; when they are missing
 * (or the package is not installed) the ASD simply runs without the mouth cue.
 */
let landmarkPromise: Promise<boolean> | null = null;
export function loadLandmarkNet(
  runtime: { faceapi: FaceApiModule; tf: TfjsModule }
): Promise<boolean> {
  if (!landmarkPromise) {
    landmarkPromise = (async () => {
      try {
        const dir = path.join(process.cwd(), LANDMARK_MODELS_DIR);
        if (!fs.existsSync(path.join(dir, 'face_landmark_68_model-weights_manifest.json'))) {
          return false;
        }
        const net = runtime.faceapi.nets.faceLandmark68Net;
        if (!net || net.isNetLoaded === true || net.isLoaded === true) return true;
        await net.loadFromDisk(dir);
        return true;
      } catch (error) {
        log.warn(`68-landmark model unavailable (${toErrorMessage(error)}) - running without the mouth-open cue.`);
        return false;
      }
    })();
  }
  return landmarkPromise;
}

/**
 * Detect ALL faces in a frame, optionally with 68 landmarks, returning a
 * normalised mouth-openness per face. This is the workhorse for ASD:
 *   - the face box drives tracking + prominence,
 *   - the inner-lip height (68 landmarks 60..67) drives the articulation cue.
 */
export async function detectFacesWithMouth(
  runtime: { faceapi: FaceApiModule; tf: TfjsModule } | null,
  framePath: string,
  useLandmarks: boolean
): Promise<FaceDetection[]> {
  if (!runtime) return [];

  const { faceapi, tf } = runtime;
  try {
    const image = await Jimp.read(framePath);
    const { width, height, data } = image.bitmap;

    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }

    const tensor = tf.tensor3d(rgb, [height, width, 3]);
    let detections: Array<{
      box: { x: number; y: number; width: number; height: number };
      score: number;
      landmarks?: { positions: Array<[number, number]> };
    }>;

    if (useLandmarks) {
      // `withFaceLandmarks()` is a per-detection method on face-api; running it
      // over every detection adds the 68 landmarks to each of them.
      const base = await faceapi.detectAllFaces(
        tensor,
        // 416 input + 0.3 threshold (was 320/0.4): podcast-style frames often
        // hold a SECOND, smaller/darker speaker that the tighter old settings
        // silently dropped - which is exactly what made both layouts look
        // "stuck in the centre" (only one track, or none, survived).
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 })
      );
      detections = await Promise.all(
        base.map((d) => {
          const instance = d as { withFaceLandmarks?: () => Promise<typeof d> };
          return instance.withFaceLandmarks ? instance.withFaceLandmarks() : Promise.resolve(d);
        })
      );
    } else {
      detections = await faceapi.detectAllFaces(
        tensor,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
      );
    }

    const disposable = tensor as { dispose?: () => void };
    disposable.dispose?.();

    if (!detections || detections.length === 0) return [];

    return detections
      .map((d) => {
        let mouthOpen: number | null = null;
        const positions = d.landmarks?.positions;
        if (useLandmarks && positions && positions.length >= 68) {
          // Inner-lip ring (indices 60..67): its vertical extent is how open
          // the mouth is. Normalised by the face-box height so it is
          // scale-invariant across zoom levels.
          let minY = Number.POSITIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          for (let i = 60; i <= 67; i += 1) {
            const y = positions[i][1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          mouthOpen = Math.max(0, Math.min(0.35, (maxY - minY) / Math.max(1, d.box.height)));
        }
        return {
          centerX: d.box.x + d.box.width / 2,
          centerY: d.box.y + d.box.height / 2,
          faceWidth: d.box.width,
          score: d.score,
          frameWidth: width,
          mouthOpen,
        };
      })
      .filter((f) => f.faceWidth > 8);
  } catch (error) {
    log.warn(`face-api failed on ${path.basename(framePath)}: ${toErrorMessage(error)}`);
    return [];
  }
}

/**
 * Extract a bounded set of JPEG frames from a clip window. The `hflip` is
 * applied FIRST so the sampled frames are exactly what the (mirrored) crop
 * filter will see. Returns the absolute frame paths in time order.
 */
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
  tmpPrefix = 'frames'
): Promise<SampledFrames> {
  const safeDuration = Math.max(0.5, duration);
  const fps = Math.max(0.5, Math.min(targetFps, maxFrames / safeDuration));

  const tempFramesDir = path.join(
    process.cwd(),
    '.tmp',
    `${tmpPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(tempFramesDir, { recursive: true });

  try {
    const frameArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-t', safeDuration.toFixed(3),
      '-i', videoPath,
      // hflip FIRST: sample exactly what the crop filter will see.
      // fps=<fps> limits the decode work - without it ffmpeg decodes every
      // frame of the segment and only -frames:v caps the output (slow).
      '-vf', `hflip,scale=640:-2,fps=${fps.toFixed(3)}`,
      '-frames:v', String(maxFrames),
      path.join(tempFramesDir, 'frame_%03d.jpg'),
    ];

    await runFfmpeg(frameArgs, { label: 'sample-frames' });

    const frames = fs
      .readdirSync(tempFramesDir)
      .filter((file) => file.toLowerCase().endsWith('.jpg'))
      .sort()
      .map((file) => path.join(tempFramesDir, file));

    if (frames.length === 0) {
      throw new AppError('Frame sampling produced no frames.', {
        details: `start=${start}, duration=${safeDuration}`,
        resolution: 'Check the clip timestamps and verify FFmpeg can decode the source video.',
      });
    }

    return { frames, fps };
  } finally {
    // Caller may still need the frames; cleanup is done by the caller via
    // the returned directory. We only ensure the dir is removed on failure.
  }
}

/** Remove a sampled-frames directory (caller passes the dir it sampled into). */
export function cleanupSampledFrames(tempFramesDir: string): void {
  try {
    if (fs.existsSync(tempFramesDir)) fs.rmSync(tempFramesDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

/**
 * Fallback detector: centroid of skin-coloured pixels. Crude (it also reacts to
 * wood, warm backgrounds and hands) but it needs no ML runtime at all.
 */
export async function detectWithSkinHeuristic(
  framePath: string
): Promise<FaceDetection[]> {
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
    if (skinPixels < minPixels) return [];

    // Weighted centroid over columns, ignoring columns that are clearly noise.
    const threshold = Math.max(...counts) * 0.15;
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < columns; i += 1) {
      if (counts[i] < threshold) continue;
      weightedSum += counts[i] * ((i + 0.5) / columns) * width;
      weightTotal += counts[i];
    }
    if (weightTotal === 0) return [];

    // Confidence is how concentrated the skin mass is (a single face -> high).
    const concentration = Math.max(...counts) / Math.max(1, skinPixels / columns);
    return [
      {
        centerX: weightedSum / weightTotal,
        centerY: height / 2,
        faceWidth: width * 0.2,
        score: Math.min(1, 0.3 + concentration * 0.35),
        frameWidth: width,
      },
    ];
  } catch {
    return [];
  }
}

/**
 * Pick WHICH face to follow when several are visible (a conversation shot).
 *
 * Heuristic for "the speaker": the person nearest the camera has the largest
 * face box, and the shot normally cuts to whoever is talking. Size therefore
 * dominates, with a continuity bias so the tracker doesn't flicker between two
 * visible people while the same person keeps talking. When the shot cuts to the
 * other person they become the largest face and the tracker (plus the slew
 * limit in smoothTrack) pans over to them smoothly.
 */
export function selectSpeakerFace(
  faces: FaceDetection[],
  prevCenterX: number | null,
  frameWidth: number
): FaceDetection | null {
  if (faces.length === 0) return null;
  if (faces.length === 1) return faces[0];

  let best: FaceDetection | null = null;
  let bestScore = -1;
  for (const face of faces) {
    const proximity =
      prevCenterX === null
        ? 1
        : Math.max(0, 1 - Math.abs(face.centerX - prevCenterX) / (frameWidth * 0.5));
    // faceWidth^1.5 makes size dominate; proximity (0..1) breaks ties softly.
    const score = Math.pow(face.faceWidth, 1.5) * (0.6 + 0.4 * proximity);
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }
  return best;
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
  maxPoints = 48
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
 * Turn raw per-sample face centres into a smooth pan:
 *   1. exponential moving average (kills per-frame jitter),
 *   2. slew limit (a "camera pan" never teleports - it moves at most
 *      MAX_PAN_PX_PER_SEC, so a cut to another person glides over ~1s).
 */
/**
 * A cut to another person must COMPLETE within a short speaking turn: two
 * podcast speakers can sit ~900px apart in a 1920px frame, and at 900px/s the
 * window spent most of the clip travelling - to the viewer the frame looked
 * "stuck in the centre" between them. 1600px/s crosses the whole frame in
 * ~0.6s: fast enough to feel like a cut, slow enough to never look shaky.
 */
export const MAX_PAN_PX_PER_SEC = 1600;
const EMA_ALPHA = 0.45;

export function smoothTrack(
  raw: FaceTrackPoint[],
  videoWidth: number
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

/**
 * Compute the 9:16 smart-crop for a segment as a FACE TRACK: a smooth X-pan over
 * time that keeps the SPEAKER in frame.
 *
 * - Several people can be in the shot; `selectSpeakerFace` follows the largest
 *   face (nearest the camera, usually the one talking) with a continuity bias,
 *   so when the shot cuts to another person the pan glides over to them.
 * - `smoothTrack` (EMA + slew limit) turns the per-sample centres into a
 *   camera-like pan instead of a jittery teleport.
 * - The ffmpeg pipeline turns the returned points into a time-varying
 *   `crop` filter expression, evaluated per frame.
 *
 * IMPORTANT: the ffmpeg chain is `hflip,crop=...`, i.e. the picture is mirrored
 * BEFORE it is cropped. The frames sampled here therefore have `hflip` applied
 * too, so the returned X values are already in mirrored space. Sampling
 * un-mirrored frames (the old behaviour) put the crop window on the opposite
 * side of the speaker.
 */
export async function detectFaceTrack(
  videoPath: string,
  start: number,
  duration: number,
  videoWidth: number,
  videoHeight: number
): Promise<FaceTrackResult> {
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
    const rawPoints: FaceTrackPoint[] = [];
    const scores: number[] = [];
    let method: CropWindowResult['method'] = runtime ? 'face-api' : 'skin-heuristic';
    let maxFacesSeen = 0;
    let prevCenterX: number | null = null;

    for (let i = 0; i < frameFiles.length; i += 1) {
      const framePath = path.join(tempFramesDir, frameFiles[i]);
      const sample = await readFrame(framePath);
      if (!sample) continue;

      let faces = runtime ? await detectWithFaceApi(runtime, framePath) : [];
      if (faces.length === 0) {
        faces = await detectWithSkinHeuristic(framePath);
        if (faces.length > 0 && runtime) method = 'skin-heuristic';
      }
      if (faces.length === 0) continue;

      maxFacesSeen = Math.max(maxFacesSeen, faces.length);

      // Scale from the sampled 640px-wide frame back to source pixels BEFORE
      // selection, so size/continuity are compared in source space.
      const scaled: FaceDetection[] = faces.map((f) => {
        const scaleFactor = videoWidth / Math.max(1, f.frameWidth);
        return {
          ...f,
          centerX: f.centerX * scaleFactor,
          centerY: f.centerY * scaleFactor,
          faceWidth: f.faceWidth * scaleFactor,
        };
      });

      const speaker = selectSpeakerFace(scaled, prevCenterX, videoWidth);
      if (!speaker) continue;

      // The fps filter emits frames at 0, 1/sampleFps, 2/sampleFps, ...
      rawPoints.push({
        t: i / sampleFps,
        x: speaker.centerX,
        y: speaker.centerY,
      });
      scores.push(speaker.score);
      prevCenterX = speaker.centerX;
    }

    // Keep the vertical centre; for a landscape source this is normally 0 anyway.
    const cropY = evenSize(Math.max(0, Math.floor((videoHeight - cropH) / 2)), 0);

    // Decimate in the SAME space the ffmpeg expression lives in (clamped X):
    // a keyframe is only redundant if the clamped interpolation is flat.
    const clampX = (x: number): number =>
      Math.max(0, Math.min(Math.round(x - cropW / 2), videoWidth - cropW));
    let points = decimateTrack(smoothTrack(rawPoints, videoWidth), clampX);
    let staticCropX = evenSize(Math.max(0, Math.min(videoWidth - cropW, Math.round(videoWidth / 2 - cropW / 2))), 0);
    let confidence: number | undefined;

    if (rawPoints.length === 0) {
      /**
       * No detection at all: fall back to a static centred crop instead of
       * failing the job. (Previously this threw, so any landscape/b-roll
       * segment could never render.)
       */
      log.warn('No subject detected in the sampled frames - using a static centred 9:16 crop.');
      method = 'center-fallback';
      points = [];
    } else {
      confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;
      staticCropX = evenSize(
        Math.max(0, Math.min(videoWidth - cropW, Math.round(points[points.length - 1].x - cropW / 2))),
        0
      );
      if (maxFacesSeen > 1) {
        log.detail(`Multiple people detected (max ${maxFacesSeen} in one frame) - following the speaker.`);
      }
    }

    const firstX = points.length > 0 ? Math.round(points[0].x) : Math.round(videoWidth / 2);
    const lastX = points.length > 0 ? Math.round(points[points.length - 1].x) : Math.round(videoWidth / 2);
    log.ok(
      `face track: ${points.length ? `pan ${firstX}→${lastX}px` : 'static crop'} across ${points.length} keyframes ` +
      `(method=${method}, frames=${rawPoints.length}/${frameFiles.length}` +
      `${maxFacesSeen > 0 ? `, people=${maxFacesSeen}` : ''}` +
      `${confidence !== undefined ? `, confidence=${confidence.toFixed(2)}` : ''})`
    );

    return {
      cropW,
      cropH,
      cropY,
      staticCropX,
      points,
      maxFacesSeen,
      framesUsed: rawPoints.length,
      framesTotal: frameFiles.length,
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
