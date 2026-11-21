import { createHash } from "node:crypto";
import type { BrollAttribution, BrollProviderId } from "../../types";

/**
 * One image as a provider returned it - before any download or crop.
 * The plan stores only what survives all three, plus this metadata.
 */
export interface BrollCandidate {
  provider: BrollProviderId;
  providerId: string;
  pageUrl: string;
  /** Direct image URL that is downloaded and cached. */
  imageUrl: string;
  /** Smaller version used when a provider exposes one. */
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

/** MediaWiki file metadata can contain HTML links and formatting. */
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

/** MediaWiki `extmetadata` wraps every value in `{ value, source }`. */
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


/* ------------------------------------------------------------------ */
/* Phase 4c: choosing WHICH returned photo actually illustrates a word  */
/* ------------------------------------------------------------------ */

/** A card needs a real photograph, not a 320 px thumbnail blown up to 756 px. */
export const MIN_CARD_WIDTH = 960;
export const MIN_CARD_HEIGHT = 540;

/** Tokens that say nothing about the picture ("a photo of the sunset"). */
const CHOICE_STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the",
  "to", "with", "photo", "picture", "image", "stock", "photograph", "shoot",
  "closeup", "close", "up", "view", "background", "wallpaper", "concept",
]);

/**
 * Rank a provider's candidates against the keyword we searched for.
 *
 * Providers return whatever fits the search string, including 600 px test
 * images, text-heavy posters and several near-identical frames of the same
 * scene. The score rewards the words of the keyword appearing in the photo's
 * own title/tags, and the caller rejects anything without overlap at all.
 */
export function candidateChoiceScore(
  candidate: BrollCandidate,
  keyword: string,
): { score: number; overlap: number; tokens: string[] } {
  const tokens = keyword
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !CHOICE_STOPWORDS.has(token));
  if (tokens.length === 0) return { score: 0, overlap: 0, tokens };

  const haystack = [candidate.title, candidate.description, ...(candidate.categories ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ");
  const words = new Set(haystack.split(/\s+/).filter(Boolean));
  const overlap = tokens.filter((token) => words.has(token)).length;

  // A landscape source wider than the card is a bonus; a portrait-ish source is
  // wrong for this slot even when the provider called it landscape.
  const aspect = candidate.height > 0 ? candidate.width / candidate.height : 0;
  const aspectBonus = aspect >= 1.5 ? 0.2 : 0;
  const sizeBonus = candidate.width >= 1600 ? 0.1 : 0;
  return {
    score: overlap / tokens.length + aspectBonus + sizeBonus,
    overlap: overlap / tokens.length,
    tokens,
  };
}

/** Reject a photo that cannot be a card at all (too small, wrong shape). */
export function isUsableCardImage(candidate: BrollCandidate): boolean {
  if (!isUsableImage(candidate)) return false;
  if (candidate.height <= 0) return false;
  if (candidate.width / candidate.height < 1.25) return false;
  return candidate.width >= MIN_CARD_WIDTH && candidate.height >= MIN_CARD_HEIGHT;
}

/** Titles that say "poster", "chart" or "text" are almost always text-heavy. */
const TEXT_HEAVY = /\b(poster|chart|graph|diagram|screenshot|map|document|sign|text|flyer|logo|banner|infographic)\b/i;

export function looksTextHeavy(candidate: BrollCandidate): boolean {
  const haystack = [candidate.title, candidate.description, ...(candidate.categories ?? [])]
    .filter(Boolean)
    .join(" ");
  return TEXT_HEAVY.test(haystack);
}
