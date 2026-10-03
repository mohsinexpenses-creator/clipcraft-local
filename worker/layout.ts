/**
 * Layout engine: turns the ASD result (tracks + speaker timeline) into a
 * concrete 9:16 rendering plan, and the plan into FFmpeg filter graphs.
 *
 * Two user-selectable modes:
 *
 *  - `speaker-focus`: ONE time-varying 9:16 window that pans (EMA + slew
 *    limited, exactly like the original smart crop) from speaker to speaker.
 *    The face is anchored ~32% from the top of the window so the frame shows
 *    the head plus upper body instead of an unnaturally zoomed face.
 *
 *  - `split-screen`: an adaptive grid (2 stacked / 3 adaptive / 2x2) that
 *    keeps every relevant person visible at all times. Each pane is a LOCKED
 *    crop of its person (worker/camera-lock.ts): it is placed on the person once,
 *    holds perfectly still while the head stays inside it, and only glides to
 *    re-centre them when the head leaves the frame. No emphasis frame is drawn.
 *
 * Pure logic (no I/O) - the plan builders and filter-graph strings are
 * unit-testable without FFmpeg.
 */

import { AsdResult } from './asd';
import { FaceTrackPoint, decimateTrack, evenSize, smoothTrack } from './frame-sampler';
import { Track } from './asd/tracker';
import {
  CameraMove,
  CameraPath,
  CameraSample,
  FACE_HALF_HEIGHT,
  HEAD_DOWN,
  HEAD_UP,
  buildLockedCamera,
  cameraPositionAt,
  filterSamples,
} from './camera-lock';

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

export type LayoutMode = 'speaker-focus' | 'split-screen';

/** One keyframe of a crop window's centre (mirrored source pixels). */
export interface PanPoint {
  t: number;
  x: number;
  y: number;
}

export interface SinglePlan {
  mode: 'single';
  /** 9:16 window size in source pixels. */
  cropW: number;
  cropH: number;
  /** Smoothed camera path (empty = static centred crop). */
  points: PanPoint[];
  /** Where the tracked face sits inside the window (0.5 = centred, <0.5 = higher). */
  faceAnchorY: number;
  /**
   * Set ONLY when the user asked for a split screen but this single window was
   * rendered instead (fewer than two people could be found). Says why, so the
   * worker log / clip card can tell the user rather than silently degrading.
   */
  splitFallbackReason?: string;
}

/** A vertical band of the 1080x1920 canvas (output pixels, top < bottom). */
export interface CanvasZone {
  top: number;
  bottom: number;
}

/** Where one person's face / head are on the canvas at one sampled moment. */
export interface FaceTraceSample {
  /** Seconds from the clip start (base clip, before the hook intro is prepended). */
  t: number;
  faceTop: number;
  faceBottom: number;
  headTop: number;
  headBottom: number;
}

export interface CellPlan {
  trackId: number;
  /** Position/size on the 1080x1920 canvas. */
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
  /** Crop window in source pixels (matches the cell aspect). */
  cropW: number;
  cropH: number;
  /**
   * The locked camera: where the window starts and the (usually zero) eased
   * glides that re-centre the person. See worker/camera-lock.ts.
   */
  camera: CameraPath;
  /**
   * Where this person's FACE (detector box) appears on the canvas over the whole
   * clip - the area no overlay may cover.
   */
  faceZone: CanvasZone;
  /** The same for the whole HEAD (hair included) - overlays avoid it when they can. */
  headZone: CanvasZone;
  /**
   * The same thing moment by moment, so an overlay that is only on screen for part
   * of the clip (the hook intro, the end CTA) can be placed against where the face
   * is THEN rather than everywhere it ever goes. See `zonesBetween`.
   */
  trace: FaceTraceSample[];
}

export interface SplitPlan {
  mode: 'split';
  cells: CellPlan[];
}

export type LayoutPlan = SinglePlan | SplitPlan;

const SPEAKER_FACE_ANCHOR_Y = 0.32;
/** A face box is roughly 80% as wide as it is tall. */
const FACE_BOX_ASPECT = 0.8;
const DEFAULT_SPLIT_FACE_TARGET_FRAC = 0.38;
const DEFAULT_SPLIT_ZOOM = 3.5;
const MIN_SPLIT_ZOOM = 1;
const MAX_SPLIT_ZOOM = 4;
const MIN_FACE_TARGET_FRAC = 0.25;
const MAX_FACE_TARGET_FRAC = 0.55;
/** Preferred output face height (38% of a pane) before zoom/source bounds apply. */
const SPLIT_FACE_HEIGHT_FRAC = 0.38;

export interface SplitFramingSettings {
  /** Face-centre target, as a fraction from the top of each pane. */
  faceTargetFrac: number;
  /** Maximum crop enlargement; limited further when the source is too small. */
  zoom: number;
}

const DEFAULT_SPLIT_FRAMING_SETTINGS: SplitFramingSettings = {
  faceTargetFrac: DEFAULT_SPLIT_FACE_TARGET_FRAC,
  zoom: DEFAULT_SPLIT_ZOOM,
};

/** Parse/clamp split framing environment values; exported for deterministic tests. */
export function getSplitFramingSettings(
  env: Record<string, string | undefined> = process.env
): SplitFramingSettings {
  const targetRaw = env.SPLIT_FACE_TARGET_FRAC?.trim();
  const zoomRaw = env.SPLIT_ZOOM?.trim();
  const targetValue = targetRaw ? Number(targetRaw) : Number.NaN;
  const zoomValue = zoomRaw ? Number(zoomRaw) : Number.NaN;
  return {
    faceTargetFrac: Number.isFinite(targetValue)
      ? Math.max(MIN_FACE_TARGET_FRAC, Math.min(targetValue, MAX_FACE_TARGET_FRAC))
      : DEFAULT_SPLIT_FACE_TARGET_FRAC,
    zoom: Number.isFinite(zoomValue)
      ? Math.max(MIN_SPLIT_ZOOM, Math.min(zoomValue, MAX_SPLIT_ZOOM))
      : DEFAULT_SPLIT_ZOOM,
  };
}

/** Default max magnification, retained as a named constant for existing consumers/tests. */
export const MAX_CELL_UPSCALE = DEFAULT_SPLIT_ZOOM;
/**
 * A track must be at least this wide (fraction of the source width) to count as
 * a real on-screen PERSON in the split planner (speaker or not). Kills specks
 * the detector keeps (it only drops < 1.4%).
 */
const MIN_PERSON_FACE_FRACTION = 0.02;
/**
 * A person who never speaks needs a face at least this fraction of the biggest
 * speaker's - a much smaller "face" is a poster / screen / passer-by, not the
 * second person of the conversation.
 */
const MIN_LISTENER_SIZE_RATIO = 0.45;

/** `t-5.000` / `t+1.500` - never `t--1.500` (a keyframe time can be negative once shifted for the hook branch). */
function tMinus(time: number): string {
  return time < 0 ? `t+${(-time).toFixed(3)}` : `t-${time.toFixed(3)}`;
}

/**
 * Generalised pan expression: piecewise-smooth window POSITION over time for
 * one axis (X or Y), given face CENTRES and the anchor fraction of the window
 * that the centre should sit at. Clamped so the window never leaves the frame.
 * (This is a generalisation of the original buildCropXExpression - pass
 * anchorFrac 0.5 and it behaves exactly like that.)
 *
 * IMPORTANT: the input MUST be flattened + decimated first (see
 * flattenAndDecimate) - with 200+ points the FFmpeg command line exceeds
 * Windows' ~32k character limit and spawn fails with ENAMETOOLONG.
 */
export function buildPanExpression(
  points: PanPoint[],
  axis: 'x' | 'y',
  dimSize: number,
  winSize: number,
  anchorFrac: number
): string {
  const maxPos = Math.max(0, dimSize - winSize);
  const posFor = (centre: number): number =>
    Math.max(0, Math.min(centre - winSize * anchorFrac, maxPos));
  const clamp = (expr: string): string => (maxPos === 0 ? '0' : `min(max(${expr},0),${maxPos})`);

  if (points.length === 0) return String(posFor(dimSize / 2));

  // A face that never moves in this axis -> emit a plain constant instead of
  // a 200-branch if() chain of the same value.
  const positions = points.map((p) => posFor(p[axis]));
  const minPos = Math.min(...positions);
  const maxPosOfValues = Math.max(...positions);
  if (maxPosOfValues - minPos < 0.5) return clamp(positions[0].toFixed(1));

  if (points.length === 1) return clamp(positions[0].toFixed(1));

  let expr = posFor(points[points.length - 1][axis]).toFixed(1);
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = Math.max(1e-3, b.t - a.t);
    const pa = posFor(a[axis]).toFixed(1);
    const pb = posFor(b[axis]).toFixed(1);
    const u = `(${tMinus(a.t)})/${segLen.toFixed(3)}`;
    // Smoothstep the interval so the window eases in/out instead of producing
    // a linear crawl that is especially visible after crop-coordinate rounding.
    const eased = `((${u})*(${u})*(3-2*(${u})))`;
    const interp = `(${pa}+(${pb}-${pa})*${eased})`;
    expr = `if(gte(t,${a.t.toFixed(3)})*lte(t,${b.t.toFixed(3)}),${interp},${expr})`;
  }
  if (points[0].t > 0) {
    expr = `if(gte(t,${points[0].t.toFixed(3)}),${expr},${posFor(points[0][axis]).toFixed(1)})`;
  }
  return clamp(expr);
}

/**
 * Flatten a per-sample face track into a small set of pan keyframes:
 *
 * 1. Jitter filter: a point that moves less than `deadZonePx` (source px) in
 *    BOTH axes from the last kept point is dropped - face detection jitters
 *    by a few pixels between samples and the old code turned that into a
 *    visible shake at every sample. Time anchors every 10s keep the timeline
 *    covered even for a completely static speaker.
 * 2. Deviation decimation (decimateTrack): collinear points are removed
 *    without changing the path, and a hard cap (24) keeps the generated
 *    FFmpeg expressions inside command-line limits - 24 keyframes over 60s
 *    is one every 2.5s; the FFmpeg expression smoothstep-eases between them.
 */
export function flattenAndDecimate(points: PanPoint[], maxPoints = 24, deadZonePx = 6): PanPoint[] {
  if (points.length === 0) return points;

  const jittered: PanPoint[] = [];
  /** Last point dropped by the dead zone (its time anchors the end of a flat run). */
  let lastDroppedT: number | null = null;
  for (const p of points) {
    const last = jittered[jittered.length - 1];
    if (!last) {
      jittered.push(p);
      continue;
    }
    const movedX = Math.abs(p.x - last.x) >= deadZonePx;
    const movedY = Math.abs(p.y - last.y) >= deadZonePx;
    if (movedX || movedY || p.t - last.t >= 10) {
      // A flat (dead-zoned) run just ended with a real move: re-insert the
      // end of that run at its frozen position. Without this, the crop window
      // is drawn as ONE straight line from "arrived at speaker B" to
      // "left speaker A" - a diagonal that crosses the centre of the frame
      // for most of the hold. The user saw exactly that: "frame stays in the
      // centre".
      if (lastDroppedT !== null && (movedX || movedY)) {
        jittered.push({ t: lastDroppedT, x: last.x, y: last.y });
      }
      jittered.push({ t: p.t, x: movedX ? p.x : last.x, y: movedY ? p.y : last.y });
      lastDroppedT = null;
    } else {
      lastDroppedT = p.t;
    }
  }

  // The final position must stay exact when the face actually travelled
  // (otherwise a 100px pan would end 6px short). For a pure-jitter track the
  // tail is frozen, so residual detection noise never leaks in as a twitch.
  const first = points[0];
  const lastInput = points[points.length - 1];
  const lastKept = jittered[jittered.length - 1];
  if (lastInput !== lastKept) {
    const overallMoved =
      Math.abs(lastInput.x - first.x) >= deadZonePx ||
      Math.abs(lastInput.y - first.y) >= deadZonePx;
    jittered.push(
      overallMoved
        ? lastInput
        : { t: lastInput.t, x: lastKept.x, y: lastKept.y }
    );
  }

  return decimateTrack(
    jittered.map((p) => ({ t: p.t, x: p.x, y: p.y, box: { x: p.x, y: p.y, w: 1, h: 1 } })),
    undefined,
    0.5,
    maxPoints
  ).map((p) => ({ t: p.t, x: p.x, y: p.y }));
}

function trackToPanPoints(track: Track, srcW: number, deadZonePx = 6): PanPoint[] {
  if (track.points.length === 0) return [];
  const asFace: FaceTrackPoint[] = track.points.map((p) => ({ t: p.t, x: p.cx, y: p.cy }));
  const smoothed = smoothTrack(asFace, srcW);
  const points = smoothed.map((p) => ({ t: p.t, x: p.x, y: p.y }));
  return flattenAndDecimate(points, 24, deadZonePx);
}

/** How long (s) the crop window glides from one speaker to the next. */
const SPEAKER_GLIDE_SECONDS = 0.15;

/** Median of a number array (unlike the mean, it rejects outlier sightings). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The camera path for speaker-focus: ONE stable anchor per speaker segment.
 *
 * While a person speaks the crop window stays LOCKED on that person's median
 * centre - the old per-sample chase (which drifted with every minor head or
 * body movement) is gone. The MEDIAN (not the mean) rejects outliers from
 * brief occlusions and head turns.
 *
 * The crop filter smoothstep-eases between keyframes, so "lock on A until B is
 * judged the speaker, then a fast glide to B" needs explicit keyframes:
 *   - at seg.t0       : the previous speaker's anchor (still locked on A at the
 *                      exact moment B starts - no creeping toward B early),
 *   - at t0 + 0.15s   : this segment's anchor (the glide is complete),
 *   - at seg.t1       : the same anchor again (locked for the rest of the
 *                      segment - without this the window would ramp toward the
 *                      NEXT speaker during the current speaker's segment).
 * No EMA/slew smoothing is applied: the keyframes themselves encode the
 * lock + 0.15s glide, and re-smoothing them would blur the lock.
 */
// `_srcW` is intentionally part of the signature (the pan expressions clamp
// against the source size downstream); the anchor maths works in source px.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildSpeakerPath(asd: AsdResult, _srcW: number): PanPoint[] {
  const byId = new Map<number, Track>();
  for (const track of asd.tracks) byId.set(track.id, track);

  const points: PanPoint[] = [];
  let prev: { x: number; y: number } | null = null;

  for (const seg of asd.speakerSegments) {
    if (seg.trackId === null) continue; // no face on screen: hold previous position
    const track = byId.get(seg.trackId);
    if (!track) continue;

    // The speaker's sightings inside this segment (0.001s epsilon).
    const inSegment = track.points.filter(
      (p) => p.t >= seg.t0 - 0.001 && p.t <= seg.t1 + 0.001
    );
    if (inSegment.length === 0) continue;
    const x = median(inSegment.map((p) => p.cx));
    const y = median(inSegment.map((p) => p.cy));

    if (prev === null) {
      points.push({ t: seg.t0, x, y });
    } else {
      // Speaker switch: hold the previous anchor at the boundary (robust even
      // with a gap between segments), then glide to the new anchor.
      points.push({ t: seg.t0, x: prev.x, y: prev.y });
      points.push({ t: Math.min(seg.t0 + SPEAKER_GLIDE_SECONDS, seg.t1), x, y });
    }
    // Lock the anchor for the remainder of the segment.
    points.push({ t: seg.t1, x, y });

    prev = { x, y };
  }

  return points;
}

/** Largest 9:16 window that fits inside the source (even dimensions). */
export function largest916Window(srcW: number, srcH: number): { w: number; h: number } {
  let h = evenSize(srcH);
  let w = evenSize(h * (9 / 16));
  if (w > srcW) {
    w = evenSize(srcW);
    h = evenSize(w / (9 / 16));
  }
  return { w: Math.min(w, evenSize(srcW)), h: Math.min(h, evenSize(srcH)) };
}

export function buildLayoutPlan(
  asd: AsdResult,
  layout: LayoutMode,
  srcW: number,
  srcH: number,
  splitFraming: SplitFramingSettings = DEFAULT_SPLIT_FRAMING_SETTINGS
): LayoutPlan {
  if (layout === 'split-screen') {
    return buildSplitPlan(asd, srcW, srcH, splitFraming);
  }
  return buildSinglePlan(asd, srcW, srcH, SPEAKER_FACE_ANCHOR_Y);
}

/** Speaker-focus plan. anchorY 0.5 + static-y points = the legacy behaviour. */
export function buildSinglePlan(
  asd: AsdResult,
  srcW: number,
  srcH: number,
  faceAnchorY: number
): SinglePlan {
  const { w: cropW, h: cropH } = largest916Window(srcW, srcH);
  let points = buildSpeakerPath(asd, srcW);

  // Fallback: the audio+visual speaker fusion can come back empty (short clip,
  // low voice energy, ...). The window must still follow SOMEONE - use the
  // most visible track instead of freezing a static centred crop.
  if (points.length <= 1) {
    const best = asd.tracks
      .filter((track) => track.points.length >= 2)
      .sort((a, b) => b.visibleTime * b.avgW - a.visibleTime * a.avgW)[0];
    if (best) points = trackToPanPoints(best, srcW);
  }

  if (points.length <= 1) {
    // No usable track data -> static centred crop (the long-standing fallback).
    return { mode: 'single', cropW, cropH, points: [], faceAnchorY };
  }

  // No decimation/smoothing here: the speaker path already emits exactly the
  // keyframes it needs (one lock anchor per segment + switch glides), and
  // re-smoothing them would reintroduce the drift toward the next speaker.
  // The fallback path (trackToPanPoints) still decimates internally.

  return { mode: 'single', cropW, cropH, points, faceAnchorY };
}

/**
 * How many DIFFERENT people are on screen at the same time at the busiest
 * moment (0.25s buckets). The split grid is sized from this - not from the
 * raw track count - so a two-person conversation is always a 2-pane split
 * even if the tracker had to re-identify someone mid-clip.
 */
function peakConcurrent(tracks: Track[]): number {
  const buckets = new Map<number, Set<number>>();
  for (const track of tracks) {
    for (const p of track.points) {
      const key = Math.round(p.t * 4);
      let set = buckets.get(key);
      if (!set) {
        set = new Set<number>();
        buckets.set(key, set);
      }
      set.add(track.id);
    }
  }
  let peak = 0;
  for (const set of buckets.values()) peak = Math.max(peak, set.size);
  return peak;
}

/**
 * Source-pixel crop window for ONE split pane.
 *
 * Target a ~38%-pane-height face for ordinary source sizes. SPLIT_ZOOM caps how
 * tightly small faces may be cropped; source dimensions impose an additional hard
 * bound so the crop can never extend beyond the actual frame. The window always
 * matches the pane's aspect, including the wide three-cell top and narrow 3/4 grid
 * cells.
 */
export function cellCropSize(
  faceW: number,
  cellW: number,
  cellH: number,
  srcW: number,
  srcH: number,
  framing: SplitFramingSettings = DEFAULT_SPLIT_FRAMING_SETTINGS
): { cropW: number; cropH: number } {
  const aspect = cellW / cellH;
  const faceH = Math.max(40, faceW / FACE_BOX_ASPECT);

  let cropH = Math.max(faceH / SPLIT_FACE_HEIGHT_FRAC, cellH / framing.zoom);
  // Largest window of this aspect that fits in the source.
  cropH = Math.min(cropH, srcH, srcW / aspect);

  const h = evenSize(cropH);
  const w = Math.min(evenSize(h * aspect), evenSize(srcW));
  return { cropW: w, cropH: Math.min(h, evenSize(srcH)) };
}

/**
 * Where one person's FACE and HEAD appear on the 1080x1920 canvas over the whole
 * clip, given the pane they are shown in and its camera. The overlay planner
 * (worker/overlay-layout.ts) keeps the hook / captions / CTA out of these bands.
 * Detections are median-filtered first so one bad box can't inflate a zone.
 */
export function paneZones(
  samples: CameraSample[],
  camera: CameraPath,
  pane: { cellY: number; cellH: number; cropH: number; faceTargetFrac?: number }
): { face: CanvasZone; head: CanvasZone; trace: FaceTraceSample[] } {
  const scale = pane.cellH / pane.cropH;
  const lo = pane.cellY;
  const hi = pane.cellY + pane.cellH;
  const clamp = (y: number): number => Math.max(lo, Math.min(y, hi));

  const trace: FaceTraceSample[] = [];
  for (const s of filterSamples(samples)) {
    const win = cameraPositionAt(camera, s.t);
    const toCanvas = (srcY: number): number => clamp(pane.cellY + (srcY - win.y) * scale);
    trace.push({
      t: s.t,
      faceTop: toCanvas(s.cy - FACE_HALF_HEIGHT * s.w),
      faceBottom: toCanvas(s.cy + FACE_HALF_HEIGHT * s.w),
      headTop: toCanvas(s.cy - HEAD_UP * s.w),
      headBottom: toCanvas(s.cy + HEAD_DOWN * s.w),
    });
  }
  if (trace.length === 0) {
    // No samples (never planned on purpose): keep fallback zones at the configured face target.
    const mid = pane.cellY + pane.cellH * (pane.faceTargetFrac ?? DEFAULT_SPLIT_FACE_TARGET_FRAC);
    const half = pane.cellH * 0.15;
    return {
      face: { top: mid - half, bottom: mid + half },
      head: { top: mid - half * 1.6, bottom: mid + half * 1.1 },
      trace,
    };
  }
  return { ...unionOf(trace), trace };
}

function unionOf(trace: FaceTraceSample[]): { face: CanvasZone; head: CanvasZone } {
  return {
    face: {
      top: Math.min(...trace.map((p) => p.faceTop)),
      bottom: Math.max(...trace.map((p) => p.faceBottom)),
    },
    head: {
      top: Math.min(...trace.map((p) => p.headTop)),
      bottom: Math.max(...trace.map((p) => p.headBottom)),
    },
  };
}

/**
 * The face / head bands of a pane restricted to the base-clip seconds [t0, t1] -
 * where the person is while an overlay that only shows for that long is on screen.
 * Falls back to the whole-clip zones when the person was not detected in that window.
 */
export function zonesBetween(
  cell: Pick<CellPlan, 'trace' | 'faceZone' | 'headZone'>,
  t0: number,
  t1: number
): { face: CanvasZone; head: CanvasZone } {
  const inside = cell.trace.filter((p) => p.t >= t0 && p.t <= t1);
  if (inside.length === 0) return { face: cell.faceZone, head: cell.headZone };
  return unionOf(inside);
}

/**
 * FFmpeg expression for ONE axis of a locked camera: the start position plus one
 * eased (smoothstep) glide per move,
 *
 *   x0 + d1*S((t-t1)/g1) + d2*S((t-t2)/g2) + ...      S(u) = u*u*(3-2*u), u clipped to 0..1
 *
 * S is 0 before its glide and 1 after it, so the terms simply add up - no nested
 * if() chains, which keeps the expression a few hundred characters even with ten
 * re-centres (Windows' command line is limited to ~32k characters). A window that
 * never moves is just a constant.
 */
export function buildGlideExpression(
  start: number,
  moves: Array<{ t: number; duration: number; pos: number }>,
  maxPos: number
): string {
  if (maxPos <= 0) return '0';
  const terms: string[] = [];
  let prev = start;
  for (const move of moves) {
    const delta = move.pos - prev;
    prev = move.pos;
    if (Math.abs(delta) < 0.05) continue;
    const u = `clip((${tMinus(move.t)})/${Math.max(0.05, move.duration).toFixed(3)},0,1)`;
    terms.push(`(${delta.toFixed(2)})*(3-2*${u})*pow(${u},2)`);
  }
  const base = Math.max(0, Math.min(start, maxPos)).toFixed(1);
  if (terms.length === 0) return base;
  return `min(max(${base}+${terms.join('+')},0),${maxPos})`;
}

/**
 * The X / Y expressions of a pane's camera, ready for `crop=w:h:'X':'Y'`.
 *
 * `timeOffset` is for a branch that replays a LATER part of the clip (the hook
 * intro): its frames start at t=0 but belong to clip time `timeOffset`, so every
 * glide is shifted earlier by that much. With `windowSeconds` too, only the glides
 * that touch [timeOffset, timeOffset + windowSeconds] are kept - those already
 * finished are folded into the start position and later ones dropped - so the hook
 * branch's copy of the camera is usually a plain constant instead of a second long
 * expression on the command line.
 */
export function cameraExpressions(
  camera: CameraPath,
  srcW: number,
  srcH: number,
  cropW: number,
  cropH: number,
  timeOffset = 0,
  windowSeconds?: number
): { x: string; y: string } {
  let start = { x: camera.x0, y: camera.y0 };
  let moves: CameraMove[] = camera.moves;
  if (windowSeconds !== undefined) {
    const windowEnd = timeOffset + windowSeconds;
    const kept: CameraMove[] = [];
    for (const move of camera.moves) {
      if (move.t + move.duration <= timeOffset) {
        start = { x: move.x, y: move.y }; // finished before the window opens
      } else if (move.t < windowEnd) {
        kept.push(move);
      } // else: starts after the window closes - not needed
    }
    moves = kept;
  }
  return {
    x: buildGlideExpression(
      start.x,
      moves.map((m) => ({ t: m.t - timeOffset, duration: m.duration, pos: m.x })),
      Math.max(0, srcW - cropW)
    ),
    y: buildGlideExpression(
      start.y,
      moves.map((m) => ({ t: m.t - timeOffset, duration: m.duration, pos: m.y })),
      Math.max(0, srcH - cropH)
    ),
  };
}

/**
 * Split-screen plan.
 *
 * Returns a SplitPlan (2-4 panes) when at least two people can be shown. With
 * only ONE person it returns the single speaker window (the same full-height 9:16
 * framing as speaker-focus, ~1.8x magnification) with `splitFallbackReason` set -
 * NOT a one-cell "split": that used to crop 212x378 px and blow it up 5x, i.e.
 * a single blurry face filling the frame, which is what a failed split looked like.
 */
function buildSplitPlan(
  asd: AsdResult,
  srcW: number,
  srcH: number,
  splitFraming: SplitFramingSettings
): LayoutPlan {
  // Who was EVER the active speaker - those people always win a cell, and
  // their count caps the grid (a 2-person conversation must never grow a 3rd/
  // 4th cell from a briefly-glimpsed false face).
  const speakerIds = new Set(
    asd.speakerSegments
      .map((seg) => seg.trackId)
      .filter((id): id is number => id !== null)
  );

  // A track counts as a real on-screen person when it has a few sightings AND a
  // big-enough average face (relative to the frame, so the bar means the same
  // on 720p and 4K) - this kills specks and tiny false positives.
  const minPersonW = Math.max(24, srcW * MIN_PERSON_FACE_FRACTION);
  const candidateTracks = asd.tracks.filter(
    (track) => track.points.length >= 2 && track.avgW >= minPersonW
  );

  // The biggest face among the speakers: listeners must be comparable in size.
  const biggestSpeakerW = candidateTracks
    .filter((track) => speakerIds.has(track.id))
    .reduce((max, track) => Math.max(max, track.avgW), 0);

  // Score: speakers ALWAYS beat non-speakers (1e6 bonus), then screen-time*size.
  const scored = candidateTracks
    .map((track) => {
      const isSpeaker = speakerIds.has(track.id);
      return {
        track,
        isSpeaker,
        score: (isSpeaker ? 1_000_000 : 0) + track.visibleTime * track.avgW,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Relevant = every actual speaker (no minimum screen time for them) plus
  // non-speaker co-participants who were on screen for at least 3 seconds AND
  // whose face is comparable to the speaker's (not a poster / screen / passer-by).
  const MIN_CO_PARTICIPANT_VISIBLE_SECONDS = 3;
  let relevant = scored
    .filter(
      (s) =>
        s.isSpeaker ||
        (s.track.visibleTime >= MIN_CO_PARTICIPANT_VISIBLE_SECONDS &&
          (biggestSpeakerW === 0 || s.track.avgW >= biggestSpeakerW * MIN_LISTENER_SIZE_RATIO))
    )
    .map((s) => s.track);

  // People ARE on screen but none passed the filters (tiny faces in a wide
  // shot, fragmented short tracks, ...). Show the most visible people anyway -
  // never silently degrade to a static centred crop.
  if (relevant.length === 0 && asd.tracks.length > 0) {
    relevant = [...asd.tracks]
      .filter((track) => track.points.length > 0)
      .sort((x, y) => y.visibleTime * y.avgW - x.visibleTime * x.avgW)
      .slice(0, 2);
  }

  // Size the grid by how many people SHARE THE SCREEN at the busiest moment -
  // never more panes than that, so fragmented track ids can never inflate 2
  // people into 3-4 cells. But the speaker timeline is a heuristic: when two
  // people clearly co-exist, BOTH get a pane even if only one was ever judged
  // the speaker (a 2-person conversation must be a 2-pane split).
  const coexisting = Math.max(1, peakConcurrent(relevant));
  const count = Math.min(
    4,
    coexisting,
    Math.max(
      relevant.filter((track) => speakerIds.has(track.id)).length,
      Math.min(2, coexisting)
    ),
    relevant.length
  );

  // Fewer than two people to show: a split screen is impossible. Render the
  // proper full-height speaker window and SAY so (see the doc comment).
  if (count < 2) {
    const single = buildSinglePlan(asd, srcW, srcH, SPEAKER_FACE_ANCHOR_Y);
    const seen = asd.tracks.length;
    single.splitFallbackReason =
      relevant.length >= 2 && coexisting < 2
        ? // Two real people, but a camera that cuts between them: there is never a
          // frame with both on screen, so there is nothing to stack.
          `Split screen needs two people on screen at the same time, but the ${relevant.length} ` +
          `people found in this window are never visible together (the camera cuts between them). ` +
          `Rendered a single speaker window that follows the active speaker instead.`
        : `Split screen needs two people on screen at the same time, but ` +
          `${count === 0 ? 'none' : 'only one'} could be confirmed in this window ` +
          `(${seen} face track${seen === 1 ? '' : 's'}, ` +
          `faces in ${asd.framesUsed}/${asd.framesTotal} sampled frames). ` +
          `Rendered a single full-height speaker window instead.`;
    return single;
  }
  relevant = relevant.slice(0, count);

  // Two panes: a stable spatial assignment - the person sitting LEFT (mirrored
  // source space) always gets the TOP pane, the right person the bottom one.
  // The order never swaps mid-clip, no matter who is talking. (3+ panes keep
  // the score order: speakers first, then screen-time x face size.)
  if (count === 2) {
    const medianX = (track: Track): number => median(track.points.map((p) => p.cx));
    relevant.sort((a, b) => medianX(a) - medianX(b));
  }

  // Adaptive 9:16 grids (1080x1920 canvas) - all tile the canvas exactly.
  const grids: Array<Array<[number, number, number, number]>> = [
    [],
    [[0, 0, 1080, 1920]],
    [
      [0, 0, 1080, 960],
      [0, 960, 1080, 960],
    ],
    [
      [0, 0, 1080, 960],
      [0, 960, 540, 960],
      [540, 960, 540, 960],
    ],
    [
      [0, 0, 540, 960],
      [540, 0, 540, 960],
      [0, 960, 540, 960],
      [540, 960, 540, 960],
    ],
  ];

  const cells: CellPlan[] = [];
  for (let i = 0; i < count; i += 1) {
    const [cellX, cellY, cellW, cellH] = grids[count][i];
    const track = relevant[i];
    const { cropW, cropH } = cellCropSize(track.avgW, cellW, cellH, srcW, srcH, splitFraming);

    // The pane is a LOCKED crop: placed on the person once, still while their
    // head stays inside it, gliding to re-centre them only when it leaves.
    const samples: CameraSample[] = track.points.map((p) => ({ t: p.t, cx: p.cx, cy: p.cy, w: p.w }));
    const camera = buildLockedCamera(samples, {
      srcW,
      srcH,
      cropW,
      cropH,
      anchorY: splitFraming.faceTargetFrac,
    });
    const zones = paneZones(samples, camera, {
      cellY,
      cellH,
      cropH,
      faceTargetFrac: splitFraming.faceTargetFrac,
    });

    cells.push({
      trackId: track.id,
      cellX,
      cellY,
      cellW,
      cellH,
      cropW,
      cropH,
      camera,
      faceZone: zones.face,
      headZone: zones.head,
      trace: zones.trace,
    });
  }

  return { mode: 'split', cells };
}

/**
 * Filter chain for the single-window mode (speaker focus):
 *   setpts reset -> hflip -> time-varying crop (X and Y expressions) -> colour -> scale -> yuv420p
 *
 * The timestamp reset matters: after `-ss` the first decoded frame sits a fraction
 * of a frame past 0, and the constant-frame-rate encoder answers that gap by
 * repeating the first frame. Starting the clock at exactly 0 means no frame is
 * duplicated or invented, whatever the cut point.
 *
 * `timeOffset`: see `cameraExpressions` (the hook branch replays a later part).
 */
export function buildSingleFilterParts(
  plan: SinglePlan,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  colorFilter: string,
  timeOffset = 0,
  windowSeconds?: number
): string[] {
  let source = plan.points;
  if (windowSeconds !== undefined && source.length > 2) {
    // Only the keyframes around the replayed window matter (plus one on each side, so the
    // interpolation across its edges is unchanged).
    const t0 = timeOffset;
    const t1 = timeOffset + windowSeconds;
    let first = 0;
    while (first + 1 < source.length && source[first + 1].t <= t0) first += 1;
    let last = source.length - 1;
    while (last - 1 > first && source[last - 1].t >= t1) last -= 1;
    source = source.slice(first, last + 1);
  }
  const points = timeOffset ? source.map((p) => ({ ...p, t: p.t - timeOffset })) : source;
  const xExpr = buildPanExpression(points, 'x', srcW, plan.cropW, 0.5);
  const yExpr = buildPanExpression(points, 'y', srcH, plan.cropH, plan.faceAnchorY);

  const parts: string[] = [
    'setpts=PTS-STARTPTS',
    'hflip',
    `crop=${plan.cropW}:${plan.cropH}:'${xExpr}':'${yExpr}':exact=1`,
  ];
  if (colorFilter) parts.push(colorFilter);
  parts.push(`scale=${outW}:${outH}:flags=lanczos`);
  parts.push('format=yuv420p');
  return parts;
}

/** Where a split graph reads from, what it is called and how its labels are namespaced. */
export interface SplitGraphIo {
  /** Input stream specifier, e.g. `0:v`. */
  input: string;
  /** Label of the finished 1080x1920 stream (no brackets). */
  output: string;
  /** Prefix for every intermediate label, so two branches can live in one graph. */
  prefix: string;
  /** See `cameraExpressions`. */
  timeOffset?: number;
  /** See `cameraExpressions`: how long the branch lasts (the hook intro's length). */
  windowSeconds?: number;
}

/**
 * Filter statements (to be joined with `;`) for the split-screen mode: each pane is
 * a crop of its person (a locked camera - see worker/camera-lock.ts), scaled to the
 * pane, and the panes are laid onto the 1080x1920 canvas. Nothing is drawn on top of
 * them.
 *
 * The canvas is made by PADDING the first pane, not by overlaying onto a free-running
 * black `color` source. That distinction is what keeps the footage frame-exact: a
 * generated canvas has its own clock, so the output got a black first frame (the
 * overlay had nothing to show yet) and a repeated last one, and every source frame
 * was re-timed onto the canvas's grid. Padding keeps the source's own timestamps.
 */
export function buildSplitFilterStatements(
  plan: SplitPlan,
  srcW: number,
  srcH: number,
  colorFilter: string,
  io: SplitGraphIo
): string[] {
  const { input, output, prefix } = io;
  const timeOffset = io.timeOffset ?? 0;
  const n = plan.cells.length;
  const out: string[] = [];

  // Reset the clock, mirror, colour-correct, then fan out with `split`: a filtergraph
  // pad label can be consumed exactly ONCE, so every cell needs its own pad.
  // (Referencing one [base] label for every cell makes FFmpeg reject the WHOLE graph
  // with "Invalid stream specifier" and write an empty file - the original bug that
  // stopped the split screen from rendering at all.)
  const pre = colorFilter
    ? `[${input}]setpts=PTS-STARTPTS,hflip,${colorFilter},format=yuv420p`
    : `[${input}]setpts=PTS-STARTPTS,hflip,format=yuv420p`;
  out.push(`${pre},split=${n}${plan.cells.map((_, i) => `[${prefix}s${i}]`).join('')}`);

  // One crop+scale per person. Use Lanczos for the final resize; pane crop size
  // still controls magnification so small source faces are not enlarged too far.
  plan.cells.forEach((cell, i) => {
    const expr = cameraExpressions(cell.camera, srcW, srcH, cell.cropW, cell.cropH, timeOffset, io.windowSeconds);
    const scaled =
      `[${prefix}s${i}]crop=${cell.cropW}:${cell.cropH}:'${expr.x}':'${expr.y}':exact=1,` +
      `scale=${cell.cellW}:${cell.cellH}:flags=lanczos,format=yuv420p`;
    if (i === 0) {
      out.push(`${scaled},pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:${cell.cellX}:${cell.cellY}:color=black[${n === 1 ? output : `${prefix}o0`}]`);
    } else {
      out.push(`${scaled}[${prefix}c${i}]`);
    }
  });

  // Lay the remaining panes onto the padded first one (they tile the canvas exactly).
  for (let i = 1; i < n; i += 1) {
    const cell = plan.cells[i];
    const label = i === n - 1 ? output : `${prefix}o${i}`;
    out.push(`[${prefix}o${i - 1}][${prefix}c${i}]overlay=${cell.cellX}:${cell.cellY}[${label}]`);
  }
  return out;
}

/** The split graph as one `-filter_complex` string (one input, `[vout]` output). */
export function buildSplitFilterComplex(
  plan: SplitPlan,
  srcW: number,
  srcH: number,
  colorFilter: string,
  io: Partial<SplitGraphIo> = {}
): string {
  return buildSplitFilterStatements(plan, srcW, srcH, colorFilter, {
    input: io.input ?? '0:v',
    output: io.output ?? 'vout',
    prefix: io.prefix ?? '',
    timeOffset: io.timeOffset,
    windowSeconds: io.windowSeconds,
  }).join(';');
}
