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
  /**
   * Face-box HEIGHT, when the detector reported it. YuNet's box runs brow -> chin
   * and is ~1.25x as tall as it is wide, so the head extents (`HEAD_UP`/`HEAD_DOWN`)
   * have always been expressed in face WIDTHS. A tall/rotated box or a profile view
   * is not proportional though, and framing the complete head is exactly what the
   * quality report measures - so the real height is used when it is known, and the
   * width is used as the fallback (every existing caller keeps working).
   */
  h?: number;
}

/**
 * The head's extent around the face-box centre, in SOURCE pixels: hair above the
 * box, jaw below, and the sides of the head out past the box edges.
 *
 * Widths are used when no height was reported (the 1.25 ratio YuNet documents);
 * a real height makes the estimate exact for flat/rotated boxes.
 */
export function headExtent(s: CameraSample): {
  halfW: number;
  up: number;
  down: number;
} {
  const faceW = Math.max(1e-6, s.w);
  const faceH = s.h && Number.isFinite(s.h) && s.h > 0 ? s.h : faceW / FACE_BOX_ASPECT;
  // The head extents are expressed in FACE WIDTHS (1.15w above the box centre).
  // A detected height says how wide an equivalent YuNet box would be
  // (`width = height * FACE_BOX_ASPECT`), so a non-proportional box - a profile
  // view, a tilted head, a shorter box from a different detector - still gets the
  // right head extent instead of inheriting the standard ratio.
  const widthFromHeight = faceH * FACE_BOX_ASPECT;
  return {
    halfW: HEAD_HALF_WIDTH * faceW,
    up: HEAD_UP * widthFromHeight,
    down: HEAD_DOWN * widthFromHeight,
  };
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
  /**
   * Source shot cuts inside the clip where the window must JUMP instead of
   * gliding (a cut between two camera angles). At `t` the window is already at
   * `x`, so the cut frame itself shows the new framing - no interpolation can
   * ever cross one. Emitted as `if(lt(t,T),…,…)` in the FFmpeg expression.
   */
  cuts?: CameraCut[];
  /**
   * Spans where the followed face is NOT on screen. The window holds its last
   * valid position for a short grace period, then falls back deterministically
   * instead of pretending the last crop is still valid. Only the cuts that carry
   * a `reanchor` position can satisfy a fallback; a hole with no such cut keeps
   * the crop held still, which is the safe (never-random) behaviour.
   */
  holes?: CameraHole[];
}

/**
 * A span in which the followed person was not detected. `holdSeconds` is how long
 * the previous framing stays valid (a blink, a microphone across the mouth, a
 * missed sample); after that the window falls back.
 */
export interface CameraHole {
  /** Horizon of the last sighting that ended before this hole (seconds). */
  start: number;
  /** Next sighting of the followed person, or the clip end when there is none. */
  end: number;
  /** How long the last valid framing may be held before falling back. */
  holdSeconds: number;
}

/** A hard switch of the window at a source shot cut (t = the first frame after it). */
export interface CameraCut {
  t: number;
  x: number;
  y: number;
  /**
   * Set when the subject is NOT visible on the new shot: the window jumps to this
   * deterministic position at the cut (the new shot's only visible face, else the
   * clamped default window) instead of keeping the previous shot's framing. The
   * window still re-anchors on the subject as soon as they are seen again.
   */
  reanchor?: boolean;
}

/**
 * Cut markers are honoured exactly like FFmpeg's `crop` filter evaluates with
 * `exact=1` (nearest `t`), so `t + CUT_EPSILON` sits unambiguously on the new
 * shot. One microsecond is far below a frame at any real frame rate.
 */
export const CUT_EPSILON = 1e-6;

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
  /**
   * `head` (default, the split-pane behaviour): the safe zone is the window minus
   * `marginFraction` and the whole HEAD (hair included) must leave it.
   * `face` (the speaker-focus lock): the safe zone is the FACE CENTRE only,
   * `deadZoneXPct`/`deadZoneYPct` of the window, and the window glides a fixed
   * `recentreSeconds` to the median of the last `recentreLookbackSeconds` of
   * detections. No look-ahead, no distance-dependent duration.
   */
  deadZoneMode?: "head" | "face";
  /** Face-centre dead zone, fraction of the window WIDTH. Default 0.10. */
  deadZoneXPct?: number;
  /** Face-centre dead zone, fraction of the window HEIGHT. Default 0.08. */
  deadZoneYPct?: number;
  /** Length of one re-centre glide (s). Default 0.35. */
  recentreSeconds?: number;
  /** Detections the re-centre target is taken from (s). Default 0.5. */
  recentreLookbackSeconds?: number;
  /** Start each glide this long before the dead zone was left. Default 0. */
  anticipationSeconds?: number;
  /** A re-centre shorter than this is skipped (already as close as the frame allows). Default 12. */
  minMovePx?: number;
  /**
   * Source shot cuts (clip-relative seconds, the first frame after the cut). The
   * window is already on the new shot's anchor at each one - no glide may cross
   * a cut.
   */
  cuts?: Array<{ t: number }>;
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
/** YuNet's box height relative to its width (brow to chin). */
export const FACE_BOX_ASPECT = 0.8;
/**
 * Safety margin kept between the head and the crop edge, as a fraction of the
 * crop. A head that exactly touches the edge reads as "cut off" even when it is
 * technically whole, so "safely framed" needs room to breathe - and the framing
 * planner reserves it when it has any say in the vertical position.
 */
export const HEAD_SAFETY_MARGIN = 0.035;

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

/**
 * Is the person's FACE BOX fully inside the window (whole head with a margin)?
 *
 * This is the visibility contract that matters for a portrait crop: a face centre
 * can sit comfortably inside a 10 % dead zone while the top of the head is already
 * cut off, and the old planner never looked. Evaluated on sampled detections, so it
 * needs no extra frame decode.
 */
export function faceBoxInsideWindow(
  s: CameraSample,
  win: { x: number; y: number },
  p: Pick<CameraParams, 'cropW' | 'cropH'> & { marginFraction?: number }
): boolean {
  const margin = p.marginFraction ?? 0.02;
  // Head = hair above the box, jaw below it - what must not be clipped.
  const { halfW, up, down } = headExtent(s);
  return (
    s.cx - halfW >= win.x + margin * p.cropW &&
    s.cx + halfW <= win.x + p.cropW - margin * p.cropW &&
    s.cy - up >= win.y + margin * p.cropH &&
    s.cy + down <= win.y + p.cropH - margin * p.cropH
  );
}

/** Is the person's FACE BOX (YuNet's own box) fully inside the window? */
export function faceBoundsInsideWindow(
  s: CameraSample,
  win: { x: number; y: number },
  p: Pick<CameraParams, 'cropW' | 'cropH'>
): boolean {
  // YuNet's box height is ~1.25x its width; judge the box itself, not the hair.
  const halfH = FACE_HALF_HEIGHT * s.w;
  return (
    s.cx - s.w / 2 >= win.x &&
    s.cx + s.w / 2 <= win.x + p.cropW &&
    s.cy - halfH >= win.y &&
    s.cy + halfH <= win.y + p.cropH
  );
}

/** Window position that keeps the whole head inside, else the closest the frame allows. */
export function windowForHead(
  s: CameraSample,
  p: Pick<CameraParams, 'srcW' | 'srcH' | 'cropW' | 'cropH' | 'anchorX' | 'anchorY'>,
  marginFraction = 0.02
): { x: number; y: number } {
  const maxX = Math.max(0, p.srcW - p.cropW);
  const maxY = Math.max(0, p.srcH - p.cropH);
  const anchorX = p.anchorX ?? 0.5;
  const { halfW, up, down } = headExtent(s);
  // The margin is a fraction of the crop on the axis it applies to (it used to be
  // a fraction of the HEIGHT on the horizontal padding too, which is why a
  // head-heavy case could still end up with the side of the head 4 px outside).
  const padX = marginFraction * p.cropW;
  const padUp = marginFraction * p.cropH + up;
  const padDown = marginFraction * p.cropH + down;
  // Vertical: the configured anchor (headroom above the eyes) wins as long as it
  // leaves the whole head inside the crop WITH the safety margin. When the head
  // plus both pads is taller than the window, centre the face and accept a crop -
  // no camera position can do better.
  //
  // This is the "natural amount of space above the head" rule: the anchor puts the
  // face at 32% of the window (roughly a third of headroom), and the head is only
  // moved when honouring the anchor would actually clip it.
  const idealY = s.cy - p.cropH * p.anchorY;
  const lowest = s.cy + padDown - p.cropH;
  const highest = s.cy - padUp;
  let y = idealY;
  if (highest <= lowest) {
    // The head fits with room to spare: clamp the ideal anchor into the range
    // that keeps it whole (and clear of the edges).
    y = Math.max(lowest, Math.min(highest, idealY));
  } else {
    // Not enough window for the head plus margins: centre the head.
    const centred = s.cy - p.cropH / 2;
    y = Math.max(0, Math.min(centred, maxY));
  }
  // Horizontal: the anchor is fine while it leaves the whole head (plus margin)
  // inside the crop. A person near the frame edge is where that fails: the ideal
  // anchor would clip the side of their head, so the window is clamped to the
  // range that keeps it whole - as far as the source frame allows at all.
  const idealX = s.cx - p.cropW * anchorX;
  const xLowest = s.cx + halfW + padX - p.cropW; // head (plus pad) at the right edge
  const xHighest = s.cx - halfW - padX; // head (plus pad) at the left edge
  let x: number;
  // The window is placed where the head constraint says it must be, THEN clamped
  // into the frame. A person beyond the crop centre line is exactly the case that
  // needs this order: their window is at the frame edge, and clamping the ideal
  // anchor first would throw the head-aware position away.
  if (xLowest <= xHighest) {
    x = Math.max(xLowest, Math.min(xHighest, idealX));
  } else {
    // Not even the bare head fits with the margin: keep it whole without it.
    const bareLowest = s.cx + halfW - p.cropW;
    const bareHighest = s.cx - halfW;
    x = bareLowest <= bareHighest
      ? Math.max(bareLowest, Math.min(bareHighest, idealX))
      : s.cx - p.cropW / 2;
  }
  return {
    x: Math.max(0, Math.min(x, maxX)),
    y: Math.max(0, Math.min(y, maxY)),
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

  const extent = headExtent(s);
  let halfW = extent.halfW;
  let up = extent.up;
  let down = extent.down;

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
 *
 * Two dead-zone behaviours, both "tripod, not stalker-cam":
 *
 *  - `head` (default, split panes): the window holds while the whole head is
 *    inside the window minus `marginFraction`; it glides - distance-dependent
 *    duration, aimed slightly ahead - only when the head has stayed outside for
 *    `confirmSeconds`.
 *  - `face` (speaker-focus single window): the window holds while the FACE
 *    CENTRE stays inside a `deadZoneXPct` x `deadZoneYPct` box in the middle of
 *    the window; when the centre has been outside that box for `confirmSeconds`
 *    it does ONE eased `recentreSeconds` glide to the median of the last
 *    `recentreLookbackSeconds` of detections, with no look-ahead.
 *
 * `params.cuts` are source shot cuts: the window is already on the new anchor at
 * the exact cut time (a hard switch, never a glide across two shots).
 */
export function buildLockedCamera(samples: CameraSample[], params: CameraParams): CameraPath {
  const maxMoves = params.maxMoves ?? DEFAULT_MAX_MOVES;
  const confirm = params.confirmSeconds ?? DEFAULT_CONFIRM_SECONDS;
  const settle = params.settleSeconds ?? DEFAULT_SETTLE_SECONDS;
  const faceMode = params.deadZoneMode === "face";
  const recentreDuration = Math.max(0.05, params.recentreSeconds ?? 0.35);
  const lookback = Math.max(0, params.recentreLookbackSeconds ?? 0.5);
  const anticipation = Math.max(0, params.anticipationSeconds ?? (faceMode ? 0 : ANTICIPATION_SECONDS));
  const minMove = Math.max(0, params.minMovePx ?? MIN_MOVE_PX);
  const maxX = Math.max(0, params.srcW - params.cropW);
  const maxY = Math.max(0, params.srcH - params.cropH);

  const pts = filterSamples(samples);
  if (pts.length === 0) {
    // Nothing to follow: a centred, static window (callers never plan this on purpose).
    return { x0: maxX / 2, y0: maxY / 2, moves: [], truncated: false };
  }

  const medianWindow = (group: CameraSample[]): { x: number; y: number } =>
    windowFor(median(group.map((s) => s.cx)), median(group.map((s) => s.cy)), params);

  const cuts = (params.cuts ?? [])
    .filter((cut) => Number.isFinite(cut.t))
    .sort((a, b) => a.t - b.t);

  // One group of detections per source SHOT: a cut can never sit inside a group,
  // so the analysis below can never interpolate across one.
  const shots: CameraSample[][] = [];
  {
    let shot = 0;
    let current: CameraSample[] = [];
    for (const point of pts) {
      while (shot < cuts.length && point.t >= cuts[shot].t - 1e-6) {
        if (current.length > 0) shots.push(current);
        current = [];
        shot += 1;
      }
      current.push(point);
    }
    if (current.length > 0) shots.push(current);
  }

  const firstSettled = buildSettledWindow(shots[0], settle, params);
  const start = firstSettled;
  const moves: CameraMove[] = [];
  const switches: CameraCut[] = [];
  let truncated = false;
  let lastPos = start;
  let busyUntil = -Infinity;
  let quietUntil = -Infinity;

  shots.forEach((group, shotIndex) => {
    let firstIndex = 0;
    if (shotIndex === 0) {
      // 1) LOCK: the median position over the first `settle` seconds of sightings.
      firstIndex = settledSampleCount(group, settle);
    } else {
      const cut = cuts[Math.min(shotIndex - 1, cuts.length - 1)];
      // The new shot is anchored on the face visible AFTER the cut - which is the
      // only face this shot has - and switches on that exact frame.
      lastPos = medianWindow(group);
      switches.push({ t: round3(cut.t), x: lastPos.x, y: lastPos.y });
      busyUntil = cut.t;
      quietUntil = -Infinity;
    }

    // 2) HOLD / 3) RE-CENTRE.
    let outsideFrom = -1;
    let needsInside = false;
    for (let i = firstIndex; i < group.length; i += 1) {
      const s = group[i];
      if (s.t < busyUntil || s.t < quietUntil) {
        outsideFrom = -1;
        continue;
      }
      const inside = faceMode
        ? faceCentreInsideDeadZone(s, lastPos, params)
        : headInsideSafeZone(s, lastPos, params);
      if (inside) {
        outsideFrom = -1;
        needsInside = false;
        continue;
      }
      // A sway or a nod: the face is outside the dead zone, but its recent MEDIAN
      // is not. Only a sustained displacement counts as leaving the lock - this
      // is what keeps a +/-40px talking head perfectly still.
      if (faceMode && !faceRecentreWanted(group, i, lastPos, params, lookback)) {
        outsideFrom = -1;
        continue;
      }
      if (outsideFrom === -1) outsideFrom = i;
      // Outside for long enough to be real? (the median filter already removed blips)
      const outsideFor = s.t - group[outsideFrom].t;
      if (outsideFor < confirm - 1e-6) continue;
      if (
        faceMode &&
        needsInside &&
        // The head still fits comfortably inside the crop: a slow drift may
        // leave the dead zone, but it is ONE departure until the face comes back
        // inside (or the head would actually be cut by the crop edge).
        headInsideSafeZone(s, lastPos, { ...params, marginFraction: 0 })
      ) {
        continue;
      }

      const tFirst = group[outsideFrom].t;
      const target = faceMode
        ? medianWindow(recentSamples(group, s.t, lookback))
        : headTarget(group, outsideFrom, i, lastPos, params);
      const distance = Math.max(Math.abs(target.x - lastPos.x), Math.abs(target.y - lastPos.y));
      if (distance < minMove) {
        // The window is already as close as the frame edge allows: nothing to gain.
        outsideFrom = -1;
        quietUntil = tFirst + 1;
        continue;
      }
      if (moves.length >= maxMoves) {
        truncated = true;
        break;
      }

      // Speaker-focus re-centres are one fixed short glide; the split-pane
      // "head left the safe zone" move stays distance-dependent (0.6-1.3 s).
      const duration = faceMode ? recentreDuration : glideSeconds(distance);
      const tStart = Math.max(0, tFirst - anticipation, busyUntil);
      moves.push({ t: round3(tStart), duration: round3(duration), x: target.x, y: target.y });
      lastPos = target;
      busyUntil = tStart + duration;
      outsideFrom = -1;
      needsInside = true;
    }
  });

  const orderedSwitches = switches.sort((a, b) => a.t - b.t);
  return {
    x0: start.x,
    y0: start.y,
    moves: moves.sort((a, b) => a.t - b.t),
    truncated,
    ...(orderedSwitches.length > 0 ? { cuts: orderedSwitches } : {}),
  };
}

/**
 * How far past the dead zone the face's recent median must sit before a
 * re-centre is considered (anti-flicker hysteresis, never a smaller zone).
 */
export const FACE_DEADZONE_HYSTERESIS = 1.15;

/**
 * Face-mode re-centre arming: after a glide the face is usually still slightly
 * outside the (small, 10%x8%) dead zone, because the glide targets the median of
 * the last half second - i.e. where the face WAS. Re-testing immediately would
 * produce a chain of back-to-back 0.35 s hops - exactly the "camera creeps
 * constantly" behaviour this mode exists to remove. A second glide therefore
 * needs the face to come back INSIDE the dead zone first; a continuous drift is
 * ONE re-centre, not one per 1.5 s. The single exception is a head that the crop
 * would actually cut: then the camera may move again to keep them framed.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** How many samples fall inside the initial `settle` seconds (at least 3, all of them at most). */
function settledSampleCount(group: CameraSample[], settle: number): number {
  const firstT = group[0].t;
  let end = group.findIndex((s) => s.t > firstT + settle);
  if (end === -1) end = group.length;
  return Math.max(end, Math.min(group.length, 3));
}

/** Window position from the median of the first `settle` seconds of a shot. */
function buildSettledWindow(
  group: CameraSample[],
  settle: number,
  params: CameraParams
): { x: number; y: number } {
  const settled = group.slice(0, settledSampleCount(group, settle));
  return windowFor(median(settled.map((s) => s.cx)), median(settled.map((s) => s.cy)), params);
}

/**
 * Face mode: does the recent (median-filtered) position want a re-centre?
 *
 * The FACE may sway through the edge of the dead zone for as long as it likes; a
 * re-centre needs the recent median to sit outside it. `confirm` is honoured by
 * the caller, so a genuine departure (which the median follows within a couple of
 * samples) still triggers exactly one glide.
 */
function faceRecentreWanted(
  group: CameraSample[],
  index: number,
  win: { x: number; y: number },
  params: CameraParams,
  lookback: number
): boolean {
  const sample = group[index];
  const recent = recentSamples(group, sample.t, lookback);
  if (recent.length === 0) return false;
  const medianX = median(recent.map((q) => q.cx));
  const medianY = median(recent.map((q) => q.cy));
  // Hysteresis: a face that GRAZES the edge of the dead zone is still holding -
  // a re-centre needs it clearly outside (`FACE_DEADZONE_HYSTERESIS`).
  const hysteretic = {
    ...params,
    deadZoneXPct: (params.deadZoneXPct ?? 0.1) * FACE_DEADZONE_HYSTERESIS,
    deadZoneYPct: (params.deadZoneYPct ?? 0.08) * FACE_DEADZONE_HYSTERESIS,
  };
  return !faceCentreInsideDeadZone(
    { t: sample.t, cx: medianX, cy: medianY, w: sample.w },
    win,
    hysteretic
  );
}

/** The detections inside the last `lookback` seconds up to and including `t` (at least one). */
function recentSamples(group: CameraSample[], t: number, lookback: number): CameraSample[] {
  const inside = group.filter((q) => q.t >= t - lookback - 1e-6 && q.t <= t + 1e-6);
  return inside.length > 0 ? inside : group.filter((q) => q.t <= t + 1e-6).slice(-1);
}

/** The `head`-mode re-centre target: ~0.8 s ahead, refined to where the head will be. */
function headTarget(
  group: CameraSample[],
  outsideFrom: number,
  index: number,
  current: { x: number; y: number },
  params: CameraParams
): { x: number; y: number } {
  const tFirst = group[outsideFrom].t;
  const centreOver = (t0: number, t1: number): { x: number; y: number } | null => {
    const inRange = group.filter((q) => q.t >= t0 && q.t <= t1);
    if (inRange.length < 2) return null;
    return windowFor(median(inRange.map((q) => q.cx)), median(inRange.map((q) => q.cy)), params);
  };
  const target =
    centreOver(tFirst, tFirst + 0.8) ??
    windowFor(
      median(group.slice(outsideFrom, index + 1).map((q) => q.cx)),
      median(group.slice(outsideFrom, index + 1).map((q) => q.cy)),
      params
    );
  const distance = Math.max(Math.abs(target.x - current.x), Math.abs(target.y - current.y));
  const duration = glideSeconds(distance);
  return centreOver(tFirst + duration * 0.6, tFirst + duration + 0.5) ?? target;
}

/**
 * Is the FACE CENTRE inside the speaker-focus dead zone?
 *
 * The zone is measured from where the lock PUT the face (`anchorY` of the
 * window), and each side is `deadZoneXPct` of the crop WIDTH by `deadZoneYPct`
 * of the crop HEIGHT: with the defaults (10% x 8% of a 606x1080 crop) a talking
 * head may sway +/-60 px horizontally and +/-86 px vertically before the camera
 * even considers moving.
 */
export function faceCentreInsideDeadZone(
  s: CameraSample,
  win: { x: number; y: number },
  p: Pick<CameraParams, "cropW" | "cropH" | "deadZoneXPct" | "deadZoneYPct"> & {
    anchorY?: number;
  }
): boolean {
  const halfX = p.cropW * (p.deadZoneXPct ?? 0.1);
  const halfY = p.cropH * (p.deadZoneYPct ?? 0.08);
  const centreX = win.x + p.cropW / 2;
  const centreY = win.y + p.cropH * (p.anchorY ?? 0.5);
  return Math.abs(s.cx - centreX) <= halfX && Math.abs(s.cy - centreY) <= halfY;
}

/**
 * Window top-left at time `t` (the same maths the FFmpeg expression encodes).
 *
 * Cut switches are applied first: on the cut frame itself (`t === cut.t`) the
 * window is ALREADY at the new shot's position, exactly like the generated
 * expression's `if(lt(t,T),…)`.
 */
export function cameraPositionAt(path: CameraPath, t: number): { x: number; y: number } {
  const cuts = path.cuts ?? [];
  let base = { x: path.x0, y: path.y0 };
  let cutIndex = 0;
  while (cutIndex < cuts.length && cuts[cutIndex].t <= t + 1e-9) {
    base = { x: cuts[cutIndex].x, y: cuts[cutIndex].y };
    cutIndex += 1;
  }
  let prev = base;
  for (const move of path.moves) {
    if (cutIndex < cuts.length && move.t >= cuts[cutIndex].t - 1e-9) break;
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
