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
import { FaceTrackPoint, decimateTrack, evenSize, smoothTrack } from './face-detector';
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
  if (points.length === 1) return clamp(posFor(points[0][axis]).toFixed(1));

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

function trackToPanPoints(track: Track, srcW: number): PanPoint[] {
  if (track.points.length === 0) return [];
  const asFace: FaceTrackPoint[] = track.points.map((p) => ({ t: p.t, x: p.cx, y: p.cy }));
  const smoothed = smoothTrack(asFace, srcW);
  return smoothed.map((p) => ({ t: p.t, x: p.x, y: p.y }));
}

/**
 * The camera path for speaker-focus: the centres of whoever the timeline says
 * is speaking, in time order. Speaker switches become short linear glides
 * (smoothed + slew-limited afterwards), so the frame moves instead of jumping.
 */
function buildSpeakerPath(asd: AsdResult, srcW: number): PanPoint[] {
  const byId = new Map<number, Track>();
  for (const track of asd.tracks) byId.set(track.id, track);

  const raw: PanPoint[] = [];
  for (const seg of asd.speakerSegments) {
    if (seg.trackId === null) continue; // hold previous position
    const track = byId.get(seg.trackId);
    if (!track) continue;
    for (const p of track.points) {
      if (p.t >= seg.t0 - 0.001 && p.t <= seg.t1 + 0.001) {
        raw.push({ t: p.t, x: p.cx, y: p.cy });
      }
    }
  }
  if (raw.length === 0) return [];
  const smoothed = smoothTrack(raw, srcW);
  return smoothed.map((p) => ({ t: p.t, x: p.x, y: p.y }));
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

  if (points.length <= 1) {
    // No usable track data -> static centred crop (the long-standing fallback).
    return { mode: 'single', cropW, cropH, points: [], faceAnchorY };
  }

  // Decimate in the same clamped space the X expression lives in.
  const clampX = (x: number): number =>
    Math.max(0, Math.min(Math.round(x - cropW / 2), srcW - cropW));
  points = decimateTrack(
    points.map((p) => ({ t: p.t, x: p.x, y: p.y })),
    clampX
  ).map((p) => ({ t: p.t, x: p.x, y: p.y }));

  return { mode: 'single', cropW, cropH, points, faceAnchorY };
}

function buildSplitPlan(asd: AsdResult, srcW: number, srcH: number): SplitPlan {
  const tracks = asd.tracks.filter((track) => track.points.length >= 2);

  // Relevant people = the ones actually on screen, ranked by screen-time * size.
  const ranked = [...tracks].sort(
    (a, b) => b.visibleTime * b.avgW - a.visibleTime * a.avgW
  );
  const minVisible = 2; // seconds - brief passers-by do not get a cell
  let relevant = ranked.filter((track) => track.visibleTime >= minVisible);
  if (relevant.length === 0) relevant = ranked.slice(0, 1);
  const count = Math.min(4, relevant.length);

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
  const trackToCell = new Map<number, number>();
  cells.forEach((cell, index) => trackToCell.set(cell.trackId, index));
  const emphasis: SplitPlan['emphasis'] = [];
  for (const seg of asd.speakerSegments) {
    if (seg.trackId === null) continue;
    const cellIndex = trackToCell.get(seg.trackId);
    if (cellIndex === undefined) continue;
    if (emphasis.length > 0) {
      const last = emphasis[emphasis.length - 1];
      if (last.cellIndex === cellIndex && Math.abs(last.t1 - seg.t0) < 0.01) {
        last.t1 = seg.t1;
        continue;
      }
    }
    emphasis.push({ cellIndex, t0: seg.t0, t1: seg.t1 });
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
