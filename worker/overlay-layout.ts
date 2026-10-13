/**
 * Placement of the captions, the hook text and the CTA card.
 *
 * THE CONTRACT (every framing layout):
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
 * `positionY` changes), and the Remotion compositions - which already position
 * everything from `positionY` - pick it up without any special casing.
 */
import type { CaptionPreset, OverlayStylePreset } from '../lib/types';
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
   * need to dodge them: always 0. Kept in the shape because the Remotion
   * compositions still multiply their lift by it.
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
  const { plan } = input;
  const notes: string[] = [];
  const placements: OverlayAdaptation['placements'] = {};

  // 1) CAPTIONS: preset position everywhere; in a split screen, moved only when
  //    that position would sit on a face (the seam between panes is the natural
  //    new home).
  const band = captionReservedBand(input.caption);
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
      // The adapted band keeps the same height; the inverse turns the new top
      // back into the preset's positionY. The published band is re-derived from
      // the ROUNDED preset so the two stay in lockstep.
      const positionY = captionPositionYForBandTop(input.caption, captionTop);
      caption = { ...input.caption, positionY: round1(Math.max(0, Math.min(100, positionY))) };
      captionTop = captionReservedBand(caption).top;
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

export interface VisualCardPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  bottom: number;
}

function bandOverlap(a: Band, b: { top: number; bottom: number }): number {
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * Computes a safe on-canvas 9:16 card placement for contextual visual overlays
 * (portrait ~720x900 4:5 by default, or square 720x720 1:1) in the upper/center
 * safe area without colliding with captions, hook/CTA cards, or detected faces.
 */
export function planVisualCardPlacement(params: {
  plan: LayoutPlan;
  captionBand?: Band;
  hookBand?: Band;
  ctaBand?: Band;
  cardAspect?: 'portrait' | 'square';
  cardWidth?: number;
  cardHeight?: number;
  /**
   * When true, places the visual card in the caption-background zone (behind the
   * transparent Remotion captions, which composite on top of `[vvis]`) while
   * strictly avoiding speaker face zones so faces are never covered.
   */
  placeBehindCaptions?: boolean;
}): VisualCardPlacement {
  const { plan, hookBand, ctaBand, placeBehindCaptions = false } = params;
  const captionBand: Band = params.captionBand ?? { top: 1320, bottom: 1620 };
  const aspect = params.cardAspect ?? 'portrait';
  const defaultWidth = placeBehindCaptions ? 920 : 720;
  const defaultHeight = placeBehindCaptions
    ? aspect === 'square'
      ? 860
      : 920
    : aspect === 'square'
      ? 720
      : 900;

  let width = Math.max(320, Math.min(1040, Math.round((params.cardWidth ?? defaultWidth) / 2) * 2));
  let height = Math.max(240, Math.min(1080, Math.round((params.cardHeight ?? defaultHeight) / 2) * 2));

  if (placeBehindCaptions) {
    if (plan.mode === 'single') {
      const anchorY = Number.isFinite(plan.faceAnchorY) ? (plan.faceAnchorY as number) : 0.35;
      const faceCenterY = Math.round(anchorY * CANVAS_HEIGHT);
      const faceTop = Math.max(0, faceCenterY - 240);
      const faceBottom = Math.min(CANVAS_HEIGHT, faceCenterY + 240);

      if (anchorY <= 0.54) {
        // Speaker face is in the upper half -> place the image in the lower half
        // directly behind the captions without touching the face zone.
        const minSafeTop = Math.max(880, faceBottom + 20);
        const maxBottom = CANVAS_HEIGHT - 56;
        const availableH = maxBottom - minSafeTop;
        if (availableH >= 420 && height > availableH) {
          height = Math.floor(availableH / 2) * 2;
        }
        const captionCenter = Math.round((captionBand.top + captionBand.bottom) / 2);
        const desiredTop = Math.round(captionCenter - height * 0.55);
        const top = Math.max(minSafeTop, Math.min(maxBottom - height, desiredTop));
        const x = Math.round((CANVAS_WIDTH - width) / 2);
        return {
          x,
          y: top,
          width,
          height,
          top,
          bottom: top + height,
        };
      } else {
        // Speaker face is in the lower half -> place the image in the upper half above the face.
        const maxSafeBottom = Math.max(480, faceTop - 20);
        const minTop = 64;
        const availableH = maxSafeBottom - minTop;
        if (availableH >= 360 && height > availableH) {
          height = Math.floor(availableH / 2) * 2;
        }
        const top = minTop;
        const x = Math.round((CANVAS_WIDTH - width) / 2);
        return {
          x,
          y: top,
          width,
          height,
          top,
          bottom: top + height,
        };
      }
    }

    // Split-screen mode: find the vertical position that strictly avoids all cell faceZones
    // while preferring the lower/caption-background region.
    const splitFaces = plan.cells.map((c) => c.faceZone);
    const x = Math.round((CANVAS_WIDTH - width) / 2);
    let bestTop = Math.max(64, CANVAS_HEIGHT - height - 64);
    let bestScore = Number.POSITIVE_INFINITY;
    for (let candidateTop = 64; candidateTop <= CANVAS_HEIGHT - height - 64; candidateTop += 40) {
      const band: Band = { top: candidateTop, bottom: candidateTop + height };
      let faceOverlap = 0;
      for (const fz of splitFaces) {
        faceOverlap += bandOverlap(band, fz) * 40;
      }
      // Prefer overlapping the caption band (behind captions)
      const capOverlap = bandOverlap(band, captionBand);
      const score = faceOverlap - capOverlap * 2;
      if (score < bestScore) {
        bestScore = score;
        bestTop = candidateTop;
      }
    }
    return {
      x,
      y: bestTop,
      width,
      height,
      top: bestTop,
      bottom: bestTop + height,
    };
  }

  const reservedBands: Band[] = [captionBand];
  if (hookBand) reservedBands.push(hookBand);
  if (ctaBand) reservedBands.push(ctaBand);

  const stackTop = Math.min(...reservedBands.map((b) => b.top));
  const stackBottom = Math.max(...reservedBands.map((b) => b.bottom));

  // If the upper safe area above the overlay stack is tighter than the card height,
  // scale proportionally while preserving the portrait (4:5) or square (1:1) aspect ratio.
  const upperAvailableHeight = stackTop - OVERLAY_STACK_GAP - EDGE_MARGIN;
  if (upperAvailableHeight >= 360 && upperAvailableHeight < height) {
    const ratio = width / height;
    height = Math.max(360, Math.floor(upperAvailableHeight / 2) * 2);
    width = Math.max(320, Math.floor((height * ratio) / 2) * 2);
  }

  const x = Math.round((CANVAS_WIDTH - width) / 2);

  const upperMaxTop = Math.max(EDGE_MARGIN, stackTop - height - OVERLAY_STACK_GAP);
  const upperMidTop = Math.round((EDGE_MARGIN + upperMaxTop) / 2);
  const candidateTops: number[] = [
    108,
    upperMidTop,
    upperMaxTop,
    Math.min(CANVAS_HEIGHT - height - EDGE_MARGIN, stackBottom + OVERLAY_STACK_GAP),
    CANVAS_HEIGHT - height - 120,
  ];

  const faceZones: Array<{ top: number; bottom: number }> =
    plan.mode === 'split'
      ? plan.cells.map((c) => c.faceZone)
      : Number.isFinite(plan.faceAnchorY)
        ? [
            {
              top: Math.max(0, Math.round(plan.faceAnchorY * CANVAS_HEIGHT - 160)),
              bottom: Math.min(CANVAS_HEIGHT, Math.round(plan.faceAnchorY * CANVAS_HEIGHT + 160)),
            },
          ]
        : [];

  let bestTop = 108;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (const rawTop of candidateTops) {
    const top = Math.max(EDGE_MARGIN, Math.min(CANVAS_HEIGHT - height - EDGE_MARGIN, Math.round(rawTop)));
    const bottom = top + height;
    const candidateBand: Band = { top, bottom };

    let captionPenalty = 0;
    for (const r of reservedBands) {
      captionPenalty += bandOverlap(candidateBand, r) * 10;
    }

    let facePenalty = 0;
    for (const fz of faceZones) {
      facePenalty += bandOverlap(candidateBand, fz) * 1.5;
    }

    // Slight preference for the upper contextual zone when clear
    const positionPreference = Math.abs(top - 108) * 0.05;
    const totalPenalty = captionPenalty + facePenalty + positionPreference;

    if (totalPenalty < bestPenalty) {
      bestPenalty = totalPenalty;
      bestTop = top;
    }
  }

  return {
    x,
    y: bestTop,
    width,
    height,
    top: bestTop,
    bottom: bestTop + height,
  };
}



