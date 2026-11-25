import path from "path";
import { Jimp } from "jimp";
import {
  AppError,
  RenderCancelledError,
  toErrorMessage,
} from "../../lib/errors";
import { log } from "../../lib/logger";
import { cleanupSampledFrames, sampleSegmentFrames } from "../frame-sampler";
import {
  detectFacesYunet,
  loadYuNet,
  yunetModelPresent,
  type YuNetRuntime,
} from "../yunet-detector";
import {
  detectPersonsYolox,
  getPersonDetectorSettings,
  loadYolox,
  matchPersonsToLostTracks,
  personBoxToFaceEstimate,
  yoloxModelPath,
  shouldRunPersonDetectorForGap,
  yoloxModelPresent,
  type PersonDetectorSettings,
  type YoloxRuntime,
} from "../person-detector";
import { computeMfcc } from "./mfcc";
import {
  lrAsdLikelihood,
  lrAsdModelPresent,
  loadLrAsd,
  scoreLrAsdWindow,
  LR_ASD_FPS,
  type LrAsdRuntime,
} from "./lr-asd";
import type { AmbiguousWindow, SpeakerTimelineInput } from "./speaker";
import { computeVoiceEnvelope, extractPcmMono } from "./audio";
import {
  effectiveFaceMotion,
  includePersistentCoVisibleCompanions,
  isCameraUsableTrack,
  isLikelyLiveTrack,
  Tracker,
  Track,
  TrackPoint,
  FrameDetection,
} from "./tracker";
import { SpeakerSegment, buildSpeakerTimeline } from "./speaker";
import { detectShotCuts } from "./shot-cuts";
import {
  ASD_QUALITY_SAMPLE_WIDTH,
  buildAsdSamplingPlan,
  getAdaptiveAsdSamplingEnabled,
  getAsdDetectionConcurrency,
  getAsdInitialProfile,
  getAsdSkipFullFrameOnWideShotsEnabled,
  interpolateTracksForAnalysis,
  type AsdSamplingProfile,
} from "./sampling";
import {
  buildAsdResultCacheKey,
  getAsdCacheSettings,
  getAsdSourceIdentity,
  readAsdResultCache,
  readAsdSourceProfile,
  writeAsdResultCache,
} from "./cache";

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
  /** Motion-qualified face tracks (points in MIRRORED source pixels, t clip-relative). */
  tracks: Track[];
  /** Per-time active speaker (merged runs). */
  speakerSegments: SpeakerSegment[];
  /** Distinct people who were ever the active speaker. */
  speakerCount: number;
  method: "yunet+audio-visual" | "yunet-visual" | "yunet";
  hasLandmarks: boolean;
  hasAudio: boolean;
  /** Peak concurrent motion-qualified face tracks. */
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
  /**
   * Source SHOT CUTS inside the window (clip-relative seconds, the first frame
   * after each cut), from the scene probe that runs beside frame extraction.
   * The speaker camera switches on these exact frames and never interpolates
   * across one. Empty when none were found (or the probe was disabled).
   */
  shotCuts?: number[];
  /**
   * Source cuts that CLOSED the face tracker. Every identity (and therefore every
   * camera position) restarts on the first frame of a new shot, so a re-framed
   * speaker can never inherit the previous angle's coordinates.
   */
  cutsApplied?: number;
  /**
   * Gap frames on which the YOLOX person detector ran (only frames where a face
   * was lost). 0 means it never ran - the ordinary case.
   */
  personFramesUsed?: number;
  /**
   * Face sightings kept alive by a body box while the person was turned away.
   * These frames carry NO face pixels, so they extend identity and framing only.
   */
  personHolds?: number;
  /** Body-box-only extra hold applied to lost faces, in seconds (0 = disabled). */
  personHoldSeconds?: number;
  /** Windows the cheap fusion could not settle (candidates for the LR-ASD cue). */
  ambiguousWindows?: number;
  /** Ambiguous windows the LR-ASD model actually decided. */
  lrAsdWindows?: number;
  /** Empty-window runs skipped because the window showed no face at all. */
  skipEmptyLrAsdWindows?: boolean;
}

export type AsdTimingStage =
  | "ffmpeg-frame-extraction"
  | "audio-envelope"
  | "yunet-detection"
  | "tracking-speaker-fusion"
  | "shot-cut-detection"
  | "person-detection"
  | "lr-asd";
export type AsdStageTimingReporter = (
  stage: AsdTimingStage,
  elapsedMs: number,
) => void;

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
    log.warn(
      `ASD timing reporter failed for ${stage}: ${toErrorMessage(error)}`,
    );
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

/**
 * Source shot-cut detection is always safe (a failure means "no cuts", the camera
 * then simply never has to switch on one), so it runs by default on the SAME
 * window as the frame extraction. `SHOT_CUT_DETECTION=0` skips the probe.
 */
export function getShotCutDetectionSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { enabled: boolean; threshold: number; minGapSeconds: number } {
  const disabled = /^(0|false|no|off)$/i.test(env.SHOT_CUT_DETECTION?.trim() ?? "");
  const threshold = Number(env.SHOT_CUT_THRESHOLD?.trim());
  const minGap = Number(env.SHOT_CUT_MIN_GAP_SECONDS?.trim());
  return {
    enabled: !disabled,
    threshold: Number.isFinite(threshold) ? Math.max(0.05, Math.min(0.95, threshold)) : 0.3,
    minGapSeconds: Number.isFinite(minGap) ? Math.max(0.1, Math.min(10, minGap)) : 0.5,
  };
}
/**
 * LR-ASD cost/behaviour knobs. Default ON when the exported model exists:
 *   LR_ASD_ENABLED=0        hard off (today's behaviour, byte for byte)
 *   LR_ASD_MAX_WINDOWS=24   ambiguous windows the model may decide per clip
 *   LR_ASD_MAX_FRAMES=75    crops per person per window (also the ONNX batch)
 *   LR_ASD_WEIGHT=0.25      weight of its verdict vs the cheap cues (0..0.5)
 */
export function getLrAsdSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { enabled: boolean; maxWindows: number; maxFrames: number; weight: number } {
  const disabled = /^(0|false|no|off)$/i.test(env.LR_ASD_ENABLED?.trim() ?? "");
  const windows = Number(env.LR_ASD_MAX_WINDOWS?.trim());
  const frames = Number(env.LR_ASD_MAX_FRAMES?.trim());
  const weight = Number(env.LR_ASD_WEIGHT?.trim());
  return {
    enabled: !disabled,
    maxWindows: Number.isFinite(windows) ? Math.max(0, Math.min(200, Math.floor(windows))) : 24,
    maxFrames: Number.isFinite(frames) ? Math.max(8, Math.min(400, Math.floor(frames))) : 75,
    weight: Number.isFinite(weight) ? Math.max(0, Math.min(0.5, weight)) : 0.25,
  };
}

/**
 * Does this clip even need the LR-ASD model? One cheap, model-free pass answers it:
 * build the speaker timeline with a referee that only *records* which windows the
 * cheap cues could not settle, then stop. Nothing is loaded, sampled or decoded
 * until that list is non-empty, so a clip with a clear speaker never pays for it.
 */
function collectAmbiguousWindows(input: SpeakerTimelineInput): AmbiguousWindow[] {
  const recorded: AmbiguousWindow[] = [];
  buildSpeakerTimeline({
    ...input,
    referee: {
      judge: (window) => {
        recorded.push(window);
        return null; // no verdict: the timeline is exactly the no-model one
      },
    },
  });
  return recorded;
}

/**
 * Ask LR-ASD about the ambiguous windows, within a hard budget, and return the
 * verdicts keyed by "t0|t1" for the referee lookup below.
 *
 * Cost control (mandatory):
 *   - at most `LR_ASD_MAX_WINDOWS` windows per clip, `LR_ASD_MAX_FRAMES` crops
 *     per person per window;
 *   - frames come from the ALREADY sampled JPEGs (no second FFmpeg pass), deduped
 *     through a per-clip decode cache;
 *   - a window whose people are not both visible in it is skipped;
 *   - the whole stage is reported through the existing `lr-asd` timing channel.
 */
async function judgeAmbiguousWindows(context: {
  windows: AmbiguousWindow[];
  settings: ReturnType<typeof getLrAsdSettings>;
  runtime: () => Promise<LrAsdRuntime | null>;
  window: { start: number; duration: number; pcm: Int16Array };
  mfcc: { features: Float32Array; frames: number };
  framePaths: string[];
  sampleFps: number;
  tracks: Track[];
  signal?: AbortSignal;
  onStageTiming?: AsdOptions["onStageTiming"];
}): Promise<Map<string, Map<number, number>>> {
  const verdicts = new Map<string, Map<number, number>>();
  const { settings } = context;
  if (!settings.enabled || settings.maxWindows <= 0) return verdicts;
  if (context.window.pcm.length === 0) return verdicts;
  if (context.windows.length === 0) return verdicts;
  const runtime = await context.runtime();
  if (!runtime) return verdicts;

  const frameCache = new Map<string, Promise<SampledFrame | null>>();
  const loadFrameAt = async (t: number): Promise<SampledFrame | null> => {
    const index = pickFrameIndex(context.framePaths.length, t, context.sampleFps);
    if (index === null) return null;
    const file = context.framePaths[index];
    let pending = frameCache.get(file);
    if (!pending) {
      pending = Jimp.read(file).then((image) => ({
        data: image.bitmap.data,
        width: image.bitmap.width,
        height: image.bitmap.height,
      }));
      frameCache.set(file, pending);
    }
    return pending;
  };

  let elapsedMs = 0;
  for (const window of context.windows) {
    if (verdicts.size >= settings.maxWindows) break;
    if (context.signal?.aborted) break;
    const candidates = window.trackIds
      .map((trackId) => {
        const track = context.tracks.find((candidate) => candidate.id === trackId);
        if (!track) return null;
        const frames = framesInside(track, window.t0, window.t1, 1 / LR_ASD_FPS);
        return frames.length > 0
          ? { trackId, frames }
          : null;
      })
      .filter(
        (
          entry,
        ): entry is {
          trackId: number;
          frames: Array<{ t: number; cx: number; cy: number; w: number; h: number }>;
        } => entry !== null,
      );
    if (candidates.length < 2) continue;

    const startedAt = Date.now();
    try {
      const scores = await scoreLrAsdWindow(
        runtime,
        {
          start: window.t0,
          duration: Math.max(0.2, window.t1 - window.t0),
          pcm: context.window.pcm,
          sampleRate: 16000,
          mfcc: context.mfcc,
          candidates,
        },
        (t: number) => loadFrameAt(t),
        { signal: context.signal, maxFrames: settings.maxFrames },
      );
      if (!scores) continue;
      const verdict = new Map<number, number>();
      for (const [trackId, mean] of scores.byTrack) {
        verdict.set(trackId, lrAsdLikelihood(mean));
      }
      verdicts.set(windowKey(window), verdict);
      log.detail(
        `  LR-ASD window ${window.t0.toFixed(2)}-${window.t1.toFixed(2)}s (${window.reason}): ` +
          [...verdict.entries()]
            .map(([trackId, value]) => `person#${trackId} ${(value * 100).toFixed(0)}%`)
            .join(", ") +
          ` (${scores.frames} crops)`,
      );
    } finally {
      elapsedMs += Date.now() - startedAt;
      reportAsdStageTiming(context.onStageTiming, "lr-asd", elapsedMs);
    }
  }
  return verdicts;
}

/**
 * The model-free first half of the two-pass coordinator, exported so the cost
 * behaviour is testable: it reports which windows are ambiguous (deduplicated) and
 * returns the timeline those windows produce WITHOUT any verdict - which is, by
 * construction, identical to the timeline of a build with no referee at all.
 */
export function planLrAsdWindows(
  input: SpeakerTimelineInput,
  options: { maxWindows?: number } = {},
): {
  ambiguous: AmbiguousWindow[];
  timeline: ReturnType<typeof buildSpeakerTimeline>;
  budget: number;
} {
  const ambiguous = uniqueWindows(collectAmbiguousWindows(input));
  const budget = Math.max(0, Math.min(200, Math.floor(options.maxWindows ?? Infinity)));
  return {
    ambiguous,
    timeline: buildSpeakerTimeline(input),
    budget,
  };
}

/** Stable identity for one ambiguous window (the fusion walks windows in order). */
function windowKey(window: { t0: number; t1: number }): string {
  return `${window.t0.toFixed(3)}|${window.t1.toFixed(3)}`;
}

/** Deduplicate identical windows so one ambiguous span is scored at most once. */
function uniqueWindows(windows: AmbiguousWindow[]): AmbiguousWindow[] {
  const seen = new Set<string>();
  const out: AmbiguousWindow[] = [];
  for (const window of windows) {
    const key = windowKey(window);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(window);
  }
  return out;
}


/** The sampled frame index whose timestamp is closest to `t` (null when empty). */
function pickFrameIndex(count: number, t: number, sampleFps: number): number | null {
  if (count <= 0 || !(sampleFps > 0)) return null;
  const index = Math.round(t * sampleFps);
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * Track points inside a window, re-sampled to `step` seconds. The LR-ASD crops
 * must come from the model's own 25 fps cadence; the pipeline only samples
 * 4-8 fps, so positions in between come from the track's own interpolation
 * (the same rule `interpolateTracksForAnalysis` uses) and the nearest sampled
 * JPEG supplies the pixels. This changes WHERE a crop is taken from, never what
 * is in it.
 */
function framesInside(
  track: Track,
  t0: number,
  t1: number,
  step: number,
): Array<{ t: number; cx: number; cy: number; w: number; h: number }> {
  const out: Array<{ t: number; cx: number; cy: number; w: number; h: number }> = [];
  const points = [...track.points].sort((a, b) => a.t - b.t);
  if (points.length === 0) return out;
  for (let t = t0; t < t1 - 1e-6; t += step) {
    let before: TrackPoint | null = null;
    let after: TrackPoint | null = null;
    for (const point of points) {
      if (point.t <= t + 1e-6) before = point;
      if (point.t >= t - 1e-6) {
        after = point;
        break;
      }
    }
    const useBefore = before ?? after;
    const useAfter = after ?? before;
    if (!useBefore || !useAfter) continue;
    const span = useAfter.t - useBefore.t;
    const fraction = span > 1e-6 ? Math.max(0, Math.min(1, (t - useBefore.t) / span)) : 0;
    const cx = useBefore.cx + (useAfter.cx - useBefore.cx) * fraction;
    const cy = useBefore.cy + (useAfter.cy - useBefore.cy) * fraction;
    const w = useBefore.w + (useAfter.w - useBefore.w) * fraction;
    out.push({ t, cx, cy, w, h: w });
  }
  return out;
}

const THUMB = 16;

/** 16x16 grayscale thumbnail of a face region (scale-invariant motion cue). */
function faceThumb(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
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
      thumb[ty * THUMB + tx] =
        (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
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

/**
 * Fraction of the face box's size the background ring extends beyond it.
 * 0.6 means the ring reaches 0.6 box-widths past the box on each side, which is
 * shoulder / wall / background territory for a face crop, while staying close
 * enough that a camera move affects box and ring equally.
 */
const BACKGROUND_RING_PAD = 0.6;

/** Ring cells whose thumbnail is (near) identical to a face-patch cell are skipped. */
const BACKGROUND_FACE_CELL_TOLERANCE = 10;

/**
 * 16x16 grayscale thumbnail of the background RING around a face box: the padded
 * rectangle around the face box with the face box itself cut out.
 *
 * The two are measured on the same grid, so a camera shake / zoom that translates
 * or scales the picture changes both by the same amount - exactly what makes the
 * difference between them a measure of INDEPENDENT motion. When a box is so close
 * to the frame edge that it has no ring at all, nothing is returned and the caller
 * keeps the plain face motion (no false "this is a poster" verdict).
 *
 * Two rejections keep the ring honest:
 *  - cells whose thumbnail value is within `BACKGROUND_FACE_CELL_TOLERANCE` of the
 *    face patch's value for that cell are dropped. A red face-detector box that
 *    hugs a head puts hair/cheeks in the ring, and those WOULD move with the face
 *    - counting them as "background" would hide a real person's motion;
 *  - a ring with fewer than a third of its cells left is treated as no ring.
 */
function backgroundRingThumb(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  faceThumbValues: number[],
): number[] | null {
  const pad = Math.max(2, Math.round(Math.max(w, h) * BACKGROUND_RING_PAD));
  const rx0 = Math.max(0, Math.round(x) - pad);
  const ry0 = Math.max(0, Math.round(y) - pad);
  const rx1 = Math.min(width, Math.round(x + w) + pad);
  const ry1 = Math.min(height, Math.round(y + h) + pad);
  if (rx1 - rx0 < 4 || ry1 - ry0 < 4) return null;

  // The padded rectangle must be meaningfully bigger than the face box, else
  // there is no background in it at all (box clipped by the frame edge).
  const ringArea = (rx1 - rx0) * (ry1 - ry0);
  const faceArea = Math.max(1, Math.min(width, Math.round(x + w)) - Math.max(0, Math.round(x)))
    * Math.max(1, Math.min(height, Math.round(y + h)) - Math.max(0, Math.round(y)));
  if (ringArea - faceArea < faceArea * 0.5) return null;

  const ring: number[] = new Array(THUMB * THUMB).fill(0);
  let kept = 0;
  for (let ty = 0; ty < THUMB; ty += 1) {
    const sy = Math.min(ry1 - 1, ry0 + Math.floor(((ry1 - ry0) * ty) / THUMB));
    for (let tx = 0; tx < THUMB; tx += 1) {
      const sx = Math.min(rx1 - 1, rx0 + Math.floor(((rx1 - rx0) * tx) / THUMB));

      // Is this sample point inside the face box? Then it is not background.
      const insideFace =
        sx >= Math.round(x) &&
        sx < Math.round(x) + Math.round(w) &&
        sy >= Math.round(y) &&
        sy < Math.round(y) + Math.round(h);
      if (insideFace) {
        ring[ty * THUMB + tx] = Number.NaN;
        continue;
      }

      const i = (sy * width + sx) * 4;
      const value = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      const faceCell = faceThumbValues?.[ty * THUMB + tx];
      if (
        Number.isFinite(faceCell) &&
        Math.abs(value - (faceCell as number)) <= BACKGROUND_FACE_CELL_TOLERANCE
      ) {
        ring[ty * THUMB + tx] = Number.NaN;
        continue;
      }
      ring[ty * THUMB + tx] = value;
      kept += 1;
    }
  }
  // Too little real background survived (a close-up filling the frame): no ring.
  if (kept < (THUMB * THUMB) / 3) return null;
  return ring;
}

/** Mean absolute difference of two ring thumbnails, skipping cut-out cells. */
function ringDiff(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    sum += Math.abs(av - bv);
    count += 1;
  }
  if (count === 0) return 0;
  return Math.min(1, Math.max(0, sum / count / 255));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Test-only view of the exact same measurement `analyzeSampledFrames` performs on
 * every sampled frame: the full-face + mouth thumbnails, the background-ring
 * thumbnail, and the resulting background-RELATIVE motion.
 *
 * `previous` is the previous sampled frame (null for the first sample, which then
 * reports motion null exactly like the pipeline does).
 */
export function measureFaceMotionForTests(
  previous: { data: ArrayLike<number>; width: number; height: number } | null,
  current: { data: ArrayLike<number>; width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
  /** The box the same face had in `previous` (defaults to `box`). */
  previousBox: { x: number; y: number; w: number; h: number } = box,
): {
  motion: number | null;
  faceMotion: number | null;
  backgroundMotion: number | null;
  ring: number[] | null;
} {
  const currentThumb = faceThumb(
    current.data,
    current.width,
    current.height,
    box.x,
    box.y,
    box.w,
    box.h,
  );
  const currentMouth = faceThumb(
    current.data,
    current.width,
    current.height,
    box.x,
    box.y + box.h * 0.55,
    box.w,
    box.h * 0.45,
  );
  const currentRing = backgroundRingThumb(
    current.data,
    current.width,
    current.height,
    box.x,
    box.y,
    box.w,
    box.h,
    currentThumb,
  );
  if (!previous) {
    return { motion: null, faceMotion: null, backgroundMotion: null, ring: currentRing };
  }
  const previousThumb = faceThumb(
    previous.data,
    previous.width,
    previous.height,
    previousBox.x,
    previousBox.y,
    previousBox.w,
    previousBox.h,
  );
  const previousMouth = faceThumb(
    previous.data,
    previous.width,
    previous.height,
    previousBox.x,
    previousBox.y + previousBox.h * 0.55,
    previousBox.w,
    previousBox.h * 0.45,
  );
  const previousRing = backgroundRingThumb(
    previous.data,
    previous.width,
    previous.height,
    previousBox.x,
    previousBox.y,
    previousBox.w,
    previousBox.h,
    previousThumb,
  );
  const faceMotion =
    0.6 * thumbDiff(previousThumb, currentThumb) +
    0.4 * thumbDiff(previousMouth, currentMouth);
  const backgroundMotion =
    previousRing && currentRing ? ringDiff(previousRing, currentRing) : null;
  return {
    motion:
      backgroundMotion === null
        ? faceMotion
        : effectiveFaceMotion({ motion: faceMotion, faceMotion, backgroundMotion }),
    faceMotion,
    backgroundMotion,
    ring: currentRing,
  };
}

/**
 * Upper-body estimate of a person box, converted from SAMPLE pixels (what the
 * body detector saw) to SOURCE pixels (what the tracker stores).
 */
function faceEstimateFromBox(
  box: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
): { cx: number; cy: number; w: number; h: number } {
  const face = personBoxToFaceEstimate({
    ...box,
    score: 1,
  });
  return {
    cx: face.cx * scaleFactor,
    cy: face.cy * scaleFactor,
    w: face.w * scaleFactor,
    h: face.h * scaleFactor,
  };
}

/**
 * Load the YOLOX person detector for this window, degrading to `null` (today's
 * behaviour) when the model, the runtime or the user's setting says no. The
 * one clear warning is emitted by the caller; this stays quiet on success.
 */
async function loadPersonDetector(
  settings: PersonDetectorSettings,
): Promise<YoloxRuntime | null> {
  if (!settings.enabled) return null;
  if (!yoloxModelPresent()) return null;
  try {
    return await loadYolox();
  } catch (error) {
    log.warn(
      `Person detection (YOLOX) could not start: ${toErrorMessage(error)} - continuing without it.`,
    );
    return null;
  }
}

/**
 * Per-analysis-frame "how much did the scene change" signal, sampled from the
 * points the tracker already measured (any person's background/face motion at
 * that instant).
 *
 * This is only ever read for `personHold` points: when a face is lost but a body
 * box proves the person is still there, the ONLY honest motion evidence left is
 * the audio and how much the picture itself is moving.
 */
function buildSceneMotion(
  tracks: Track[],
  analysisFps: number,
  duration: number,
): number[] {
  const frames = Math.max(1, Math.round(duration * analysisFps));
  const out = new Array<number>(frames).fill(0);
  for (const track of tracks) {
    for (const point of track.points) {
      if (point.personHold) continue;
      const value =
        point.backgroundMotion !== null && point.backgroundMotion !== undefined
          ? point.backgroundMotion
          : point.motion;
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      const index = Math.max(
        0,
        Math.min(frames - 1, Math.round(point.t * analysisFps)),
      );
      out[index] = Math.max(out[index], value);
    }
  }
  return out;
}

/** Test-only: the background-ring thumbnail for one frame + face box. */
export function backgroundRingThumbForTests(
  frame: { data: ArrayLike<number>; width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
): number[] | null {
  const face = faceThumb(frame.data, frame.width, frame.height, box.x, box.y, box.w, box.h);
  return backgroundRingThumb(
    frame.data,
    frame.width,
    frame.height,
    box.x,
    box.y,
    box.w,
    box.h,
    face,
  );
}

/** Test-only: the ring thumbnail diff (NaN cells skipped). */
export function ringDiffForTests(a: number[] | null, b: number[] | null): number {
  return ringDiff(a, b);
}

function maxConcurrentTracks(tracks: Track[]): number {
  const samples = new Map<number, Set<number>>();
  for (const track of tracks) {
    for (const point of track.points) {
      // Group detections from the same decoded frame, not adjacent 0.25s bins.
      const key = Math.round(point.t * 1000);
      const sample = samples.get(key) ?? new Set<number>();
      sample.add(track.id);
      samples.set(key, sample);
    }
  }
  let maximum = 0;
  for (const sample of samples.values())
    maximum = Math.max(maximum, sample.size);
  return maximum;
}

function keepLiveTracks(result: AsdResult): AsdResult {
  const tracks = result.tracks.filter(isCameraUsableTrack);
  const ids = new Set(tracks.map((track) => track.id));
  const speakerSegments = result.speakerSegments.map((segment) => ({
    ...segment,
    trackId:
      segment.trackId !== null && ids.has(segment.trackId)
        ? segment.trackId
        : null,
  }));
  const speakerIds = new Set(
    speakerSegments
      .map((segment) => segment.trackId)
      .filter((id): id is number => id !== null),
  );
  return {
    ...result,
    tracks,
    speakerSegments,
    speakerCount: speakerIds.size,
    maxFacesSeen: maxConcurrentTracks(tracks),
  };
}

interface FrameAnalysis {
  tracks: Track[];
  maxFacesSeen: number;
  /** Frames with at least one face; kept as the historical `framesUsed` metric. */
  framesUsed: number;
  framesWithMultipleFaces: number;
  faceWidthsSource: number[];
  faceWidthsSample: number[];
  /** Source cuts that closed the tracker (proves identities never span a shot). */
  cutsApplied: number;
  /** Gap frames on which the YOLOX person detector actually ran. */
  personFramesUsed: number;
  /** Face sightings that a body box kept alive through a turned-away gap. */
  personHolds: number;
}

/**
 * Run the expensive per-image YuNet/motion/tracker work for one sampling pass.
 * It deliberately has no audio or layout concerns so an adaptive quality retry
 * can reuse already-decoded PCM and only repeat the work that needs sharper
 * frames.
 */
/** A decoded sampled JPEG (RGBA), as the LR-ASD crop needs it. */
interface SampledFrame {
  data: Buffer | Uint8Array;
  width: number;
  height: number;
}

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
  shotCuts: number[] = [],
  personRuntime: YoloxRuntime | null = null,
  personSettings: PersonDetectorSettings = getPersonDetectorSettings({}),
): Promise<FrameAnalysis> {
  const tracker = new Tracker();
  // Sorted copies of the cut times, consumed in order as samples advance. A cut
  // CLOSES every open track, so no face identity (and therefore no camera
  // position) is ever carried across two camera angles of the source.
  const pendingCuts = [...shotCuts].filter((cut) => Number.isFinite(cut)).sort((a, b) => a - b);
  let nextCut = 0;
  let cutsApplied = 0;
  let maxFacesSeen = 0;
  let framesUsed = 0;
  let framesWithMultipleFaces = 0;
  const faceWidthsSource: number[] = [];
  const faceWidthsSample: number[] = [];
  let prevThumbs: Array<{
    cx: number;
    cy: number;
    w: number;
    full: number[];
    mouth: number[];
    ring: number[] | null;
  }> = [];
  const measureTimings = Boolean(onStageTiming);
  let yunetDetectionMs = 0;
  let trackingAndFusionMs = 0;
  const boundedDetectionConcurrency = Math.max(
    1,
    Math.min(3, Math.floor(detectionConcurrency) || 1),
  );
  let recentSmallFaceFrames = 0;
  // Change 2 - person (body) detection is a GAP FILLER, never a primary pass:
  // it runs only on frames where a tracked face was lost, at a slower cadence
  // and under a per-window budget. It can extend an existing track, never add one.
  const personEnabled = Boolean(personRuntime) && personSettings.enabled;
  let personFramesUsed = 0;
  let personLastRunAt: number | null = null;
  let personHolds = 0;
  let personDetectMs = 0;

  try {
    for (
      let batchStart = 0;
      batchStart < frames.length;
      batchStart += boundedDetectionConcurrency
    ) {
      if (signal?.aborted) throw new RenderCancelledError();
      const batchEnd = Math.min(
        frames.length,
        batchStart + boundedDetectionConcurrency,
      );
      // Wait for three recent small-face frames before dropping the full-frame
      // pass. A miss resets the streak, so close-ups and scene changes return to
      // the conservative all-pass detector immediately.
      const includeFullFrame =
        !skipFullFrameOnWideShots || recentSmallFaceFrames < 3;
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
          while (nextCut < pendingCuts.length && pendingCuts[nextCut] <= t + 1e-6) {
            tracker.resetAtShotCut(pendingCuts[nextCut]);
            nextCut += 1;
            cutsApplied += 1;
          }
          const { width, height, data, scaleFactor, faces, sampleFaceWidths } =
            sample;
          faceWidthsSample.push(...sampleFaceWidths);

          // No skin-heuristic fallback here by design: a frame YuNet misses simply
          // contributes no track points (the tracker ages it out). If the WHOLE
          // window yields no face, detectSpeakerTimeline throws rather than faking a
          // static/centre crop.
          maxFacesSeen = Math.max(maxFacesSeen, faces.length);
          if (faces.length > 1) framesWithMultipleFaces += 1;
          for (const face of faces) faceWidthsSource.push(face.w);

          const widestSampleFace = sampleFaceWidths.reduce(
            (widest, width) => Math.max(widest, width),
            0,
          );
          if (
            faces.length > 0 &&
            widestSampleFace > 0 &&
            widestSampleFace < width * 0.1
          ) {
            recentSmallFaceFrames += 1;
          } else {
            recentSmallFaceFrames = 0;
          }

          if (faces.length === 0) {
            // A face was lost on THIS frame. Before the tracker ages it out, ask
            // the body detector whether the person is simply turned away: one
            // slow, budgeted pass that can only EXTEND the existing track.
            //
            // A person box only ever holds a track that was ALREADY open: no new
            // identity, no pane, no inflated person count.
            const hints = personRuntime ? tracker.openTrackHints() : [];
            if (
              personRuntime &&
              hints.length > 0 &&
              shouldRunPersonDetectorForGap({
                t,
                facesFound: 0,
                openTracks: hints.length,
                lastRunAt: personLastRunAt,
                maxFps: personSettings.maxFps,
                framesUsed: personFramesUsed,
                maxFrames: personSettings.maxFrames,
                enabled: personEnabled,
              })
            ) {
              personLastRunAt = t;
              personFramesUsed += 1;
              const personStartedAt = measureTimings ? Date.now() : 0;
              try {
                const boxes = await detectPersonsYolox(
                  personRuntime,
                  { data, width, height },
                  { confThreshold: personSettings.confThreshold },
                );
                for (const match of matchPersonsToLostTracks(hints, boxes, t)) {
                  // Matcher geometry is in SAMPLE pixels; the tracker stores
                  // source pixels (the same space YuNet detections were scaled to).
                  if (
                    tracker.holdThroughPersonGap(
                      match.trackId,
                      t,
                      faceEstimateFromBox(match.box, scaleFactor),
                    )
                  ) {
                    personHolds += 1;
                  }
                }
              } finally {
                if (measureTimings) personDetectMs += Date.now() - personStartedAt;
              }
            }
            tracker.update(t, []);
            prevThumbs = [];
            continue;
          }

          // Full-face + mouth-region (lower third) thumbnails: the mouth channel is
          // the sharper cue when lips are visible; the full-face channel continues
          // working when a mic, mask or hand covers them.
          const curThumbs = faces.map((face) => {
            const boxX = face.cx / scaleFactor - face.w / scaleFactor / 2;
            const boxY = face.cy / scaleFactor - face.h / scaleFactor / 2;
            const boxW = face.w / scaleFactor;
            const boxH = face.h / scaleFactor;
            const full = faceThumb(data, width, height, boxX, boxY, boxW, boxH);
            const mouth = faceThumb(
              data,
              width,
              height,
              boxX,
              boxY + boxH * 0.55,
              boxW,
              boxH * 0.45,
            );
            // The same face box, measured on the RING of background that
            // surrounds it. A camera shake/zoom moves both identically; only a
            // real person moves the face without moving the wall behind them.
            const ring = backgroundRingThumb(
              data,
              width,
              height,
              boxX,
              boxY,
              boxW,
              boxH,
              full,
            );
            return { cx: face.cx, cy: face.cy, w: face.w, full, mouth, ring };
          });

          const detections: FrameDetection[] = faces.map((face, faceIndex) => {
            // Two-frame nearest-neighbour motion (no long-term identity needed).
            let bestPrev: (typeof prevThumbs)[number] | null = null;
            let bestDist = Infinity;
            for (const previous of prevThumbs) {
              const distance = Math.hypot(
                face.cx - previous.cx,
                face.cy - previous.cy,
              );
              if (
                distance < bestDist &&
                distance < 0.6 * (face.w + previous.w)
              ) {
                bestDist = distance;
                bestPrev = previous;
              }
            }
            // Raw face motion (what the pixels did)...
            const faceMotion = bestPrev
              ? 0.6 * thumbDiff(bestPrev.full, curThumbs[faceIndex].full) +
                0.4 * thumbDiff(bestPrev.mouth, curThumbs[faceIndex].mouth)
              : null;
            // ...and what the BACKGROUND around it did over the same interval.
            // The speaker/liveness cues only ever see the difference: a poster,
            // photo or framed print under a shaking/zooming camera is rigid, so
            // its relative motion collapses to zero while a real person's head
            // still moves against the wall behind them.
            const backgroundMotion = bestPrev?.ring && curThumbs[faceIndex].ring
              ? ringDiff(bestPrev.ring, curThumbs[faceIndex].ring)
              : null;
            const motion =
              faceMotion === null
                ? null
                : backgroundMotion === null
                  ? faceMotion
                  : effectiveFaceMotion({
                      motion: faceMotion,
                      faceMotion,
                      backgroundMotion,
                    });
            return {
              cx: face.cx,
              cy: face.cy,
              w: face.w,
              mouthOpen: null, // YuNet has no mouth landmarks; the fusion treats this as no cue.
              motion,
              faceMotion,
              backgroundMotion,
            };
          });

          tracker.update(t, detections);
          prevThumbs = curThumbs;
          framesUsed += 1;
        } finally {
          if (measureTimings)
            trackingAndFusionMs += Date.now() - trackingStartedAt;
        }
      }
    }

    const mergeStartedAt = measureTimings ? Date.now() : 0;
    try {
      return {
        tracks: mergeTrackFragments(tracker.allVisible()),
        // Person boxes never enter this count: only real faces do.
        maxFacesSeen,
        framesUsed,
        framesWithMultipleFaces,
        faceWidthsSource,
        faceWidthsSample,
        cutsApplied,
        personFramesUsed,
        personHolds,
      };
    } finally {
      if (measureTimings) trackingAndFusionMs += Date.now() - mergeStartedAt;
    }
  } finally {
    reportAsdStageTiming(onStageTiming, "yunet-detection", yunetDetectionMs);
    reportAsdStageTiming(
      onStageTiming,
      "tracking-speaker-fusion",
      trackingAndFusionMs,
    );
    reportAsdStageTiming(onStageTiming, "person-detection", personDetectMs);
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
  options: AsdOptions,
): Promise<AsdResult> {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    throw new AppError(
      "Cannot run speaker detection without a valid source resolution.",
      {
        status: 400,
        details: `width=${videoWidth}, height=${videoHeight}`,
        resolution: "Re-upload the video so FFmpeg can read its resolution.",
      },
    );
  }

  if (options.signal?.aborted) throw new RenderCancelledError();
  const personSettings = getPersonDetectorSettings();
  const lrAsdSettings = getLrAsdSettings();
  if (lrAsdSettings.enabled && !lrAsdModelPresent()) {
    log.warn(
      `LR-ASD active speaker model not found in models/lr-asd - ambiguous two-person ` +
        `windows keep using the audio+motion cues. Run "npm run setup:asd" to enable it.`,
    );
  }
  if (personSettings.enabled && !yoloxModelPresent()) {
    log.warn(
      `Person detection (YOLOX) is unavailable: ${yoloxModelPath()} is missing - ` +
        `run "npm run setup:yolox" to keep people who turn away. Continuing without it.`,
    );
  }
  const adaptiveSampling =
    options.adaptiveSampling ?? getAdaptiveAsdSamplingEnabled();
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
      return keepLiveTracks(cached);
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
  let personRuntime: YoloxRuntime | null = null;
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
    // The shot-cut probe is a fourth independent pass: one small grayscale decode
    // that tells the camera where the source cuts, so it can switch on that exact
    // frame instead of interpolating two different shots together.
    const shotCutSettings = getShotCutDetectionSettings();
    const [initialSampled, pcm, runtime, loadedPersonRuntime, shotCuts] = await Promise.all([
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
      // Loaded beside YuNet: a missing file is a ONE-LINE warning and today's
      // behaviour, never an error.
      loadPersonDetector(personSettings),
      shotCutSettings.enabled
        ? measureAsdStage(options, "shot-cut-detection", () =>
            detectShotCuts(videoPath, start, duration, {
              threshold: shotCutSettings.threshold,
              minGapSeconds: shotCutSettings.minGapSeconds,
              signal: options.signal,
            }),
          )
        : Promise.resolve([] as number[]),
    ]);
    if (options.signal?.aborted) throw new RenderCancelledError();
    personRuntime = loadedPersonRuntime;
    frames = initialSampled.frames;
    sampleFps = initialSampled.fps;
    sampleWidth = initial.sampleWidth;

    // Missing model -> a clear error. There is no unrelated detector fallback:
    // if no face can be detected the render stops rather than centring blindly.
    if (!runtime) {
      throw new AppError(
        `YuNet face detection is unavailable${yunetModelPresent() ? "" : " (model not found)"}.`,
        {
          details:
            'Run "npm run setup:yunet" to download face_detection_yunet_2023mar.onnx.',
          resolution:
            'Run "npm run setup:yunet" (or set YUNET_MODEL_PATH) and re-render the clip.',
        },
      );
    }

    const profile = initial;
    const analysis = await analyzeSampledFrames(
      frames,
      sampleFps,
      videoWidth,
      runtime,
      options.signal,
      options.onStageTiming,
      detectionConcurrency,
      skipFullFrameOnWideShots,
      shotCutSettings.enabled ? shotCuts : [],
      personRuntime,
      personSettings,
    );

    // Single-attempt policy: no higher-quality re-extraction or second YuNet pass.

    analysis.tracks = includePersistentCoVisibleCompanions(
      analysis.tracks,
      sampleFps,
    );
    analysis.maxFacesSeen = maxConcurrentTracks(analysis.tracks);

    if (analysis.tracks.length === 0) {
      throw new AppError(
        analysis.framesUsed === 0
          ? `No faces were detected in this clip window (0 of ${frames.length} sampled frames contained a face).`
          : `No live faces were detected in this clip window (${analysis.framesUsed} sampled frames contained only static or motionless faces).`,
        {
          details:
            "The 9:16 layouts follow people with measurable face motion; a still image is not treated as a person, and no fallback detector is used.",
          resolution:
            "Choose a window with a visible, moving person (avoid still photos, extreme angles, heavy occlusion or tiny faces in a very wide shot), then re-render.",
        },
      );
    }

    // The quality/rollback path preserves its historical cadence exactly. Every
    // bounded initial profile promotes only adjacent face positions to the old
    // 8fps analysis grid; synthetic points carry no motion so they cannot
    // manufacture a speaker decision.
    const analysisFps =
      profile.name !== "quality"
        ? Math.max(sampleFps, samplingPlan.analysisFps)
        : sampleFps;
    const voice = await measureAsdStage(options, "audio-envelope", () =>
      pcm.length > 0
        ? computeVoiceEnvelope(pcm, 16000, analysisFps).voice
        : new Array(Math.max(1, Math.round(duration * analysisFps))).fill(0),
    );
    // Scene motion on the analysis grid, used ONLY for person-box sightings (the
    // frames where a face was lost). Counted from the sampled frames themselves,
    // so the cue is measured evidence, not a guess.
    const sceneMotion =
      analysis.personHolds > 0
        ? buildSceneMotion(analysis.tracks, analysisFps, duration)
        : undefined;
    // Change 3 - LR-ASD referee for AMBIGUOUS windows only, in two passes:
    //   1. build the timeline with a recording referee to learn which windows the
    //      cheap cues could not settle (costs nothing - no model, no pixels);
    //   2. only if there are any, ask the model about them within its budget,
    //      then build the timeline again with those verdicts available.
    // The timeline stays a pure function of (tracks, voice, verdicts).
    const { segments, speakerCount, ambiguousWindows, lrAsdWindows } =
      await measureAsdStage(options, "tracking-speaker-fusion", async () => {
        const tracks = interpolateTracksForAnalysis(
          analysis.tracks,
          sampleFps,
          analysisFps,
        ).filter(isLikelyLiveTrack);
        const input: SpeakerTimelineInput = {
          duration,
          fps: analysisFps,
          voice,
          tracks,
          frameWidth: videoWidth,
          // A speaker label must never cross a source cut: the new shot has its
          // own framing and its own visible faces.
          shotCuts,
          sceneMotion,
        };
        const ambiguousWindows = uniqueWindows(collectAmbiguousWindows(input));
        const verdicts = await judgeAmbiguousWindows({
          windows: ambiguousWindows,
          settings: lrAsdSettings,
          runtime: () => loadLrAsd(),
          window: { start, duration, pcm },
          // One MFCC pass for the whole clip, shared by every ambiguous window.
          mfcc: computeMfcc(pcm, 16000),
          framePaths: frames,
          sampleFps,
          tracks,
          signal: options.signal,
          onStageTiming: options.onStageTiming,
        });
        const timeline =
          verdicts.size === 0
            ? buildSpeakerTimeline(input)
            : buildSpeakerTimeline({
                ...input,
                referee: {
                  weight: lrAsdSettings.weight,
                  judge: (window) => verdicts.get(windowKey(window)) ?? null,
                },
              });
        return {
          segments: timeline.segments,
          speakerCount: timeline.speakerCount,
          ambiguousWindows,
          lrAsdWindows: verdicts.size,
        };
      });
    const cameraTracks = interpolateTracksForAnalysis(
      analysis.tracks,
      sampleFps,
      analysisFps,
    );

    const voicedRatio =
      voice.length > 0
        ? voice.filter((v) => v >= 0.18).length / voice.length
        : 0;
    const medianFaceWidth = medianOf(analysis.faceWidthsSource);
    const facePct =
      frames.length > 0
        ? Math.round((analysis.framesUsed / frames.length) * 100)
        : 0;

    if (shotCuts.length > 0) {
      log.detail(
        `  shot cuts at ${shotCuts.map((t) => t.toFixed(2)).join(", ")}s - the speaker camera switches on those frames`,
      );
    }
    log.ok(
      `ASD: ${cameraTracks.length} person(s) tracked${analysis.maxFacesSeen > 1 ? `, ${analysis.maxFacesSeen} on screen at once` : ""}, ` +
        `${speakerCount} active speaker(s), ${Math.round(voicedRatio * 100)}% voiced, ` +
        `frames=${analysis.framesUsed}/${frames.length}, detector_fps=${sampleFps.toFixed(2)}, ` +
        `analysis_fps=${analysisFps.toFixed(2)}, profile=${profile.name}, ` +
        `cue=multi-cue (audio↔motion + energy + prominence + continuity)`,
    );
    log.detail(
      `  detection: faces in ${facePct}% of sampled frames` +
        (analysis.framesWithMultipleFaces > 0
          ? `, 2+ faces together in ${Math.round((analysis.framesWithMultipleFaces / Math.max(1, frames.length)) * 100)}%`
          : "") +
        `, median face ${Math.round(medianFaceWidth)}px ` +
        `(${((medianFaceWidth / videoWidth) * 100).toFixed(1)}% of the ${videoWidth}px frame), ` +
        `scanned on ${sampleWidth}px frames`,
    );
    if (lrAsdWindows > 0) {
      log.detail(
        `  LR-ASD decided ${lrAsdWindows} of ${ambiguousWindows.length} ambiguous window(s) ` +
          `(weight ${lrAsdSettings.weight.toFixed(2)}, budget ${lrAsdSettings.maxWindows} windows).`,
      );
    }
    if (analysis.personFramesUsed > 0) {
      log.detail(
        `  person detector: ran on ${analysis.personFramesUsed} gap frame(s) at <=${personSettings.maxFps}fps, ` +
          `kept ${analysis.personHolds} turned-away sighting(s) alive ` +
          `(hold ${personSettings.holdSeconds.toFixed(1)}s, budget ${personSettings.maxFrames} frames)`,
      );
    }
    if (frames.length >= 8 && analysis.framesUsed / frames.length < 0.25) {
      log.warn(
        `Faces were found in only ${analysis.framesUsed} of ${frames.length} sampled frames - the framing will ` +
          `be unreliable. The people may be very small, dark, turned away or covered in this window.`,
      );
    }

    for (const track of cameraTracks) {
      const third = videoWidth / 3;
      const avgX = Math.round(
        track.points.reduce((sum, point) => sum + point.cx, 0) /
          track.points.length,
      );
      const side =
        avgX < third ? "LEFT" : avgX > third * 2 ? "RIGHT" : "centre";
      log.detail(
        `  person#${track.id}: visible ${track.visibleTime.toFixed(1)}s, ` +
          `avg face ${Math.round(track.avgW)}px, ${track.points.length} sightings, ` +
          `sits ${side} (avg x=${avgX} of ${videoWidth})`,
      );
    }

    const method: AsdResult["method"] = options.hasAudio
      ? "yunet+audio-visual"
      : "yunet-visual";

    const result: AsdResult = {
      tracks: cameraTracks,
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
      shotCuts,
      cutsApplied: analysis.cutsApplied,
      personFramesUsed: analysis.personFramesUsed,
      personHolds: analysis.personHolds,
      ambiguousWindows: ambiguousWindows.length,
      lrAsdWindows,
      personHoldSeconds:
        personSettings.enabled && analysis.personFramesUsed > 0
          ? personSettings.holdSeconds
          : 0,
    };
    if (cacheKey && writeAsdResultCache(cacheSettings, cacheKey, result)) {
      log.info(
        `[ASD-CACHE] event=write profile=${requestedInitialProfile} source=${sourceIdentity?.key.slice(0, 12)} ` +
          `window=${start.toFixed(3)}+${duration.toFixed(3)}s`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RenderCancelledError || options.signal?.aborted)
      throw new RenderCancelledError();
    if (error instanceof AppError) throw error;
    throw new AppError("Speaker detection failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the sampled-frame and audio-extract FFmpeg commands in the worker log, and retry.",
    });
  } finally {
    // sampleSegmentFrames keeps the dir alive for the caller; clean it here.
    if (frames.length > 0) {
      cleanupSampledFrames(path.dirname(frames[0]));
    }
  }
}
