import { log } from '../logger';
import { toErrorMessage } from '../errors';
import type { BrollSearchCandidate, BrollSubjectKind } from './types';

export const WIKIMEDIA_COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
export const WIKIPEDIA_ENGLISH_API_URL = 'https://en.wikipedia.org/w/api.php';

/**
 * Official Wikimedia Foundation standard pre-cached thumbnail step (`T360589`):
 * valid steps are `20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840`.
 * Non-standard widths like `1440` trigger deterministic HTTP 429 on `upload.wikimedia.org`.
 */
export const WMF_STANDARD_THUMB_WIDTH = 960;

export const WIKIMEDIA_USER_AGENT =
  'ClipCraftLocal/1.0 (https://github.com/mohsinexpenses-creator/clipcraft-local; local-broll-cache) node-fetch';

/** Supported raster image formats suitable for fast local FFmpeg rendering. */
export const ALLOWED_BROLL_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Explicitly forbidden private / scraped social domains. */
const FORBIDDEN_HOST_SUFFIXES = [
  'instagram.com',
  'cdninstagram.com',
  'facebook.com',
  'fbcdn.net',
  'pinterest.com',
  'pinimg.com',
  'tiktokcdn.com',
];

const BLOCKED_TITLE_PATTERNS = [
  /\bsignature\b/i,
  /\bautograph\b/i,
  /\bcoat[\s_-]+of[\s_-]+arms\b/i,
  /\bseal[\s_-]+of\b/i,
  /\blogo\b/i,
  /\bwordmark\b/i,
  /\bicon\b/i,
  /\bdiagram\b/i,
  /\bflowchart\b/i,
  /\bblank[\s_-]+map\b/i,
  /\blocator[\s_-]+map\b/i,
  /\borthographic\b/i,
  /\bplaceholder\b/i,
  /\bno[\s_-]+image\b/i,
  /\bquestion[\s_-]+book\b/i,
  /\bcommons[\s_-]+emblem\b/i,
  /\bwikimedia[\s_-]+logo\b/i,
  /\bdisambig/i,
  /\bbarcode\b/i,
  /\bqr[\s_-]*code\b/i,
  /\.(svg|pdf|djvu|tif|tiff|gif|ogg|ogv|webm|mp3|wav|flac|xcf)$/i,
];

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'with',
  'from', 'portrait', 'photo', 'photograph', 'image', 'picture',
]);

export const MIN_IMAGE_WIDTH = 320;
export const MIN_IMAGE_HEIGHT = 320;
export const MIN_RELEVANCE_SCORE = 16;
export const DEFAULT_MAX_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB stream safety ceiling

export type FetchLike = typeof fetch;

/**
 * Normalize an image URL for deterministic deduplication and safety validation.
 * Returns `null` if the URL is invalid, non-HTTP(S), local-file, or from a restricted host.
 */
export function normalizeImageUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  if (
    FORBIDDEN_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return null;
  }

  // Canonicalize Wikimedia HTTP links to HTTPS.
  if (parsed.protocol === 'http:' && (host.endsWith('.wikimedia.org') || host.endsWith('.wikipedia.org'))) {
    parsed.protocol = 'https:';
  }
  parsed.hash = '';
  for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid']) {
    parsed.searchParams.delete(param);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

/**
 * Convert any Wikimedia Commons original or `/thumb/` image URL to a canonical
 * standard-step thumbnail URL (`960` or `1280`) on `upload.wikimedia.org`.
 */
export function buildStandardWikimediaThumbUrl(
  rawUrl: string,
  stepWidth: 500 | 960 | 1280 = 960,
): string | null {
  const normalized = normalizeImageUrl(rawUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== 'upload.wikimedia.org') {
      return null;
    }

    // Case 1: Already a `/thumb/.../<N>px-<filename>` URL -> rewrite step prefix directly
    const thumbMatch = parsed.pathname.match(/^(.*\/thumb\/.+)\/\d+px-([^/]+)$/);
    if (thumbMatch) {
      parsed.pathname = `${thumbMatch[1]}/${stepWidth}px-${thumbMatch[2]}`;
      return parsed.toString();
    }

    // Case 2: Original `/wikipedia/commons/<a/ab/Filename.ext>` -> construct `/thumb/...`
    const origMatch = parsed.pathname.match(/^\/wikipedia\/(commons|en)\/([0-9a-f]\/[0-9a-f]{2}\/([^/]+))$/i);
    if (origMatch) {
      const [, wiki, restPath, fileName] = origMatch;
      parsed.pathname = `/wikipedia/${wiki}/thumb/${restPath}/${stepWidth}px-${fileName}`;
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Normalize a Wikimedia file title or URL filename so differently-sized thumbnails
 * of the same photograph (e.g. `800px-Elon_Musk.jpg` vs `1280px-Elon_Musk.jpg`)
 * collapse to one canonical identity.
 */
export function canonicalizeMediaStem(titleOrUrl: string): string {
  const base = titleOrUrl
    .replace(/^File:/i, '')
    .split('/')
    .pop() ?? titleOrUrl;
  return decodeURIComponent(base)
    .replace(/^\d+px-/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Strip HTML markup and common entities from Wikimedia `extmetadata` fields. */
export function cleanCommonsMetadataText(raw: unknown, maxLength = 240): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const stripped = raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&copy;/gi, '(c)')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return undefined;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1).trim()}…` : stripped;
}

function significantQueryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok.length >= 2 && !QUERY_STOPWORDS.has(tok));
}

function titleExplicitlyRequestsBlockedTerm(query: string, title: string): boolean {
  const qLower = query.toLowerCase();
  if (qLower.includes('logo') && /\blogo\b/i.test(title)) return true;
  if (qLower.includes('map') && /\bmap\b/i.test(title)) return true;
  if (qLower.includes('flag') && /\bflag\b/i.test(title)) return true;
  return false;
}

function inferMimeFromUrlOrName(urlOrName: string): BrollSearchCandidate['mimeType'] | null {
  const clean = urlOrName.split('?')[0].toLowerCase();
  if (/\.(svg|pdf|djvu|tif|tiff|gif|ogg|ogv|webm|xcf)(\b|$)/i.test(clean)) {
    return null;
  }
  if (/\.(jpe?g)$/i.test(clean)) return 'image/jpeg';
  if (/\.png$/i.test(clean)) return 'image/png';
  if (/\.webp$/i.test(clean)) return 'image/webp';
  return null;
}

/**
 * Score a candidate's contextual relevance + portrait/social-video suitability.
 * Returns `0` when the candidate has no meaningful relevance to `query`.
 */
export function scoreCandidateRelevance(options: {
  title: string;
  description?: string;
  mimeType: string;
  width: number;
  height: number;
  query: string;
  subjectKind?: BrollSubjectKind;
  wikipediaRank?: number;
}): number {
  const { title, description, mimeType, width, height, query, subjectKind, wikipediaRank } = options;
  const queryTokens = significantQueryTokens(query);
  if (queryTokens.length === 0) return 0;

  const titleLower = title.replace(/[_-]+/g, ' ').toLowerCase();
  const descLower = (description ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  const combined = `${titleLower} ${descLower}`;

  const corePhrase = queryTokens.join(' ');
  const normalizedHaystack = combined.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const exactInTitle = titleLower.replace(/[^\p{L}\p{N}]+/gu, ' ').includes(corePhrase);
  const exactInDesc = !exactInTitle && normalizedHaystack.includes(corePhrase);

  let matchedTokens = 0;
  let titleMatchedTokens = 0;
  for (const tok of queryTokens) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Support singular/plural stem match (e.g. "rockets" <-> "rocket", "smartphones" <-> "smartphone")
    const stem = tok.length >= 5 && tok.endsWith('s') ? escaped.slice(0, -1) : escaped;
    const prefixRegex = new RegExp(`\\b${stem}`, 'i');
    const inTitle = prefixRegex.test(titleLower);
    const inDesc = prefixRegex.test(descLower);
    if (inTitle || inDesc) matchedTokens += 1;
    if (inTitle) titleMatchedTokens += 1;
  }

  // Top-ranked Wikipedia search redirects/synonyms (rank 1..2) are encyclopedia topic matches
  // even when redirected (e.g. "AI" -> "Artificial intelligence", "NYC" -> "New York City")
  const isTopWikipediaRedirect = typeof wikipediaRank === 'number' && wikipediaRank <= 2;

  if (matchedTokens === 0 && !isTopWikipediaRedirect) return 0;
  const tokenCoverage = matchedTokens / queryTokens.length;
  if (!isTopWikipediaRedirect && queryTokens.length >= 2 && tokenCoverage < 0.45) {
    return 0;
  }

  let score = isTopWikipediaRedirect && matchedTokens === 0
    ? 44
    : tokenCoverage * 40 + (titleMatchedTokens / queryTokens.length) * 18;
  if (exactInTitle) score += 26;
  else if (exactInDesc) score += 14;
  if (typeof wikipediaRank === 'number') {
    score += Math.max(0, 14 - (wikipediaRank - 1) * 3);
  }

  // Portrait orientation bonus (9:16 social video target)
  const aspect = width / Math.max(1, height);
  if (aspect <= 0.85 && aspect >= 0.42) {
    score += 12;
  } else if (aspect > 0.85 && aspect <= 1.12) {
    score += 7;
  } else if (aspect > 1.12 && aspect <= 1.85) {
    score += 3;
  } else {
    score -= 6;
  }

  if (mimeType === 'image/jpeg') score += 5;
  else if (mimeType === 'image/webp') score += 3;

  const minSide = Math.min(width, height);
  if (minSide >= 900) score += 6;
  else if (minSide >= 640) score += 3;

  if (!/plaque|grave|tomb|document|letter|newspaper|map/i.test(query)) {
    if (/\b(plaque|tombstone|gravestone|document|manuscript|page\s+\d+|table|chart|map)\b/i.test(combined)) {
      score -= 18;
    }
  }

  if (subjectKind === 'person' && /\b(cropped|portrait|headshot|speaking|press|premiere|award)\b/i.test(combined)) {
    score += 4;
  }

  return Math.max(0, Math.round(score * 10) / 10);
}

interface RawExtMetadataEntry {
  value?: unknown;
}

interface RawImageInfo {
  url?: unknown;
  thumburl?: unknown;
  descriptionurl?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  size?: unknown;
  sha1?: unknown;
  extmetadata?: Record<string, RawExtMetadataEntry | undefined>;
}

interface RawPageImageSide {
  source?: unknown;
  width?: unknown;
  height?: unknown;
}

interface RawWikimediaPage {
  pageid?: number;
  title?: string;
  index?: number;
  description?: string;
  pageimage?: string;
  thumbnail?: RawPageImageSide;
  original?: RawPageImageSide;
  imageinfo?: RawImageInfo[];
}

interface RawWikimediaResponse {
  query?: {
    pages?: RawWikimediaPage[] | Record<string, RawWikimediaPage>;
  };
}

/**
 * Parse, validate, score, and deduplicate raw responses from EITHER:
 * - Wikimedia Commons `prop=imageinfo` API (`page.imageinfo[...]`), OR
 * - English Wikipedia `prop=pageimages` API (`page.thumbnail` / `page.original`).
 */
export function parseAndValidateWikimediaResults(
  payload: unknown,
  query: string,
  options: {
    subjectKind?: BrollSubjectKind;
    maxImageBytes?: number;
    minRelevanceScore?: number;
  } = {},
): BrollSearchCandidate[] {
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const minScore = options.minRelevanceScore ?? MIN_RELEVANCE_SCORE;
  if (!payload || typeof payload !== 'object') return [];

  const rawPages = (payload as RawWikimediaResponse).query?.pages;
  if (!rawPages) return [];
  const pageList: RawWikimediaPage[] = Array.isArray(rawPages)
    ? rawPages
    : Object.values(rawPages);

  const candidates: BrollSearchCandidate[] = [];

  for (const page of pageList) {
    const rawTitle = typeof page?.title === 'string' ? page.title.trim() : '';
    if (!rawTitle) continue;

    // Branch A: Standard Wikimedia Commons `imageinfo` payload
    const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : undefined;
    if (info) {
      const normalizedTitleForFilter = rawTitle.replace(/[_-]+/g, ' ');
      if (
        BLOCKED_TITLE_PATTERNS.some((pattern) => pattern.test(normalizedTitleForFilter)) &&
        !titleExplicitlyRequestsBlockedTerm(query, normalizedTitleForFilter)
      ) {
        continue;
      }

      const mime = typeof info.mime === 'string' ? info.mime.trim().toLowerCase() : '';
      if (!ALLOWED_BROLL_MIME_TYPES.has(mime)) continue;

      const width = Number(info.width);
      const height = Number(info.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) continue;

      const aspect = width / height;
      if (aspect < 0.2 || aspect > 3.2) continue;

      const originalUrlRaw = typeof info.url === 'string' ? info.url.trim() : '';
      const thumbUrlRaw = typeof info.thumburl === 'string' ? info.thumburl.trim() : '';
      const originalByteSize = Number(info.size);

      // Prefer pre-scaled thumbnail whenever original exceeds 1080px or maxBytes
      const preferThumb =
        Boolean(thumbUrlRaw) &&
        (width > 1080 || (Number.isFinite(originalByteSize) && originalByteSize > maxBytes));
      const chosenRawUrl = preferThumb ? thumbUrlRaw : originalUrlRaw || thumbUrlRaw;

      if (
        !preferThumb &&
        Number.isFinite(originalByteSize) &&
        originalByteSize > maxBytes
      ) {
        continue;
      }

      const normalizedUrl = normalizeImageUrl(chosenRawUrl);
      const normalizedOriginal = normalizeImageUrl(originalUrlRaw || chosenRawUrl);
      if (!normalizedUrl || !normalizedOriginal) continue;

      const pageUrl =
        typeof info.descriptionurl === 'string'
          ? normalizeImageUrl(info.descriptionurl) ?? undefined
          : undefined;

      const cleanTitle = rawTitle
        .replace(/^File:/i, '')
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/_/g, ' ')
        .trim();

      const ext = info.extmetadata ?? {};
      const artist = cleanCommonsMetadataText(ext.Artist?.value, 160);
      const credit = cleanCommonsMetadataText(ext.Credit?.value, 160);
      const attribution = artist || credit;
      const licenseShort = cleanCommonsMetadataText(ext.LicenseShortName?.value, 80);
      const usageTerms = cleanCommonsMetadataText(ext.UsageTerms?.value, 80);
      const license = licenseShort || usageTerms;
      const description =
        cleanCommonsMetadataText(ext.ImageDescription?.value, 240) ||
        cleanCommonsMetadataText(ext.ObjectName?.value, 240);

      const relevanceScore = scoreCandidateRelevance({
        title: cleanTitle,
        description,
        mimeType: mime,
        width,
        height,
        query,
        subjectKind: options.subjectKind,
      });
      if (relevanceScore < minScore) continue;

      const sha1 =
        typeof info.sha1 === 'string' && /^[a-f0-9]{20,64}$/i.test(info.sha1.trim())
          ? info.sha1.trim().toLowerCase()
          : undefined;

      candidates.push({
        normalizedUrl,
        sourceUrl: normalizedUrl,
        originalUrl: normalizedOriginal,
        ...(pageUrl ? { pageUrl } : {}),
        title: cleanTitle,
        canonicalStem: canonicalizeMediaStem(rawTitle),
        mimeType: mime as BrollSearchCandidate['mimeType'],
        width: Math.round(width),
        height: Math.round(height),
        ...(Number.isFinite(originalByteSize) && originalByteSize > 0
          ? { byteSize: Math.round(originalByteSize) }
          : {}),
        ...(sha1 ? { sha1 } : {}),
        ...(attribution ? { attribution } : {}),
        ...(license ? { license } : {}),
        ...(description ? { description } : {}),
        relevanceScore,
      });
      continue;
    }

    // Branch B: English Wikipedia `pageimages` payload (human-curated lead encyclopedia photo)
    const origSide = page.original;
    const thumbSide = page.thumbnail;
    if (!origSide && !thumbSide) continue;

    const pageImageName = typeof page.pageimage === 'string' ? page.pageimage.trim() : '';
    const origSrc = typeof origSide?.source === 'string' ? origSide.source.trim() : '';
    const thumbSrc = typeof thumbSide?.source === 'string' ? thumbSide.source.trim() : '';

    const combinedNameCheck = `${rawTitle} ${pageImageName}`.replace(/[_-]+/g, ' ');
    if (
      BLOCKED_TITLE_PATTERNS.some((pattern) => pattern.test(combinedNameCheck)) &&
      !titleExplicitlyRequestsBlockedTerm(query, combinedNameCheck)
    ) {
      continue;
    }

    const mime =
      inferMimeFromUrlOrName(origSrc) ||
      inferMimeFromUrlOrName(pageImageName) ||
      inferMimeFromUrlOrName(thumbSrc);
    if (!mime || !ALLOWED_BROLL_MIME_TYPES.has(mime)) continue;

    const width = Number(origSide?.width) || Number(thumbSide?.width);
    const height = Number(origSide?.height) || Number(thumbSide?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) continue;

    const aspect = width / height;
    if (aspect < 0.2 || aspect > 3.2) continue;

    const chosenUrl = normalizeImageUrl(thumbSrc || origSrc);
    const fullOriginalUrl = normalizeImageUrl(origSrc || thumbSrc);
    if (!chosenUrl || !fullOriginalUrl) continue;

    const description = cleanCommonsMetadataText(page.description, 240);
    const combinedTitle = pageImageName
      ? `${rawTitle} (${pageImageName.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ')})`
      : rawTitle;

    const relevanceScore = scoreCandidateRelevance({
      title: combinedTitle,
      description,
      mimeType: mime,
      width,
      height,
      query,
      subjectKind: options.subjectKind,
      wikipediaRank: typeof page.index === 'number' ? page.index : undefined,
    });
    if (relevanceScore < minScore) continue;

    candidates.push({
      normalizedUrl: chosenUrl,
      sourceUrl: chosenUrl,
      originalUrl: fullOriginalUrl,
      pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(rawTitle.replace(/\s+/g, '_'))}`,
      title: rawTitle,
      canonicalStem: canonicalizeMediaStem(pageImageName || chosenUrl),
      mimeType: mime,
      width: Math.round(width),
      height: Math.round(height),
      attribution: 'Wikimedia Commons / Wikipedia',
      license: 'Free media (Wikimedia Commons)',
      ...(description ? { description } : {}),
      relevanceScore,
    });
  }

  return deduplicateSearchCandidates(candidates);
}

/**
 * Deduplicate candidates by normalized URL, SHA-1 digest, and canonical file stem,
 * retaining the highest-scoring candidate in every equivalence class.
 */
export function deduplicateSearchCandidates(
  candidates: BrollSearchCandidate[],
): BrollSearchCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const seenStems = new Set<string>();
  const unique: BrollSearchCandidate[] = [];

  for (const item of sorted) {
    if (seenUrls.has(item.normalizedUrl)) continue;
    if (item.sha1 && seenHashes.has(item.sha1)) continue;
    if (item.canonicalStem && seenStems.has(item.canonicalStem)) continue;

    seenUrls.add(item.normalizedUrl);
    if (item.sha1) seenHashes.add(item.sha1);
    if (item.canonicalStem) seenStems.add(item.canonicalStem);
    unique.push(item);
  }

  return unique;
}

export function buildWikimediaSearchUrl(query: string, limit = 12): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${query.trim()} filetype:bitmap`,
    gsrlimit: String(Math.max(1, Math.min(25, Math.floor(limit)))),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|sha1',
    iiurlwidth: String(WMF_STANDARD_THUMB_WIDTH),
  });
  return `${WIKIMEDIA_COMMONS_API_URL}?${params.toString()}`;
}

export function buildWikipediaPageImagesUrl(query: string, limit = 8): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    generator: 'search',
    gsrnamespace: '0',
    gsrsearch: query.trim(),
    gsrlimit: String(Math.max(1, Math.min(20, Math.floor(limit)))),
    prop: 'pageimages|description',
    piprop: 'thumbnail|original|name',
    pilicense: 'free',
    pithumbsize: String(WMF_STANDARD_THUMB_WIDTH),
  });
  return `${WIKIPEDIA_ENGLISH_API_URL}?${params.toString()}`;
}

async function fetchMediaWikiJson(
  url: string,
  fetchFn: FetchLike,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (externalSignal?.aborted) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          'user-agent': WIKIMEDIA_USER_AGENT,
          'api-user-agent': WIKIMEDIA_USER_AGENT,
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if ((response.status === 429 || response.status === 503) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 450));
        continue;
      }

      if (!response.ok) {
        log.warn(`B-roll API HTTP ${response.status} on ${new URL(url).hostname}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      if (attempt === 0 && !externalSignal?.aborted) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      log.warn(`B-roll API request failed (${new URL(url).hostname}): ${toErrorMessage(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
  return null;
}

/**
 * Query free, keyless Wikimedia Commons (`imageinfo`) + English Wikipedia (`pageimages`)
 * APIs for relevant free photographic images using standard pre-cached `960px` steps.
 */
export async function searchWikimediaCommons(
  query: string,
  options: {
    subjectKind?: BrollSubjectKind;
    limit?: number;
    timeoutMs?: number;
    maxImageBytes?: number;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  } = {},
): Promise<BrollSearchCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  // Stage 1: Wikimedia Commons direct photographic file search (`iiurlwidth=960`)
  const commonsJson = await fetchMediaWikiJson(
    buildWikimediaSearchUrl(trimmed, options.limit ?? 12),
    fetchFn,
    timeoutMs,
    options.signal,
  );
  const commonsCandidates = commonsJson
    ? parseAndValidateWikimediaResults(commonsJson, trimmed, {
        subjectKind: options.subjectKind,
        maxImageBytes: options.maxImageBytes,
      })
    : [];

  // Fast exit when Commons already returned strong direct photographic matches
  const topCommonsScore = commonsCandidates[0]?.relevanceScore ?? 0;
  if (commonsCandidates.length >= 1 && topCommonsScore >= 52) {
    return commonsCandidates;
  }

  // Stage 2: English Wikipedia `pageimages` search (`pilicense=free`, `pithumbsize=960`)
  // Handles everyday concepts, redirects, nicknames, brands, and topics cleanly!
  const wikiJson = await fetchMediaWikiJson(
    buildWikipediaPageImagesUrl(trimmed, 8),
    fetchFn,
    timeoutMs,
    options.signal,
  );
  const wikiCandidates = wikiJson
    ? parseAndValidateWikimediaResults(wikiJson, trimmed, {
        subjectKind: options.subjectKind,
        maxImageBytes: options.maxImageBytes,
      })
    : [];

  return deduplicateSearchCandidates([...wikiCandidates, ...commonsCandidates]);
}
