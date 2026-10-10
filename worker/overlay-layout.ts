/**
 * Placement of the captions, the hook text and the CTA card.
 *
 * THE CONTRACT (every framing layout, both caption engines):
 *
 *   - the captions keep their preset position; in a SPLIT SCREEN they move only
 *     when that position would cover a face (recomputed from where the heads
 *     really are on the 1080x1920 canvas);
 *   - the hook card and the CTA card are stacked DIRECTLY ABOVE the caption
 *     block - card bottom a fixed gap above the captions' top edge - no matter
 *     which layout is used. The old behaviour (hook near the top of the frame,
 *     CTA floating mid-frame, face-searching spots in a split) put the cards on
 *     foreheads and between panes; the stack is what modern editors do and what
 *     reads correctly on every framing;
 *   - overlays never cover each other and the caption never moves out of the
 *     way of a card (cards go above it instead), so the "lift captions while
 *     the CTA shows" behaviour is switched off everywhere.
 *
 * Pure logic, no I/O. The result is a set of ADAPTED COPIES of the presets (only
 * `positionY` changes), so both caption engines - which already position
 * everything from `positionY` - pick it up without any special casing.
 */
import type { CaptionEngine, CaptionPreset, OverlayStylePreset } from '../lib/types';
import {
  OVERLAY_STACK_GAP,
  captionPositionYForBandTop,
  captionReservedBand,
  estimateCtaHeight,
  estimateHookHeight,
  stackCardAboveCaptions,
  stackPositionPercent,
  type OverlayBand,
} from '../lib/overlay-stack';
import type { LayoutPlan } from './layout';

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
export type Band = OverlayBand;

/**
 * When the timed overlays are on screen, in BASE-CLIP seconds (the clip before the
 * hook intro is prepended). Currently informational: the hook/CTA cards stack
 * above the captions instead of searching face-free spots, so their placement no
 * longer depends on the exact seconds they are visible.
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
  /** True when any placement differs from the stored presets. */
  adapted: boolean;
  caption: CaptionPreset;
  hookStyle?: OverlayStylePreset;
  ctaStyle?: OverlayStylePreset;
  /**
   * The CTA/hook cards are stacked ABOVE the captions, so the captions never
   * need to dodge them: always 0. Kept in the shape because both engines and
   * the ASS generator still multiply their lift by it.
   */
  captionLiftScale: number;
  /** Where each overlay ended up (canvas px) - for the log and the tests. */
  placements: { caption?: Band; hook?: Band; cta?: Band };
  /** Human-readable account of what was moved and why (empty when nothing moved). */
  notes: string[];
}

// Re-exports: the size estimates live in lib/overlay-stack now (shared with the
// Remotion previews); existing imports from this module keep working.
export { estimateCtaHeight, estimateHookHeight, estimateLineCount } from '../lib/overlay-stack';

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Split-screen caption placement (the ONLY face-aware part left)
// ---------------------------------------------------------------------------

interface Keepouts {
  /** Faces (padded): an overlay must not cover these. */
  hard: Band[];
  /** Hair: avoided when possible. */
  soft: Band[];
}

const HARD_WEIGHT = 1000; // covering a face
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

function captionPenalty(top: number, height: number, keep: Keepouts): { hard: number; soft: number } {
  const bottom = top + height;
  let hard = 0;
  let soft = 0;
  for (const z of keep.hard) hard += overlap(top, bottom, z.top, z.bottom);
  for (const z of keep.soft) soft += overlap(top, bottom, z.top, z.bottom);
  return { hard, soft };
}

/**
 * The cheapest top position for the caption block: closest to `preferred`,
 * with faces a near-hard constraint and hair a mild one.
 */
function searchCaption(
  height: number,
  preferred: number,
  keep: Keepouts
): { top: number; clean: boolean } {
  const lo = EDGE_MARGIN;
  const hi = Math.max(lo, CANVAS_HEIGHT - EDGE_MARGIN - height);
  let best = { top: Math.min(hi, Math.max(lo, preferred)), cost: Infinity, clean: false };
  for (let top = lo; top <= hi; top += 2) {
    const p = captionPenalty(top, height, keep);
    const cost = Math.abs(top - preferred) + HARD_WEIGHT * p.hard + SOFT_WEIGHT * p.soft;
    if (cost < best.cost) best = { top, cost, clean: p.hard === 0 };
  }
  return { top: best.top, clean: best.clean };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function adaptOverlaysToLayout(input: OverlayAdaptationInput): OverlayAdaptation {
  const { plan, engine } = input;
  const notes: string[] = [];
  const placements: OverlayAdaptation['placements'] = {};

  // 1) CAPTIONS: preset position everywhere; in a split screen, moved only when
  //    that position would sit on a face (the seam between panes is the natural
  //    new home).
  const band = captionReservedBand(engine, input.caption);
  const capHeight = band.bottom - band.top;
  let captionTop = band.top;
  let caption = input.caption;

  if (plan.mode === 'split') {
    const keep: Keepouts = { hard: [], soft: [] };
    for (const cell of plan.cells) {
      const zones = { face: cell.faceZone, head: cell.headZone };
      const faceH = Math.max(1, zones.face.bottom - zones.face.top);
      keep.hard.push({
        top: zones.face.top - FOREHEAD_FRACTION * faceH - FACE_GAP,
        bottom: zones.face.bottom + CHIN_FRACTION * faceH + FACE_GAP,
      });
      keep.soft.push({ top: zones.head.top, bottom: zones.head.bottom });
    }
    const presetPenalty = captionPenalty(captionTop, capHeight, keep);
    if (presetPenalty.hard > CLEAR_TOLERANCE_PX || presetPenalty.soft > CLEAR_TOLERANCE_PX) {
      const seamTop = CANVAS_HEIGHT / 2 - capHeight / 2;
      const found = searchCaption(capHeight, seamTop, keep);
      captionTop = found.top;
      notes.push(
        `captions moved from y=${Math.round(band.top)} to y=${Math.round(captionTop)} ` +
          `(the preset position covers a face)` +
          (found.clean ? '' : ' - no completely free spot, covering as little as possible')
      );
      // The adapted band keeps the same height; the engine-specific inverse
      // turns the new top back into the preset's positionY. The published band
      // is re-derived from the ROUNDED preset so the two stay in lockstep.
      const positionY = captionPositionYForBandTop(engine, input.caption, captionTop);
      caption = { ...input.caption, positionY: round1(Math.max(0, Math.min(100, positionY))) };
      captionTop = captionReservedBand(engine, caption).top;
    }
  }
  const captionBand: Band = { top: captionTop, bottom: captionTop + capHeight };
  placements.caption = captionBand;

  // 2) HOOK and 3) CTA: DIRECTLY ABOVE the caption block, whatever the layout.
  //    positionY for both is "% from the top" (see remotion/HookOverlay.tsx,
  //    remotion/CTAOverlay.tsx). A style that is ALREADY at the stacked spot
  //    (e.g. a re-render of an adapted clip) comes back unchanged.
  let hookStyle: OverlayStylePreset | undefined = input.hook?.style;
  if (input.hook && input.hook.text.trim()) {
    const height = estimateHookHeight(input.hook.style, input.hook.text);
    const top = stackCardAboveCaptions(captionBand, height, OVERLAY_STACK_GAP);
    const positionY = stackPositionPercent(top);
    if (Math.abs(positionY - (input.hook.style.positionY ?? -1)) > 0.05) {
      notes.push(`hook stacked directly above the captions (y=${top}px)`);
      hookStyle = { ...input.hook.style, positionY };
    }
    placements.hook = { top, bottom: top + height };
  }

  let ctaStyle: OverlayStylePreset | undefined = input.cta?.style;
  if (input.cta && input.cta.text.trim()) {
    const height = estimateCtaHeight(input.cta.style, input.cta.text);
    const top = stackCardAboveCaptions(captionBand, height, OVERLAY_STACK_GAP);
    const positionY = stackPositionPercent(top);
    if (Math.abs(positionY - (input.cta.style.positionY ?? -1)) > 0.05) {
      notes.push(`CTA stacked directly above the captions (y=${top}px)`);
      ctaStyle = { ...input.cta.style, positionY };
    }
    placements.cta = { top, bottom: top + height };
  }

  return {
    adapted: notes.length > 0 || caption !== input.caption,
    caption,
    hookStyle,
    ctaStyle,
    // The cards live ABOVE the captions, so captions never dodge them.
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


