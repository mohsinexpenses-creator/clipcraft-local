import path from 'path';
import { Jimp } from 'jimp';
import { AppError, toErrorMessage } from '../../lib/errors';
import { log } from '../../lib/logger';
import {
  cleanupSampledFrames,
  sampleSegmentFrames,
} from '../frame-sampler';
import { detectFacesYunet, loadYuNet, yunetModelPresent } from '../yunet-detector';
import { computeVoiceEnvelope, extractPcmMono } from './audio';
import { Tracker, Track, FrameDetection } from './tracker';
import { SpeakerSegment, buildSpeakerTimeline } from './speaker';

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
 * Cost model: frames are sampled at <= 8 fps (bounded by a 480-frame budget),
 * so a 90 s clip runs at most ~480 YuNet inferences on 640px frames (a few
 * seconds of CPU time) instead of 2,700. The higher rate matters for the
 * speaker decision: the audio↔motion cues need several samples per 0.6 s
 * window to be statistically meaningful at 4 fps, and it is what lets the
 * label flip promptly when the turn changes.
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

export interface AsdOptions {
  /** False when the source has no audio stream. */
  hasAudio: boolean;
  /** Upper bound on the frame-sampling fps (default 8). */
  maxSampleFps?: number;
  /** Upper bound on sampled frames (default 480). */
  maxFrames?: number;
}

const DEFAULT_MAX_SAMPLE_FPS = 8;
const DEFAULT_MAX_FRAMES = 480;
/**
 * Width of the frames the detector sees. 640px (the old value) leaves a host in
 * a 1080p wide shot ~35px wide; 960px keeps ~50px of real detail per face (and
 * sharper face-motion thumbnails) for ~25ms of extra JPEG decode per frame.
 * Never larger than the source itself.
 */
export const ASD_SAMPLE_WIDTH = 960;
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

  const maxFps = options.maxSampleFps ?? DEFAULT_MAX_SAMPLE_FPS;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;

  let frames: string[] = [];
  let sampleFps = 0;
  try {
    log.detail(
      `ASD · sampling up to ${maxFrames} frames @ <=${maxFps}fps + audio envelope ` +
      `(window ${start.toFixed(1)}s +${duration.toFixed(1)}s)`
    );

    // 1) Frames and audio can be extracted independently - run them together.
    const sampleWidth = Math.max(160, Math.min(ASD_SAMPLE_WIDTH, Math.floor(videoWidth / 2) * 2));
    const sampled = await sampleSegmentFrames(
      videoPath,
      start,
      duration,
      maxFps,
      maxFrames,
      'frames',
      sampleWidth
    );
    frames = sampled.frames;
    sampleFps = sampled.fps;

    const pcm = options.hasAudio ? await extractPcmMono(videoPath, start, duration) : new Int16Array(0);
    const voice =
      pcm.length > 0 ? computeVoiceEnvelope(pcm, 16000, sampleFps).voice : new Array(frames.length).fill(0);

    // 2) YuNet runtime. Missing model -> a clear error. There is NO fallback
    //    detector by design: if we cannot detect a face the render stops with
    //    an informative error instead of producing a static/centre crop.
    const runtime = await loadYuNet();
    if (!runtime) {
      throw new AppError(
        `YuNet face detection is unavailable${yunetModelPresent() ? '' : ' (model not found)'}.`,
        {
          details: 'Run "npm run setup:yunet" to download face_detection_yunet_2023mar.onnx.',
          resolution: 'Run "npm run setup:yunet" (or set YUNET_MODEL_PATH) and re-render the clip.',
        }
      );
    }

    // 3) Per-frame detection -> motion cues -> tracker.
    const tracker = new Tracker();
    let maxFacesSeen = 0;
    let framesUsed = 0;
    let framesWithMultipleFaces = 0;
    const faceWidthsSource: number[] = [];
    let prevThumbs: Array<{ cx: number; cy: number; w: number; full: number[]; mouth: number[] }> = [];

    for (let i = 0; i < frames.length; i += 1) {
      const framePath = frames[i];
      const t = i / sampleFps;

      const image = await Jimp.read(framePath);
      const width = image.bitmap.width;
      const height = image.bitmap.height;
      const data = image.bitmap.data;
      const scaleFactor = videoWidth / Math.max(1, width);

      const detections = await detectFacesYunet(runtime, { data, width, height });
      const faces: Array<{ cx: number; cy: number; w: number; h: number }> = detections.map((d) => ({
        cx: (d.box.x + d.box.width / 2) * scaleFactor,
        cy: (d.box.y + d.box.height / 2) * scaleFactor,
        w: d.box.width * scaleFactor,
        h: d.box.height * scaleFactor,
      }));

      // No skin-heuristic fallback here by design: a frame YuNet misses simply
      // contributes no track points (the tracker ages it out). If the WHOLE
      // window yields no face, detectSpeakerTimeline throws and the render
      // stops with an informative error instead of faking a pan.
      maxFacesSeen = Math.max(maxFacesSeen, faces.length);
      if (faces.length > 1) framesWithMultipleFaces += 1;
      for (const f of faces) faceWidthsSource.push(f.w);
      if (faces.length === 0) {
        // Still feed an empty frame so the tracker ages its grace periods.
        tracker.update(t, []);
        prevThumbs = [];
        continue;
      }

      // Full-face + mouth-region (lower third) thumbnails: the mouth channel is
      // the sharper cue when the lips are visible; the full-face channel keeps
      // working when a mic/mask/hand covers them.
      const curThumbs = faces.map((f) => {
        const boxX = (f.cx / scaleFactor) - (f.w / scaleFactor) / 2;
        const boxY = (f.cy / scaleFactor) - (f.h / scaleFactor) / 2;
        const boxW = f.w / scaleFactor;
        const boxH = f.h / scaleFactor;
        const full = faceThumb(data, width, height, boxX, boxY, boxW, boxH);
        const mouth = faceThumb(data, width, height, boxX, boxY + boxH * 0.55, boxW, boxH * 0.45);
        return { cx: f.cx, cy: f.cy, w: f.w, full, mouth };
      });

      const dets: FrameDetection[] = faces.map((f, fi) => {
        // 2-frame nearest-neighbour motion (no long-term identity needed).
        let bestPrev: (typeof prevThumbs)[number] | null = null;
        let bestDist = Infinity;
        for (const prev of prevThumbs) {
          const dist = Math.hypot(f.cx - prev.cx, f.cy - prev.cy);
          if (dist < bestDist && dist < 0.6 * (f.w + prev.w)) {
            bestDist = dist;
            bestPrev = prev;
          }
        }
        const motion = bestPrev
          ? 0.6 * thumbDiff(bestPrev.full, curThumbs[fi].full) +
            0.4 * thumbDiff(bestPrev.mouth, curThumbs[fi].mouth)
          : null;
        return {
          cx: f.cx,
          cy: f.cy,
          w: f.w,
          mouthOpen: null, // YuNet has no mouth landmarks; the fusion treats this as "no cue"
          motion,
        };
      });

      tracker.update(t, dets);
      prevThumbs = curThumbs;
      framesUsed += 1;
    }

    // 4) Fuse audio + per-track visual cues into a speaker timeline.
    // Fragments of one person (ids lost through long occlusions) are merged
    // FIRST so both the speaker decision and the split-grid count see PEOPLE,
    // not track-id history.
    const tracks = mergeTrackFragments(tracker.allVisible());

    if (tracks.length === 0) {
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

    const { segments, speakerCount } = buildSpeakerTimeline({
      duration,
      fps: sampleFps,
      voice,
      tracks,
      frameWidth: videoWidth,
    });

    const voicedRatio =
      voice.length > 0 ? voice.filter((v) => v >= 0.18).length / voice.length : 0;

    const medianFaceWidth = medianOf(faceWidthsSource);
    const facePct = frames.length > 0 ? Math.round((framesUsed / frames.length) * 100) : 0;

    log.ok(
      `ASD: ${tracks.length} person(s) tracked${maxFacesSeen > 1 ? `, ${maxFacesSeen} on screen at once` : ''}, ` +
      `${speakerCount} active speaker(s), ${Math.round(voicedRatio * 100)}% voiced, ` +
      `frames=${framesUsed}/${frames.length}, fps=${sampleFps.toFixed(2)}, ` +
      `cue=multi-cue (audio↔motion + energy + prominence + continuity)`
    );
    log.detail(
      `  detection: faces in ${facePct}% of sampled frames` +
      (framesWithMultipleFaces > 0
        ? `, 2+ faces together in ${Math.round((framesWithMultipleFaces / Math.max(1, frames.length)) * 100)}%`
        : '') +
      `, median face ${Math.round(medianFaceWidth)}px ` +
      `(${((medianFaceWidth / videoWidth) * 100).toFixed(1)}% of the ${videoWidth}px frame), ` +
      `scanned on ${sampleWidth}px frames`
    );
    if (frames.length >= 8 && framesUsed / frames.length < 0.25) {
      log.warn(
        `Faces were found in only ${framesUsed} of ${frames.length} sampled frames - the framing will ` +
        `be unreliable. The people may be very small, dark, turned away or covered in this window.`
      );
    }

    if (tracks.length > 0) {
      for (const track of tracks) {
        const third = videoWidth / 3;
        const avgX = Math.round(
          track.points.reduce((sum, p) => sum + p.cx, 0) / track.points.length
        );
        const side = avgX < third ? 'LEFT' : avgX > third * 2 ? 'RIGHT' : 'centre';
        log.detail(
          `  person#${track.id}: visible ${track.visibleTime.toFixed(1)}s, ` +
          `avg face ${Math.round(track.avgW)}px, ${track.points.length} sightings, ` +
          `sits ${side} (avg x=${avgX} of ${videoWidth})`
        );
      }
    }

    const method: AsdResult['method'] = options.hasAudio
      ? 'yunet+audio-visual'
      : 'yunet-visual';

    return {
      tracks,
      speakerSegments: segments,
      speakerCount,
      method,
      hasLandmarks: false, // no mouth-landmark cue from YuNet (5-point only)
      hasAudio: pcm.length > 0,
      maxFacesSeen,
      framesUsed,
      framesTotal: frames.length,
      sampleFps,
      voicedRatio,
      framesWithMultipleFaces,
      medianFaceWidth,
      sampleWidth,
    };
  } catch (error) {
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
