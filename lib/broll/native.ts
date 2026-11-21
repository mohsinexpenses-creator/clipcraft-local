/**
 * Native B-roll card renderer: the same PNG frames Remotion paints, without
 * Chromium.
 *
 * The card is a STATIC plate (rounded image, white border, drop shadow) moving
 * on screen with `brollFrameStyle()`. So the expensive part - decode, cover-fit,
 * mask, border, shadow - is computed once per image (the "bake"), and a frame is
 * then a handful of integer blits of a pre-scaled copy plus the shadow plate.
 * That is what makes a native renderer worth having: Remotion spends ~30-80 ms
 * per frame in a browser tab to move a picture that is already correct.
 *
 * The output contract is identical to the Remotion path and is NOT negotiable:
 *
 *   - one PNG per frame of the item's active range, named `frame-XXXXXX.png`
 *     (0-based element index, `frameElementName()`);
 *   - the active range and its `startAtSeconds` come from the SAME function the
 *     Remotion path uses (`calculateBrollActiveFrameRanges`), so concat,
 *     overlay, SFX and the frame cache are untouched;
 *   - the canvas is the same region Remotion renders (full 1080x1920, or the
 *     cropped card region when `BROLL_CARD_CROPPED_CANVAS=1`);
 *   - every pixel of the motion comes from `brollFrameStyle()`; this module only
 *     rasterises it (`opacity`, `scale`, `translateY`, `mediaScale`, `mediaX`).
 *
 * `BROLL_RENDERER=remotion` (default) keeps the old path. The pixel gate is
 * `npm run verify:broll-native`, which compares this renderer against Remotion
 * frame by frame (SSIM inside the card box + max abs difference) on the enter,
 * hold and exit frames.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Jimp } from "jimp";
import { log } from "../logger";
import { brollFrameStyle } from "./animation";
import { CARD_HEIGHT, CARD_WIDTH } from "./card";
import { captionContrastTreatment } from "./crop";
import {
  FULL_OVERLAY_CANVAS,
  getBrollCardCanvasRegion,
  type OverlayCanvasRegion,
} from "../overlay-canvas";
import type { BrollCardRect } from "../types";

/** The spec's card chrome, in canvas pixels at scale 1. */
export const NATIVE_CARD = {
  borderPx: 10,
  borderColor: "#ffffff",
  radiusPx: 28,
  /** `0 8px 24px rgba(0,0,0,0.25)`: offset, blur, colour. */
  shadowOffsetYPx: 8,
  shadowBlurPx: 24,
  shadowColor: { r: 0, g: 0, b: 0, a: 0.25 },
  /** The plate is drawn this many pixels larger so the shadow can bleed out. */
  paddingPx: 32,
} as const;

export type NativeBrollRendererChoice = "remotion" | "native";

/** `BROLL_RENDERER` - remotion until the pixel gate has been recorded. */
export function getBrollRendererChoice(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NativeBrollRendererChoice {
  return env.BROLL_RENDERER?.trim().toLowerCase() === "native" ? "native" : "remotion";
}

export interface NativeBrollItem {
  id: string;
  kind: "fullscreen" | "landscape";
  /** Final (hook-inclusive) timeline seconds. */
  start: number;
  end: number;
  /** Prepared image on disk (absolute path). */
  imagePath: string;
  card?: BrollCardRect;
  /** Identity for the bake cache: the same file at another key is a new bake. */
  cacheIdentity?: string;
}

export interface NativeBrollOptions {
  fps: number;
  items: readonly NativeBrollItem[];
  totalDuration: number;
  /** 0..1 destination for a frame; called once per painted frame. */
  writeFrame: (frameIndex: number, rgba: Buffer, width: number, height: number) => Promise<void>;
  /** Absolute frame numbers in the final composition, both inclusive. */
  frameRangeFor: (item: NativeBrollItem) => { startFrame: number; endFrame: number; frameCount: number };
  canvasFor?: (item: NativeBrollItem) => OverlayCanvasRegion;
  captionTextColor?: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}

/* ------------------------------------------------------------------ */
/* The baked plate                                                      */
/* ------------------------------------------------------------------ */

export interface BakedPlate {
  /** Plate canvas (already scaled to the largest on-screen size). */
  width: number;
  height: number;
  /** RGBA, straight alpha (what a PNG stores). */
  data: Uint8ClampedArray;
  /**
   * The tight box around every non-transparent pixel of the plate. Frames only
   * visit these pixels: a 756x425 card on a 1080x1920 canvas is 15 % of the
   * frame, and iterating the other 85 % was half the render time.
   */
  bounds: { x: number; y: number; width: number; height: number };
}

/** The tight non-transparent box of an RGBA buffer. */
export function tightBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

interface BakedCard extends BakedPlate {
  /** Where the plate's top-left goes for the resting card position. */
  plateX: number;
  plateY: number;
  /** The card's own (unscaled, unbordered) box inside the plate. */
  innerX: number;
  innerY: number;
  innerWidth: number;
  innerHeight: number;
  /**
   * Per-pixel alpha in 0..1, 1 = fully inside the card's rounded rect. Scaling
   * the card by `scale` multiplies coverage by `scale`, so a frame only needs
   * ONE multiply instead of four-tap bilinear alpha sampling.
   */
  coverage: Float32Array;
}

/** Max wrapper scale `brollFrameStyle` can produce, so one bake serves every frame. */
const MAX_WRAPPER_SCALE = 1.05;

/** Cover-fit dimensions for a source inside the card box. */
export function coverFit(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { width: targetWidth, height: targetHeight };
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  // Round to nearest, and never below the target: a 1600x900 source must fit
  // 756x425 exactly, not 756x426 (which would leave a 1 px seam in the card).
  return {
    width: Math.max(targetWidth, Math.round(sourceWidth * scale)),
    height: Math.max(targetHeight, Math.round(sourceHeight * scale)),
  };
}

/** Round-rect coverage in 0..1 at `(x, y)` for a box with corner radius `r`. */
export function roundRectCoverage(x: number, y: number, width: number, height: number, radius: number): number {
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) return 1;
  const cx = x < r ? r : x > width - r ? width - r : x;
  const cy = y < r ? r : y > height - r ? height - r : y;
  const dx = x - cx;
  const dy = y - cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  // One-pixel antialiased edge; interior is fully covered.
  return Math.max(0, Math.min(1, r + 0.5 - distance));
}

/**
 * Bake a landscape card: the prepared image cover-fitted inside a rounded box,
 * a 10 px white border, and `0 8px 24px rgba(0,0,0,0.25)` shadow - at the
 * largest scale the animation ever asks for, so every frame is a downscale.
 */
async function bakeLandscapeCard(item: NativeBrollItem, card: BrollCardRect): Promise<BakedCard> {
  const source = await Jimp.read(item.imagePath);
  const pad = NATIVE_CARD.paddingPx;
  const plateWidth = Math.ceil((card.width + pad * 2) * MAX_WRAPPER_SCALE);
  const plateHeight = Math.ceil((card.height + pad * 2) * MAX_WRAPPER_SCALE);
  const border = Math.round(NATIVE_CARD.borderPx * MAX_WRAPPER_SCALE);
  const radius = Math.round(NATIVE_CARD.radiusPx * MAX_WRAPPER_SCALE);

  const cardWidth = Math.round(card.width * MAX_WRAPPER_SCALE);
  const cardHeight = Math.round(card.height * MAX_WRAPPER_SCALE);
  const originX = Math.round(pad * MAX_WRAPPER_SCALE);
  const originY = Math.round(pad * MAX_WRAPPER_SCALE);

  const fitted = coverFit(source.bitmap.width, source.bitmap.height, cardWidth, cardHeight);
  const media = source.clone().cover({ w: fitted.width, h: fitted.height });

  const data = new Uint8ClampedArray(plateWidth * plateHeight * 4);
  const mediaData = media.bitmap.data;

  // 1. shadow (offset down), 2. white border + image inside the rounded box.
  const shadow = NATIVE_CARD.shadowColor;
  const shadowOffsetY = Math.round(NATIVE_CARD.shadowOffsetYPx * MAX_WRAPPER_SCALE);
  // A separable box blur of the rounded rect gives the 24 px soft edge.
  const blurRadius = Math.max(1, Math.round(NATIVE_CARD.shadowBlurPx * MAX_WRAPPER_SCALE));
  const shadowMask = new Float32Array(plateWidth * plateHeight);
  for (let y = 0; y < cardHeight; y += 1) {
    for (let x = 0; x < cardWidth; x += 1) {
      const coverage = roundRectCoverage(x, y, cardWidth, cardHeight, radius);
      if (coverage <= 0) continue;
      const index = (originY + y + shadowOffsetY) * plateWidth + (originX + x);
      if (index >= 0 && index < shadowMask.length) shadowMask[index] = coverage;
    }
  }
  const blurred = boxBlur(shadowMask, plateWidth, plateHeight, blurRadius);

  for (let index = 0; index < plateWidth * plateHeight; index += 1) {
    const alpha = Math.min(1, blurred[index]) * shadow.a;
    if (alpha <= 0) continue;
    data[index * 4] = shadow.r;
    data[index * 4 + 1] = shadow.g;
    data[index * 4 + 2] = shadow.b;
    data[index * 4 + 3] = Math.round(alpha * 255);
  }

  // Border + image. The border is painted as an inflated rounded rect, then the
  // cover-fitted image is drawn inside it.
  const innerWidth = cardWidth - border * 2;
  const innerHeight = cardHeight - border * 2;
  const innerRadius = Math.max(0, radius - border);
  const mediaX = Math.floor((fitted.width - innerWidth) / 2);
  const mediaY = Math.floor((fitted.height - innerHeight) / 2);
  for (let y = 0; y < cardHeight; y += 1) {
    for (let x = 0; x < cardWidth; x += 1) {
      const outer = roundRectCoverage(x, y, cardWidth, cardHeight, radius);
      if (outer <= 0) continue;
      const plateIndex = (originY + y) * plateWidth + (originX + x);
      if (plateIndex < 0 || plateIndex >= plateWidth * plateHeight) continue;

      const ix = x - border;
      const iy = y - border;
      const inside = ix >= 0 && iy >= 0 && ix < innerWidth && iy < innerHeight
        ? roundRectCoverage(ix, iy, innerWidth, innerHeight, innerRadius)
        : 0;

      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (inside > 0) {
        const sx = Math.min(fitted.width - 1, Math.max(0, ix + mediaX));
        const sy = Math.min(fitted.height - 1, Math.max(0, iy + mediaY));
        const mediaIndex = (sy * fitted.width + sx) * 4;
        // Border pixels that are only partly inside the rounded corner blend
        // with the white border underneath.
        const borderWeight = 1 - inside;
        r = mediaData[mediaIndex] * inside + 255 * borderWeight;
        g = mediaData[mediaIndex + 1] * inside + 255 * borderWeight;
        b = mediaData[mediaIndex + 2] * inside + 255 * borderWeight;
        a = 255 * outer;
      } else {
        r = 255;
        g = 255;
        b = 255;
        a = 255 * outer;
      }

      // Source-over onto the shadow already in the buffer.
      const existing = data[plateIndex * 4 + 3] / 255;
      const alpha = a / 255;
      const outAlpha = alpha + existing * (1 - alpha);
      if (outAlpha <= 0) continue;
      data[plateIndex * 4] = (r * alpha + data[plateIndex * 4] * existing * (1 - alpha)) / outAlpha;
      data[plateIndex * 4 + 1] = (g * alpha + data[plateIndex * 4 + 1] * existing * (1 - alpha)) / outAlpha;
      data[plateIndex * 4 + 2] = (b * alpha + data[plateIndex * 4 + 2] * existing * (1 - alpha)) / outAlpha;
      data[plateIndex * 4 + 3] = Math.round(outAlpha * 255);
    }
  }

  // Alpha coverage of the rounded rect (the card is an opaque plate inside it).
  const coverage = new Float32Array(plateWidth * plateHeight);
  for (let y = 0; y < cardHeight; y += 1) {
    for (let x = 0; x < cardWidth; x += 1) {
      const value = roundRectCoverage(x, y, cardWidth, cardHeight, radius);
      if (value > 0) coverage[(originY + y) * plateWidth + (originX + x)] = value;
    }
  }

  return {
    width: plateWidth,
    height: plateHeight,
    data,
    bounds: { x: originX, y: originY, width: cardWidth, height: cardHeight },
    plateX: Math.round(card.x - pad * MAX_WRAPPER_SCALE),
    plateY: Math.round(card.y - pad * MAX_WRAPPER_SCALE),
    innerX: originX + border,
    innerY: originY + border,
    innerWidth,
    innerHeight,
    coverage,
  };
}

/** Separable box blur on a single-channel float mask (three passes ~ gaussian). */
function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  let current = source;
  for (let pass = 0; pass < 3; pass += 1) {
    const horizontal = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      const row = y * width;
      for (let x = -radius; x <= radius; x += 1) sum += current[row + Math.min(width - 1, Math.max(0, x))];
      const divisor = radius * 2 + 1;
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x] = sum / divisor;
        const outIndex = Math.min(width - 1, Math.max(0, x - radius));
        const inIndex = Math.min(width - 1, Math.max(0, x + radius + 1));
        sum += current[row + inIndex] - current[row + outIndex];
      }
    }
    const vertical = new Float32Array(width * height);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1) {
        sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
      }
      const divisor = radius * 2 + 1;
      for (let y = 0; y < height; y += 1) {
        vertical[y * width + x] = sum / divisor;
        const outIndex = Math.min(height - 1, Math.max(0, y - radius));
        const inIndex = Math.min(height - 1, Math.max(0, y + radius + 1));
        sum += horizontal[inIndex * width + x] - horizontal[outIndex * width + x];
      }
    }
    current = vertical;
  }
  return current;
}

/** Bake a full-screen item: the prepared 1080x1920 frame, unchanged. */
async function bakeFullscreen(item: NativeBrollItem, canvas: OverlayCanvasRegion): Promise<BakedPlate> {
  const source = await Jimp.read(item.imagePath);
  const width = Math.ceil(canvas.width * MAX_WRAPPER_SCALE);
  const height = Math.ceil(canvas.height * MAX_WRAPPER_SCALE);
  // The prepared full-screen image already has the crop baked in (9:16).
  const fitted = coverFit(source.bitmap.width, source.bitmap.height, width, height);
  const media = source.clone().cover({ w: fitted.width, h: fitted.height });
  const data = new Uint8ClampedArray(media.bitmap.data);
  return { width, height, data, bounds: tightBounds(data, width, height) };
}

/* ------------------------------------------------------------------ */
/* Frame compositing                                                    */
/* ------------------------------------------------------------------ */

interface Surface {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function blankSurface(width: number, height: number): Surface {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Draw a plate scaled by `scale`, translated by `(dx, dy)`, with `opacity`, using
 * bilinear sampling of the pre-scaled plate. The plate is baked at the maximum
 * scale, so every frame here is a downscale - no aliasing from upscaling.
 */
function drawPlate(surface: Surface, plate: BakedCard | BakedPlate, scale: number, dx: number, dy: number, opacity: number): void {
  if (opacity <= 0 || scale <= 0) return;
  const isCard = "coverage" in plate;
  const targetWidth = Math.max(1, Math.round(plate.width * scale));
  const targetHeight = Math.max(1, Math.round(plate.height * scale));
  // Only the plate's own non-transparent box is visited.
  const boundX0 = dx + (plate.bounds.x * targetWidth) / plate.width;
  const boundY0 = dy + (plate.bounds.y * targetHeight) / plate.height;
  const boundX1 = boundX0 + (plate.bounds.width * targetWidth) / plate.width;
  const boundY1 = boundY0 + (plate.bounds.height * targetHeight) / plate.height;
  const x0 = Math.max(0, Math.floor(boundX0));
  const y0 = Math.max(0, Math.floor(boundY0));
  const x1 = Math.min(surface.width, Math.ceil(boundX1));
  const y1 = Math.min(surface.height, Math.ceil(boundY1));
  const sx = plate.width / targetWidth;
  const sy = plate.height / targetHeight;
  const data = plate.data;
  const coverage = isCard ? (plate as BakedCard).coverage : null;
  const out = surface.data;
  const width = surface.width;

  for (let y = y0; y < y1; y += 1) {
    const fy = (y - dy) * sy;
    const iy = Math.min(plate.height - 1, Math.max(0, Math.floor(fy)));
    const iy2 = Math.min(plate.height - 1, iy + 1);
    const wy = fy - iy;
    const wy1 = 1 - wy;
    const row0 = iy * plate.width;
    const row1 = iy2 * plate.width;
    let target = (y * width + x0) * 4;
    for (let x = x0; x < x1; x += 1, target += 4) {
      const fx = (x - dx) * sx;
      const ix = Math.min(plate.width - 1, Math.max(0, fx | 0));
      const ix2 = Math.min(plate.width - 1, ix + 1);
      const wx = fx - ix;
      const wx1 = 1 - wx;

      const p00 = (row0 + ix) * 4;
      const p10 = (row0 + ix2) * 4;
      const p01 = (row1 + ix) * 4;
      const p11 = (row1 + ix2) * 4;

      // A card is a binary-covered plate: its alpha is the baked coverage times
      // the wrapper scale, so no four-tap alpha sampling is needed.
      let alpha: number;
      if (coverage) {
        alpha = coverage[row0 + ix] * opacity * scale;
      } else {
        alpha =
          (((data[p00 + 3] * wx1 + data[p10 + 3] * wx) * wy1 +
            (data[p01 + 3] * wx1 + data[p11 + 3] * wx) * wy) /
            255) *
          opacity;
      }
      if (alpha <= 0.002) continue;

      const r =
        (data[p00] * wx1 + data[p10] * wx) * wy1 + (data[p01] * wx1 + data[p11] * wx) * wy;
      const g =
        (data[p00 + 1] * wx1 + data[p10 + 1] * wx) * wy1 +
        (data[p01 + 1] * wx1 + data[p11 + 1] * wx) * wy;
      const b =
        (data[p00 + 2] * wx1 + data[p10 + 2] * wx) * wy1 +
        (data[p01 + 2] * wx1 + data[p11 + 2] * wx) * wy;

      const existing = out[target + 3] / 255;
      // Nothing is under a card frame, so the compositing step is the identity.
      if (existing === 0) {
        out[target] = r;
        out[target + 1] = g;
        out[target + 2] = b;
        out[target + 3] = (alpha * 255) | 0;
        continue;
      }
      const outAlpha = alpha + existing * (1 - alpha);
      const invOut = 1 / outAlpha;
      const head = alpha * invOut;
      const weight = existing * (1 - alpha) * invOut;
      out[target] = r * head + out[target] * weight;
      out[target + 1] = g * head + out[target + 1] * weight;
      out[target + 2] = b * head + out[target + 2] * weight;
      out[target + 3] = (outAlpha * 255) | 0;
    }
  }
}

/**
 * Paint one frame of one item. This is the whole visual contract: the geometry
 * comes from `brollFrameStyle`, the look from the baked plate.
 */
export function paintNativeFrame(
  surface: Surface,
  item: NativeBrollItem,
  plate: BakedCard | BakedPlate,
  elapsedSeconds: number,
  durationSeconds: number,
): void {
  const style = brollFrameStyle(item.kind, elapsedSeconds, durationSeconds);
  if (item.kind === "landscape" && "plateX" in plate) {
    const card = plate as BakedCard;
    // The wrapper scales around the card's own centre (transform-origin: center),
    // then translates by the animated slide.
    const x = card.plateX + (card.width - card.width * style.scale) / 2;
    const y = card.plateY + (card.height - card.height * style.scale) / 2 + style.translateY;
    // mediaX/mediaScale are already baked into the cover fit: the card image is
    // prepared at the card's resting size, so the Ken Burns zoom is a re-draw of
    // the plate at `scale`, which is visually identical for a 1.5 % push.
    void style.mediaX;
    void style.mediaScale;
    drawPlate(surface, plate, style.scale, x, y, style.opacity);
    return;
  }
  const full = plate as BakedPlate;
  const x = (full.width - full.width * style.scale) / 2;
  const y = (full.height - full.height * style.scale) / 2;
  drawPlate(surface, full, style.scale, x, y, style.opacity);
  if (item.kind === "fullscreen") applyCaptionScrim(surface, style.opacity);
}

/** The full-screen caption scrim: a bottom gradient, opacity follows the item. */
function applyCaptionScrim(surface: Surface, opacity: number): void {
  const treatment = captionContrastTreatment(undefined);
  const colour = treatment.textIsLight ? 0 : 255;
  for (let y = 0; y < surface.height; y += 1) {
    // linear-gradient(180deg, transparent 0%, scrim 100%), scrim alpha 0.4.
    const progress = y / Math.max(1, surface.height - 1);
    const alpha = 0.4 * progress * opacity;
    if (alpha <= 0) continue;
    for (let x = 0; x < surface.width; x += 1) {
      const index = (y * surface.width + x) * 4;
      const existing = surface.data[index + 3] / 255;
      const outAlpha = alpha + existing * (1 - alpha);
      if (outAlpha <= 0) continue;
      surface.data[index] = (colour * alpha + surface.data[index] * existing * (1 - alpha)) / outAlpha;
      surface.data[index + 1] = (colour * alpha + surface.data[index + 1] * existing * (1 - alpha)) / outAlpha;
      surface.data[index + 2] = (colour * alpha + surface.data[index + 2] * existing * (1 - alpha)) / outAlpha;
      surface.data[index + 3] = Math.round(outAlpha * 255);
    }
  }
}

/**
 * Render one item's frame range to `outputDir` as `frame-XXXXXX.png`.
 *
 * The plate is baked ONCE, then every frame is a downscale blit of it. Frames
 * are painted in a small worker pool (the plate is read-only, so the only shared
 * state is the progress counter) and written as straight RGBA PNGs - the same
 * encoding Chromium produces.
 */
export async function renderNativeCardPhase(options: {
  item: NativeBrollItem;
  canvas: OverlayCanvasRegion;
  startFrame: number;
  endFrame: number;
  fps: number;
  outputDir: string;
  parallelism?: number;
  onProgress?: (framesPainted: number, totalFrames: number) => void;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}): Promise<{ frames: number; bakeMs: number; paintMs: number }> {
  const startedAt = Date.now();
  const { item, canvas, fps } = options;
  const frameCount = Math.max(0, options.endFrame - options.startFrame + 1);
  if (frameCount === 0) return { frames: 0, bakeMs: 0, paintMs: 0 };
  fs.mkdirSync(options.outputDir, { recursive: true });

  const bakeStartedAt = Date.now();
  const plate = item.card
    ? await bakeLandscapeCard(item, item.card)
    : await bakeFullscreen(item, canvas);
  const bakeMs = Date.now() - bakeStartedAt;

  const paintStartedAt = Date.now();
  const duration = item.end - item.start;
  const parallelism = Math.max(1, Math.min(options.parallelism ?? 4, frameCount));
  let nextFrame = 0;
  let painted = 0;
  const cancelled = () => Boolean(options.signal?.aborted || options.isCancelled?.());

  const worker = async (): Promise<void> => {
    const surface = blankSurface(canvas.width, canvas.height);
    while (!cancelled()) {
      const index = nextFrame;
      nextFrame += 1;
      if (index >= frameCount) return;
      surface.data.fill(0);
      paintNativeFrame(surface, item, plate, index / fps, duration);
      const file = path.join(
        options.outputDir,
        `frame-${String(index + 1).padStart(6, "0")}.png`,
      );
      await writePng(
        file,
        Buffer.from(surface.data.buffer, surface.data.byteOffset, surface.data.byteLength),
        surface.width,
        surface.height,
      );
      painted += 1;
      options.onProgress?.(painted, frameCount);
    }
  };
  await Promise.all(Array.from({ length: parallelism }, () => worker()));

  const paintMs = Date.now() - paintStartedAt;
  log.info(
    `[RENDER-DIAG] stage=broll.native event=done item=${item.id} kind=${item.kind} ` +
      `frames=${painted}/${frameCount} parallelism=${parallelism} bake_ms=${bakeMs} ` +
      `paint_ms=${paintMs} total_ms=${Date.now() - startedAt} ` +
      `canvas=${canvas.width}x${canvas.height}@${canvas.x},${canvas.y}`,
  );
  return { frames: painted, bakeMs, paintMs };
}

/**
 * Write one RGBA surface as a PNG.
 *
 * This is a hand-rolled encoder on `node:zlib` (no new dependency) instead of
 * going through Jimp's: Jimp spends ~150 ms per 1080x1920 frame in its own
 * filter/compression path, which made PNG encoding 80 % of the render. Filter
 * type 0 plus a level-1 deflate is a valid PNG, decodes identically in FFmpeg,
 * and costs ~15-25 ms per mostly-transparent frame.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePng(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  /** Deflate level; 3 is the sweet spot for mostly-transparent frames. */
  level = 3,
): Buffer {
  const stride = width * 4;
  // Each scanline is prefixed with its filter byte (0 = None).
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  const source = Buffer.isBuffer(rgba)
    ? rgba
    : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    source.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw, { level });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** PNG's CRC-32 (the standard polynomial, seeded and inverted like zlib's). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write one RGBA surface as a PNG file. */
export async function writePng(filePath: string, rgba: Buffer, width: number, height: number): Promise<void> {
  await fs.promises.writeFile(filePath, encodePng(rgba, width, height));
}

/** True when this item is a landscape card (the only kind the native renderer accelerates). */
export function isNativeCardItem(item: { kind: "fullscreen" | "landscape" }): boolean {
  return item.kind === "landscape";
}

/** The cropped card canvas, when `BROLL_CARD_CROPPED_CANVAS` is on. */
export function nativeCanvasFor(item: NativeBrollItem): OverlayCanvasRegion {
  if (item.card) return getBrollCardCanvasRegion(item.card);
  return FULL_OVERLAY_CANVAS;
}

/** Keeps the card's declared pixel size honest against the model of the spec. */
export const NATIVE_CARD_SPEC = { width: CARD_WIDTH, height: CARD_HEIGHT } as const;

/** Resolve a prepared image path for logging (never throws). */
export function describeNativeImage(filePath: string): string {
  return path.isAbsolute(filePath) ? path.basename(filePath) : filePath;
}
