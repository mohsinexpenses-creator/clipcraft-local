/**
 * Wikimedia Commons search for full-screen entity images.
 *
 * Entity B-roll must be the *actual* thing (Elon Musk, the Eiffel Tower, the
 * Olympics) - a stock lookalike is never substituted, so Commons is the only
 * provider used for entities and it needs no API key.
 *
 * API notes that matter:
 *  - `generator=search` + `gsrnamespace=6` searches the File namespace;
 *  - `iiurlwidth=1080` makes the API return a `thumburl` at a useful size;
 *  - `extmetadata` carries Artist / LicenseShortName / LicenseUrl, which the
 *    attribution requirement makes mandatory;
 *  - a descriptive User-Agent is required by the Wikimedia API etiquette.
 */

import type { BrollFetch } from "../http";
import { fetchJson } from "../http";
import type { BrollCandidate } from "./types";
import { extMetadataValue, isUsableImage, stripHtml } from "./types";

export const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";

/** Requested render size; the API returns a thumbnail at most this wide. */
export const COMMONS_THUMB_WIDTH = 1080;

export interface CommonsSearchOptions {
  fetcher: BrollFetch;
  /** Results to ask the API for (default 10). */
  limit?: number;
  timeoutMs?: number;
}

interface CommonsPage {
  pageid?: number;
  title?: string;
  imageinfo?: Array<{
    url?: string;
    descriptionurl?: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width?: number;
    height?: number;
    mime?: string;
    extmetadata?: Record<string, unknown>;
  }>;
}

export function buildCommonsSearchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(COMMONS_THUMB_WIDTH),
  });
  return `${COMMONS_API_URL}?${params.toString()}`;
}

/**
 * Parse the API payload. `formatversion=2` returns an array, but the v1 object
 * shape (`query.pages` keyed by page id) is accepted too because cached JSON from
 * an older request may still be on disk.
 */
export function parseCommonsResponse(payload: unknown): BrollCandidate[] {
  const root = payload as { query?: { pages?: unknown } } | null;
  const pagesRaw = root?.query?.pages;
  const pages: CommonsPage[] = Array.isArray(pagesRaw)
    ? (pagesRaw as CommonsPage[])
    : pagesRaw && typeof pagesRaw === "object"
      ? Object.values(pagesRaw as Record<string, CommonsPage>)
      : [];

  const candidates: BrollCandidate[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const mime = info.mime ?? "";
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    if (!isUsableImage({ width, height, mime })) continue;

    const metadata = info.extmetadata;
    const author = extMetadataValue(metadata, "Artist") ?? extMetadataValue(metadata, "Credit");
    const license = extMetadataValue(metadata, "LicenseShortName");
    const licenseUrl = extMetadataValue(metadata, "LicenseUrl");
    const description = extMetadataValue(metadata, "ImageDescription");
    const categories = (extMetadataValue(metadata, "Categories") ?? "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);

    candidates.push({
      provider: "wikimedia",
      providerId: String(page.pageid ?? info.descriptionurl ?? info.url),
      pageUrl: info.descriptionurl ?? info.url,
      imageUrl: info.url,
      // The 1080 thumb is what gets downloaded when the original is huge; the
      // vision pass downscales it with jimp.
      thumbUrl: info.thumburl ?? info.url,
      width: info.thumbwidth && info.thumbwidth > width ? info.thumbwidth : width,
      height: info.thumbheight && info.thumbheight > height ? info.thumbheight : height,
      mime: mime || "image/jpeg",
      title: stripHtml(page.title?.replace(/^File:/, "")),
      description,
      categories,
      ...(author ? { author } : {}),
      ...(license ? { license } : {}),
      ...(licenseUrl ? { licenseUrl } : {}),
    });
  }
  return candidates;
}

/**
 * Search Commons. Results are ordered by relevance (the generator's search
 * ranking), with portrait-ish images first because they fill a 9:16 frame with
 * less cropping - the caller still verifies them with Gemini.
 */
export async function searchCommons(
  query: string,
  options: CommonsSearchOptions
): Promise<BrollCandidate[]> {
  const limit = options.limit ?? 10;
  const payload = await fetchJson(buildCommonsSearchUrl(query, limit), {
    fetcher: options.fetcher,
    provider: "Wikimedia Commons",
    timeoutMs: options.timeoutMs,
  });
  return rankCommonsCandidates(parseCommonsResponse(payload));
}

export function rankCommonsCandidates(candidates: BrollCandidate[]): BrollCandidate[] {
  const score = (candidate: BrollCandidate): number => {
    const aspect = candidate.width / Math.max(1, candidate.height);
    // 0.75 (3:4 portrait) is ideal; very wide or very tall images rank last.
    const portraitBonus = aspect <= 1 ? 1 : Math.max(0, 0.6 - (aspect - 1));
    return portraitBonus;
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}
