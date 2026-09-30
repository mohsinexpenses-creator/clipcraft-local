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
 *    keeps every relevant person visible at all times. Each cell is its own
 *    time-varying crop that follows that person's track, and a red frame
 *    highlights whichever cell holds the active speaker.
 *
 * Pure logic (no I/O) - the plan builders and filter-graph strings are
 * unit-testable without FFmpeg.
 */

import { AsdResult } from './asd';
import { FaceTrackPoint, decimateTrack, evenSize, smoothTrack } from './frame-sampler';
import { Track } from './asd/tracker';

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
  /** Smoothed per-person camera path. */
  points: PanPoint[];
}

export interface SplitPlan {
  mode: 'split';
  cells: CellPlan[];
  /** Red-frame emphasis on the active speaker's cell, per timeline run. */
  emphasis: Array<{ cellIndex: number; t0: number; t1: number }>;
}

export type LayoutPlan = SinglePlan | SplitPlan;

const SPEAKER_FACE_ANCHOR_Y = 0.32;
/** A face box is roughly 80% as wide as it is tall. */
const FACE_BOX_ASPECT = 0.8;
/** Split-cell crop shows ~2.2x the face height (head + upper body). */
const CELL_FACE_HEIGHT_FACTOR = 2.2;

/**
 * Generalised pan expression: piecewise-linear window POSITION over time for
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
    const interp = `(${pa}+(${pb}-${pa})*(t-${a.t.toFixed(3)})/${segLen.toFixed(3)})`;
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
 *    is one every 2.5s, which is still smooth as piecewise-linear motion.
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

function trackToPanPoints(track: Track, srcW: number): PanPoint[] {
  if (track.points.length === 0) return [];
  const asFace: FaceTrackPoint[] = track.points.map((p) => ({ t: p.t, x: p.cx, y: p.cy }));
  const smoothed = smoothTrack(asFace, srcW);
  const points = smoothed.map((p) => ({ t: p.t, x: p.x, y: p.y }));
  return flattenAndDecimate(points);
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
 * The crop filter is piecewise-linear over keyframes, so "lock on A until B is
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
  srcH: number
): LayoutPlan {
  if (layout === 'split-screen') {
    return buildSplitPlan(asd, srcW, srcH);
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

function buildSplitPlan(asd: AsdResult, srcW: number, srcH: number): SplitPlan {
  // Who was EVER the active speaker - those people always win a cell, and
  // their count caps the grid (a 2-person conversation must never grow a 3rd/
  // 4th cell from a briefly-glimpsed false face).
  const speakerIds = new Set(
    asd.speakerSegments
      .map((seg) => seg.trackId)
      .filter((id): id is number => id !== null)
  );

  // A track counts as a real on-screen person when it has enough sightings
  // AND a big-enough average face (source px) - this kills the tiny YuNet
  // false positives (walls, doors, posters, hands, background faces).
  const candidateTracks = asd.tracks.filter(
    (track) => track.points.length >= 3 && track.avgW >= 80
  );

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
  // non-speaker co-participants who were on screen for at least 3 seconds.
  const MIN_CO_PARTICIPANT_VISIBLE_SECONDS = 3;
  let relevant = scored
    .filter(
      (s) =>
        s.isSpeaker || s.track.visibleTime >= MIN_CO_PARTICIPANT_VISIBLE_SECONDS
    )
    .map((s) => s.track);

  // No faces at all (detector found nothing): a single static centred 9:16
  // crop. (An empty cell list would build a filter graph with no cells, which
  // FFmpeg rejects.)
  if (relevant.length === 0) {
    const { w: cropW, h: cropH } = largest916Window(srcW, srcH);
    return {
      mode: 'split',
      cells: [
        {
          trackId: -1,
          cellX: 0,
          cellY: 0,
          cellW: OUTPUT_WIDTH,
          cellH: OUTPUT_HEIGHT,
          cropW,
          cropH,
          points: [],
        },
      ],
      emphasis: [],
    };
  }
  // Cap the grid by how many people actually spoke: a single presenter gets a
  // full-screen cell, a 2-person conversation stays at 2 cells. peakConcurrent
  // is an extra guard - never more panes than the busiest frame had faces on
  // screen, so fragmented track ids can never inflate 2 people into 3-4 cells.
  const count = Math.min(
    4,
    Math.max(speakerIds.size, 1),
    relevant.length,
    Math.max(1, peakConcurrent(candidateTracks))
  );
  relevant = relevant.slice(0, count);

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
    const cellAspect = cellW / cellH;

    // Crop window: ~2.2x the face height (head + upper body), matched to the
    // cell aspect, clamped to the source.
    const faceH = Math.max(40, track.avgW / FACE_BOX_ASPECT);
    let cropH = Math.round(Math.min(srcH, Math.max(srcH * 0.35, faceH * CELL_FACE_HEIGHT_FACTOR)) / 2) * 2;
    let cropW = Math.round((cropH * cellAspect) / 2) * 2;
    if (cropW > srcW) {
      cropW = evenSize(srcW);
      cropH = evenSize(cropW / cellAspect);
    }
    cropH = Math.min(cropH, evenSize(srcH));
    cropW = Math.min(cropW, evenSize(srcW));

    const points = trackToPanPoints(track, srcW);

    cells.push({
      trackId: track.id,
      cellX,
      cellY,
      cellW,
      cellH,
      cropW,
      cropH,
      points,
    });
  }

  // Emphasis: red frame on the cell of whoever the timeline says is speaking.
  // - With a single cell there is nothing to highlight (the whole canvas IS
  //   the person), so the frame would only add a distracting border.
  // - Speaking runs from the timeline are fragmented (silence pauses, track
  //   switches): runs of the same cell closer than 0.6s are merged, and the
  //   result is capped - a 60s clip must not turn into 120 drawbox clauses
  //   (that is what blew past Windows' command-line limit).
  const trackToCell = new Map<number, number>();
  cells.forEach((cell, index) => trackToCell.set(cell.trackId, index));
  const emphasis: SplitPlan['emphasis'] = [];
  if (cells.length > 1) {
    for (const seg of asd.speakerSegments) {
      if (seg.trackId === null) continue;
      const cellIndex = trackToCell.get(seg.trackId);
      if (cellIndex === undefined) continue;
      if (emphasis.length > 0) {
        const last = emphasis[emphasis.length - 1];
        if (last.cellIndex === cellIndex && seg.t0 - last.t1 < 0.6) {
          last.t1 = seg.t1;
          continue;
        }
      }
      emphasis.push({ cellIndex, t0: seg.t0, t1: seg.t1 });
    }
    if (emphasis.length > 12) {
      emphasis.sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0));
      emphasis.length = 12;
      emphasis.sort((a, b) => a.t0 - b.t0);
    }
  }

  return { mode: 'split', cells, emphasis };
}

/**
 * `-vf` chain for the single-window mode (speaker focus):
 *   hflip -> time-varying crop (X and Y expressions) -> colour -> scale -> yuv420p
 */
export function buildSingleFilterParts(
  plan: SinglePlan,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  colorFilter: string
): string[] {
  const xExpr = buildPanExpression(plan.points, 'x', srcW, plan.cropW, 0.5);
  const yExpr = buildPanExpression(plan.points, 'y', srcH, plan.cropH, plan.faceAnchorY);

  const parts: string[] = ['hflip', `crop=${plan.cropW}:${plan.cropH}:'${xExpr}':'${yExpr}'`];
  if (colorFilter) parts.push(colorFilter);
  parts.push(`scale=${outW}:${outH}:flags=lanczos`);
  parts.push('format=yuv420p');
  return parts;
}

/**
 * `-filter_complex` graph for the split-screen mode:
 *   one blurred full-frame base is NOT used - each cell is a time-varying crop
 *   of its person, scaled to the cell, overlaid onto a black canvas, and the
 *   active speaker's cell gets a red frame via drawbox with per-run enable.
 */
export function buildSplitFilterComplex(
  plan: SplitPlan,
  srcW: number,
  srcH: number,
  fps: number,
  duration: number,
  colorFilter: string
): string {
  const chains: string[] = [];

  // Mirrored + colour-corrected base (shared by every cell).
  const baseChain = colorFilter
    ? `[0:v]hflip,${colorFilter},format=yuv420p[base];`
    : `[0:v]hflip,format=yuv420p[base];`;
  chains.push(baseChain);

  // One crop+scale per person.
  plan.cells.forEach((cell, i) => {
    const xExpr = buildPanExpression(cell.points, 'x', srcW, cell.cropW, 0.5);
    const yExpr = buildPanExpression(cell.points, 'y', srcH, cell.cropH, 0.5);
    chains.push(
      `[base]crop=${cell.cropW}:${cell.cropH}:'${xExpr}':'${yExpr}',` +
      `scale=${cell.cellW}:${cell.cellH}:flags=bicubic,format=yuv420p[c${i}];`
    );
  });

  // Black canvas, then overlay every cell (they tile the canvas exactly).
  chains.push(
    `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${fps}:d=${duration.toFixed(3)}[bg];`
  );
  let prev = 'bg';
  plan.cells.forEach((cell, i) => {
    const label = `o${i}`;
    chains.push(`[${prev}][c${i}]overlay=${cell.cellX}:${cell.cellY}[${label}];`);
    prev = label;
  });

  // Active-speaker emphasis: one drawbox per (cell, speaking run).
  const emphasisBoxes: string[] = [];
  for (const e of plan.emphasis) {
    const cell = plan.cells[e.cellIndex];
    if (!cell) continue;
    emphasisBoxes.push(
      `drawbox=x=${cell.cellX + 2}:y=${cell.cellY + 2}:w=${cell.cellW - 4}:h=${cell.cellH - 4}` +
      `:color=0xef4444@0.9:t=8:enable='between(t,${e.t0.toFixed(3)},${e.t1.toFixed(3)})'`
    );
  }

  if (emphasisBoxes.length > 0) {
    chains.push(`[${prev}]${emphasisBoxes.join(',')}[vout];`);
  } else {
    chains.push(`[${prev}]null[vout];`);
  }

  return chains.join('');
}
