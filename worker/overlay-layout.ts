/**
 * Layout-aware placement of the captions, the hook text and the CTA card.
 *
 * The preset positions (caption 22-30 % from the bottom, hook 12 % from the top,
 * CTA 64-66 % from the top) were designed for the SPEAKER-FOCUS frame: one person,
 * face near the upper third, torso below. In a SPLIT SCREEN the same pixels land on
 * the two faces - the caption on the lower person's eyes, the CTA on their
 * forehead, the hook on the upper person's brow.
 *
 * So for a split layout the placement is recomputed from where the heads really
 * are on the 1080x1920 canvas (`CellPlan.faceZone` / `headZone`, worked out from
 * the tracked faces and the locked cameras):
 *
 *   - the position from the preset is KEPT when it doesn't cover a face (nothing
 *     moves unless it has to);
 *   - otherwise the CAPTIONS move to the seam between the panes, the HOOK moves
 *     to the nearest face-safe spot (often below the upper head at the default
 *     38% face target), the CTA to the nearest free spot (normally below captions);
 *   - overlays never cover each other, and the usual "lift the captions while the
 *     CTA is showing" is switched off (the CTA no longer shares their area);
 *   - the hook and the CTA are only on screen for a few seconds, so each is placed
 *     against where the faces are DURING THOSE SECONDS - a person who briefly
 *     stands up at 0:24 does not push the end card around for the whole clip.
 *
 * Speaker focus is untouched: its presets already fit that framing.
 *
 * Pure logic, no I/O. The result is a set of ADAPTED COPIES of the presets (only
 * `positionY` changes), so both caption engines - which already position
 * everything from `positionY` - pick it up without any special casing.
 */
import type { CaptionEngine, CaptionPreset, OverlayStylePreset } from '../lib/types';
import { resolveCaptionLineStyle } from '../lib/caption-layout';
import { zonesBetween, type CanvasZone, type LayoutPlan } from './layout';

export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;

/** Keep overlays this far from the very top / bottom edge of the canvas. */
const EDGE_MARGIN = 40;
/** Clear space kept between an overlay and a face (px). */
const FACE_GAP = 16;
/**
 * The detector box runs brow-to-chin; the forehead above it and a little of the
 * chin/neck below it are protected too (fractions of the face height).
 */
const FOREHEAD_FRACTION = 0.25;
const CHIN_FRACTION = 0.06;

/** A vertical band an overlay occupies on the canvas. */
export interface Band {
  top: number;
  bottom: number;
}

/**
 * When the timed overlays are on screen, in BASE-CLIP seconds (the clip before the
 * hook intro is prepended). Optional: without it every overlay is placed against
 * the faces' whole-clip extent.
 */
export interface OverlayTiming {
  clipDuration: number;
  /** Where in the clip the hook intro is replayed from. */
  hookStart: number;
  /** How long the hook card is visible (the intro minus its fade-out window). */
  hookVisibleSeconds: number;
  ctaDuration: number;
}

export interface OverlayAdaptationInput {
  plan: LayoutPlan;
  engine: CaptionEngine;
  timing?: OverlayTiming;
  caption: CaptionPreset;
  /** Omit (or pass null) when the hook overlay is off for this clip. */
  hook?: { style: OverlayStylePreset; text: string } | null;
  /** Omit (or pass null) when the CTA card is off for this clip. */
  cta?: { style: OverlayStylePreset; text: string } | null;
}

export interface OverlayAdaptation {
  /** True when the placement was recomputed (split layouts only). */
  adapted: boolean;
  caption: CaptionPreset;
  hookStyle?: OverlayStylePreset;
  ctaStyle?: OverlayStylePreset;
  /**
   * 1 = keep the usual caption lift while the CTA card is on screen; 0 = the CTA
   * no longer shares the captions' area, so they stay where they are.
   */
  captionLiftScale: number;
  /** Where each overlay ended up (canvas px) - for the log and the tests. */
  placements: { caption?: Band; hook?: Band; cta?: Band };
  /** Human-readable account of what was moved and why (empty when nothing moved). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Size estimates
// ---------------------------------------------------------------------------

/**
 * Average advance of a bold glyph as a fraction of the font size. Deliberately on the
 * WIDE side and independent of the font stack: 0.78 is Arial Black / DejaVu Bold, the
 * widest of the usual fallbacks, and which font Chrome actually ends up with depends
 * on what is installed (a stack starting with Impact only gets Impact's narrow glyphs
 * where Impact exists). Measured against real Chrome renders, 0.68 under-counted the
 * lines of 30-100 character hooks. Over-estimating the line count only ever reserves a
 * little extra room; under-estimating could put a card on a face.
 */
const GLYPH_FACTOR_UPPERCASE = 0.78;
const GLYPH_FACTOR_MIXED = GLYPH_FACTOR_UPPERCASE * 0.86;

/** The text is shown in capitals: the style says so, or the text already is. */
function rendersUppercase(text: string, textTransform: string | undefined): boolean {
  if (textTransform !== 'none') return true;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return true;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6;
}

/** Greedy word wrap with estimated glyph widths; returns the number of lines (>= 1). */
export function estimateLineCount(
  text: string,
  maxWidth: number,
  fontSize: number,
  uppercase: boolean,
  letterSpacing = 0
): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const advance = fontSize * (uppercase ? GLYPH_FACTOR_UPPERCASE : GLYPH_FACTOR_MIXED) + letterSpacing;
  const space = fontSize * 0.3 + letterSpacing;
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const width = word.length * advance;
    if (used === 0) {
      used = width;
    } else if (used + space + width <= maxWidth) {
      used += space + width;
    } else {
      lines += 1;
      used = width;
    }
  }
  return lines;
}

function fontSizeOf(style: OverlayStylePreset, fallback: number): number {
  return Number.isFinite(style.fontSize) && style.fontSize > 0 ? style.fontSize : fallback;
}

/**
 * Height of the hook card block as remotion/HookOverlay.tsx lays it out: the
 * optional "Hook Intro" chip (~34px with its margin) + a card with 20px vertical
 * padding, its border and the wrapped text at line-height 1.2. Includes a small
 * safety pad for the pop / slide animation.
 */
export function estimateHookHeight(style: OverlayStylePreset, text: string): number {
  const fontSize = fontSizeOf(style, 38);
  const border = style.borderWidth ?? 2;
  const innerWidth = CANVAS_WIDTH * 0.88 - 48 - 2 * border;
  const lines = estimateLineCount(text, innerWidth, fontSize, rendersUppercase(text, style.textTransform), 1);
  const badge = style.showBadge !== false ? 34 : 0;
  return Math.ceil(badge + 40 + 2 * border + lines * fontSize * 1.2 + 12);
}

/** Height of the CTA card as remotion/CTAOverlay.tsx lays it out (18px padding, line-height 1.2). */
export function estimateCtaHeight(style: OverlayStylePreset, text: string): number {
  const fontSize = fontSizeOf(style, 34);
  const border = style.borderWidth ?? 2;
  const innerWidth = Math.min(CANVAS_WIDTH * 0.86, 880) - 44 - 2 * border;
  const lines = estimateLineCount(text, innerWidth, fontSize, rendersUppercase(text, style.textTransform), 0);
  return Math.ceil(36 + 2 * border + lines * fontSize * 1.2 + 12);
}

/** libass scales the preset size up (see ASS_FONT_SCALE in captions-ass.ts). */
const ASS_FONT_SCALE = 1.2;

interface CaptionGeometry {
  /** Vertical room to reserve (px). */
  height: number;
  /** Distance from the reserved block's top to the middle of a typical caption line. */
  centreOffset: number;
  /** The preset `positionY` (% from the bottom) that puts the reserved block's top at `top`. */
  positionYFor: (top: number) => number;
  /** Where the preset's own `positionY` puts the reserved block's top. */
  topFor: (positionY: number) => number;
}

/**
 * How each caption engine turns `positionY` into pixels:
 *  - native (ASS): one line, `\an8` at y = bottomEdge - 0.625*size, so the line box
 *    runs [bottomEdge - 0.625*size, bottomEdge + 0.705*size] (Segoe UI metrics);
 *  - Remotion: a bottom-anchored flex box - its BOTTOM edge sits at positionY and
 *    a wrapped second line grows upward, so room for two lines is reserved.
 */
function captionGeometry(engine: CaptionEngine, preset: CaptionPreset): CaptionGeometry {
  const fontSize = Number.isFinite(preset.fontSize) && preset.fontSize > 0 ? preset.fontSize : 48;
  if (preset.lineStyles?.length) {
    const lineStyles = preset.lineStyles.map((_, index) => resolveCaptionLineStyle(preset, index));
    const lineGap = Number.isFinite(preset.lineGap) ? Math.max(0, Math.min(80, preset.lineGap ?? 0)) : 4;
    const height = lineStyles.reduce((sum, line) => {
      const engineScale = engine === 'native' ? ASS_FONT_SCALE : 1.12;
      const stroke = engine === 'native' ? line.strokeWidth * 2 : line.strokeWidth * 2;
      return sum + line.fontSize * engineScale * line.lineHeight + stroke;
    }, 0) + Math.max(0, lineStyles.length - 1) * lineGap + 16;
    return {
      height,
      centreOffset: height / 2,
      positionYFor: (top) => 100 * (1 - (top + height) / CANVAS_HEIGHT),
      topFor: (positionY) => CANVAS_HEIGHT * (1 - positionY / 100) - height,
    };
  }
  if (engine === 'native') {
    const size = Math.round(fontSize * ASS_FONT_SCALE);
    const stroke = preset.strokeWidth ?? 3;
    const lineBox = size * 1.33;
    // Long chunks wrap to a second line (growing downward from the top-anchored
    // first line), so room for two lines is reserved - but a normal one-line
    // caption is what gets centred on the seam.
    const height = Math.ceil(2 * lineBox + 2 * stroke);
    return {
      height,
      centreOffset: lineBox / 2 + stroke,
      positionYFor: (top) => 100 * (1 - (top + 0.625 * size) / CANVAS_HEIGHT),
      topFor: (positionY) => CANVAS_HEIGHT * (1 - positionY / 100) - 0.625 * size,
    };
  }
  const line = fontSize * 1.25 * 1.12; // active-word scale 1.12
  const height = Math.ceil(2 * line + 16);
  return {
    height,
    centreOffset: height - (line + 16) / 2,
    positionYFor: (top) => 100 * (1 - (top + height) / CANVAS_HEIGHT),
    topFor: (positionY) => CANVAS_HEIGHT * (1 - positionY / 100) - height,
  };
}

// ---------------------------------------------------------------------------
// Placement search
// ---------------------------------------------------------------------------

const HARD_WEIGHT = 1000; // covering a face / another overlay
const SOFT_WEIGHT = 4; // covering hair - undesirable, but better than relocating far

/**
 * A preset position that overlaps a keep-out by no more than this many pixels still
 * counts as clear: positions are stored as a percentage rounded to 0.1 (~2px), so
 * an overlay the planner placed exactly against a boundary must not be "moved"
 * the next time round because of rounding.
 */
const CLEAR_TOLERANCE_PX = 4;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

interface Keepouts {
  /** Faces (padded): an overlay must not cover these. */
  hard: Band[];
  /** Hair: avoided when possible. */
  soft: Band[];
}

/** Penalty for an overlay occupying [top, top + height]. */
function penalty(top: number, height: number, keep: Keepouts, others: Band[]): { hard: number; soft: number } {
  const bottom = top + height;
  let hard = 0;
  let soft = 0;
  for (const z of keep.hard) hard += overlap(top, bottom, z.top, z.bottom);
  for (const z of others) hard += overlap(top, bottom, z.top - FACE_GAP / 2, z.bottom + FACE_GAP / 2);
  for (const z of keep.soft) soft += overlap(top, bottom, z.top, z.bottom);
  return { hard, soft };
}

/**
 * The cheapest top position for a block of `height` px: closest to `preferred`,
 * with faces and other overlays as near-hard constraints and hair as a mild one.
 */
function search(
  height: number,
  preferred: number,
  keep: Keepouts,
  others: Band[]
): { top: number; clean: boolean } {
  const lo = EDGE_MARGIN;
  const hi = Math.max(lo, CANVAS_HEIGHT - EDGE_MARGIN - height);
  let best = { top: Math.min(hi, Math.max(lo, preferred)), cost: Infinity, clean: false };
  for (let top = lo; top <= hi; top += 2) {
    const p = penalty(top, height, keep, others);
    const cost = Math.abs(top - preferred) + HARD_WEIGHT * p.hard + SOFT_WEIGHT * p.soft;
    if (cost < best.cost) best = { top, cost, clean: p.hard === 0 };
  }
  return { top: best.top, clean: best.clean };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Unchanged presets - used for speaker focus (and the single-window fallback). */
function untouched(input: OverlayAdaptationInput): OverlayAdaptation {
  return {
    adapted: false,
    caption: input.caption,
    hookStyle: input.hook?.style,
    ctaStyle: input.cta?.style,
    captionLiftScale: 1,
    placements: {},
    notes: [],
  };
}

export function adaptOverlaysToLayout(input: OverlayAdaptationInput): OverlayAdaptation {
  const { plan, engine } = input;
  if (plan.mode !== 'split') return untouched(input);

  const notes: string[] = [];

  // What an overlay must stay off: every face (padded), and, softly, the hair -
  // measured over the seconds that overlay is actually on screen.
  const keepoutsFor = (window?: { t0: number; t1: number }): Keepouts => {
    const keep: Keepouts = { hard: [], soft: [] };
    for (const cell of plan.cells) {
      const zones = window ? zonesBetween(cell, window.t0, window.t1) : { face: cell.faceZone, head: cell.headZone };
      const faceH = Math.max(1, zones.face.bottom - zones.face.top);
      keep.hard.push({
        top: zones.face.top - FOREHEAD_FRACTION * faceH - FACE_GAP,
        bottom: zones.face.bottom + CHIN_FRACTION * faceH + FACE_GAP,
      });
      keep.soft.push({ top: zones.head.top, bottom: zones.head.bottom });
    }
    return keep;
  };
  const SLACK = 0.4; // seconds of margin for pop/slide animations and caption holds
  const timing = input.timing;
  const clipEnd = timing ? Math.max(0.1, timing.clipDuration) : 0;
  const hookWindow = timing
    ? { t0: Math.max(0, timing.hookStart - SLACK), t1: Math.min(clipEnd, timing.hookStart + timing.hookVisibleSeconds + SLACK) }
    : undefined;
  const ctaWindow = timing
    ? { t0: Math.max(0, clipEnd - timing.ctaDuration - SLACK), t1: clipEnd }
    : undefined;

  const placements: OverlayAdaptation['placements'] = {};
  const taken: Band[] = [];

  // 1) CAPTIONS first: always on screen, so everything else works around them.
  const keep = keepoutsFor();
  const cap = captionGeometry(engine, input.caption);
  const presetTop = cap.topFor(input.caption.positionY ?? 25);
  const presetPenalty = penalty(presetTop, cap.height, keep, []);
  let captionTop = presetTop;
  if (presetPenalty.hard > CLEAR_TOLERANCE_PX || presetPenalty.soft > CLEAR_TOLERANCE_PX) {
    // The seam between the panes is the natural home for captions in a split.
    const seamTop = CANVAS_HEIGHT / 2 - cap.centreOffset;
    const found = search(cap.height, seamTop, keep, []);
    captionTop = found.top;
    notes.push(
      `captions moved from y=${Math.round(presetTop)} to y=${Math.round(captionTop)} ` +
        `(the preset position covers a face)` +
        (found.clean ? '' : ' - no completely free spot, covering as little as possible')
    );
  }
  const captionBand: Band = { top: captionTop, bottom: captionTop + cap.height };
  placements.caption = captionBand;
  taken.push(captionBand);
  const caption: CaptionPreset = {
    ...input.caption,
    positionY: round1(Math.max(0, Math.min(100, cap.positionYFor(captionTop)))),
  };

  // 2) HOOK and 3) CTA: keep the preset position if it is clear, else the nearest clear spot.
  const place = (
    name: 'hook' | 'cta',
    style: OverlayStylePreset,
    height: number,
    window?: { t0: number; t1: number }
  ): { style: OverlayStylePreset; band: Band } => {
    const keep = keepoutsFor(window);
    const wantTop = ((style.positionY ?? (name === 'hook' ? 12 : 70)) / 100) * CANVAS_HEIGHT;
    const here = penalty(wantTop, height, keep, taken);
    let top = wantTop;
    if (here.hard > CLEAR_TOLERANCE_PX || here.soft > CLEAR_TOLERANCE_PX) {
      const found = search(height, wantTop, keep, taken);
      top = found.top;
      notes.push(
        `${name} moved from y=${Math.round(wantTop)} to y=${Math.round(top)} ` +
          `(the preset position covers a face or the captions)` +
          (found.clean ? '' : ' - no completely free spot, covering as little as possible')
      );
    }
    return {
      style: { ...style, positionY: round1(Math.max(0, Math.min(100, (top / CANVAS_HEIGHT) * 100))) },
      band: { top, bottom: top + height },
    };
  };

  let hookStyle: OverlayStylePreset | undefined;
  if (input.hook && input.hook.text.trim()) {
    const placed = place('hook', input.hook.style, estimateHookHeight(input.hook.style, input.hook.text), hookWindow);
    hookStyle = placed.style;
    placements.hook = placed.band;
  } else {
    hookStyle = input.hook?.style;
  }

  let ctaStyle: OverlayStylePreset | undefined;
  if (input.cta && input.cta.text.trim()) {
    const placed = place('cta', input.cta.style, estimateCtaHeight(input.cta.style, input.cta.text), ctaWindow);
    ctaStyle = placed.style;
    placements.cta = placed.band;
  } else {
    ctaStyle = input.cta?.style;
  }

  return {
    adapted: true,
    caption,
    hookStyle,
    ctaStyle,
    // The CTA is placed clear of the captions, so they never need to dodge it.
    captionLiftScale: 0,
    placements,
    notes,
  };
}

/** Compact one-line summary of the placements for the worker log. */
export function describePlacements(result: OverlayAdaptation): string {
  const fmt = (band?: Band): string =>
    band ? `y ${Math.round(band.top)}-${Math.round(band.bottom)}` : 'off';
  return `captions ${fmt(result.placements.caption)}, hook ${fmt(result.placements.hook)}, CTA ${fmt(result.placements.cta)}`;
}

/** Re-export so callers don't need a second import. */
export type { CanvasZone };
