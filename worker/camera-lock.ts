/**
 * LOCKED virtual camera for the split-screen panes.
 *
 * A pane used to chase its person: every few pixels of head sway moved the crop
 * window a little, and because FFmpeg's `crop` snaps the window to whole (even)
 * pixels, that creeping showed up as a constant shimmer of the whole background -
 * "the frame is trying to keep the face in the centre". A podcast wide shot has a
 * perfectly static background, so ANY window movement is visible.
 *
 * The camera here behaves like a tripod instead:
 *
 *   1. LOCK  - the window is placed on the person's median position during the
 *              first second they are seen, and then does not move at all.
 *   2. HOLD  - while the head (face box + hair) stays inside the window, minus a
 *              small safety margin, nothing happens. Nodding, swaying, gesturing
 *              and detector jitter are all absorbed by the margin.
 *   3. RE-CENTRE - only when the head has stayed outside that safe zone for a
 *              moment (so a single bad detection can't trigger it) the window
 *              glides - eased, ~0.5-1 s - to re-centre the person, and locks again.
 *
 * Pure logic (no I/O): unit-testable without FFmpeg. The result is expressed as
 * the window's top-left corner in SOURCE (mirrored) pixels: a start position plus
 * a short list of eased glides, which `buildGlideExpression` (worker/layout.ts)
 * turns into a compact FFmpeg expression.
 */

/** One detection of the person (source pixels, `t` in seconds from the clip start). */
export interface CameraSample {
  t: number;
  /** Face-box centre. */
  cx: number;
  cy: number;
  /** Face-box width. */
  w: number;
}

/** An eased glide of the window to `(x, y)`, starting at `t` and taking `duration` seconds. */
export interface CameraMove {
  t: number;
  duration: number;
  /** Window top-left AFTER the glide (source pixels, already clamped inside the frame). */
  x: number;
  y: number;
}

export interface CameraPath {
  /** Window top-left at t = 0 (source pixels, clamped inside the frame). */
  x0: number;
  y0: number;
  /** Sorted, non-overlapping glides. Empty = the window never moves. */
  moves: CameraMove[];
  /** True when more re-centres were needed than `maxMoves` allows (the rest were held). */
  truncated: boolean;
}

export interface CameraParams {
  srcW: number;
  srcH: number;
  /** Window size in source pixels. */
  cropW: number;
  cropH: number;
  /** Where the face centre sits inside the window (0.5 = middle). Default 0.5 for X. */
  anchorX?: number;
  anchorY: number;
  /** Safety margin kept free around the head, as a fraction of the window. Default 0.08. */
  marginFraction?: number;
  /** The head must stay outside the safe zone this long (s) before the camera reacts. Default 0.3. */
  confirmSeconds?: number;
  /** Seconds of footage (from the first sighting) the initial lock is taken from. Default 1. */
  settleSeconds?: number;
  /** Re-centres allowed per clip (keeps the FFmpeg expression short). Default 10. */
  maxMoves?: number;
}

/**
 * Head extents relative to the face-box centre, in multiples of the face-box
 * WIDTH. A YuNet box runs from the brow to the chin (height ~1.25x its width), so
 * the head - hair included - reaches ~1.15w above the centre (voluminous hair
 * stands well clear of the box; 1.0w clipped curly hair in a real render) and
 * ~0.69w below it.
 */
export const HEAD_HALF_WIDTH = 0.62;
export const HEAD_UP = 1.15;
export const HEAD_DOWN = 0.69;
/** The detector box itself (what must never be covered), same units. */
export const FACE_HALF_HEIGHT = 0.625;

/** Seconds the window starts moving BEFORE the head reaches the safe-zone edge. */
const ANTICIPATION_SECONDS = 0.15;
/** A re-centre that would move the window less than this many source px is pointless. */
const MIN_MOVE_PX = 12;
const DEFAULT_MARGIN = 0.08;
const DEFAULT_CONFIRM_SECONDS = 0.3;
const DEFAULT_SETTLE_SECONDS = 1;
const DEFAULT_MAX_MOVES = 10;

/** Smoothstep: 0 -> 1 with zero velocity at both ends. */
export function smoothstep(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
}

/** How long a re-centre glide takes: a short hop is quick, a big one gets more time. */
export function glideSeconds(distancePx: number): number {
  return Math.min(1.3, Math.max(0.6, 0.6 + distancePx / 600));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Running median over +-`radius` neighbours (rejects one-sample detector outliers). */
function medianFilter(values: number[], radius: number): number[] {
  return values.map((_, i) =>
    median(values.slice(Math.max(0, i - radius), Math.min(values.length, i + radius + 1)))
  );
}

/** Same samples, median-filtered over 5 detections (cx, cy and w separately). */
export function filterSamples(samples: CameraSample[]): CameraSample[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const cx = medianFilter(sorted.map((s) => s.cx), 2);
  const cy = medianFilter(sorted.map((s) => s.cy), 2);
  const w = medianFilter(sorted.map((s) => s.w), 2);
  return sorted.map((s, i) => ({ t: s.t, cx: cx[i], cy: cy[i], w: w[i] }));
}

/** Window position (top-left) that puts the face centre at the anchor, clamped inside the frame. */
export function windowFor(
  cx: number,
  cy: number,
  p: Pick<CameraParams, 'srcW' | 'srcH' | 'cropW' | 'cropH' | 'anchorX' | 'anchorY'>
): { x: number; y: number } {
  const maxX = Math.max(0, p.srcW - p.cropW);
  const maxY = Math.max(0, p.srcH - p.cropH);
  return {
    x: Math.max(0, Math.min(cx - p.cropW * (p.anchorX ?? 0.5), maxX)),
    y: Math.max(0, Math.min(cy - p.cropH * p.anchorY, maxY)),
  };
}

/** Is the whole head inside the window's safe zone (the window minus its margin)? */
export function headInsideSafeZone(
  s: CameraSample,
  win: { x: number; y: number },
  p: Pick<CameraParams, 'cropW' | 'cropH' | 'marginFraction'>
): boolean {
  const margin = p.marginFraction ?? DEFAULT_MARGIN;
  const safeL = win.x + margin * p.cropW;
  const safeR = win.x + p.cropW - margin * p.cropW;
  const safeT = win.y + margin * p.cropH;
  const safeB = win.y + p.cropH - margin * p.cropH;

  let halfW = HEAD_HALF_WIDTH * s.w;
  let up = HEAD_UP * s.w;
  let down = HEAD_DOWN * s.w;

  // A head that is bigger than the safe zone itself can only be judged by where
  // its centre is - otherwise the camera would re-centre forever.
  const maxHalfW = ((safeR - safeL) / 2) * 0.9;
  halfW = Math.min(halfW, maxHalfW);
  const maxHeight = (safeB - safeT) * 0.9;
  if (up + down > maxHeight) {
    // Symmetric about the face centre, so a head that is centred counts as inside.
    up = maxHeight / 2;
    down = maxHeight / 2;
  }

  return (
    s.cx - halfW >= safeL &&
    s.cx + halfW <= safeR &&
    s.cy - up >= safeT &&
    s.cy + down <= safeB
  );
}

/**
 * Plan the locked camera for ONE person.
 *
 * `samples` are that person's detections (any order). Returns where the window
 * starts and the (usually empty) list of glides that re-centre them.
 */
export function buildLockedCamera(samples: CameraSample[], params: CameraParams): CameraPath {
  const maxMoves = params.maxMoves ?? DEFAULT_MAX_MOVES;
  const confirm = params.confirmSeconds ?? DEFAULT_CONFIRM_SECONDS;
  const settle = params.settleSeconds ?? DEFAULT_SETTLE_SECONDS;
  const maxX = Math.max(0, params.srcW - params.cropW);
  const maxY = Math.max(0, params.srcH - params.cropH);

  const pts = filterSamples(samples);
  if (pts.length === 0) {
    // Nothing to follow: a centred, static window (callers never plan this on purpose).
    return { x0: maxX / 2, y0: maxY / 2, moves: [], truncated: false };
  }

  // 1) LOCK: the median position over the first `settle` seconds of sightings.
  const firstT = pts[0].t;
  let settleEnd = pts.findIndex((s) => s.t > firstT + settle);
  if (settleEnd === -1) settleEnd = pts.length;
  settleEnd = Math.max(settleEnd, Math.min(pts.length, 3));
  const settled = pts.slice(0, settleEnd);
  const start = windowFor(median(settled.map((s) => s.cx)), median(settled.map((s) => s.cy)), params);

  const moves: CameraMove[] = [];
  let current = start;
  let busyUntil = -Infinity; // end of the last glide
  let quietUntil = -Infinity; // after a pointless trigger, don't re-test for a moment
  let outsideFrom = -1; // index where the current outside-the-safe-zone run began
  let truncated = false;

  // 2) HOLD / 3) RE-CENTRE.
  for (let i = settleEnd; i < pts.length; i += 1) {
    const s = pts[i];
    if (s.t < busyUntil || s.t < quietUntil) {
      outsideFrom = -1;
      continue;
    }
    if (headInsideSafeZone(s, current, params)) {
      outsideFrom = -1;
      continue;
    }
    if (outsideFrom === -1) outsideFrom = i;
    // Outside for long enough to be real? (the median filter already removed 1-2 sample blips)
    if (s.t - pts[outsideFrom].t < confirm - 1e-6) continue;

    const tFirst = pts[outsideFrom].t;
    const centreOver = (t0: number, t1: number): { x: number; y: number } | null => {
      const inRange = pts.filter((q) => q.t >= t0 && q.t <= t1);
      if (inRange.length < 2) return null;
      return windowFor(median(inRange.map((q) => q.cx)), median(inRange.map((q) => q.cy)), params);
    };

    // Where will the head be? First guess from the next ~0.8 s ...
    let target =
      centreOver(tFirst, tFirst + 0.8) ??
      windowFor(
        median(pts.slice(outsideFrom, i + 1).map((q) => q.cx)),
        median(pts.slice(outsideFrom, i + 1).map((q) => q.cy)),
        params
      );
    let distance = Math.max(Math.abs(target.x - current.x), Math.abs(target.y - current.y));
    let duration = glideSeconds(distance);
    // ... then refine: aim at where it is when the glide has finished.
    const refined = centreOver(tFirst + duration * 0.6, tFirst + duration + 0.5);
    if (refined) {
      target = refined;
      distance = Math.max(Math.abs(target.x - current.x), Math.abs(target.y - current.y));
      duration = glideSeconds(distance);
    }

    if (distance < MIN_MOVE_PX) {
      // The window is already as close as the frame edge allows: nothing to gain.
      outsideFrom = -1;
      quietUntil = tFirst + 1;
      continue;
    }
    if (moves.length >= maxMoves) {
      truncated = true;
      break;
    }

    const tStart = Math.max(0, tFirst - ANTICIPATION_SECONDS, busyUntil);
    moves.push({ t: tStart, duration, x: target.x, y: target.y });
    current = target;
    busyUntil = tStart + duration;
    outsideFrom = -1;
  }

  return { x0: start.x, y0: start.y, moves, truncated };
}

/** Window top-left at time `t` (the same maths the FFmpeg expression encodes). */
export function cameraPositionAt(path: CameraPath, t: number): { x: number; y: number } {
  let prev = { x: path.x0, y: path.y0 };
  for (const move of path.moves) {
    if (t <= move.t) return prev;
    if (t < move.t + move.duration) {
      const s = smoothstep((t - move.t) / move.duration);
      return { x: prev.x + (move.x - prev.x) * s, y: prev.y + (move.y - prev.y) * s };
    }
    prev = { x: move.x, y: move.y };
  }
  return prev;
}

/** True when the window never moves. */
export function isStaticCamera(path: CameraPath): boolean {
  return path.moves.length === 0;
}
