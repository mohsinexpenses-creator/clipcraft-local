import type { BrollSearchCandidate, BrollSubjectKind } from './types';

export const WIKIMEDIA_COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';

export const WIKIMEDIA_USER_AGENT =
  'ClipCraftLocal/0.1 (https://github.com/mohsinexpenses-creator/clipcraft-local; local-broll-cache)';

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
  /\bplaceholder\b/i,
  /\bbarcode\b/i,
  /\bqr[\s_-]*code\b/i,
  /\.(svg|pdf|djvu|tif|tiff|gif|ogg|ogv|webm|mp3|wav|flac|xcf)$/i,
];

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'with',
  'from', 'portrait', 'photo', 'photograph', 'image', 'picture',
]);

export const MIN_IMAGE_WIDTH = 360;
export const MIN_IMAGE_HEIGHT = 360;
export const MIN_RELEVANCE_SCORE = 18;
export const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB ceiling

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

function titleexplicitlyRequestsBlockedTerm(query: string, title: string): boolean {
  const qLower = query.toLowerCase();
  if (qLower.includes('logo') && /\blogo\b/i.test(title)) return true;
  if (qLower.includes('map') && /\bmap\b/i.test(title)) return true;
  if (qLower.includes('flag') && /\bflag\b/i.test(title)) return true;
  return false;
}

/**
 * Score a candidate's contextual relevance + portrait/social-video suitability.
 * Returns `0` when the candidate has no meaningful lexical relevance to `query`.
 */
export function scoreCandidateRelevance(options: {
  title: string;
  description?: string;
  mimeType: string;
  width: number;
  height: number;
  query: string;
  subjectKind?: BrollSubjectKind;
}): number {
  const { title, description, mimeType, width, height, query, subjectKind } = options;
  const queryTokens = significantQueryTokens(query);
  if (queryTokens.length === 0) return 0;

  const titleLower = title.replace(/[_-]+/g, ' ').toLowerCase();
  const descLower = (description ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  const combined = `${titleLower} ${descLower}`;

  // Exact core phrase check
  const corePhrase = queryTokens.join(' ');
  const normalizedHaystack = combined.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const exactInTitle = titleLower.replace(/[^\p{L}\p{N}]+/gu, ' ').includes(corePhrase);
  const exactInDesc = !exactInTitle && normalizedHaystack.includes(corePhrase);

  let matchedTokens = 0;
  let titleMatchedTokens = 0;
  for (const tok of queryTokens) {
    const wordBoundary = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const inTitle = wordBoundary.test(titleLower);
    const inDesc = wordBoundary.test(descLower);
    if (inTitle || inDesc) matchedTokens += 1;
    if (inTitle) titleMatchedTokens += 1;
  }

  // Strict relevance gate: never return unrelated images just to fill slots.
  if (matchedTokens === 0) return 0;
  const tokenCoverage = matchedTokens / queryTokens.length;
  if (queryTokens.length >= 2 && tokenCoverage < 0.5) return 0;

  let score = tokenCoverage * 40 + (titleMatchedTokens / queryTokens.length) * 18;
  if (exactInTitle) score += 26;
  else if (exactInDesc) score += 14;

  // Portrait orientation bonus (9:16 social video target), calibrated so portrait wins
  // among comparably relevant candidates while a much more relevant landscape photo wins!
  const aspect = width / Math.max(1, height);
  if (aspect <= 0.85 && aspect >= 0.42) {
    score += 12; // Natural portrait (e.g. 9:16, 2:3, 3:4)
  } else if (aspect > 0.85 && aspect <= 1.12) {
    score += 7; // Square / 4:5 vertical social frame
  } else if (aspect > 1.12 && aspect <= 1.85) {
    score += 3; // Standard 3:2 / 16:9 event or landmark photograph
  } else {
    score -= 6; // Very wide panorama crops poorly to 9:16
  }

  // Photographic format & resolution signals
  if (mimeType === 'image/jpeg') score += 5;
  else if (mimeType === 'image/webp') score += 3;

  const minSide = Math.min(width, height);
  if (minSide >= 900) score += 6;
  else if (minSide >= 640) score += 3;

  // Mildly penalize non-scene words unless queried (e.g. "plaque", "document", "letter", "grave")
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

interface RawWikimediaPage {
  pageid?: number;
  title?: string;
  index?: number;
  imageinfo?: RawImageInfo[];
}

interface RawWikimediaResponse {
  query?: {
    pages?: RawWikimediaPage[] | Record<string, RawWikimediaPage>;
  };
}

/**
 * Parse, validate, score, and deduplicate raw Wikimedia Commons API `imageinfo` results.
 * Pure function — directly testable with fixture payloads and used identically in production.
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
    const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : undefined;
    if (!rawTitle || !info) continue;

    const normalizedTitleForFilter = rawTitle.replace(/[_-]+/g, ' ');
    if (
      BLOCKED_TITLE_PATTERNS.some((pattern) => pattern.test(normalizedTitleForFilter)) &&
      !titleexplicitlyRequestsBlockedTerm(query, normalizedTitleForFilter)
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

    // Prefer CDN-scaled thumbnail when the original DSLR upload is huge (> 1440px or > maxBytes)
    const preferThumb =
      Boolean(thumbUrlRaw) &&
      (width > 1440 || (Number.isFinite(originalByteSize) && originalByteSize > maxBytes));
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
    iiurlwidth: '1440',
  });
  return `${WIKIMEDIA_COMMONS_API_URL}?${params.toString()}`;
}

/**
 * Query the free, keyless Wikimedia Commons API for relevant photographic images.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetchFn(buildWikimediaSearchUrl(trimmed, options.limit ?? 12), {
      method: 'GET',
      headers: {
        'user-agent': WIKIMEDIA_USER_AGENT,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    return parseAndValidateWikimediaResults(data, trimmed, {
      subjectKind: options.subjectKind,
      maxImageBytes: options.maxImageBytes,
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
