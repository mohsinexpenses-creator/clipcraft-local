/**
 * Stock photo search for landscape cards: Pexels, Pixabay, Unsplash.
 *
 * All three are asked for a LANDSCAPE photo (the card is 16:9) and every result
 * is re-checked locally - an API's idea of "landscape" includes near-square
 * images, and a card needs a wide picture.
 *
 * Failure policy: a missing key skips the provider, 429/quota moves to the next
 * provider in the configured order, and a rejected key (401/403) is only ever
 * reported as a key problem. Nothing here throws past the chain - a card is
 * optional, so the plan records a note and continues.
 */

import { AppError } from "../../errors";
import type { BrollProviderId } from "../../types";
import type { BrollFetch } from "../http";
import { ProviderKeyError, ProviderQuotaError, fetchJson } from "../http";
import type { BrollCandidate } from "./types";
import { isUsableImage } from "./types";

/** Minimum width/height ratio for a card: wider than 5:4. */
export const MIN_LANDSCAPE_ASPECT = 1.25;

export const STOCK_ENDPOINTS = {
  pexels: "https://api.pexels.com/v1/search",
  pixabay: "https://pixabay.com/api/",
  unsplash: "https://api.unsplash.com/search/photos",
} as const;

export interface StockKeys {
  pexels?: string;
  pixabay?: string;
  unsplash?: string;
}

export interface StockSearchOptions {
  fetcher: BrollFetch;
  limit?: number;
  timeoutMs?: number;
}

function isLandscape(width: number, height: number): boolean {
  return height > 0 && width / height >= MIN_LANDSCAPE_ASPECT;
}

/** Keep a stable order and drop duplicates by direct URL. */
function dedupe(candidates: BrollCandidate[], limit: number): BrollCandidate[] {
  const seen = new Set<string>();
  const kept: BrollCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.imageUrl)) continue;
    seen.add(candidate.imageUrl);
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept;
}

/* ------------------------------- Pexels ---------------------------------- */

interface PexelsPhoto {
  id?: number;
  width?: number;
  height?: number;
  url?: string;
  photographer?: string;
  alt?: string;
  src?: Record<string, string>;
}

export function buildPexelsUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    per_page: String(limit),
  });
  return `${STOCK_ENDPOINTS.pexels}?${params.toString()}`;
}

export function parsePexelsResponse(payload: unknown): BrollCandidate[] {
  const photos = (payload as { photos?: PexelsPhoto[] } | null)?.photos;
  if (!Array.isArray(photos)) return [];
  const candidates: BrollCandidate[] = [];
  for (const photo of photos) {
    const src = photo.src ?? {};
    const imageUrl = src.large2x ?? src.large ?? src.original;
    const width = photo.width ?? 0;
    const height = photo.height ?? 0;
    if (!imageUrl || !isLandscape(width, height)) continue;
    if (!isUsableImage({ width, height, mime: "image/jpeg" })) continue;
    candidates.push({
      provider: "pexels",
      providerId: String(photo.id ?? imageUrl),
      pageUrl: photo.url ?? imageUrl,
      imageUrl,
      thumbUrl: src.medium ?? src.large ?? imageUrl,
      width,
      height,
      mime: "image/jpeg",
      title: photo.alt,
      author: photo.photographer,
      license: "Pexels License",
      licenseUrl: "https://www.pexels.com/license/",
    });
  }
  return candidates;
}

export async function searchPexels(
  query: string,
  key: string,
  options: StockSearchOptions
): Promise<BrollCandidate[]> {
  const payload = await fetchJson(buildPexelsUrl(query, options.limit ?? 8), {
    fetcher: options.fetcher,
    provider: "Pexels",
    timeoutMs: options.timeoutMs,
    headers: { Authorization: key },
  });
  return dedupe(parsePexelsResponse(payload), options.limit ?? 8);
}

/* ------------------------------- Pixabay ---------------------------------- */

interface PixabayHit {
  id?: number;
  pageURL?: string;
  tags?: string;
  previewURL?: string;
  webformatURL?: string;
  largeImageURL?: string;
  imageWidth?: number;
  imageHeight?: number;
  user?: string;
}

export function buildPixabayUrl(query: string, key: string, limit: number): string {
  const params = new URLSearchParams({
    key,
    q: query,
    image_type: "photo",
    orientation: "horizontal",
    safesearch: "true",
    per_page: String(Math.max(3, limit)),
  });
  return `${STOCK_ENDPOINTS.pixabay}?${params.toString()}`;
}

export function parsePixabayResponse(payload: unknown): BrollCandidate[] {
  const hits = (payload as { hits?: PixabayHit[] } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const candidates: BrollCandidate[] = [];
  for (const hit of hits) {
    const imageUrl = hit.largeImageURL ?? hit.webformatURL;
    const width = hit.imageWidth ?? 0;
    const height = hit.imageHeight ?? 0;
    if (!imageUrl || !isLandscape(width, height)) continue;
    if (!isUsableImage({ width, height, mime: "image/jpeg" })) continue;
    const tags = (hit.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    candidates.push({
      provider: "pixabay",
      providerId: String(hit.id ?? imageUrl),
      pageUrl: hit.pageURL ?? imageUrl,
      imageUrl,
      thumbUrl: hit.webformatURL ?? imageUrl,
      width,
      height,
      mime: "image/jpeg",
      title: tags.slice(0, 4).join(", ") || undefined,
      author: hit.user,
      license: "Pixabay Content License",
      licenseUrl: "https://pixabay.com/service/license-summary/",
    });
  }
  return candidates;
}

export async function searchPixabay(
  query: string,
  key: string,
  options: StockSearchOptions
): Promise<BrollCandidate[]> {
  const payload = await fetchJson(buildPixabayUrl(query, key, options.limit ?? 8), {
    fetcher: options.fetcher,
    provider: "Pixabay",
    timeoutMs: options.timeoutMs,
  });
  return dedupe(parsePixabayResponse(payload), options.limit ?? 8);
}

/* ------------------------------ Unsplash ---------------------------------- */

interface UnsplashPhoto {
  id?: string;
  width?: number;
  height?: number;
  description?: string;
  alt_description?: string;
  urls?: Record<string, string>;
  links?: { html?: string; download_location?: string };
  user?: { name?: string; links?: { html?: string } };
}

export function buildUnsplashUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    per_page: String(Math.max(3, limit)),
  });
  return `${STOCK_ENDPOINTS.unsplash}?${params.toString()}`;
}

export function parseUnsplashResponse(payload: unknown): BrollCandidate[] {
  const results = (payload as { results?: UnsplashPhoto[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const candidates: BrollCandidate[] = [];
  for (const photo of results) {
    const urls = photo.urls ?? {};
    const imageUrl = urls.regular ?? urls.full ?? urls.raw;
    const width = photo.width ?? 0;
    const height = photo.height ?? 0;
    if (!imageUrl || !isLandscape(width, height)) continue;
    if (!isUsableImage({ width, height, mime: "image/jpeg" })) continue;
    candidates.push({
      provider: "unsplash",
      providerId: photo.id ?? imageUrl,
      pageUrl: photo.links?.html ?? imageUrl,
      imageUrl,
      thumbUrl: urls.small ?? urls.regular ?? imageUrl,
      width,
      height,
      mime: "image/jpeg",
      title: photo.description ?? photo.alt_description,
      author: photo.user?.name,
      license: "Unsplash License",
      licenseUrl: "https://unsplash.com/license",
      ...(photo.links?.download_location ? { downloadLocation: photo.links.download_location } : {}),
    });
  }
  return candidates;
}

export async function searchUnsplash(
  query: string,
  key: string,
  options: StockSearchOptions
): Promise<BrollCandidate[]> {
  const payload = await fetchJson(buildUnsplashUrl(query, options.limit ?? 8), {
    fetcher: options.fetcher,
    provider: "Unsplash",
    timeoutMs: options.timeoutMs,
    headers: { Authorization: `Client-ID ${key}` },
  });
  return dedupe(parseUnsplashResponse(payload), options.limit ?? 8);
}

/**
 * Unsplash's API terms require pinging the photo's `download_location` when the
 * image is actually used. Failure is logged and ignored - a missing ping must
 * not lose an otherwise good card.
 */
export async function trackUnsplashDownload(
  candidate: BrollCandidate,
  key: string,
  options: { fetcher: BrollFetch; timeoutMs?: number }
): Promise<boolean> {
  if (candidate.provider !== "unsplash" || !candidate.downloadLocation) return false;
  try {
    await fetchJson(candidate.downloadLocation, {
      fetcher: options.fetcher,
      provider: "Unsplash",
      timeoutMs: options.timeoutMs,
      headers: { Authorization: `Client-ID ${key}` },
    });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- Provider chain ------------------------------- */

export interface StockSearchResult {
  candidates: BrollCandidate[];
  provider?: BrollProviderId;
  /** Human-readable reasons providers were skipped (shown in the plan notes). */
  notes: string[];
}

export const PROVIDER_LABELS: Record<Exclude<BrollProviderId, "wikimedia">, string> = {
  pexels: "Pexels",
  pixabay: "Pixabay",
  unsplash: "Unsplash",
};

/**
 * Try each provider in the configured order and stop at the first one that
 * returns usable landscape photos. Quota, missing keys and provider errors fall
 * through; the caller gets an empty candidate list only when all of them fail.
 */
export async function searchStockAcrossProviders(
  query: string,
  options: StockSearchOptions & { providerOrder: BrollProviderId[]; keys: StockKeys }
): Promise<StockSearchResult> {
  const notes: string[] = [];
  const order = options.providerOrder.filter(
    (provider): provider is Exclude<BrollProviderId, "wikimedia"> => provider !== "wikimedia"
  );

  for (const provider of order) {
    const key = options.keys[provider]?.trim();
    if (!key) {
      notes.push(`${PROVIDER_LABELS[provider]}: no API key configured`);
      continue;
    }
    try {
      const candidates =
        provider === "pexels"
          ? await searchPexels(query, key, options)
          : provider === "pixabay"
            ? await searchPixabay(query, key, options)
            : await searchUnsplash(query, key, options);
      if (candidates.length > 0) return { candidates, provider, notes };
      notes.push(`${PROVIDER_LABELS[provider]}: no usable landscape result`);
    } catch (error) {
      // Quota/key/network problems move on to the next provider. Any other AppError
      // is a provider bug we still want to survive, so it also just becomes a note.
      if (error instanceof ProviderQuotaError || error instanceof ProviderKeyError || error instanceof AppError) {
        notes.push(`${PROVIDER_LABELS[provider]}: ${error.summary}`);
      } else {
        notes.push(`${PROVIDER_LABELS[provider]}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { candidates: [], notes };
}
