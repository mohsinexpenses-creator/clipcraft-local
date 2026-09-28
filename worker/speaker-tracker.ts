import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { toErrorMessage } from '../lib/errors';
import { getFfmpegPath } from '../lib/ffmpeg';
import { log } from '../lib/logger';
import {
  DetectedFace,
  detectFacesYunet,
  loadYuNet,
  YuNetRuntime,
  yunetModelPresent,
} from './yunet-detector';

/**
 * Active-speaker tracking for generated clips.
 *
 * Samples the clip window (mirrored + downscaled), runs YuNet face detection on
 * every sample, keeps per-face TRACKS (identity-free - just motion continuity,
 * never "who" the person is), and decides which tracked face is currently
 * speaking using MULTIPLE cues so a covered mouth (mic, mask, hand) still
 * resolves:
 *
 *   1. mouth-ROI motion energy (primary when the mouth is visible),
 *   2. full-face motion energy (secondary - works when the mouth is hidden),
 *   3. correlation of motion with the audio loudness envelope (the classic
 *      audio-visual active-speaker cue),
 *   4. worst-case fallbacks: speaker continuity, face size, centrality -
 *      so there is ALWAYS an active speaker while someone is talking.
 *
 * The output is crop timelines for both generated-clip layouts:
 *   - speaker-focus: one 9:16 window that pans to the active speaker and
 *     glides to the new speaker whenever the speaker changes,
 *   - split-screen: two stacked panes (active speaker on top) that each
 *     follow their person, swapping panes on speaker change.
 */

export const SAMPLE_FPS = 4;

/** A crop position along one axis at a point in time (seconds from clip start). */
export interface Keyframe {
  t: number;
  v: number;
}

export interface PaneKeyframe {
  t: number;
  x: number;
  y: number;
}

export interface SpeakerSegmentInfo {
  trackId: number;
  start: number;
  end: number;
}

export interface FocusTimeline {
  cropW: number;
  cropH: number;
  /** Which source axis the window slides along ('x' for landscape sources). */
  axis: 'x' | 'y';
  keyframes: Keyframe[];
}

export interface SplitTimeline {
  cropW: number;
  cropH: number;
  top: PaneKeyframe[];
  bottom: PaneKeyframe[];
}

export interface SpeakerAnalysis {
  method: 'yunet-audio-visual' | 'yunet-visual' | 'center-fallback';
  hasAudio: boolean;
  /** Mirrored source dimensions (the ffmpeg chain flips BEFORE cropping). */
  sourceWidth: number;
  sourceHeight: number;
  focus: FocusTimeline;
  split: SplitTimeline;
  speakerSegments: SpeakerSegmentInfo[];
  trackCount: number;
}

export interface SampleFace {
  trackId: number;
  box: DetectedFace['box'];
  /** Combined mouth+face motion 0..1 vs the previous sample of this track. */
  motion: number;
  score: number;
}

export interface Sample {
  t: number;
  faces: SampleFace[];
  audioRms: number;
  activeTrackId: number | null;
}

export interface TrackState {
  id: number;
  lastBox: DetectedFace['box'];
  lastSeenT: number;
  prevMouthThumb: number[] | null;
  prevFaceThumb: number[] | null;
  totalSpeaking: number;
  totalVisible: number;
  faceHeightSum: number;
  samples: Array<{ t: number; box: DetectedFace['box']; motion: number }>;
}

const MOUTH_THUMB_W = 20;
const MOUTH_THUMB_H = 12;
const FACE_THUMB = 16;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function boxCenter(box: DetectedFace['box']): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.42 };
}

function iou(a: DetectedFace['box'], b: DetectedFace['box']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Mouth ROI from the 5 YuNet landmarks, with a box-based fallback when they are junk (occlusion). */
function mouthRoi(face: DetectedFace): { x: number; y: number; w: number; h: number } {
  const { box, landmarks } = face;
  const pts = landmarks.points;
  const rightMouth = pts[3];
  const leftMouth = pts[4];
  const nose = pts[2];

  const mouthD = dist(rightMouth, leftMouth);
  const mouthCenter = { x: (rightMouth.x + leftMouth.x) / 2, y: (rightMouth.y + leftMouth.y) / 2 };
  const noseD = dist(nose, mouthCenter);

  const plausible =
    mouthD > box.width * 0.12 &&
    noseD > box.height * 0.04 &&
    mouthCenter.x > box.x &&
    mouthCenter.x < box.x + box.width &&
    mouthCenter.y > box.y &&
    mouthCenter.y < box.y + box.height;

  if (plausible) {
    const w = mouthD * 2.4;
    const h = Math.max(noseD * 3.0, mouthD * 1.4);
    return {
      x: mouthCenter.x - w / 2,
      y: mouthCenter.y - h * 0.35,
      w,
      h,
    };
  }

  // Worst case (mic/mask/hand over the mouth, landmarks collapsed): use the
  // lower-face region so motion is still measurable around the jaw/cheeks.
  return {
    x: box.x + box.width * 0.22,
    y: box.y + box.height * 0.55,
    w: box.width * 0.56,
    h: box.height * 0.34,
  };
}

/** Downsample a grayscale ROI to a fixed-size thumb (nearest sampling). */
function sampleThumb(
  gray: Uint8Array,
  frameW: number,
  frameH: number,
  roi: { x: number; y: number; w: number; h: number },
  tw: number,
  th: number
): number[] {
  const thumb: number[] = new Array(tw * th);
  for (let ty = 0; ty < th; ty += 1) {
    for (let tx = 0; tx < tw; tx += 1) {
      const px = clamp(Math.round(roi.x + ((tx + 0.5) / tw) * roi.w), 0, frameW - 1);
      const py = clamp(Math.round(roi.y + ((ty + 0.5) / th) * roi.h), 0, frameH - 1);
      thumb[ty * tw + tx] = gray[py * frameW + px];
    }
  }
  return thumb;
}

function thumbDiff(a: number[] | null, b: number[]): number {
  if (!a || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return clamp(sum / a.length / 255, 0, 1);
}

function toGray(image: { bitmap: { width: number; height: number; data: ArrayLike<number> } }): Uint8Array {
  const { width, height, data } = image.bitmap;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

/** Pearson correlation over a window; 0 when degenerate. */
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 1e-9 || db <= 1e-9) return 0;
  return clamp(num / Math.sqrt(da * db), -1, 1);
}

/** Decode raw mono s16 PCM into a per-sample-bin RMS envelope (0..1). */
function audioEnvelope(pcm: Buffer, duration: number, bins: number): number[] {
  const envelope = new Array<number>(bins).fill(0);
  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples === 0 || bins === 0) return envelope;

  const samplesPerBin = Math.max(1, Math.floor(totalSamples / bins));
  for (let bin = 0; bin < bins; bin += 1) {
    const startS = bin * samplesPerBin;
    const endS = Math.min(totalSamples, startS + samplesPerBin);
    let sum = 0;
    let count = 0;
    for (let s = startS; s < endS; s += 1) {
      const v = pcm.readInt16LE(s * 2) / 32768;
      sum += v * v;
      count += 1;
    }
    envelope[bin] = count > 0 ? Math.sqrt(sum / count) : 0;
  }

  void duration;
  // Normalise to 0..1 (speech RMS typically 0.02-0.3).
  const max = Math.max(...envelope, 1e-6);
  return envelope.map((v) => clamp(v / Math.max(max, 0.08), 0, 1));
}

function extractAudioPcm(
  videoPath: string,
  start: number,
  duration: number
): Promise<Buffer> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
    const child = spawn(getFfmpegPath(), args, { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(Buffer.alloc(0)));
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

async function extractSampleFrames(
  videoPath: string,
  start: number,
  duration: number,
  outDir: string
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'frame_%04d.jpg');
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', videoPath,
    // Mirror FIRST: the render chain is `hflip,crop=...`, so all coordinates
    // used for cropping must live in mirrored space (same lesson as the old
    // face-detector learned the hard way).
    '-vf', `hflip,scale=640:-2,fps=${SAMPLE_FPS}`,
    '-q:v', '3',
    pattern,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`frame sampling failed (${code}): ${stderr.slice(-400)}`))
    );
  });

  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('frame_') && f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(outDir, f));
}

/**
 * Run the whole active-speaker analysis for one clip window.
 * Never throws: every failure degrades to the center-crop fallback so renders
 * always proceed.
 */
export async function analyzeSpeakers(options: {
  videoPath: string;
  start: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  hasAudio: boolean;
}): Promise<SpeakerAnalysis> {
  const { videoPath, start, duration, videoWidth, videoHeight, hasAudio } = options;

  const focus = buildFallbackFocus(videoWidth, videoHeight);
  const split = buildFallbackSplit(videoWidth, videoHeight);
  const fallback: SpeakerAnalysis = {
    method: 'center-fallback',
    hasAudio,
    sourceWidth: videoWidth,
    sourceHeight: videoHeight,
    focus,
    split,
    speakerSegments: [],
    trackCount: 0,
  };

  let runtime: YuNetRuntime | null = null;
  try {
    runtime = await loadYuNet();
  } catch (error) {
    log.warn(`YuNet load failed: ${toErrorMessage(error)}`);
  }
  if (!runtime) {
    log.warn(
      `Speaker tracking running in center-fallback mode (${yunetModelPresent() ? 'model failed to load' : 'model missing'}). ` +
        'Run "npm run setup:yunet" to enable active-speaker tracking.'
    );
    return fallback;
  }

  const workDir = path.join(
    path.dirname(videoPath),
    `_speaker_${path.basename(videoPath, path.extname(videoPath))}_${Date.now()}`
  );

  try {
    const startedAt = Date.now();
    const [frames, pcm] = await Promise.all([
      extractSampleFrames(videoPath, start, duration, workDir),
      hasAudio
        ? extractAudioPcm(videoPath, start, duration)
        : Promise.resolve(Buffer.alloc(0)),
    ]);

    if (frames.length === 0) return fallback;

    const envelope = hasAudio
      ? audioEnvelope(pcm, duration, frames.length)
      : new Array<number>(frames.length).fill(0);

    const samples = await trackFacesOverFrames(runtime, frames, envelope);
    const analysis = decideSpeakers(samples, videoWidth, videoHeight, hasAudio, focus, split);

    log.ok(
      `Speaker tracking: ${analysis.trackCount} face track(s), ` +
        `${analysis.speakerSegments.length} speaker segment(s), ` +
        `method=${analysis.method}, ${Date.now() - startedAt}ms`
    );
    return analysis;
  } catch (error) {
    log.warn(`Speaker tracking failed, using center crop: ${toErrorMessage(error)}`);
    return fallback;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
}

function buildFallbackFocus(sourceWidth: number, sourceHeight: number): FocusTimeline {
  const landscape = sourceWidth / sourceHeight >= 9 / 16;
  const cropH = landscape ? sourceHeight : Math.round((sourceWidth * 16) / 9);
  const cropW = landscape ? Math.round((sourceHeight * 9) / 16) : sourceWidth;
  const axis: 'x' | 'y' = landscape ? 'x' : 'y';
  const maxPos = Math.max(0, axis === 'x' ? sourceWidth - cropW : sourceHeight - cropH);
  const centerPos = maxPos / 2;
  return {
    cropW: evenSize(Math.min(cropW, sourceWidth)),
    cropH: evenSize(Math.min(cropH, sourceHeight)),
    axis,
    keyframes: [
      { t: 0, v: centerPos },
      { t: 1, v: centerPos },
    ],
  };
}

function buildFallbackSplit(sourceWidth: number, sourceHeight: number): SplitTimeline {
  const cropH = evenSize(Math.min(Math.round(sourceHeight * 0.62), sourceHeight));
  const cropW = evenSize(Math.min(Math.round(cropH * 1080 / 960), sourceWidth));
  const x = Math.max(0, (sourceWidth - cropW) / 2);
  return {
    cropW,
    cropH,
    top: [
      { t: 0, x, y: Math.max(0, sourceHeight * 0.05) },
      { t: 1, x, y: Math.max(0, sourceHeight * 0.05) },
    ],
    bottom: [
      { t: 0, x, y: Math.max(0, sourceHeight * 0.32) },
      { t: 1, x, y: Math.max(0, sourceHeight * 0.32) },
    ],
  };
}

function evenSize(v: number): number {
  return Math.max(2, Math.floor(v / 2) * 2);
}

async function trackFacesOverFrames(
  runtime: YuNetRuntime,
  frames: string[],
  envelope: number[]
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const tracks = new Map<number, TrackState>();
  let nextTrackId = 1;

  for (let i = 0; i < frames.length; i += 1) {
    const t = i / SAMPLE_FPS;
    const image = await Jimp.read(frames[i]);
    const { width, height } = image.bitmap;
    const gray = toGray(image);

    let faces: DetectedFace[] = [];
    try {
      faces = await detectFacesYunet(runtime, {
        data: image.bitmap.data,
        width,
        height,
      });
    } catch (error) {
      log.detail(`YuNet failed on sample ${i}: ${toErrorMessage(error)}`);
    }

    // Match detections to existing tracks (IoU + landmark continuity, greedy
    // by score). Tracks are PURELY motion-continuity based - no identity.
    const matched = new Set<number>();
    const sampleFaces: SampleFace[] = [];

    for (const face of faces) {
      let bestId: number | null = null;
      let bestScore = 0.18; // minimum IoU to claim a track
      for (const [id, track] of tracks) {
        if (matched.has(id) || t - track.lastSeenT > 0.75) continue;
        const score = iou(face.box, track.lastBox);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }

      if (bestId === null) {
        bestId = nextTrackId;
        nextTrackId += 1;
        tracks.set(bestId, {
          id: bestId,
          lastBox: face.box,
          lastSeenT: t,
          prevMouthThumb: null,
          prevFaceThumb: null,
          totalSpeaking: 0,
          totalVisible: 0,
          faceHeightSum: 0,
          samples: [],
        });
      }

      const track = tracks.get(bestId)!;
      matched.add(bestId);

      const mouthThumb = sampleThumb(gray, width, height, mouthRoi(face), MOUTH_THUMB_W, MOUTH_THUMB_H);
      const faceRoi = {
        x: face.box.x,
        y: face.box.y,
        w: face.box.width,
        h: face.box.height,
      };
      const faceThumb = sampleThumb(gray, width, height, faceRoi, FACE_THUMB, FACE_THUMB);

      // Combined motion: mouth movement dominates, full-face motion covers the
      // "mouth hidden behind a mic/mask/hand" worst case.
      const mouthMotion = thumbDiff(track.prevMouthThumb, mouthThumb);
      const faceMotion = thumbDiff(track.prevFaceThumb, faceThumb);
      const motion = clamp(mouthMotion + 0.5 * faceMotion, 0, 1);

      track.prevMouthThumb = mouthThumb;
      track.prevFaceThumb = faceThumb;
      track.lastBox = face.box;
      track.lastSeenT = t;
      track.totalVisible += 1;
      track.faceHeightSum += face.box.height;
      track.samples.push({ t, box: face.box, motion });

      sampleFaces.push({ trackId: bestId, box: face.box, motion, score: face.score });
    }

    samples.push({ t, faces: sampleFaces, audioRms: envelope[i] ?? 0, activeTrackId: null });
    void image;
  }

  // Stash tracks for the decision stage via the samples (ids already on faces).
  (samples as Sample[] & { _tracks?: Map<number, TrackState> })._tracks = tracks;
  return samples;
}

export function decideSpeakers(
  samples: Sample[],
  sourceWidth: number,
  sourceHeight: number,
  hasAudio: boolean,
  focusFallback: FocusTimeline,
  splitFallback: SplitTimeline
): SpeakerAnalysis {
  const tracks = ((samples as Sample[] & { _tracks?: Map<number, TrackState> })._tracks ??
    new Map<number, TrackState>()) as Map<number, TrackState>;

  const windowBins = Math.max(3, Math.round(1.2 * SAMPLE_FPS));
  let prevActive: number | null = null;
  let lastSwitchT = -10;

  // Very short clips (or an empty sample set) get the deterministic fallback
  // timelines instead of per-frame scoring.
  if (samples.length < Math.round(1.5 * SAMPLE_FPS)) {
    return finalizeDecisions(samples, tracks, sourceWidth, sourceHeight, hasAudio, focusFallback, splitFallback);
  }

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    // Snapshot for scoring: keeps continuity bonuses free of later assignments
    // to prevActive (and avoids a circular type inference for `score`).
    const prevActiveSnapshot: number | null = prevActive;
    if (sample.faces.length === 0) {
      sample.activeTrackId = prevActive;
      continue;
    }
    if (sample.faces.length === 1) {
      sample.activeTrackId = sample.faces[0].trackId;
      prevActive = sample.activeTrackId;
      tracks.get(prevActive)!.totalSpeaking += 1;
      continue;
    }

    const from = Math.max(0, i - windowBins);
    const audioWindow = samples.slice(from, i + 1).map((s) => s.audioRms);

    let best: { trackId: number; score: number } | null = null;
    let second: { trackId: number; score: number } | null = null;
    let maxMotion = 1e-6;

    const candidates = sample.faces.map((face) => {
      const motionWindow = motionSeriesFor(tracks.get(face.trackId)!, samples[from].t, sample.t);
      maxMotion = Math.max(maxMotion, Math.max(...motionWindow, 0));
      return { face, motionWindow };
    });

    for (const { face, motionWindow } of candidates) {
      const corr: number = hasAudio ? Math.max(0, correlation(motionWindow, audioWindow)) : 0;
      const meanMotion = motionWindow.reduce((a, b) => a + b, 0) / Math.max(1, motionWindow.length);
      const track = tracks.get(face.trackId)!;
      const avgFaceH = track.faceHeightSum / Math.max(1, track.totalVisible);
      const sizeBonus = clamp(avgFaceH / (sourceHeight * 0.3), 0, 1) * 0.08;
      const continuityBonus: number = face.trackId === prevActiveSnapshot ? 0.12 : 0;
      const energy = clamp(meanMotion / maxMotion, 0, 1);

      // Weighted multi-cue score. When mouths are covered the correlation and
      // energy terms flatten toward 0 and the worst-case bonuses (continuity,
      // size) decide - which is exactly the desired behaviour.
      const score: number = 0.55 * corr + 0.45 * energy + continuityBonus + sizeBonus;

      if (!best || score > best.score) {
        second = best;
        best = { trackId: face.trackId, score };
      } else if (!second || score > second.score) {
        second = { trackId: face.trackId, score };
      }
    }

    void second;

    if (!best) {
      sample.activeTrackId = prevActive;
      continue;
    }

    // Hysteresis: only switch when the challenger clearly wins, and never more
    // often than once per 0.75s (avoids frame flicker on borderline scores).
    const activeCandidate = sample.faces.find((f) => f.trackId === prevActive);
    const shouldSwitch =
      best.trackId !== prevActive &&
      sample.t - lastSwitchT > 0.75 &&
      (!activeCandidate || best.score > 0.05 + scoreOf(activeCandidate));

    if (shouldSwitch) {
      prevActive = best.trackId;
      lastSwitchT = sample.t;
    }

    sample.activeTrackId = prevActive ?? best.trackId;
    const winner = tracks.get(sample.activeTrackId);
    if (winner) winner.totalSpeaking += 1;
  }

  return finalizeDecisions(samples, tracks, sourceWidth, sourceHeight, hasAudio, focusFallback, splitFallback);

  function scoreOf(face: SampleFace): number {
    // Rough reconstruction of the challenger comparison used above.
    return face.motion + (face.trackId === prevActive ? 0.12 : 0);
  }
}

/**
 * Shared tail of the decision stage: turn per-sample active-speaker decisions
 * into smoothed focus/split crop timelines and the final analysis record.
 */
function finalizeDecisions(
  samples: Sample[],
  tracks: Map<number, TrackState>,
  sourceWidth: number,
  sourceHeight: number,
  hasAudio: boolean,
  focusFallback: FocusTimeline,
  splitFallback: SplitTimeline
): SpeakerAnalysis {
  const speakerSegments = segmentsFromSamples(samples);
  const focus = samples.length
    ? buildFocusTimeline(samples, tracks, sourceWidth, sourceHeight, speakerSegments)
    : focusFallback;
  const split = samples.length
    ? buildSplitTimeline(samples, tracks, sourceWidth, sourceHeight, speakerSegments)
    : splitFallback;

  return {
    method: hasAudio ? 'yunet-audio-visual' : 'yunet-visual',
    hasAudio,
    sourceWidth,
    sourceHeight,
    focus,
    split,
    speakerSegments,
    trackCount: tracks.size,
  };
}

function motionSeriesFor(track: TrackState, fromT: number, toT: number): number[] {
  return track.samples.filter((s) => s.t >= fromT - 1e-6 && s.t <= toT + 1e-6).map((s) => s.motion);
}

export function segmentsFromSamples(samples: Sample[]): SpeakerSegmentInfo[] {
  const segments: SpeakerSegmentInfo[] = [];
  let current: SpeakerSegmentInfo | null = null;

  for (const sample of samples) {
    const id = sample.activeTrackId;
    if (id === null) continue;
    if (current && current.trackId === id) {
      current.end = sample.t + 1 / SAMPLE_FPS;
    } else {
      if (current) segments.push(current);
      current = { trackId: id, start: sample.t, end: sample.t + 1 / SAMPLE_FPS };
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Median of a numeric series (used for stable crop sizing per track). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Turn per-sample active-speaker decisions into a smoothed crop timeline.
 * Speaker changes become a ~0.45s glide to the new speaker ("when the speaker
 * changes, the frame changes" - but never with a hard jump).
 */
export function buildFocusTimeline(
  samples: Sample[],
  tracks: Map<number, TrackState>,
  sourceWidth: number,
  sourceHeight: number,
  segments: SpeakerSegmentInfo[]
): FocusTimeline {
  const landscape = sourceWidth / sourceHeight >= 9 / 16;
  const cropH = landscape ? sourceHeight : Math.min(sourceHeight, Math.round(sourceWidth * 16 / 9));
  const cropW = landscape ? Math.min(sourceWidth, Math.round(sourceHeight * 9 / 16)) : sourceWidth;
  const axis: 'x' | 'y' = landscape ? 'x' : 'y';
  const maxPos = Math.max(0, axis === 'x' ? sourceWidth - cropW : sourceHeight - cropH);

  const keyframes: Keyframe[] = [];
  let lastPos: number | null = null;

  const push = (t: number, pos: number) => {
    const v = clamp(pos, 0, maxPos);
    if (lastPos === null || Math.abs(v - lastPos) > 10 || keyframes.length < 2) {
      keyframes.push({ t: Math.max(0, Math.min(t, samples[samples.length - 1]?.t ?? t)), v });
      lastPos = v;
    }
  };

  for (const sample of samples) {
    const active = sample.faces.find((f) => f.trackId === sample.activeTrackId) ?? sample.faces[0];
    if (!active) continue;
    const center = boxCenter(active.box);
    const pos = axis === 'x' ? center.x - cropW / 2 : center.y - cropH / 2;
    push(sample.t, pos);
  }

  // Glide keyframes at speaker changes: hold the old position until the change,
  // then land at the new position 0.45s later. Raw keyframes inside the
  // transition window are superseded by the glide.
  for (const segment of segments) {
    const changeT = segment.start;
    if (changeT <= 0) continue;
    let before: Keyframe | null = null;
    for (let i = keyframes.length - 1; i >= 0; i -= 1) {
      if (keyframes[i].t < changeT) {
        before = keyframes[i];
        break;
      }
    }
    const after = keyframes.find((k) => k.t >= changeT) ?? null;
    if (before && after && Math.abs(before.v - after.v) > 10) {
      const keep = keyframes.filter((k) => !(k.t >= changeT && k.t <= changeT + 0.45 && k !== before));
      keyframes.length = 0;
      keyframes.push(...keep);
      keyframes.push({ t: changeT, v: before.v });
      keyframes.push({ t: changeT + 0.45, v: after.v });
    }
  }

  keyframes.sort((a, b) => a.t - b.t);

  // Guarantee a start/end anchor so the expression is fully defined.
  const endT = samples[samples.length - 1]?.t ?? 1;
  if (!keyframes.length || keyframes[0].t > 0) {
    const first = keyframes[0]?.v ?? maxPos / 2;
    keyframes.unshift({ t: 0, v: first });
  }
  if (keyframes[keyframes.length - 1].t < endT) {
    keyframes.push({ t: endT + 0.5, v: keyframes[keyframes.length - 1].v });
  }

  void tracks;
  return { cropW: evenSize(cropW), cropH: evenSize(cropH), axis, keyframes };
}

/**
 * Split-screen timeline: two stacked panes, the ACTIVE speaker always on top
 * (so a speaker change re-frames the split), each pane following its person's
 * face with its own clamped x/y path.
 */
export function buildSplitTimeline(
  samples: Sample[],
  tracks: Map<number, TrackState>,
  sourceWidth: number,
  sourceHeight: number,
  segments: SpeakerSegmentInfo[]
): SplitTimeline {
  const trackIds = [...tracks.keys()];
  const ranked = trackIds.sort((a, b) => {
    const ta = tracks.get(a)!;
    const tb = tracks.get(b)!;
    return tb.totalSpeaking - ta.totalSpeaking || tb.totalVisible - ta.totalVisible;
  });
  const mainA = ranked[0] ?? null;

  const faceHeights = ranked.map((id) => {
    const track = tracks.get(id)!;
    return track.faceHeightSum / Math.max(1, track.totalVisible);
  });
  const typicalFaceH = median(faceHeights.filter((h) => h > 0)) || sourceHeight * 0.25;

  const cropH = evenSize(clamp(typicalFaceH * 2.6, sourceHeight * 0.45, sourceHeight * 0.92));
  const cropW = evenSize(Math.min(sourceWidth, Math.round((cropH * 1080) / 960)));

  const top: PaneKeyframe[] = [];
  const bottom: PaneKeyframe[] = [];
  const endT = samples[samples.length - 1]?.t ?? 1;

  const paneTarget = (
    box: DetectedFace['box'],
    zoom: number
  ): { x: number; y: number } => {
    const center = boxCenter(box);
    const w = cropW * zoom;
    const h = cropH * zoom;
    return {
      x: clamp(center.x - w / 2, 0, Math.max(0, sourceWidth - cropW)),
      y: clamp(center.y - h * 0.42, 0, Math.max(0, sourceHeight - cropH)),
    };
  };

  let lastTop: { x: number; y: number } | null = null;
  let lastBottom: { x: number; y: number } | null = null;

  for (const sample of samples) {
    const activeId = sample.activeTrackId;
    const topFace =
      sample.faces.find((f) => f.trackId === activeId) ??
      sample.faces.find((f) => f.trackId === mainA) ??
      sample.faces[0];
    // The bottom pane shows the OTHER person, so a speaker change swaps panes
    // (active speaker always on top). A single face appears in both panes
    // (bottom zoomed slightly).
    const bottomFace =
      (topFace ? sample.faces.find((f) => f.trackId !== topFace.trackId) : undefined) ?? topFace;

    if (topFace) {
      const target = paneTarget(topFace.box, 1);
      if (!lastTop || Math.abs(target.x - lastTop.x) > 10 || Math.abs(target.y - lastTop.y) > 10) {
        top.push({ t: sample.t, x: target.x, y: target.y });
        lastTop = target;
      }
    }
    if (bottomFace) {
      const target = paneTarget(bottomFace.box, bottomFace === topFace ? 1.25 : 1);
      if (!lastBottom || Math.abs(target.x - lastBottom.x) > 10 || Math.abs(target.y - lastBottom.y) > 10) {
        bottom.push({ t: sample.t, x: target.x, y: target.y });
        lastBottom = target;
      }
    }
  }

  // Smooth glide on speaker changes (same 0.45s transition as the focus layout).
  for (const segment of segments) {
    const changeT = segment.start;
    if (changeT <= 0) continue;
    for (const pane of [top, bottom]) {
      let before: PaneKeyframe | null = null;
      for (let i = pane.length - 1; i >= 0; i -= 1) {
        if (pane[i].t < changeT) {
          before = pane[i];
          break;
        }
      }
      const after = pane.find((k) => k.t >= changeT) ?? null;
      if (before && after && (Math.abs(before.x - after.x) > 10 || Math.abs(before.y - after.y) > 10)) {
        const keep = pane.filter((k) => !(k.t >= changeT && k.t <= changeT + 0.45 && k !== before));
        pane.length = 0;
        pane.push(...keep);
        pane.push({ t: changeT, x: before.x, y: before.y });
        pane.push({ t: changeT + 0.45, x: after.x, y: after.y });
      }
    }
  }

  top.sort((a, b) => a.t - b.t);
  bottom.sort((a, b) => a.t - b.t);

  const anchorPane = (pane: PaneKeyframe[], fallbackY: number) => {
    if (!pane.length || pane[0].t > 0) {
      const first = pane[0] ?? { x: Math.max(0, (sourceWidth - cropW) / 2), y: fallbackY };
      pane.unshift({ t: 0, x: first.x, y: first.y });
    }
    if (pane[pane.length - 1].t < endT) {
      const last = pane[pane.length - 1];
      pane.push({ t: endT + 0.5, x: last.x, y: last.y });
    }
  };
  anchorPane(top, sourceHeight * 0.05);
  anchorPane(bottom, sourceHeight * 0.32);

  return { cropW, cropH, top, bottom };
}
