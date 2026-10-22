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
import { OVERLAY_CANVAS_HEIGHT, OVERLAY_CANVAS_WIDTH, OVERLAY_STACK_GAP, OVERLAY_TOP_MARGIN } from "../overlay-stack";

/** Card frame: 16:9, leaving ~100 px on each side of the canvas. */
export const CARD_WIDTH = 880;
export const CARD_HEIGHT = 495;
/** Clear space between the card and a face box. */
export const CARD_FACE_GAP = 28;

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
 * The card rectangle. Deterministic: same input, same rect - the render reads it
 * straight from the plan.
 */
export function planCardRect(input: CardPlacementInput): BrollCardRect {
  const canvasWidth = input.canvasWidth ?? OVERLAY_CANVAS_WIDTH;
  const canvasHeight = input.canvasHeight ?? OVERLAY_CANVAS_HEIGHT;
  const top = OVERLAY_TOP_MARGIN;
  const bottom = Math.min(canvasHeight, input.captionBand.top - OVERLAY_STACK_GAP);
  const available = Math.max(0, bottom - top);
  const faceZones = (input.faceZones ?? []).map(expanded);

  // Ideal position: just below the lowest face (so the speaker's head stays clear),
  // otherwise a little under the top edge where the card reads best.
  const lowestFaceBottom = faceZones.length
    ? Math.max(...faceZones.map((zone) => zone.y + zone.height))
    : null;

  // Shrinking keeps a 16:9 frame; it is only used when no full-size position is
  // free of faces, so the card is as large as the frame allows.
  const scales = [1, 0.85, 0.72, 0.6, 0.5, 0.42];
  let best: { rect: BrollCardRect; score: number } | null = null;

  for (const scale of scales) {
    const width = Math.round(CARD_WIDTH * scale);
    const height = Math.round(CARD_HEIGHT * scale);
    if (height > available) continue;
    const x = Math.round((canvasWidth - width) / 2);
    const maxY = Math.max(top, bottom - height);
    const idealY =
      lowestFaceBottom === null
        ? top + Math.round((maxY - top) * 0.15)
        : Math.min(maxY, lowestFaceBottom + 8);

    for (let y = top; y <= maxY + 0.5; y += 8) {
      const rect = { x, y, width, height };
      const covered = faceZones.reduce((sum, zone) => sum + overlapArea(rect, zone), 0);
      // Covering a face is catastrophic; distance from the ideal spot is a nudge.
      const score = covered * 1000 + Math.abs(y - idealY) + (1 - scale) * 120;
      if (!best || score < best.score) best = { rect, score };
    }
    // A full-size, face-free position wins outright - no need to try smaller cards.
    if (best && best.score < 120) break;
  }

  if (!best) {
    // Nothing fits (a caption band at the very top): a small centred card is still
    // better than no card, and the caller can see the overlap in `card`.
    const height = Math.max(120, Math.min(CARD_HEIGHT, available || 200));
    const width = Math.round(height * (CARD_WIDTH / CARD_HEIGHT));
    return { x: Math.round((canvasWidth - width) / 2), y: top, width, height };
  }

  return { ...best.rect, y: Math.round(Math.min(bottom - best.rect.height, Math.max(top, best.rect.y))) };
}

/**
 * Re-fit a PLANNED card rect to the caption band in force at RENDER time.
 *
 * The plan is made when B-roll is planned; the user may change the caption preset
 * afterwards. The stored rect was clear of the old band, so it is moved (or, when
 * there is not enough room, shrunk at a constant 16:9) to stay clear of the new one.
 * A card is never allowed to sit on the captions: that is the one overlap the
 * viewer cannot forgive.
 */
export function fitCardRectToBand(
  rect: BrollCardRect,
  captionBand: { top: number; bottom: number },
  canvas: { width?: number; height?: number } = {}
): BrollCardRect {
  const canvasWidth = canvas.width ?? OVERLAY_CANVAS_WIDTH;
  const canvasHeight = canvas.height ?? OVERLAY_CANVAS_HEIGHT;
  const limit = Math.min(canvasHeight, captionBand.top - OVERLAY_STACK_GAP);
  if (rect.y + rect.height <= limit && rect.y >= OVERLAY_TOP_MARGIN) return rect;

  const available = limit - OVERLAY_TOP_MARGIN;
  // Below this there is no room for a readable card; keeping the planned rect (and
  // the image) beats shrinking it into a sliver. captionReservedBand never puts a
  // band this high - this only guards against a hand-edited preset.
  if (available < 120) return rect;

  if (rect.height <= available) {
    const y = Math.max(OVERLAY_TOP_MARGIN, Math.min(limit - rect.height, rect.y));
    return { ...rect, y };
  }

  const scale = available / rect.height;
  const height = Math.max(1, Math.round(rect.height * scale));
  const width = Math.max(1, Math.round(rect.width * scale));
  const x = Math.max(0, Math.min(canvasWidth - width, Math.round(rect.x + (rect.width - width) / 2)));
  return { x, y: OVERLAY_TOP_MARGIN, width, height };
}

/** True when a planned card (plus gap) touches any face box - used by tests/logs. */
export function cardCoversFace(card: BrollCardRect, faceZones: FaceZoneRect[]): boolean {
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
  canvasHeight = OVERLAY_CANVAS_HEIGHT
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
  const cropX = Math.max(0, Math.min(frameWidth - cropWidth, face.x + face.width / 2 - cropWidth / 2));
  const cropY = Math.max(0, Math.min(frameHeight - cropHeight, face.y + face.height / 2 - cropHeight * 0.4));

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
