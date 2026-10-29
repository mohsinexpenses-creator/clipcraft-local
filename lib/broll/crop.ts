/**
 * Crop maths for B-roll images - pure, no image decoding.
 *
 * Two shapes exist:
 *  - full-screen: a 9:16 frame. A person is centred on the detected face; a
 *    landscape place/event is NOT sliced down to a thin vertical strip (that
 *    throws away the scene), it is shown whole on a blurred copy of itself.
 *  - landscape card: a 16:9 centre crop for the rounded card.
 *
 * No stretch, ever: the only scale factors are crops, `cover` (uniform) and a
 * blurred backdrop behind a uniformly-fitted image.
 */

import type { BrollCropPlan, BrollEntityType } from "../types";

/** The composition canvas. */
export const BROLL_OUTPUT_WIDTH = 1080;
export const BROLL_OUTPUT_HEIGHT = 1920;

/** Landscape card image size inside its rounded frame (16:9). */
export const CARD_IMAGE_WIDTH = 960;
export const CARD_IMAGE_HEIGHT = 540;

export interface FaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FullscreenCropInput {
  sourceWidth: number;
  sourceHeight: number;
  /** Detector box in SOURCE pixels, when a face was found. */
  face?: FaceRect | null;
  /** What the mention was: a person is always face-cropped. */
  entityType?: BrollEntityType;
  outputWidth?: number;
  outputHeight?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** Even width/height (encoders reject odd sizes). */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Even offsets may legitimately be 0 (full-frame images, centred crops). */
function evenOffset(value: number): number {
  return Math.max(0, Math.round(value / 2) * 2);
}

function safeCropRect(input: {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  const sourceWidth = Math.max(1, Math.round(input.sourceWidth));
  const sourceHeight = Math.max(1, Math.round(input.sourceHeight));
  const width = clamp(Math.round(input.width), 1, sourceWidth);
  const height = clamp(Math.round(input.height), 1, sourceHeight);
  const x = clamp(Math.round(input.x), 0, Math.max(0, sourceWidth - width));
  const y = clamp(Math.round(input.y), 0, Math.max(0, sourceHeight - height));
  return {
    x: evenOffset(x),
    y: evenOffset(y),
    width: even(width),
    height: even(height),
  };
}

/**
 * The 9:16 window. With a face: crop around it, placing the face centre ~38% from
 * the top (head room above, shoulders below - the same framing the speaker crop
 * uses). Without a face: a landscape photo keeps its whole width on a blurred
 * backdrop, while a portrait/square image is centre-cropped.
 */
export function planFullscreenCrop(input: FullscreenCropInput): BrollCropPlan {
  const outputWidth = input.outputWidth ?? BROLL_OUTPUT_WIDTH;
  const outputHeight = input.outputHeight ?? BROLL_OUTPUT_HEIGHT;
  const sourceWidth = Math.max(1, Math.round(input.sourceWidth));
  const sourceHeight = Math.max(1, Math.round(input.sourceHeight));
  const targetAspect = outputWidth / outputHeight;

  const base = {
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
  } as const;

  const face = input.face;
  if (face && face.width > 0 && face.height > 0) {
    const faceCentreX = face.x + face.width / 2;
    const faceCentreY = face.y + face.height / 2;

    // The biggest 9:16 window the image allows, then centred on the face.
    let cropWidth: number;
    let cropHeight: number;
    if (sourceWidth / sourceHeight <= targetAspect) {
      cropWidth = sourceWidth;
      cropHeight = sourceWidth / targetAspect;
    } else {
      cropHeight = sourceHeight;
      cropWidth = sourceHeight * targetAspect;
    }

    // A face that would fill most of the window means the photo is a close-up;
    // back off to the whole frame instead of cropping into the forehead.
    if (face.height > cropHeight * 0.62) {
      cropWidth = sourceWidth;
      cropHeight = sourceHeight;
    }

    const width = even(Math.min(sourceWidth, cropWidth));
    const height = even(Math.min(sourceHeight, cropHeight));
    const x = clamp(faceCentreX - width / 2, 0, Math.max(0, sourceWidth - width));
    const y = clamp(faceCentreY - height * 0.38, 0, Math.max(0, sourceHeight - height));
    const safe = safeCropRect({
      sourceWidth,
      sourceHeight,
      x,
      y,
      width,
      height,
    });
    return {
      mode: "crop",
      ...base,
      x: safe.x,
      y: safe.y,
      width: safe.width,
      height: safe.height,
      faceCentered: true,
    };
  }

  // No face. A wide photo sliced to 9:16 loses ~70% of its width; a person's name
  // is never guessed, so for places/events the honest option is the full image.
  if (sourceWidth / sourceHeight > 1.4) {
    return {
      mode: "blur-fill",
      ...base,
      x: 0,
      y: 0,
      width: sourceWidth,
      height: sourceHeight,
      faceCentered: false,
    };
  }

  // Portrait/square: take the 9:16 window, biased slightly above centre (the
  // subject of a photo is rarely dead centre).
  const width = even(Math.min(sourceWidth, sourceHeight * targetAspect));
  const height = even(Math.min(sourceHeight, sourceWidth / targetAspect));
  const x = clamp((sourceWidth - width) / 2, 0, Math.max(0, sourceWidth - width));
  const y = clamp((sourceHeight - height) * 0.42, 0, Math.max(0, sourceHeight - height));
  const safe = safeCropRect({
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  });
  return {
    mode: "crop",
    ...base,
    x: safe.x,
    y: safe.y,
    width: safe.width,
    height: safe.height,
    faceCentered: false,
  };
}

/** Uniform 16:9 centre crop for the landscape card. */
export function planLandscapeCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = CARD_IMAGE_WIDTH,
  targetHeight = CARD_IMAGE_HEIGHT
): { x: number; y: number; width: number; height: number } {
  const srcW = Math.max(1, Math.round(sourceWidth));
  const srcH = Math.max(1, Math.round(sourceHeight));
  const targetAspect = targetWidth / targetHeight;
  let width: number;
  let height: number;

  if (srcW / srcH >= targetAspect) {
    height = srcH;
    width = even(srcH * targetAspect);
  } else {
    width = srcW;
    height = even(srcW / targetAspect);
  }
  width = Math.min(srcW, width);
  height = Math.min(srcH, height);
  return {
    x: evenOffset(clamp((srcW - width) / 2, 0, srcW - width)),
    y: evenOffset(clamp((srcH - height) / 2, 0, srcH - height)),
    width,
    height,
  };
}

/* -------------------------------------------------------------------------- *
 * Captions over an image: never white-on-white or dark-on-dark
 * -------------------------------------------------------------------------- */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Read `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. Defaults to white. */
export function parseCssColor(value: string | undefined): Rgba {
  const fallback: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  if (!value) return fallback;
  const text = value.trim().toLowerCase();

  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(text);
  if (rgb) {
    return {
      r: clamp(Number(rgb[1]), 0, 255),
      g: clamp(Number(rgb[2]), 0, 255),
      b: clamp(Number(rgb[3]), 0, 255),
      a: rgb[4] === undefined ? 1 : clamp(Number(rgb[4]), 0, 1),
    };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const raw = hex[1];
    const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);
    if (raw.length === 3 || raw.length === 4) {
      return {
        r: expand(raw[0]),
        g: expand(raw[1]),
        b: expand(raw[2]),
        a: raw.length === 4 ? expand(raw[3]) / 255 : 1,
      };
    }
    if (raw.length === 6 || raw.length === 8) {
      return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
        a: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  return fallback;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * The B-roll layer's legibility treatment for whichever caption preset is in use:
 * a dark scrim + a dark pill behind light text, and a light scrim + a light pill
 * behind dark text. The scrim is only ever painted while a full-screen image is
 * visible, so preset looks elsewhere are untouched.
 */
export function captionContrastTreatment(textColor: string | undefined): {
  textIsLight: boolean;
  scrimColor: string;
  pillColor: string;
} {
  const luminance = relativeLuminance(parseCssColor(textColor));
  const textIsLight = luminance >= 0.45;
  return textIsLight
    ? { textIsLight, scrimColor: "rgba(0,0,0,0.82)", pillColor: "rgba(0,0,0,0.46)" }
    : { textIsLight, scrimColor: "rgba(255,255,255,0.82)", pillColor: "rgba(255,255,255,0.66)" };
}
