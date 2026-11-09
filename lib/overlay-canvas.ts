import type { BrollCardRect, CaptionPreset, OverlayStylePreset } from "./types";
import {
  captionReservedBand,
  estimateCtaHeight,
  estimateHookHeight,
  OVERLAY_CANVAS_HEIGHT,
  OVERLAY_CANVAS_WIDTH,
} from "./overlay-stack";
import { BROLL_ANIMATION } from "./broll/animation";

/**
 * A transparent frame's physical canvas and its destination inside the final
 * 1080x1920 video canvas. Rendering a smaller canvas is safe only when its
 * virtual full-canvas artwork is translated back to this exact origin by FFmpeg.
 */
export interface OverlayCanvasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_OVERLAY_CANVAS: Readonly<OverlayCanvasRegion> = Object.freeze({
  x: 0,
  y: 0,
  width: OVERLAY_CANVAS_WIDTH,
  height: OVERLAY_CANVAS_HEIGHT,
});

/** Extra transparent room around card animation, shadows, and caption effects. */
export const OVERLAY_CROP_BLEED_PX = 128;
/** Card shadows plus its 32px slide-up entrance require a smaller, specific guard. */
export const BROLL_CARD_CROP_BLEED_PX = 40;

/**
 * Clamp and integer-align an arbitrary rectangle to the output canvas. This is
 * intentionally conservative: invalid input returns the old full-canvas path.
 */
export function normalizeOverlayCanvasRegion(
  region: OverlayCanvasRegion | undefined | null,
): OverlayCanvasRegion {
  if (
    !region ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height)
  ) {
    return { ...FULL_OVERLAY_CANVAS };
  }
  const rawX = region.x;
  const rawY = region.y;
  const rawWidth = region.width;
  const rawHeight = region.height;
  if (rawWidth <= 0 || rawHeight <= 0) return { ...FULL_OVERLAY_CANVAS };

  const left = Math.max(0, Math.min(OVERLAY_CANVAS_WIDTH - 1, Math.floor(rawX)));
  const top = Math.max(0, Math.min(OVERLAY_CANVAS_HEIGHT - 1, Math.floor(rawY)));
  const right = Math.max(left + 1, Math.min(OVERLAY_CANVAS_WIDTH, Math.ceil(rawX + rawWidth)));
  const bottom = Math.max(top + 1, Math.min(OVERLAY_CANVAS_HEIGHT, Math.ceil(rawY + rawHeight)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function isFullOverlayCanvas(region: OverlayCanvasRegion | undefined | null): boolean {
  const normalized = normalizeOverlayCanvasRegion(region);
  return (
    normalized.x === 0 &&
    normalized.y === 0 &&
    normalized.width === OVERLAY_CANVAS_WIDTH &&
    normalized.height === OVERLAY_CANVAS_HEIGHT
  );
}

export function sameOverlayCanvasRegion(
  first: OverlayCanvasRegion | undefined | null,
  second: OverlayCanvasRegion | undefined | null,
): boolean {
  const a = normalizeOverlayCanvasRegion(first);
  const b = normalizeOverlayCanvasRegion(second);
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function regionFromBounds(left: number, top: number, right: number, bottom: number): OverlayCanvasRegion {
  return normalizeOverlayCanvasRegion({
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  });
}

/**
 * Crop the landscape card artwork, not the 1080x1920 timeline. The guard covers
 * the 24px CSS shadow and the maximum 32px downward entrance/exit slide, so
 * re-placing the PNG at `x,y` reproduces the old full transparent canvas.
 */
export function getBrollCardCanvasRegion(card: BrollCardRect): OverlayCanvasRegion {
  const slide = Math.max(0, BROLL_ANIMATION.landscape.enterSlidePx);
  return regionFromBounds(
    card.x - BROLL_CARD_CROP_BLEED_PX,
    card.y - BROLL_CARD_CROP_BLEED_PX,
    card.x + card.width + BROLL_CARD_CROP_BLEED_PX,
    card.y + card.height + slide + BROLL_CARD_CROP_BLEED_PX,
  );
}

function cardBounds(
  style: OverlayStylePreset,
  text: string,
  kind: "hook" | "cta",
): { top: number; bottom: number } | null {
  if (!text.trim()) return null;
  const topPercent = Number.isFinite(style.positionY) ? style.positionY : kind === "hook" ? 12 : 70;
  const top = (Math.max(0, Math.min(100, topPercent)) / 100) * OVERLAY_CANVAS_HEIGHT;
  const height = kind === "hook"
    ? estimateHookHeight(style, text)
    : estimateCtaHeight(style, text);
  // Hook/CTA entrance transforms and shadows remain inside this crop guard.
  return {
    top: top - OVERLAY_CROP_BLEED_PX,
    bottom: top + height + OVERLAY_CROP_BLEED_PX,
  };
}

export interface CaptionOverlayCanvasInput {
  preset: CaptionPreset;
  hookText: string;
  hookDuration: number;
  hookStyle?: OverlayStylePreset;
  ctaText: string;
  ctaDuration: number;
  ctaStyle?: OverlayStylePreset;
}

/**
 * A conservative full-width vertical band containing every possible caption,
 * hook and CTA pixel for one combined transparent overlay composition. It is
 * intentionally a single region because the current composition shares one
 * Chromium pass and a stable composition clock. Returning null means the full
 * legacy canvas is the safer/no-op choice.
 */
export function getCaptionOverlayCanvasRegion(
  input: CaptionOverlayCanvasInput,
): OverlayCanvasRegion | null {
  const captionBand = captionReservedBand(input.preset);
  let top = captionBand.top - OVERLAY_CROP_BLEED_PX;
  let bottom = captionBand.bottom + OVERLAY_CROP_BLEED_PX;

  if (input.hookDuration > 0 && input.hookStyle) {
    const bounds = cardBounds(input.hookStyle, input.hookText, "hook");
    if (bounds) {
      top = Math.min(top, bounds.top);
      bottom = Math.max(bottom, bounds.bottom);
    }
  }
  if (input.ctaDuration > 0 && input.ctaStyle) {
    const bounds = cardBounds(input.ctaStyle, input.ctaText, "cta");
    if (bounds) {
      top = Math.min(top, bounds.top);
      bottom = Math.max(bottom, bounds.bottom);
    }
  }

  const region = regionFromBounds(0, top, OVERLAY_CANVAS_WIDTH, bottom);
  // A near-full canvas saves neither pixels nor image I/O. Retain the proven
  // full path rather than introducing a small crop boundary with no benefit.
  return region.height < OVERLAY_CANVAS_HEIGHT ? region : null;
}
