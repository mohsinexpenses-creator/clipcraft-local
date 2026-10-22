import { createHash } from "node:crypto";
import type { BrollAttribution, BrollProviderId } from "../../types";

/**
 * One image as a provider returned it - before any download, crop or verdict.
 * The plan stores only what survives all three, plus this metadata.
 */
export interface BrollCandidate {
  provider: BrollProviderId;
  providerId: string;
  pageUrl: string;
  /** Direct image URL that is downloaded and cached. */
  imageUrl: string;
  /** Smaller version (~512 px) used for the Gemini Vision check. */
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  title?: string;
  description?: string;
  categories?: string[];
  author?: string;
  license?: string;
  licenseUrl?: string;
  /** Unsplash only: must be pinged when the photo is actually used. */
  downloadLocation?: string;
}

/** The brief's floor: nothing smaller is worth a full-screen 9:16 frame. */
export const MIN_IMAGE_WIDTH = 1080;
export const MIN_IMAGE_HEIGHT = 1280;

/** Formats Remotion/Chromium can paint; SVG/TIFF/PDF are explicitly rejected. */
export const ACCEPTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isUsableImage(candidate: {
  width: number;
  height: number;
  mime?: string;
}): boolean {
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return false;
  if (candidate.width <= 0 || candidate.height <= 0) return false;
  if (candidate.mime && !ACCEPTED_IMAGE_MIME.has(candidate.mime.toLowerCase())) return false;
  return candidate.width >= MIN_IMAGE_WIDTH || candidate.height >= MIN_IMAGE_HEIGHT;
}

/** Public attribution record stored on the plan item. */
export function attributionFor(candidate: BrollCandidate): BrollAttribution {
  return {
    provider: candidate.provider,
    sourceUrl: candidate.pageUrl,
    imageUrl: candidate.imageUrl,
    providerId: candidate.providerId,
    ...(candidate.author ? { author: candidate.author } : {}),
    ...(candidate.license ? { license: candidate.license } : {}),
    ...(candidate.licenseUrl ? { licenseUrl: candidate.licenseUrl } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
  };
}

/** Commons metadata is HTML ("<a href=...>Jane Doe</a>", "<i>CC BY-SA 4.0</i>"). */
export function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** Commons `extmetadata` wraps every value in `{ value, source }`. */
export function extMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const entry = metadata?.[key];
  if (!entry || typeof entry !== "object") return undefined;
  const value = (entry as { value?: unknown }).value;
  if (typeof value === "string") return stripHtml(value);
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Deterministic, filesystem-safe cache identity for an image URL. */
export function cacheKeyFor(url: string, prefix = ""): string {
  // sha1 keeps imports simple (node:crypto) and the key short enough for a file name.
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 24);
  return prefix ? `${prefix}-${hash}` : hash;
}

