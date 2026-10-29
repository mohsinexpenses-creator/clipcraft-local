/**
 * Where a landscape card sits on the 1080x1920 canvas.
 *
 * Two hard rules from the brief: a card never covers the caption band, and it
 * never covers a face. The free area is the vertical strip between the top margin
 * and the top of the caption block; inside it the card prefers to sit just below
 * the speaker's face (or just above it when there is no room below), and among
 * equally free spots it prefers higher on the frame.
 */

import type { BrollCardRect } from "../types";
import {
  OVERLAY_CANVAS_HEIGHT,
  OVERLAY_CANVAS_WIDTH,
  OVERLAY_TOP_MARGIN,
} from "../overlay-stack";

/** Card frame: 16:9, 70% of the canvas width (756 x 425 on a 1080 canvas). */
export const CARD_WIDTH_FRACTION = 0.7;
export const CARD_WIDTH = Math.round(
  OVERLAY_CANVAS_WIDTH * CARD_WIDTH_FRACTION,
);
export const CARD_HEIGHT = Math.round((CARD_WIDTH * 9) / 16);
/** How far the card reaches into the caption band: 0.5 = the band's vertical middle. */
export const CARD_CAPTION_OVERLAP = 1;
/** Clear space between the card and a face box. */
export const CARD_FACE_GAP = 28;
/** Layouts a card can be anchored for. */
export type CardLayoutMode = "speaker-focus" | "split-screen";

/** Speaker focus: card bottom edge sits this fraction of the canvas height ABOVE the clip bottom. */
export const CARD_BOTTOM_ABOVE_CLIP_BOTTOM = 0.2;
/** Split screen: card centre sits this fraction of the canvas height above (+) / below (-) the seam. */
export const CARD_SEAM_OFFSET = 0;

/** How far (px) a card may sink below the caption band to avoid a face. */
export const CARD_MAX_CAPTION_SPILL = 200;

/** Lowest y a card of fixed height may take (band limit + allowed spill). */
function cardLowestY(
  bottomLimit: number,
  cardHeight: number,
  canvasHeight: number,
): number {
  const ideal = Math.max(OVERLAY_TOP_MARGIN, bottomLimit - cardHeight);
  return Math.max(
    OVERLAY_TOP_MARGIN,
    Math.min(
      canvasHeight - cardHeight - OVERLAY_TOP_MARGIN,
      ideal + CARD_MAX_CAPTION_SPILL,
    ),
  );
}

export interface FaceZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardPlacementInput {
  /** The caption block, canvas px (from `captionReservedBand`). */
  captionBand: { top: number; bottom: number };
  /** Face boxes mapped into canvas px, when the caller has them. */
  faceZones?: FaceZoneRect[];
  canvasWidth?: number;
  canvasHeight?: number;
}

/** The card must sit above the caption block. The band may be wide, but the card
 * never crosses its top edge; any spill is only a fallback for a face-avoidance
 * repair, never the normal placement. */
function cardBottomLimit(
  band: { top: number; bottom: number },
  canvasHeight: number,
): number {
  return Math.min(canvasHeight, band.top);
}

function overlapArea(a: BrollCardRect, b: FaceZoneRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** The enlarged face box a card must keep clear of (gap included). */
function expanded(zone: FaceZoneRect): FaceZoneRect {
  return {
    x: zone.x - CARD_FACE_GAP,
    y: zone.y - CARD_FACE_GAP,
    width: zone.width + CARD_FACE_GAP * 2,
    height: zone.height + CARD_FACE_GAP * 2,
  };
}

/**
 * The card rectangle. Size is ALWAYS fixed (70% width, 16:9). Only y moves:
 * first choice is the ideal spot, then the nearest spot that keeps clear of faces.
 */
export function planCardRect(input: CardPlacementInput): BrollCardRect {
  const canvasWidth = input.canvasWidth ?? OVERLAY_CANVAS_WIDTH;
  const canvasHeight = input.canvasHeight ?? OVERLAY_CANVAS_HEIGHT;
  const top = OVERLAY_TOP_MARGIN;
  const bottom = cardBottomLimit(input.captionBand, canvasHeight);
  const faceZones = (input.faceZones ?? []).map(expanded);

  const width = CARD_WIDTH;
  const height = CARD_HEIGHT;
  const x = Math.round((canvasWidth - width) / 2);
  const idealY = Math.max(top, bottom - height);
  const lowestY = cardLowestY(bottom, height, canvasHeight);

  let bestY = idealY;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let y = top; y <= lowestY + 0.5; y += 8) {
    const rect = { x, y, width, height };
    const covered = faceZones.reduce(
      (sum, zone) => sum + overlapArea(rect, zone),
      0,
    );
    // Sinking into the caption band is tolerated, but only as a last resort.
    const spill = Math.max(0, y + height - bottom);
    const score = covered * 1000 + spill * width + Math.abs(y - idealY);
    if (score < bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  return { x, y: Math.round(bestY), width, height };
}

/**
 * Re-fit a PLANNED card at RENDER time. Never resizes: the size is forced to
 * the fixed 70% / 16:9 frame (this also repairs old plans) and only y is
 * clamped. The planned y is kept, so face avoidance from planning survives.
 */
export function fitCardRectToBand(
  rect: BrollCardRect,
  captionBand: { top: number; bottom: number },
  canvas: { width?: number; height?: number } = {},
): BrollCardRect {
  const canvasWidth = canvas.width ?? OVERLAY_CANVAS_WIDTH;
  const canvasHeight = canvas.height ?? OVERLAY_CANVAS_HEIGHT;
  const limit = cardBottomLimit(captionBand, canvasHeight);

  const width = CARD_WIDTH;
  const height = CARD_HEIGHT;
  const x = Math.round((canvasWidth - width) / 2);
  const maxY = cardLowestY(limit, height, canvasHeight);
  const y = Math.round(Math.min(maxY, Math.max(OVERLAY_TOP_MARGIN, rect.y)));

  return { x, y, width, height };
}

/**
 * Fixed placement per layout; size stays 70% / 16:9. Speaker focus: bottom edge anchor.
 * Split screen: centred on the seam, nudged vertically (minimum) away from face bands.
 */
export function anchoredCardRect(
  mode: CardLayoutMode,
  options: {
    faceBands?: Array<{ top: number; bottom: number }>;
    canvas?: { width?: number; height?: number };
  } = {},
): BrollCardRect {
  const canvasWidth = options.canvas?.width ?? OVERLAY_CANVAS_WIDTH;
  const canvasHeight = options.canvas?.height ?? OVERLAY_CANVAS_HEIGHT;
  const width = CARD_WIDTH;
  const height = CARD_HEIGHT;
  const x = Math.round((canvasWidth - width) / 2);
  const minY = OVERLAY_TOP_MARGIN;
  const maxY = canvasHeight - height - OVERLAY_TOP_MARGIN;

  if (mode === "speaker-focus") {
    const bottom = canvasHeight * (1 - CARD_BOTTOM_ABOVE_CLIP_BOTTOM);
    return {
      x,
      y: Math.round(Math.min(maxY, Math.max(minY, bottom - height))),
      width,
      height,
    };
  }

  const preferred =
    canvasHeight / 2 - canvasHeight * CARD_SEAM_OFFSET - height / 2;
  const bands = (options.faceBands ?? []).map((band) => ({
    top: band.top - CARD_FACE_GAP,
    bottom: band.bottom + CARD_FACE_GAP,
  }));
  let bestY = Math.min(maxY, Math.max(minY, preferred));
  let bestScore = Number.POSITIVE_INFINITY;
  for (let y = minY; y <= maxY; y += 4) {
    const covered = bands.reduce(
      (sum, band) =>
        sum +
        Math.max(0, Math.min(y + height, band.bottom) - Math.max(y, band.top)),
      0,
    );
    const score = covered * 4 + Math.abs(y - preferred);
    if (score < bestScore) {
      bestScore = score;
      bestY = y;
    }
  }
  return { x, y: Math.round(bestY), width, height };
}

/** True when a planned card (plus gap) touches any face box - used by tests/logs. */
export function cardCoversFace(
  card: BrollCardRect,
  faceZones: FaceZoneRect[],
): boolean {
  return faceZones.some((zone) => overlapArea(card, expanded(zone)) > 0);
}

/**
 * Map a face box from a source frame to the 1080x1920 canvas.
 *
 * The speaker-focus layout fills the canvas with a 9:16 window of the frame; the
 * window is approximated here with the same face-aware crop used for full-screen
 * images, so a card can avoid the speaker's head even before the renderer has run
 * its own face tracking.
 */
export function mapFaceToCanvas(
  face: { x: number; y: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
  canvasWidth = OVERLAY_CANVAS_WIDTH,
  canvasHeight = OVERLAY_CANVAS_HEIGHT,
): FaceZoneRect | null {
  if (
    !Number.isFinite(face.width) ||
    !Number.isFinite(face.height) ||
    face.width <= 0 ||
    face.height <= 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null;
  }

  // A 9:16 window of the frame, kept centred on the face (never stretched).
  const targetAspect = canvasWidth / canvasHeight;
  const cropWidth = Math.min(frameWidth, frameHeight * targetAspect);
  const cropHeight = Math.min(frameHeight, frameWidth / targetAspect);
  const cropX = Math.max(
    0,
    Math.min(frameWidth - cropWidth, face.x + face.width / 2 - cropWidth / 2),
  );
  const cropY = Math.max(
    0,
    Math.min(
      frameHeight - cropHeight,
      face.y + face.height / 2 - cropHeight * 0.4,
    ),
  );

  const scaleX = canvasWidth / cropWidth;
  const scaleY = canvasHeight / cropHeight;
  const rect = {
    x: Math.round((face.x - cropX) * scaleX),
    y: Math.round((face.y - cropY) * scaleY),
    width: Math.round(face.width * scaleX),
    height: Math.round(face.height * scaleY),
  };

  // Add the forehead/chin the detector box leaves out (same padding as the layout).
  const padX = Math.round(rect.width * 0.25);
  const padTop = Math.round(rect.height * 0.45);
  const padBottom = Math.round(rect.height * 0.2);
  return {
    x: Math.max(0, rect.x - padX),
    y: Math.max(0, rect.y - padTop),
    width: Math.min(canvasWidth, rect.width + padX * 2),
    height: Math.min(canvasHeight, rect.height + padTop + padBottom),
  };
}
