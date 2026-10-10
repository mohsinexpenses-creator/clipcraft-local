/**
 * Shared overlay geometry: how the captions, the hook card and the CTA card are
 * stacked on the 1080x1920 canvas.
 *
 * The placement contract (for EVERY framing layout and BOTH caption engines):
 *
 *   1. the captions sit at their preset position;
 *   2. the hook card and the CTA card are placed DIRECTLY ABOVE the caption
 *      block - the card's bottom edge a fixed gap above the captions' top edge,
 *      both horizontally centred like the captions.
 *
 * Pure logic, no I/O - imported by the worker (render-time placement), the
 * Remotion compositions (in-app previews) and the tests.
 */
import type { CaptionEngine, CaptionPreset, OverlayStylePreset } from './types';
import { resolveCaptionLineStyle } from './caption-layout';

export const OVERLAY_CANVAS_WIDTH = 1080;
export const OVERLAY_CANVAS_HEIGHT = 1920;

/** Clear space between the stacked card's bottom edge and the caption block. */
export const OVERLAY_STACK_GAP = 24;
/** Cards never go closer to the top edge than this. */
export const OVERLAY_TOP_MARGIN = 40;

// ---------------------------------------------------------------------------
// Card size estimates (mirror the Remotion card layouts)
// ---------------------------------------------------------------------------

/**
 * Average advance of a bold glyph as a fraction of the font size. Deliberately on the
 * WIDE side and independent of the font stack: 0.78 is Arial Black / DejaVu Bold, the
 * widest of the usual fallbacks, and which font Chrome actually ends up with depends
 * on what is installed (a stack starting with Impact only gets Impact's narrow glyphs
 * where Impact exists). Over-estimating the line count only ever reserves a little
 * extra room; under-estimating could stack the next overlay onto the card.
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
 * optional badge chip (~34px with its margin) + a card with 20px vertical
 * padding, its border and the wrapped text at line-height 1.2. Includes a small
 * safety pad for the pop / slide animation.
 */
export function estimateHookHeight(style: OverlayStylePreset, text: string): number {
  const fontSize = fontSizeOf(style, 38);
  const border = style.borderWidth ?? 2;
  const innerWidth = OVERLAY_CANVAS_WIDTH * 0.88 - 48 - 2 * border;
  const lines = estimateLineCount(text, innerWidth, fontSize, rendersUppercase(text, style.textTransform), 1);
  const badge = style.showBadge !== false ? 34 : 0;
  return Math.ceil(badge + 40 + 2 * border + lines * fontSize * 1.2 + 12);
}

/** Height of the CTA card as remotion/CTAOverlay.tsx lays it out (18px padding, line-height 1.2). */
export function estimateCtaHeight(style: OverlayStylePreset, text: string): number {
  const fontSize = fontSizeOf(style, 34);
  const border = style.borderWidth ?? 2;
  const innerWidth = Math.min(OVERLAY_CANVAS_WIDTH * 0.86, 880) - 44 - 2 * border;
  const lines = estimateLineCount(text, innerWidth, fontSize, rendersUppercase(text, style.textTransform), 0);
  return Math.ceil(36 + 2 * border + lines * fontSize * 1.2 + 12);
}

// ---------------------------------------------------------------------------
// Caption block geometry
// ---------------------------------------------------------------------------

/** libass scales the preset size up (see ASS_FONT_SCALE in worker/captions-ass.ts). */
const ASS_FONT_SCALE = 1.2;

/** A vertical band on the canvas (px). */
export interface OverlayBand {
  top: number;
  bottom: number;
}

interface CaptionGeometry {
  /** Reserved vertical block: [top, bottom] canvas px. */
  band: OverlayBand;
  /** The `positionY` (% from the bottom) that puts the block's top at `top`. */
  positionYForTop: (top: number) => number;
}

/**
 * How each caption engine turns `positionY` (% from the bottom) into pixels:
 *  - native (ASS): one line, `\an8` at y = bottomEdge - 0.625*size (the line's
 *    TOP); a wrapped second line grows downward, so two lines are reserved;
 *  - Remotion: a bottom-anchored flex box - its BOTTOM edge sits at positionY and
 *    a wrapped second line grows upward, so room for two lines is reserved.
 */
function captionGeometry(engine: CaptionEngine, preset: CaptionPreset): CaptionGeometry {
  const fontSize = Number.isFinite(preset.fontSize) && preset.fontSize > 0 ? preset.fontSize : 48;
  const positionY = Number.isFinite(preset.positionY) ? preset.positionY : 25;
  const bottomEdge = OVERLAY_CANVAS_HEIGHT * (1 - positionY / 100);

  if (preset.lineStyles?.length) {
    const lineGap = Number.isFinite(preset.lineGap) ? Math.max(0, Math.min(80, preset.lineGap ?? 0)) : 4;
    const height = preset.lineStyles.reduce((sum, _line, index) => {
      const style = resolveCaptionLineStyle(preset, index);
      const engineScale = engine === 'native' ? ASS_FONT_SCALE : 1.12;
      return sum + style.fontSize * engineScale * style.lineHeight + style.strokeWidth * 2;
    }, 0) + Math.max(0, preset.lineStyles.length - 1) * lineGap + 16;
    return {
      band: { top: bottomEdge - height, bottom: bottomEdge },
      positionYForTop: (top) => 100 * (1 - (top + height) / OVERLAY_CANVAS_HEIGHT),
    };
  }

  if (engine === 'native') {
    const size = Math.round(fontSize * ASS_FONT_SCALE);
    const stroke = preset.strokeWidth ?? 3;
    const lineBox = size * 1.33;
    const height = Math.ceil(2 * lineBox + 2 * stroke);
    return {
      // ASS \an8 anchors the line's TOP at bottomEdge - 0.625*size.
      band: { top: bottomEdge - 0.625 * size, bottom: bottomEdge - 0.625 * size + height },
      positionYForTop: (top) => 100 * (1 - (top + 0.625 * size) / OVERLAY_CANVAS_HEIGHT),
    };
  }

  const line = fontSize * 1.25 * 1.12; // active-word scale 1.12
  const height = Math.ceil(2 * line + 16);
  return {
    band: { top: bottomEdge - height, bottom: bottomEdge },
    positionYForTop: (top) => 100 * (1 - (top + height) / OVERLAY_CANVAS_HEIGHT),
  };
}

/** The vertical band the captions reserve for a preset (see captionGeometry). */
export function captionReservedBand(engine: CaptionEngine, preset: CaptionPreset): OverlayBand {
  return captionGeometry(engine, preset).band;
}

/** Inverse of captionReservedBand: the positionY that puts the band's top at `top`. */
export function captionPositionYForBandTop(
  engine: CaptionEngine,
  preset: CaptionPreset,
  top: number
): number {
  return captionGeometry(engine, preset).positionYForTop(top);
}

// ---------------------------------------------------------------------------
// Stacking
// ---------------------------------------------------------------------------

/**
 * The top edge (canvas px) for a card of `cardHeight` stacked DIRECTLY ABOVE the
 * caption band: card bottom = caption top - gap. Clamped so the card never
 * escapes the frame - a caption placed very high pins the card to the top margin.
 */
export function stackCardAboveCaptions(
  captionBand: OverlayBand,
  cardHeight: number,
  gap: number = OVERLAY_STACK_GAP
): number {
  const top = captionBand.top - gap - cardHeight;
  return Math.max(OVERLAY_TOP_MARGIN, Math.round(top));
}

/** Card top in canvas px as the hook/CTA presets' `positionY` (% from the TOP). */
export function stackPositionPercent(topPx: number): number {
  const percent = (topPx / OVERLAY_CANVAS_HEIGHT) * 100;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}
