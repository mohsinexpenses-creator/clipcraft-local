/**
 * Turning one downloaded photo into the frames B-roll can show:
 *
 *   full-screen 1080x1920 (9:16) - cropped around a detected face, or shown whole
 *   on a blurred fill when a landscape photo has no face. Never stretched and never
 *   padded with bars.
 *   card 960x540 (16:9) - a uniform centre crop for the rounded landscape frame.
 *
 * jimp only (already a dependency of the face-crop pipeline); no native image
 * library is added.
 */

import { Jimp } from "jimp";
import {
  BROLL_OUTPUT_HEIGHT,
  BROLL_OUTPUT_WIDTH,
  CARD_IMAGE_HEIGHT,
  CARD_IMAGE_WIDTH,
  planFullscreenCrop,
  planLandscapeCrop,
  type FaceRect,
} from "./crop";
import { VISION_IMAGE_SIZE } from "./vision";
import { writeBrollImage } from "./cache";
import type { BrollCropPlan, BrollEntityType } from "../types";

export const FULLSCREEN_JPEG_QUALITY = 88;
export const CARD_JPEG_QUALITY = 88;

/**
 * The subset of jimp's API used here, structurally typed. jimp's own generic
 * instance type depends on which formats are plugged in, and those generics leak
 * into every signature otherwise.
 */
export interface JimpImage {
  bitmap: { width: number; height: number; data: Buffer | Uint8Array };
  clone(): JimpImage;
  crop(options: { x: number; y: number; w: number; h: number }): JimpImage;
  cover(options: { w: number; h: number }): JimpImage;
  resize(options: { w: number; h: number }): JimpImage;
  blur(radius: number): JimpImage;
  composite(image: JimpImage, x: number, y: number): JimpImage;
  getBuffer(mime: "image/jpeg", options?: { quality?: number }): Promise<Buffer>;
}

/** A corrupt/truncated download must fail here, not inside a render. */
export class UnreadableImageError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnreadableImageError";
  }
}

export async function readImage(bytes: Buffer): Promise<JimpImage> {
  try {
    return (await Jimp.read(bytes)) as unknown as JimpImage;
  } catch (error) {
    throw new UnreadableImageError(
      `The downloaded file is not a readable image (${error instanceof Error ? error.message : String(error)}).`
    );
  }
}

async function detectFace(image: JimpImage): Promise<FaceRect | null> {
  try {
    const { loadYuNet, detectFacesYunet } = await import("../../worker/yunet-detector");
    const runtime = await loadYuNet();
    if (!runtime) return null;
    const faces = await detectFacesYunet(runtime, {
      data: Buffer.from(image.bitmap.data),
      width: image.bitmap.width,
      height: image.bitmap.height,
    });
    const best = faces.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
    return best ? { x: best.box.x, y: best.box.y, width: best.box.width, height: best.box.height } : null;
  } catch (error) {
    // Face detection is best-effort: the crop still works without it.
    console.warn(
      `[broll] Face detection skipped: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function blurredBackdrop(image: JimpImage, width: number, height: number): JimpImage {
  // A heavily blurred, slightly zoomed copy: it fills the frame with the photo's own
  // colours so a landscape image is not reduced to a narrow vertical slice.
  return image.clone().cover({ w: width, h: height }).blur(28);
}

export interface PreparedFullscreen {
  buffer: Buffer;
  crop: BrollCropPlan;
}

/**
 * Render-ready full-screen JPEG + the crop plan that produced it (stored on the
 * plan so the UI can show how the image was framed).
 */
export async function prepareFullscreen(
  bytes: Buffer,
  options: { entityType?: BrollEntityType; face?: FaceRect | null; quality?: number } = {}
): Promise<PreparedFullscreen> {
  const image = await readImage(bytes);
  const face = options.face === undefined ? await detectFace(image) : options.face;
  const crop = planFullscreenCrop({
    sourceWidth: image.bitmap.width,
    sourceHeight: image.bitmap.height,
    face,
    entityType: options.entityType,
  });

  let rendered: JimpImage;
  if (crop.mode === "blur-fill") {
    const canvas = new Jimp({
      width: BROLL_OUTPUT_WIDTH,
      height: BROLL_OUTPUT_HEIGHT,
    }) as unknown as JimpImage;
    canvas.composite(blurredBackdrop(image, BROLL_OUTPUT_WIDTH, BROLL_OUTPUT_HEIGHT), 0, 0);
    canvas.composite(image.clone().cover({ w: BROLL_OUTPUT_WIDTH, h: BROLL_OUTPUT_HEIGHT }), 0, 0);
    rendered = canvas;
  } else {
    rendered = image
      .clone()
      .crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height })
      .cover({ w: BROLL_OUTPUT_WIDTH, h: BROLL_OUTPUT_HEIGHT });
  }

  const buffer = await rendered.getBuffer("image/jpeg", {
    quality: options.quality ?? FULLSCREEN_JPEG_QUALITY,
  });
  return { buffer: Buffer.from(buffer), crop };
}

/** The 16:9 card image. */
export async function prepareCard(bytes: Buffer, quality = CARD_JPEG_QUALITY): Promise<Buffer> {
  const image = await readImage(bytes);
  const crop = planLandscapeCrop(image.bitmap.width, image.bitmap.height);
  const rendered = image
    .clone()
    .crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height })
    .cover({ w: CARD_IMAGE_WIDTH, h: CARD_IMAGE_HEIGHT });
  const buffer = await rendered.getBuffer("image/jpeg", { quality });
  return Buffer.from(buffer);
}

export interface VisionThumbnail {
  data: string;
  mime: string;
}

/**
 * ~512 px longest edge, base64 - what Gemini sees. Sending the full 1080 px image
 * costs more tokens without improving the verdict.
 */
export async function makeVisionThumbnail(
  bytes: Buffer,
  size = VISION_IMAGE_SIZE
): Promise<VisionThumbnail> {
  const image = await readImage(bytes);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const scale = Math.min(1, size / Math.max(width, height));
  const resized =
    scale < 1
      ? image.clone().resize({ w: Math.round(width * scale), h: Math.round(height * scale) })
      : image.clone();
  const buffer = await resized.getBuffer("image/jpeg", { quality: 80 });
  return { data: Buffer.from(buffer).toString("base64"), mime: "image/jpeg" };
}

export interface PreparedBrollFile {
  cacheKey: string;
  /** Prepared JPEG's file name in the B-roll cache dir. */
  renderFile: string;
  crop?: BrollCropPlan;
}

function shortKey(cacheKey: string): string {
  return cacheKey.split("-").pop() ?? cacheKey;
}

/** Prepare + persist the full-screen frame: `fs-<hash>.jpg`. */
export async function prepareFullscreenFile(
  bytes: Buffer,
  options: { cacheKey: string; entityType?: BrollEntityType; face?: FaceRect | null; root?: string }
): Promise<PreparedBrollFile> {
  const prepared = await prepareFullscreen(bytes, {
    entityType: options.entityType,
    face: options.face,
  });
  const renderFile = await writeBrollImage(`fs-${shortKey(options.cacheKey)}.jpg`, prepared.buffer, options.root);
  return { cacheKey: options.cacheKey, renderFile, crop: prepared.crop };
}

/** Prepare + persist the 16:9 card image: `card-<hash>.jpg`. */
export async function prepareCardFile(
  bytes: Buffer,
  options: { cacheKey: string; root?: string }
): Promise<PreparedBrollFile> {
  const buffer = await prepareCard(bytes);
  const renderFile = await writeBrollImage(`card-${shortKey(options.cacheKey)}.jpg`, buffer, options.root);
  return { cacheKey: options.cacheKey, renderFile };
}
