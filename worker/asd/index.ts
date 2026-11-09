import path from 'path';
import { Jimp } from 'jimp';
import { AppError, RenderCancelledError, toErrorMessage } from '../../lib/errors';
import { log } from '../../lib/logger';
import {
  cleanupSampledFrames,
  sampleSegmentFrames,
} from '../frame-sampler';
import { detectFacesYunet, loadYuNet, yunetModelPresent, type YuNetRuntime } from '../yunet-detector';
import { computeVoiceEnvelope, extractPcmMono } from './audio';
import { Tracker, Track, FrameDetection } from './tracker';
import { SpeakerSegment, buildSpeakerTimeline } from './speaker';
import {
  ASD_QUALITY_SAMPLE_WIDTH,
  buildAsdSamplingPlan,
  getAdaptiveAsdSamplingEnabled,
  getAsdDetectionConcurrency,
  getAsdInitialProfile,
  getAsdQualityFallbackReason,
  getAsdSkipFullFrameOnWideShotsEnabled,
  interpolateTracksForAnalysis,
  type AsdSamplingProfile,
} from './sampling';
import {
  buildAsdResultCacheKey,
  getAsdCacheSettings,
  getAsdSourceIdentity,
  readAsdResultCache,
  readAsdSourceProfile,
  writeAsdResultCache,
  writeAsdSourceProfile,
} from './cache';

/**
 * Active Speaker Detection (ASD) pipeline for one clip window.
 *
 *   sample frames (mirrored) ─┐
 *   extract audio envelope  ──┼──>  per-frame faces (OpenCV YUNET)
 *                              │        │  + full-face & mouth-region motion
 *                              │        v
 *                              │   multi-face TRACKER (stable Person A/B/C ids)
 *                              │        │
 *                              │        v
 *                              └──>  MULTI-CUE AUDIO+VISUAL FUSION -> speaker timeline
 *
 * Face DETECTION is OpenCV YuNet (`face_detection_yunet_2023mar.onnx` via
 * onnxruntime-node - `npm run setup:yunet`), replacing the old face-api
 * tiny_face_detector. Everything else stays local and free: the "who is
 * talking" gate is multi-cue DSP (audio↔motion correlation, motion energy,
 * optional mouth cue, prominence, continuity - see ./speaker.ts), and the
 * tracker is identity-free nearest-neighbour - no face recognition, no cloud.
 *
 * Cost model: the ordinary adaptive pass samples at <=4 fps (bounded by 240
 * frames) on 960px JPEGs, then fills adjacent face sightings onto the 8fps
 * speaker/layout cadence without inventing motion. If face evidence is still
 * weak, it retries the established <=8fps, 960px, 480-frame quality profile
 * before a layout is chosen and remembers that source's quality preference.
 * The legacy 640px first pass remains an explicit env rollback.
 */

export interface AsdResult {
  /** Every tracked person (points in MIRRORED source pixels, t clip-relative). */
  tracks: Track[];
  /** Per-time active speaker (merged runs). */
  speakerSegments: SpeakerSegment[];
  /** Distinct people who were ever the active speaker. */
  speakerCount: number;
  method: 'yunet+audio-visual' | 'yunet-visual' | 'yunet';
  hasLandmarks: boolean;
  hasAudio: boolean;
  /** Busiest frame (how many faces at once). */
  maxFacesSeen: number;
  framesUsed: number;
  framesTotal: number;
  /** Detector sampling cadence; fast profiles may interpolate positions onto a denser analysis grid. */
  sampleFps: number;
  /** Share of sampled frames that were voiced (0..1). */
  voicedRatio: number;
  /** Sampled frames in which TWO OR MORE faces were detected at once. */
  framesWithMultipleFaces?: number;
  /** Median detected face width over all sightings, in SOURCE pixels. */
  medianFaceWidth?: number;
  /** Width (px) of the frames the detector saw. */
  sampleWidth?: number;
}

export type AsdTimingStage =
  | "ffmpeg-frame-extraction"
  | "audio-envelope"
  | "yunet-detection"
  | "tracking-speaker-fusion";
export type AsdStageTimingReporter = (stage: AsdTimingStage, elapsedMs: number) => void;

export interface AsdOptions {
  /** False when the source has no audio stream. */
  hasAudio: boolean;
  /** Upper bound on the quality-frame sampling fps (default 8). */
  maxSampleFps?: number;
  /** Upper bound on quality-frame samples (default 480). */
  maxFrames?: number;
  /** Override adaptive sampling; omitted follows ASD_ADAPTIVE_SAMPLING. */
  adaptiveSampling?: boolean;
  /** Worker-owned cancellation signal forwarded to frame/audio extraction. */
  signal?: AbortSignal;
  /** Optional per-substage timing sink; caller owns aggregation into job timing. */
  onStageTiming?: AsdStageTimingReporter;
}

function reportAsdStageTiming(
  report: AsdOptions["onStageTiming"],
  stage: AsdTimingStage,
  elapsedMs: number,
): void {
  if (!report) return;
  try {
    report(stage, elapsedMs);
  } catch (error) {
    // Observability must never turn an otherwise valid render into a failure.
    log.warn(`ASD timing reporter failed for ${stage}: ${toErrorMessage(error)}`);
  }
}

async function measureAsdStage<T>(
  options: Pick<AsdOptions, "onStageTiming">,
  stage: AsdTimingStage,
  operation: () => Promise<T> | T,
): Promise<T> {
  const startedAt = options.onStageTiming ? Date.now() : 0;
  try {
    return await operation();
  } finally {
    reportAsdStageTiming(options.onStageTiming, stage, Date.now() - startedAt);
  }
}

/** Kept as the public name for callers that describe the quality scan width. */
export const ASD_SAMPLE_WIDTH = ASD_QUALITY_SAMPLE_WIDTH;
const THUMB = 16;

/** 16x16 grayscale thumbnail of a face region (scale-invariant motion cue). */
function faceThumb(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number
): number[] {
  const thumb: number[] = new Array(THUMB * THUMB).fill(0);
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return thumb;
  for (let ty = 0; ty < THUMB; ty += 1) {
    const sy = Math.min(y1 - 1, y0 + Math.floor(((y1 - y0) * ty) / THUMB));
    for (let tx = 0; tx < THUMB; tx += 1) {
      const sx = Math.min(x1 - 1, x0 + Math.floor(((x1 - x0) * tx) / THUMB));
      const i = (sy * width + sx) * 4;
      thumb[ty * THUMB + tx] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }
  }
  return thumb;
}

/** Mean absolute thumbnail difference, normalised to 0..1. */
function thumbDiff(a: number[] | null, b: number[]): number {
  if (!a || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return Math.min(1, Math.max(0, sum / a.length / 255));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface FrameAnalysis {
  tracks: Track[];
  maxFacesSeen: number;
  /** Frames with at least one face; kept as the historical `framesUsed` metric. */
  framesUsed: number;
  framesWithMultipleFaces: number;
  faceWidthsSource: number[];
  faceWidthsSample: number[];
}

/**
 * Run the expensive per-image YuNet/motion/tracker work for one sampling pass.
 * It deliberately has no audio or layout concerns so an adaptive quality retry
 * can reuse already-decoded PCM and only repeat the work that needs sharper
 * frames.
 */
interface DetectedSampleFrame {
  index: number;
  width: number;
  height: number;
  data: Buffer | Uint8Array;
  scaleFactor: number;
  faces: Array<{ cx: number; cy: number; w: number; h: number }>;
  sampleFaceWidths: number[];
}

async function decodeAndDetectSampleFrame(
  framePath: string,
  index: number,
  videoWidth: number,
  runtime: YuNetRuntime,
  includeFullFrame: boolean,
): Promise<DetectedSampleFrame> {
  const image = await Jimp.read(framePath);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const data = image.bitmap.data;
  const scaleFactor = videoWidth / Math.max(1, width);
  const detections = await detectFacesYunet(
    runtime,
    { data, width, height },
    { includeFullFrame },
  );
  return {
    index,
    width,
    height,
    data,
    scaleFactor,
    faces: detections.map((d) => ({
      cx: (d.box.x + d.box.width / 2) * scaleFactor,
      cy: (d.box.y + d.box.height / 2) * scaleFactor,
      w: d.box.width * scaleFactor,
      h: d.box.height * scaleFactor,
    })),
    sampleFaceWidths: detections.map((d) => d.box.width),
  };
}

async function analyzeSampledFrames(
  frames: string[],
  sampleFps: number,
  videoWidth: number,
  runtime: YuNetRuntime,
  signal?: AbortSignal,
  onStageTiming?: AsdOptions["onStageTiming"],
  detectionConcurrency = 1,
  skipFullFrameOnWideShots = false,
): Promise<FrameAnalysis> {
  const tracker = new Tracker();
  let maxFacesSeen = 0;
  let framesUsed = 0;
  let framesWithMultipleFaces = 0;
  const faceWidthsSource: number[] = [];
  const faceWidthsSample: number[] = [];
  let prevThumbs: Array<{ cx: number; cy: number; w: number; full: number[]; mouth: number[] }> = [];
  const measureTimings = Boolean(onStageTiming);
  let yunetDetectionMs = 0;
  let trackingAndFusionMs = 0;
  const boundedDetectionConcurrency = Math.max(1, Math.min(3, Math.floor(detectionConcurrency) || 1));
  let recentSmallFaceFrames = 0;

  try {
    for (let batchStart = 0; batchStart < frames.length; batchStart += boundedDetectionConcurrency) {
      if (signal?.aborted) throw new RenderCancelledError();
      const batchEnd = Math.min(frames.length, batchStart + boundedDetectionConcurrency);
      // Wait for three recent small-face frames before dropping the full-frame
      // pass. A miss resets the streak, so close-ups and scene changes return to
      // the conservative all-pass detector immediately.
      const includeFullFrame = !skipFullFrameOnWideShots || recentSmallFaceFrames < 3;
      const detectionStartedAt = measureTimings ? Date.now() : 0;
      let detected: DetectedSampleFrame[];
      try {
        detected = await Promise.all(
          Array.from({ length: batchEnd - batchStart }, (_, offset) => {
            const index = batchStart + offset;
            if (signal?.aborted) throw new RenderCancelledError();
            return decodeAndDetectSampleFrame(
              frames[index],
              index,
              videoWidth,
              runtime,
              includeFullFrame,
            );
          }),
        );
      } finally {
        if (measureTimings) yunetDetectionMs += Date.now() - detectionStartedAt;
      }

      // Detector work above is bounded and concurrent; all stateful tracker and
      // speaker evidence below remains ordered by the source frame index.
      for (const sample of detected!) {
        if (signal?.aborted) throw new RenderCancelledError();
        const trackingStartedAt = measureTimings ? Date.now() : 0;
        try {
          const t = sample.index / sampleFps;
          const { width, height, data, scaleFactor, faces, sampleFaceWidths } = sample;
          faceWidthsSample.push(...sampleFaceWidths);

          // No skin-heuristic fallback here by design: a frame YuNet misses simply
          // contributes no track points (the tracker ages it out). If the WHOLE
          // window yields no face, detectSpeakerTimeline throws rather than faking a
          // static/centre crop.
          maxFacesSeen = Math.max(maxFacesSeen, faces.length);
          if (faces.length > 1) framesWithMultipleFaces += 1;
          for (const face of faces) faceWidthsSource.push(face.w);

          const widestSampleFace = sampleFaceWidths.reduce((widest, width) => Math.max(widest, width), 0);
          if (faces.length > 0 && widestSampleFace > 0 && widestSampleFace < width * 0.1) {
            recentSmallFaceFrames += 1;
          } else {
            recentSmallFaceFrames = 0;
          }

          if (faces.length === 0) {
            tracker.update(t, []);
            prevThumbs = [];
            continue;
          }

          // Full-face + mouth-region (lower third) thumbnails: the mouth channel is
          // the sharper cue when lips are visible; the full-face channel continues
          // working when a mic, mask or hand covers them.
          const curThumbs = faces.map((face) => {
            const boxX = face.cx / scaleFactor - (face.w / scaleFactor) / 2;
            const boxY = face.cy / scaleFactor - (face.h / scaleFactor) / 2;
            const boxW = face.w / scaleFactor;
            const boxH = face.h / scaleFactor;
            const full = faceThumb(data, width, height, boxX, boxY, boxW, boxH);
            const mouth = faceThumb(data, width, height, boxX, boxY + boxH * 0.55, boxW, boxH * 0.45);
            return { cx: face.cx, cy: face.cy, w: face.w, full, mouth };
          });

          const detections: FrameDetection[] = faces.map((face, faceIndex) => {
            // Two-frame nearest-neighbour motion (no long-term identity needed).
            let bestPrev: (typeof prevThumbs)[number] | null = null;
            let bestDist = Infinity;
            for (const previous of prevThumbs) {
              const distance = Math.hypot(face.cx - previous.cx, face.cy - previous.cy);
              if (distance < bestDist && distance < 0.6 * (face.w + previous.w)) {
                bestDist = distance;
                bestPrev = previous;
              }
            }
            const motion = bestPrev
              ? 0.6 * thumbDiff(bestPrev.full, curThumbs[faceIndex].full) +
                0.4 * thumbDiff(bestPrev.mouth, curThumbs[faceIndex].mouth)
              : null;
            return {
              cx: face.cx,
              cy: face.cy,
              w: face.w,
              mouthOpen: null, // YuNet has no mouth landmarks; the fusion treats this as no cue.
              motion,
            };
          });

          tracker.update(t, detections);
          prevThumbs = curThumbs;
          framesUsed += 1;
        } finally {
          if (measureTimings) trackingAndFusionMs += Date.now() - trackingStartedAt;
        }
      }
    }

    const mergeStartedAt = measureTimings ? Date.now() : 0;
    try {
      return {
        tracks: mergeTrackFragments(tracker.allVisible()),
        maxFacesSeen,
        framesUsed,
        framesWithMultipleFaces,
        faceWidthsSource,
        faceWidthsSample,
      };
    } finally {
      if (measureTimings) trackingAndFusionMs += Date.now() - mergeStartedAt;
    }
  } finally {
    reportAsdStageTiming(onStageTiming, "yunet-detection", yunetDetectionMs);
    reportAsdStageTiming(onStageTiming, "tracking-speaker-fusion", trackingAndFusionMs);
  }
}

/** Two tracks "co-exist" when both are seen around the same sampled frame. */
function tracksCoExist(a: Track, b: Track, eps = 0.3): boolean {
  let i = 0;
  let j = 0;
  while (i < a.points.length && j < b.points.length) {
    const dt = a.points[i].t - b.points[j].t;
    if (Math.abs(dt) <= eps) return true;
    if (dt < 0) i += 1;
    else j += 1;
  }
  return false;
}

function trackCenter(track: Track): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of track.points) {
    x += p.cx;
    y += p.cy;
  }
  const n = Math.max(1, track.points.length);
  return { x: x / n, y: y / n };
}

/**
 * Merge FRAGMENTED tracks: the same person re-identified after a long occlusion
 * (mic swing, hand, profile turn) leaves the tracker with two ids for one
 * face. Two tracks that are NEVER on screen at the same time and sit within
 * ~1.6 face-widths of each other are the same person - without this, a
 * two-person video can light up as a 4-cell split (one cell per fragment).
 */
export function mergeTrackFragments(tracks: Track[]): Track[] {
  const out = [...tracks];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];
        if (tracksCoExist(a, b)) continue;
        const ca = trackCenter(a);
        const cb = trackCenter(b);
        const gate = 1.6 * Math.max(a.maxW, b.maxW);
        if (Math.hypot(ca.x - cb.x, ca.y - cb.y) > gate) continue;

        const points = [...a.points, ...b.points].sort((p, q) => p.t - q.t);
        const last = points[points.length - 1];
        const nA = a.points.length;
        const nB = b.points.length;
        out[i] = {
          id: a.id,
          points,
          visibleTime: a.visibleTime + b.visibleTime,
          avgW: (a.avgW * nA + b.avgW * nB) / Math.max(1, nA + nB),
          maxW: Math.max(a.maxW, b.maxW),
          cx: last.cx,
          cy: last.cy,
          vx: a.vx,
          vy: a.vy,
          lastT: Math.max(a.lastT, b.lastT),
          missed: 0,
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}

export async function detectSpeakerTimeline(
  videoPath: string,
  start: number,
  duration: number,
  videoWidth: number,
  videoHeight: number,
  options: AsdOptions
): Promise<AsdResult> {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    throw new AppError('Cannot run speaker detection without a valid source resolution.', {
      status: 400,
      details: `width=${videoWidth}, height=${videoHeight}`,
      resolution: 'Re-upload the video so FFmpeg can read its resolution.',
    });
  }

  if (options.signal?.aborted) throw new RenderCancelledError();
  const adaptiveSampling = options.adaptiveSampling ?? getAdaptiveAsdSamplingEnabled();
  const requestedInitialProfile = getAsdInitialProfile();
  const detectionConcurrency = getAsdDetectionConcurrency();
  const skipFullFrameOnWideShots = getAsdSkipFullFrameOnWideShotsEnabled();
  const cacheSettings = getAsdCacheSettings();
  const sourceIdentity = getAsdSourceIdentity(videoPath);
  // A source that genuinely needed the full quality profile once should not
  // spend every later clip repeating a known-failing first pass. Explicit env
  // profile choices always win over this learned, source-scoped preference.
  const rememberedProfile =
    adaptiveSampling && requestedInitialProfile === "balanced"
      ? readAsdSourceProfile(cacheSettings, sourceIdentity)
      : null;
  const samplingPlan = buildAsdSamplingPlan({
    sourceWidth: videoWidth,
    maxSampleFps: options.maxSampleFps,
    maxFrames: options.maxFrames,
    adaptive: adaptiveSampling,
    initialProfile: rememberedProfile ?? requestedInitialProfile,
  });
  // Use the requested profile in the result-cache identity. A balanced run that
  // escalated to quality is still the correct reusable answer for future
  // balanced requests, even after the source preference has been remembered.
  const cacheKey = sourceIdentity
    ? buildAsdResultCacheKey({
        source: sourceIdentity,
        start,
        duration,
        videoWidth,
        videoHeight,
        hasAudio: options.hasAudio,
        adaptive: adaptiveSampling,
        initialProfile: requestedInitialProfile,
        maxSampleFps: options.maxSampleFps,
        maxFrames: options.maxFrames,
        detectionConcurrency,
        skipFullFrameOnWideShots,
      })
    : null;
  if (cacheKey) {
    const cached = readAsdResultCache(cacheSettings, cacheKey);
    if (cached) {
      log.info(
        `[ASD-CACHE] event=hit profile=${requestedInitialProfile} source=${sourceIdentity?.key.slice(0, 12)} ` +
          `window=${start.toFixed(3)}+${duration.toFixed(3)}s`,
      );
      return cached;
    }
  }
  if (cacheSettings.enabled) {
    log.info(
      `[ASD-CACHE] event=miss profile=${requestedInitialProfile} source=${sourceIdentity?.key.slice(0, 12) ?? "unavailable"} ` +
        `window=${start.toFixed(3)}+${duration.toFixed(3)}s`,
    );
  }

  let frames: string[] = [];
  let sampleFps = 0;
  let sampleWidth = samplingPlan.initial.sampleWidth;
  try {
    const sampleWithProfile = (profile: AsdSamplingProfile, prefix: string) =>
      measureAsdStage(options, "ffmpeg-frame-extraction", () =>
        sampleSegmentFrames(
          videoPath,
          start,
          duration,
          profile.maxFps,
          profile.maxFrames,
          prefix,
          profile.sampleWidth,
          options.signal,
          profile.jpegQuality,
        ),
      );

    const initial = samplingPlan.initial;
    log.detail(
      `ASD · ${initial.name} sampling up to ${initial.maxFrames} frames @ <=${initial.maxFps}fps ` +
      `on ${initial.sampleWidth}px JPEG q=${initial.jpegQuality} + audio envelope ` +
      `(window ${start.toFixed(1)}s +${duration.toFixed(1)}s)`,
    );

    // Frame extraction, PCM extraction and loading the one process-wide YuNet
    // session are independent. Starting them together removes idle wall time.
    const [initialSampled, pcm, runtime] = await Promise.all([
      sampleWithProfile(
        initial,
        initial.name === "fast"
          ? "frames-legacy-fast"
          : initial.name === "balanced"
            ? "frames-balanced"
            : "frames",
      ),
      measureAsdStage(options, "audio-envelope", () =>
        options.hasAudio
          ? extractPcmMono(videoPath, start, duration, 16000, options.signal)
          : Promise.resolve(new Int16Array(0)),
      ),
      loadYuNet(),
    ]);
    if (options.signal?.aborted) throw new RenderCancelledError();
    frames = initialSampled.frames;
    sampleFps = initialSampled.fps;
    sampleWidth = initial.sampleWidth;

    // Missing model -> a clear error. There is no unrelated detector fallback:
    // if no face can be detected the render stops rather than centring blindly.
    if (!runtime) {
      throw new AppError(
        `YuNet face detection is unavailable${yunetModelPresent() ? '' : ' (model not found)'}.`,
        {
          details: 'Run "npm run setup:yunet" to download face_detection_yunet_2023mar.onnx.',
          resolution: 'Run "npm run setup:yunet" (or set YUNET_MODEL_PATH) and re-render the clip.',
        }
      );
    }

    let profile = initial;
    let analysis = await analyzeSampledFrames(
      frames,
      sampleFps,
      videoWidth,
      runtime,
      options.signal,
      options.onStageTiming,
      detectionConcurrency,
      skipFullFrameOnWideShots,
    );

    const fallbackReason = samplingPlan.qualityFallback
      ? getAsdQualityFallbackReason({
          framesTotal: frames.length,
          framesWithFaces: analysis.framesUsed,
          tracks: analysis.tracks.length,
          medianSampleFaceWidth: medianOf(analysis.faceWidthsSample),
        })
      : null;
    if (fallbackReason && samplingPlan.qualityFallback) {
      const fallback = samplingPlan.qualityFallback;
      log.warn(
        `ASD · ${profile.name} sampling quality fallback (${fallbackReason}); retrying ` +
        `${fallback.maxFrames} frames @ <=${fallback.maxFps}fps on ${fallback.sampleWidth}px.`,
      );
      if (writeAsdSourceProfile(cacheSettings, sourceIdentity, "quality")) {
        log.detail("ASD · remembered the quality profile for this immutable source identity.");
      }
      if (frames[0]) cleanupSampledFrames(path.dirname(frames[0]));
      frames = [];

      const qualitySampled = await sampleWithProfile(fallback, 'frames-quality');
      if (options.signal?.aborted) throw new RenderCancelledError();
      frames = qualitySampled.frames;
      sampleFps = qualitySampled.fps;
      sampleWidth = fallback.sampleWidth;
      profile = fallback;
      analysis = await analyzeSampledFrames(
        frames,
        sampleFps,
        videoWidth,
        runtime,
        options.signal,
        options.onStageTiming,
        detectionConcurrency,
        skipFullFrameOnWideShots,
      );
    }

    if (analysis.tracks.length === 0) {
      throw new AppError(
        `No faces were detected in this clip window (0 of ${frames.length} sampled frames contained a face).`,
        {
          details:
            'The 9:16 layouts crop and pan around detected faces, and no fallback detector is used - the render stops here instead of producing a static centre crop.',
          resolution:
            'Make sure a face is visible and well lit in this part of the video (avoid extreme angles, heavy occlusion or a tiny face in a very wide shot), or pick a different window, then re-render the clip.',
        }
      );
    }

    // The quality/rollback path preserves its historical cadence exactly. Every
    // bounded initial profile promotes only adjacent face positions to the old
    // 8fps analysis grid; synthetic points carry no motion so they cannot
    // manufacture a speaker decision.
    const analysisFps =
      profile.name !== "quality" ? Math.max(sampleFps, samplingPlan.analysisFps) : sampleFps;
    const voice = await measureAsdStage(options, "audio-envelope", () =>
      pcm.length > 0
        ? computeVoiceEnvelope(pcm, 16000, analysisFps).voice
        : new Array(Math.max(1, Math.round(duration * analysisFps))).fill(0),
    );
    const { tracks, segments, speakerCount } = await measureAsdStage(
      options,
      "tracking-speaker-fusion",
      () => {
        const tracks = interpolateTracksForAnalysis(analysis.tracks, sampleFps, analysisFps);
        const { segments, speakerCount } = buildSpeakerTimeline({
          duration,
          fps: analysisFps,
          voice,
          tracks,
          frameWidth: videoWidth,
        });
        return { tracks, segments, speakerCount };
      },
    );

    const voicedRatio =
      voice.length > 0 ? voice.filter((v) => v >= 0.18).length / voice.length : 0;
    const medianFaceWidth = medianOf(analysis.faceWidthsSource);
    const facePct = frames.length > 0 ? Math.round((analysis.framesUsed / frames.length) * 100) : 0;

    log.ok(
      `ASD: ${tracks.length} person(s) tracked${analysis.maxFacesSeen > 1 ? `, ${analysis.maxFacesSeen} on screen at once` : ''}, ` +
      `${speakerCount} active speaker(s), ${Math.round(voicedRatio * 100)}% voiced, ` +
      `frames=${analysis.framesUsed}/${frames.length}, detector_fps=${sampleFps.toFixed(2)}, ` +
      `analysis_fps=${analysisFps.toFixed(2)}, profile=${profile.name}, ` +
      `cue=multi-cue (audio↔motion + energy + prominence + continuity)`,
    );
    log.detail(
      `  detection: faces in ${facePct}% of sampled frames` +
      (analysis.framesWithMultipleFaces > 0
        ? `, 2+ faces together in ${Math.round((analysis.framesWithMultipleFaces / Math.max(1, frames.length)) * 100)}%`
        : '') +
      `, median face ${Math.round(medianFaceWidth)}px ` +
      `(${((medianFaceWidth / videoWidth) * 100).toFixed(1)}% of the ${videoWidth}px frame), ` +
      `scanned on ${sampleWidth}px frames`,
    );
    if (frames.length >= 8 && analysis.framesUsed / frames.length < 0.25) {
      log.warn(
        `Faces were found in only ${analysis.framesUsed} of ${frames.length} sampled frames - the framing will ` +
        `be unreliable. The people may be very small, dark, turned away or covered in this window.`,
      );
    }

    for (const track of tracks) {
      const third = videoWidth / 3;
      const avgX = Math.round(
        track.points.reduce((sum, point) => sum + point.cx, 0) / track.points.length,
      );
      const side = avgX < third ? 'LEFT' : avgX > third * 2 ? 'RIGHT' : 'centre';
      log.detail(
        `  person#${track.id}: visible ${track.visibleTime.toFixed(1)}s, ` +
        `avg face ${Math.round(track.avgW)}px, ${track.points.length} sightings, ` +
        `sits ${side} (avg x=${avgX} of ${videoWidth})`,
      );
    }

    const method: AsdResult['method'] = options.hasAudio
      ? 'yunet+audio-visual'
      : 'yunet-visual';

    const result: AsdResult = {
      tracks,
      speakerSegments: segments,
      speakerCount,
      method,
      hasLandmarks: false, // no mouth-landmark cue from YuNet (5-point only)
      hasAudio: pcm.length > 0,
      maxFacesSeen: analysis.maxFacesSeen,
      framesUsed: analysis.framesUsed,
      framesTotal: frames.length,
      sampleFps,
      voicedRatio,
      framesWithMultipleFaces: analysis.framesWithMultipleFaces,
      medianFaceWidth,
      sampleWidth,
    };
    if (cacheKey && writeAsdResultCache(cacheSettings, cacheKey, result)) {
      log.info(
        `[ASD-CACHE] event=write profile=${requestedInitialProfile} source=${sourceIdentity?.key.slice(0, 12)} ` +
          `window=${start.toFixed(3)}+${duration.toFixed(3)}s`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RenderCancelledError || options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof AppError) throw error;
    throw new AppError('Speaker detection failed.', {
      details: toErrorMessage(error),
      resolution: 'Inspect the sampled-frame and audio-extract FFmpeg commands in the worker log, and retry.',
    });
  } finally {
    // sampleSegmentFrames keeps the dir alive for the caller; clean it here.
    if (frames.length > 0) {
      cleanupSampledFrames(path.dirname(frames[0]));
    }
  }
}
