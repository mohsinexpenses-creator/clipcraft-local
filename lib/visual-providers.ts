import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import {
  ClipVisualOverlay,
  DEFAULT_AI_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  RenderDefaults,
  VisualAssetAttribution,
  VisualLicenseCode,
  VisualProviderName,
} from './types';
import { isUsableSecret } from './app-settings';
import { tokenizeContentWords, tokenizeWords } from './contextual-visuals';
import { getDatabase } from './db';

export const MAX_IMAGE_DOWNLOAD_BYTES = 12 * 1024 * 1024; // 12 MB
export const DEFAULT_VISUAL_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const DEFAULT_VISUAL_SEARCH_TTL_DAYS = 21; // 14-30 day window
export const MIN_IMAGE_DIMENSION = 200;
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 25_000_000;

export interface RawProviderCandidate {
  provider: VisualProviderName;
  assetId: string;
  title: string;
  description: string;
  alt: string;
  tags: string[];
  creator: string;
  creatorUrl?: string;
  licenseRaw: string;
  licenseVersion?: string;
  licenseUrl?: string;
  attributionRaw?: string;
  nonFree?: boolean;
  mature?: boolean;
  sourcePageUrl: string;
  imageUrl: string;
  width: number;
  height: number;
  mimeType?: string;
}

export interface EvaluatedLicense {
  allowed: boolean;
  licenseCode?: VisualLicenseCode;
  displayLabel: string;
  requiresAttribution: boolean;
  shareAlike: boolean;
  preferenceBonus: number;
  reason?: string;
}

export interface ScoredCandidate {
  candidate: RawProviderCandidate;
  license: EvaluatedLicense;
  accepted: boolean;
  score: number;
  framing: 'illustrative' | 'editorial';
  reason?: string;
}

export interface ProviderRateLimitState {
  provider: VisualProviderName;
  limit: number | null;
  remaining: number | null;
  resetAtEpochSeconds: number | null;
  backoffUntilMs: number;
  requestsCount: number;
  cacheHits: number;
  rateLimitedCount: number;
  lastStatus: number | null;
  lastError?: string;
}

const providerStates: Record<VisualProviderName, ProviderRateLimitState> = {
  pexels: {
    provider: 'pexels',
    limit: null,
    remaining: null,
    resetAtEpochSeconds: null,
    backoffUntilMs: 0,
    requestsCount: 0,
    cacheHits: 0,
    rateLimitedCount: 0,
    lastStatus: null,
  },
  openverse: {
    provider: 'openverse',
    limit: null,
    remaining: null,
    resetAtEpochSeconds: null,
    backoffUntilMs: 0,
    requestsCount: 0,
    cacheHits: 0,
    rateLimitedCount: 0,
    lastStatus: null,
  },
  wikimedia: {
    provider: 'wikimedia',
    limit: null,
    remaining: null,
    resetAtEpochSeconds: null,
    backoffUntilMs: 0,
    requestsCount: 0,
    cacheHits: 0,
    rateLimitedCount: 0,
    lastStatus: null,
  },
};

const activeRequestsPerProvider: Record<VisualProviderName, number> = {
  pexels: 0,
  openverse: 0,
  wikimedia: 0,
};

const MAX_CONCURRENCY_PER_PROVIDER: Record<VisualProviderName, number> = {
  pexels: 2,
  openverse: 2,
  wikimedia: 2, // Strictly <= 3 per Wikimedia API policy
};

let openverseTokenCache: {
  clientId: string;
  accessToken: string;
  expiresAtMs: number;
} | null = null;

interface CachedSearchEntry {
  key: string;
  provider: VisualProviderName;
  query: string;
  createdAtMs: number;
  candidates: RawProviderCandidate[];
}

interface CachedDownloadedAsset {
  key: string;
  provider: VisualProviderName;
  assetId: string;
  contentHash: string;
  localFilePath: string;
  mediaUrl: string;
  width: number;
  height: number;
  mimeType: string;
  attribution: VisualAssetAttribution;
  createdAtMs: number;
}

const searchMemoryCache = new Map<string, CachedSearchEntry>();
const assetMemoryCache = new Map<string, CachedDownloadedAsset>();

let visualCacheDirOverride: string | null = null;

export function setVisualCacheDirForTests(dir: string | null): void {
  visualCacheDirOverride = dir;
}

export function getVisualCacheDir(): string {
  if (visualCacheDirOverride) return path.resolve(visualCacheDirOverride);
  const configured = process.env.VISUAL_CACHE_DIR?.trim();
  if (configured) return path.resolve(process.cwd(), configured);
  return path.resolve(process.cwd(), 'data', 'visual-cache');
}

export function clearVisualMemoryCachesOnly(): void {
  searchMemoryCache.clear();
  assetMemoryCache.clear();
}

export function resetVisualProviderStateForTests(): void {
  for (const name of ['pexels', 'openverse', 'wikimedia'] as const) {
    providerStates[name] = {
      provider: name,
      limit: null,
      remaining: null,
      resetAtEpochSeconds: null,
      backoffUntilMs: 0,
      requestsCount: 0,
      cacheHits: 0,
      rateLimitedCount: 0,
      lastStatus: null,
    };
    activeRequestsPerProvider[name] = 0;
  }
  openverseTokenCache = null;
  searchMemoryCache.clear();
  assetMemoryCache.clear();
  try {
    const db = getDatabase();
    db.exec('DELETE FROM visual_search_cache; DELETE FROM image_bank;');
  } catch {
    // Ignore if DB is not initialized in a pure test
  }
}

export function getVisualSearchCacheTtlMs(): number {
  const rawDays = Number(process.env.VISUAL_SEARCH_CACHE_TTL_DAYS?.trim());
  const days = Number.isFinite(rawDays)
    ? Math.max(14, Math.min(30, Math.round(rawDays)))
    : DEFAULT_VISUAL_SEARCH_TTL_DAYS;
  return days * 24 * 3600 * 1000;
}

function readSqliteSearchCache(cacheKey: string): RawProviderCandidate[] | null {
  try {
    const db = getDatabase();
    const now = Date.now();
    const row = db
      .prepare(
        `SELECT results_json FROM visual_search_cache
         WHERE cache_key = ? AND expires_at > ?`
      )
      .get(cacheKey, now) as { results_json: string } | undefined;
    if (!row?.results_json) return null;
    const parsed = JSON.parse(row.results_json);
    return Array.isArray(parsed) ? (parsed as RawProviderCandidate[]) : null;
  } catch {
    return null;
  }
}

function writeSqliteSearchCache(params: {
  cacheKey: string;
  provider: VisualProviderName;
  query: string;
  category?: string;
  orientation?: string;
  candidates: RawProviderCandidate[];
  ttlMs?: number;
}): void {
  try {
    const db = getDatabase();
    const now = Date.now();
    const ttlMs = params.ttlMs ?? getVisualSearchCacheTtlMs();
    db.prepare(
      `INSERT INTO visual_search_cache (
         cache_key, provider, query, category, orientation, results_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         results_json = excluded.results_json,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    ).run(
      params.cacheKey,
      params.provider,
      params.query,
      params.category ?? 'general',
      params.orientation ?? 'any',
      JSON.stringify(params.candidates),
      now,
      now + ttlMs
    );
  } catch {
    // Non-fatal if DB is read-only or unavailable
  }
}

export interface ImageBankRecord {
  id: string;
  provider: VisualProviderName;
  assetId: string;
  localPath: string;
  tags: string[];
  width: number;
  height: number;
  fileSize: number;
  contentHash?: string;
  attribution: VisualAssetAttribution;
  lastUsed: string;
  createdAt: string;
}

export function upsertImageBankEntry(entry: {
  provider: VisualProviderName;
  assetId: string;
  localPath: string;
  tags: string[];
  width: number;
  height: number;
  fileSize: number;
  contentHash?: string;
  attribution: VisualAssetAttribution;
}): void {
  try {
    const db = getDatabase();
    const now = new Date().toISOString();
    const normalizedTags = [...new Set(entry.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))];
    const id = `${entry.provider}:${entry.assetId}`;
    db.prepare(
      `INSERT INTO image_bank (
         id, provider, asset_id, local_path, tags, width, height, file_size,
         content_hash, attribution_json, last_used, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, asset_id) DO UPDATE SET
         local_path = excluded.local_path,
         tags = excluded.tags,
         width = excluded.width,
         height = excluded.height,
         file_size = excluded.file_size,
         content_hash = excluded.content_hash,
         attribution_json = excluded.attribution_json,
         last_used = excluded.last_used`
    ).run(
      id,
      entry.provider,
      entry.assetId,
      entry.localPath,
      JSON.stringify(normalizedTags),
      entry.width,
      entry.height,
      entry.fileSize,
      entry.contentHash ?? null,
      JSON.stringify(entry.attribution),
      now,
      now
    );
  } catch {
    // Best-effort persistence
  }
}

export function findMatchingImageBankEntry(params: {
  moment: Pick<
    ClipVisualOverlay,
    'category' | 'entityName' | 'visualIntent' | 'searchQueries' | 'negativeCues'
  >;
  allowedProviders: VisualProviderName[];
  usedAssetIds: Set<string>;
}): ImageBankRecord | null {
  try {
    if (params.allowedProviders.length === 0) return null;
    const db = getDatabase();
    const placeholders = params.allowedProviders.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM image_bank
         WHERE provider IN (${placeholders})
         ORDER BY last_used DESC
         LIMIT 200`
      )
      .all(...params.allowedProviders) as Array<{
      id: string;
      provider: VisualProviderName;
      asset_id: string;
      local_path: string;
      tags: string;
      width: number;
      height: number;
      file_size: number;
      content_hash: string | null;
      attribution_json: string;
      last_used: string;
      created_at: string;
    }>;

    if (rows.length === 0) return null;

    const entityTokens = tokenizeContentWords(params.moment.entityName || '');
    const queryTokens = new Set<string>([
      ...entityTokens,
      ...params.moment.searchQueries.flatMap((q) => tokenizeContentWords(q)),
      ...tokenizeContentWords(params.moment.visualIntent || ''),
    ]);
    if (queryTokens.size === 0) return null;

    const negativeTokens = new Set<string>(
      params.moment.negativeCues.flatMap((n) => tokenizeWords(n))
    );

    let bestMatch: { record: ImageBankRecord; overlap: number } | null = null;

    for (const row of rows) {
      const assetKey = `${row.provider}:${row.asset_id}`;
      if (params.usedAssetIds.has(assetKey)) continue;
      if (!row.local_path || !fs.existsSync(row.local_path)) continue;

      let parsedTags: string[] = [];
      try {
        const raw = JSON.parse(row.tags);
        if (Array.isArray(raw)) parsedTags = raw.map((t) => String(t).toLowerCase());
      } catch {
        parsedTags = tokenizeWords(row.tags);
      }

      const tagSet = new Set(parsedTags);
      if ([...negativeTokens].some((neg) => tagSet.has(neg))) continue;

      // Named entities must match all entity tokens
      if (entityTokens.length > 0 && !entityTokens.every((t) => tagSet.has(t))) {
        continue;
      }

      let overlap = 0;
      for (const qt of queryTokens) {
        if (tagSet.has(qt)) overlap += 1;
      }

      const minOverlap = entityTokens.length > 0 ? entityTokens.length : Math.min(2, queryTokens.size);
      if (overlap < minOverlap) continue;

      let attribution: VisualAssetAttribution;
      try {
        attribution = JSON.parse(row.attribution_json) as VisualAssetAttribution;
      } catch {
        continue;
      }

      const record: ImageBankRecord = {
        id: row.id,
        provider: row.provider,
        assetId: row.asset_id,
        localPath: row.local_path,
        tags: parsedTags,
        width: row.width,
        height: row.height,
        fileSize: row.file_size,
        ...(row.content_hash ? { contentHash: row.content_hash } : {}),
        attribution,
        lastUsed: row.last_used,
        createdAt: row.created_at,
      };

      if (!bestMatch || overlap > bestMatch.overlap) {
        bestMatch = { record, overlap };
      }
    }

    if (!bestMatch) return null;

    const now = new Date().toISOString();
    db.prepare(`UPDATE image_bank SET last_used = ? WHERE id = ?`).run(now, bestMatch.record.id);
    bestMatch.record.lastUsed = now;
    return bestMatch.record;
  } catch {
    return null;
  }
}

/**
 * Prunes `data/visual-cache` by total size using LRU order (`image_bank.last_used`, falling
 * back to file `mtimeMs`). Default limit is 5 GB.
 */
export function pruneVisualCacheDirectory(
  maxBytes?: number,
  customDir?: string
): { totalBytesBefore: number; totalBytesAfter: number; removedFiles: number } {
  const dir = customDir ? path.resolve(customDir) : getVisualCacheDir();
  if (!fs.existsSync(dir)) {
    return { totalBytesBefore: 0, totalBytesAfter: 0, removedFiles: 0 };
  }

  const configuredGb = Number(process.env.VISUAL_CACHE_MAX_GB?.trim());
  const limitBytes =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0
      ? maxBytes
      : Number.isFinite(configuredGb) && configuredGb > 0
        ? Math.round(configuredGb * 1024 * 1024 * 1024)
        : DEFAULT_VISUAL_CACHE_MAX_BYTES;

  let lastUsedByPath = new Map<string, number>();
  try {
    const db = getDatabase();
    const rows = db
      .prepare(`SELECT local_path, last_used FROM image_bank`)
      .all() as Array<{ local_path: string; last_used: string }>;
    for (const row of rows) {
      const ts = Date.parse(row.last_used);
      if (Number.isFinite(ts)) {
        lastUsedByPath.set(path.resolve(row.local_path), ts);
      }
    }
  } catch {
    lastUsedByPath = new Map();
  }

  const entries: Array<{ fullPath: string; size: number; lastUsedMs: number }> = [];
  let totalBytesBefore = 0;

  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    const fullPath = path.resolve(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      totalBytesBefore += stat.size;
      const lastUsedMs = lastUsedByPath.get(fullPath) ?? stat.mtimeMs;
      entries.push({ fullPath, size: stat.size, lastUsedMs });
    } catch {
      continue;
    }
  }

  if (totalBytesBefore <= limitBytes) {
    return {
      totalBytesBefore,
      totalBytesAfter: totalBytesBefore,
      removedFiles: 0,
    };
  }

  // Sort oldest first (smallest lastUsedMs evicted first)
  entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

  let totalBytesAfter = totalBytesBefore;
  let removedFiles = 0;

  for (const entry of entries) {
    if (totalBytesAfter <= limitBytes) break;
    try {
      fs.unlinkSync(entry.fullPath);
      totalBytesAfter -= entry.size;
      removedFiles += 1;
      try {
        const db = getDatabase();
        db.prepare(`DELETE FROM image_bank WHERE local_path = ?`).run(entry.fullPath);
      } catch {
        // ignore
      }
    } catch {
      continue;
    }
  }

  return {
    totalBytesBefore,
    totalBytesAfter: Math.max(0, totalBytesAfter),
    removedFiles,
  };
}

export function getVisualProviderStates(): Record<VisualProviderName, ProviderRateLimitState> {
  return {
    pexels: { ...providerStates.pexels },
    openverse: { ...providerStates.openverse },
    wikimedia: { ...providerStates.wikimedia },
  };
}

function parseHeaderNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim() !== '') {
      const num = Number(raw.trim());
      if (Number.isFinite(num) && num >= 0) return num;
    }
  }
  return null;
}

export function parseRetryAfterMs(headers: Headers, defaultBackoffMs = 5_000): number {
  const raw = headers.get('retry-after');
  if (!raw || !raw.trim()) return defaultBackoffMs;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.min(300_000, Math.round(seconds * 1_000)));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.max(1_000, Math.min(300_000, delta));
  }
  return defaultBackoffMs;
}

export function updateProviderRateLimitFromResponse(
  provider: VisualProviderName,
  response: Response
): void {
  const state = providerStates[provider];
  state.lastStatus = response.status;

  const limit = parseHeaderNumber(response.headers, [
    'x-ratelimit-limit',
    'ratelimit-limit',
  ]);
  const remaining = parseHeaderNumber(response.headers, [
    'x-ratelimit-remaining',
    'ratelimit-remaining',
  ]);
  const reset = parseHeaderNumber(response.headers, [
    'x-ratelimit-reset',
    'ratelimit-reset',
  ]);

  if (limit !== null) state.limit = limit;
  if (remaining !== null) state.remaining = remaining;
  if (reset !== null) {
    // Some APIs return epoch seconds, others return delta seconds
    state.resetAtEpochSeconds =
      reset > 1_000_000_000 ? Math.round(reset) : Math.round(Date.now() / 1000 + reset);
  }

  if (response.status === 429 || response.status === 503) {
    state.rateLimitedCount += 1;
    const backoffMs = parseRetryAfterMs(
      response.headers,
      provider === 'wikimedia' ? 5_000 : 10_000
    );
    state.backoffUntilMs = Math.max(state.backoffUntilMs, Date.now() + backoffMs);
  } else if (state.remaining === 0 && state.resetAtEpochSeconds !== null) {
    const waitMs = Math.max(1_000, state.resetAtEpochSeconds * 1000 - Date.now());
    state.backoffUntilMs = Math.max(state.backoffUntilMs, Date.now() + Math.min(waitMs, 300_000));
  }
}

export function isProviderCoolingDown(provider: VisualProviderName): boolean {
  const state = providerStates[provider];
  if (Date.now() < state.backoffUntilMs) return true;
  if (
    state.remaining === 0 &&
    state.resetAtEpochSeconds !== null &&
    state.resetAtEpochSeconds * 1000 > Date.now()
  ) {
    return true;
  }
  return false;
}

async function withProviderSlot<T>(provider: VisualProviderName, fn: () => Promise<T>): Promise<T> {
  const max = MAX_CONCURRENCY_PER_PROVIDER[provider];
  let waited = 0;
  while (activeRequestsPerProvider[provider] >= max) {
    if (waited >= 6_000) {
      throw new Error(`Provider ${provider} concurrency queue timed out.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    waited += 50;
  }
  activeRequestsPerProvider[provider] += 1;
  try {
    return await fn();
  } finally {
    activeRequestsPerProvider[provider] = Math.max(0, activeRequestsPerProvider[provider] - 1);
  }
}

/* ------------------------------------------------------------------ *
 * License validation & scoring
 * ------------------------------------------------------------------ */

export function evaluateVisualLicense(candidate: RawProviderCandidate): EvaluatedLicense {
  if (candidate.nonFree) {
    return {
      allowed: false,
      displayLabel: candidate.licenseRaw || 'Non-free',
      requiresAttribution: true,
      shareAlike: false,
      preferenceBonus: 0,
      reason: 'non_free_asset',
    };
  }

  const raw = (candidate.licenseRaw || '').trim().toLowerCase();
  const version = (candidate.licenseVersion || '').trim();
  if (!raw) {
    return {
      allowed: false,
      displayLabel: 'Unknown',
      requiresAttribution: true,
      shareAlike: false,
      preferenceBonus: 0,
      reason: 'missing_license',
    };
  }

  // Explicitly forbid Non-Commercial (NC), No-Derivatives (ND), Fair Use, or All Rights Reserved
  if (
    /(^|[^a-z])(nc|nd|by-nc|by-nd|cc-by-nc|cc-by-nd|non-?commercial|no-?derivatives|fair\s*use|all\s*rights\s*reserved|copyrighted)([^a-z]|$)/i.test(
      raw
    )
  ) {
    return {
      allowed: false,
      displayLabel: candidate.licenseRaw,
      requiresAttribution: true,
      shareAlike: false,
      preferenceBonus: 0,
      reason: 'restricted_license_nc_or_nd',
    };
  }

  if (candidate.provider === 'pexels' || raw === 'pexels' || raw === 'pexels license') {
    return {
      allowed: true,
      licenseCode: 'pexels',
      displayLabel: 'Pexels License',
      requiresAttribution: true,
      shareAlike: false,
      preferenceBonus: 0.1,
    };
  }

  if (
    raw === 'cc0' ||
    raw === 'cc-zero' ||
    raw.startsWith('cc0 ') ||
    raw.includes('creative commons zero')
  ) {
    return {
      allowed: true,
      licenseCode: 'cc0',
      displayLabel: version ? `CC0 ${version}` : 'CC0 1.0',
      requiresAttribution: false,
      shareAlike: false,
      preferenceBonus: 0.12,
    };
  }

  if (
    raw === 'pdm' ||
    raw === 'pd' ||
    raw.includes('public domain') ||
    raw.includes('public-domain') ||
    raw.startsWith('pd-') ||
    raw.includes('no known copyright')
  ) {
    return {
      allowed: true,
      licenseCode: 'pdm',
      displayLabel: 'Public Domain',
      requiresAttribution: false,
      shareAlike: false,
      preferenceBonus: 0.12,
    };
  }

  const hasAttributionMetadata = Boolean(
    (candidate.creator && candidate.creator.trim()) ||
      (candidate.attributionRaw && candidate.attributionRaw.trim())
  ) && Boolean(candidate.sourcePageUrl && candidate.sourcePageUrl.trim());

  if (
    raw === 'by-sa' ||
    raw === 'cc-by-sa' ||
    /^cc[\s-]+by[\s-]+sa(\s+\d+(\.\d+)?)?/.test(raw)
  ) {
    if (!hasAttributionMetadata) {
      return {
        allowed: false,
        displayLabel: 'CC BY-SA',
        requiresAttribution: true,
        shareAlike: true,
        preferenceBonus: 0,
        reason: 'missing_required_attribution_metadata',
      };
    }
    const ver = version || (/(\d+\.\d+)/.exec(raw)?.[1] ?? '');
    return {
      allowed: true,
      licenseCode: 'cc-by-sa',
      displayLabel: ver ? `CC BY-SA ${ver}` : 'CC BY-SA',
      requiresAttribution: true,
      shareAlike: true,
      preferenceBonus: 0.03,
    };
  }

  if (
    raw === 'by' ||
    raw === 'cc-by' ||
    /^cc[\s-]+by(\s+\d+(\.\d+)?)?(\s+\w+)?$/.test(raw)
  ) {
    if (!hasAttributionMetadata) {
      return {
        allowed: false,
        displayLabel: 'CC BY',
        requiresAttribution: true,
        shareAlike: false,
        preferenceBonus: 0,
        reason: 'missing_required_attribution_metadata',
      };
    }
    const ver = version || (/(\d+\.\d+)/.exec(raw)?.[1] ?? '');
    return {
      allowed: true,
      licenseCode: 'cc-by',
      displayLabel: ver ? `CC BY ${ver}` : 'CC BY',
      requiresAttribution: true,
      shareAlike: false,
      preferenceBonus: 0.06,
    };
  }

  return {
    allowed: false,
    displayLabel: candidate.licenseRaw,
    requiresAttribution: true,
    shareAlike: false,
    preferenceBonus: 0,
    reason: 'unrecognized_license',
  };
}

/* ------------------------------------------------------------------ *
 * Relevance, entity & polarity scoring
 * ------------------------------------------------------------------ */

const POSITIVE_CUES = new Set([
  'celebration',
  'celebrating',
  'cheerful',
  'cheering',
  'delighted',
  'excited',
  'festive',
  'happy',
  'joy',
  'joyful',
  'laughing',
  'party',
  'smiling',
  'success',
  'successful',
  'triumph',
  'victory',
]);

const NEGATIVE_TENSE_CUES = new Set([
  'angry',
  'anxiety',
  'anxious',
  'arguing',
  'argument',
  'bankrupt',
  'bankruptcy',
  'broken',
  'chaos',
  'chaotic',
  'collapse',
  'conflict',
  'crash',
  'crisis',
  'crying',
  'damage',
  'damaged',
  'danger',
  'debt',
  'disaster',
  'dispute',
  'distress',
  'emergency',
  'error',
  'Exhausted',
  'exhausted',
  'fail',
  'failed',
  'failure',
  'fear',
  'frustrated',
  'frustration',
  'hazard',
  'loss',
  'mistake',
  'panic',
  'problem',
  'risk',
  'ruined',
  'sad',
  'shocked',
  'stress',
  'stressed',
  'struggle',
  'tense',
  'tension',
  'trouble',
  'upset',
  'warning',
  'worried',
  'worry',
]);

const UNSAFE_NSFW_CUES = new Set([
  'nsfw',
  'nude',
  'nudity',
  'explicit',
  'erotic',
  'porn',
  'gore',
]);

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function isAllowedFormat(candidate: RawProviderCandidate): boolean {
  if (candidate.mimeType) {
    const normalized = candidate.mimeType.toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMAGE_MIMES.has(normalized)) return false;
  }
  const lowerUrl = candidate.imageUrl.toLowerCase().split('?')[0];
  if (
    lowerUrl.endsWith('.svg') ||
    lowerUrl.endsWith('.gif') ||
    lowerUrl.endsWith('.tif') ||
    lowerUrl.endsWith('.tiff') ||
    lowerUrl.endsWith('.pdf') ||
    lowerUrl.endsWith('.ogv') ||
    lowerUrl.endsWith('.webm')
  ) {
    return false;
  }
  return true;
}

export function scoreVisualCandidate(
  candidate: RawProviderCandidate,
  moment: Pick<
    ClipVisualOverlay,
    | 'category'
    | 'entityName'
    | 'visualIntent'
    | 'emotionalPolarity'
    | 'searchQueries'
    | 'negativeCues'
    | 'quote'
  >
): ScoredCandidate {
  const license = evaluateVisualLicense(candidate);
  const defaultFraming: 'illustrative' | 'editorial' =
    moment.category === 'person' || moment.category === 'place' || moment.category === 'named_event'
      ? 'editorial'
      : 'illustrative';

  if (!license.allowed) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: license.reason ?? 'license_rejected',
    };
  }

  if (candidate.mature) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: 'mature_content',
    };
  }

  if (!isAllowedFormat(candidate)) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: 'unsupported_format',
    };
  }

  if (candidate.width < 360 || candidate.height < 360) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: 'low_resolution',
    };
  }

  const metadataText = `${candidate.title} ${candidate.description} ${candidate.alt} ${candidate.tags.join(' ')}`.toLowerCase();
  const metadataTokens = new Set(tokenizeWords(metadataText));

  for (const unsafe of UNSAFE_NSFW_CUES) {
    if (metadataTokens.has(unsafe)) {
      return {
        candidate,
        license,
        accepted: false,
        score: 0,
        framing: defaultFraming,
        reason: 'unsafe_content',
      };
    }
  }

  // 1. Negative / avoid cues check
  for (const rawCue of moment.negativeCues) {
    const cue = rawCue.trim().toLowerCase();
    if (!cue) continue;
    const cueTokens = tokenizeWords(cue);
    if (cueTokens.length === 1) {
      if (metadataTokens.has(cueTokens[0])) {
        return {
          candidate,
          license,
          accepted: false,
          score: 0,
          framing: defaultFraming,
          reason: `negative_cue:${cue}`,
        };
      }
    } else if (cueTokens.length > 1) {
      if (metadataText.includes(cue) || cueTokens.every((tok) => metadataTokens.has(tok))) {
        return {
          candidate,
          license,
          accepted: false,
          score: 0,
          framing: defaultFraming,
          reason: `negative_cue:${cue}`,
        };
      }
    }
  }

  // 2. Named entity verification (person, place, named_event)
  const entityTokens = tokenizeWords(moment.entityName);
  const isEntityCategory =
    moment.category === 'person' || moment.category === 'place' || moment.category === 'named_event';

  if (moment.category === 'person' || (isEntityCategory && entityTokens.length > 0)) {
    if (entityTokens.length === 0) {
      return {
        candidate,
        license,
        accepted: false,
        score: 0,
        framing: 'editorial',
        reason: 'missing_entity_name',
      };
    }

    const matchedEntityTokens = entityTokens.filter((tok) => metadataTokens.has(tok));
    const entityMatchRatio = matchedEntityTokens.length / entityTokens.length;

    // Never substitute another person for a named person: require 100% of name tokens
    if (moment.category === 'person') {
      if (entityMatchRatio < 1) {
        return {
          candidate,
          license,
          accepted: false,
          score: 0,
          framing: 'editorial',
          reason: 'person_identity_mismatch',
        };
      }
      // Stock photos on Pexels must not be used to represent a named public figure unless exact full phrase is in title/alt
      if (
        candidate.provider === 'pexels' &&
        !`${candidate.title} ${candidate.alt}`.toLowerCase().includes(moment.entityName.trim().toLowerCase())
      ) {
        return {
          candidate,
          license,
          accepted: false,
          score: 0,
          framing: 'editorial',
          reason: 'stock_provider_cannot_impersonate_person',
        };
      }
    } else {
      // For places and named events, require strong entity match
      const requiredRatio = entityTokens.length <= 2 ? 1 : 0.75;
      if (entityMatchRatio < requiredRatio) {
        return {
          candidate,
          license,
          accepted: false,
          score: 0,
          framing: 'editorial',
          reason: 'entity_mismatch',
        };
      }
    }
  }

  // 3. Query & intent keyword relevance
  const queryTokens = tokenizeContentWords(
    `${moment.searchQueries.join(' ')} ${moment.visualIntent}`
  );
  const uniqueQueryTokens = [...new Set(queryTokens)];
  let matchedQueryCount = 0;
  for (const token of uniqueQueryTokens) {
    if (metadataTokens.has(token)) {
      matchedQueryCount += 1;
    } else if (token.length >= 5) {
      const stem = token.slice(0, token.length - 1);
      for (const metaTok of metadataTokens) {
        if (metaTok.startsWith(stem)) {
          matchedQueryCount += 0.75;
          break;
        }
      }
    }
  }

  const keywordRatio =
    uniqueQueryTokens.length > 0 ? Math.min(1, matchedQueryCount / Math.min(uniqueQueryTokens.length, 5)) : 0;

  if (keywordRatio === 0 && (!isEntityCategory || entityTokens.length === 0)) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: 'no_keyword_overlap',
    };
  }

  // 4. Emotional polarity & context consistency
  let positiveHits = 0;
  let negativeHits = 0;
  for (const tok of metadataTokens) {
    if (POSITIVE_CUES.has(tok)) positiveHits += 1;
    if (NEGATIVE_TENSE_CUES.has(tok)) negativeHits += 1;
  }

  let polarityBonus = 0;
  if (
    moment.emotionalPolarity === 'negative' ||
    moment.emotionalPolarity === 'tense' ||
    moment.emotionalPolarity === 'cautionary'
  ) {
    if (positiveHits > 0 && negativeHits === 0) {
      return {
        candidate,
        license,
        accepted: false,
        score: 0,
        framing: defaultFraming,
        reason: 'polarity_contradiction_positive_on_negative_beat',
      };
    }
    if (negativeHits > 0) polarityBonus = 0.08;
  } else if (moment.emotionalPolarity === 'positive') {
    if (negativeHits > 0 && positiveHits === 0) {
      return {
        candidate,
        license,
        accepted: false,
        score: 0,
        framing: defaultFraming,
        reason: 'polarity_contradiction_negative_on_positive_beat',
      };
    }
    if (positiveHits > 0) polarityBonus = 0.08;
  }

  // 5. Aspect ratio & resolution suitability for 9:16 overlay cards
  const aspect = candidate.width / Math.max(1, candidate.height);
  if (aspect > 3.2 || aspect < 0.28) {
    return {
      candidate,
      license,
      accepted: false,
      score: 0,
      framing: defaultFraming,
      reason: 'extreme_aspect_ratio',
    };
  }
  const aspectScore = aspect >= 0.55 && aspect <= 1.9 ? 0.08 : 0.03;
  const resolutionScore = candidate.width >= 1000 && candidate.height >= 700 ? 0.07 : 0.03;
  const entityBonus = isEntityCategory && entityTokens.length > 0 ? 0.25 : 0;

  const totalScore = Math.min(
    1,
    Math.round(
      (keywordRatio * 0.55 +
        entityBonus +
        polarityBonus +
        aspectScore +
        resolutionScore +
        license.preferenceBonus) *
        100
    ) / 100
  );

  const minRequiredScore = isEntityCategory ? 0.48 : 0.35;
  if (totalScore < minRequiredScore) {
    return {
      candidate,
      license,
      accepted: false,
      score: totalScore,
      framing: defaultFraming,
      reason: 'below_relevance_threshold',
    };
  }

  const finalFraming: 'illustrative' | 'editorial' =
    candidate.provider === 'pexels' || !isEntityCategory ? 'illustrative' : 'editorial';

  return {
    candidate,
    license,
    accepted: true,
    score: totalScore,
    framing: finalFraming,
  };
}

/* ------------------------------------------------------------------ *
 * Provider routing order
 * ------------------------------------------------------------------ */

export function getProviderOrderForMoment(params: {
  moment: Pick<ClipVisualOverlay, 'category' | 'entityName'>;
  renderSettings?: Partial<RenderDefaults>;
  hasPexelsKey: boolean;
}): VisualProviderName[] {
  const { moment, renderSettings, hasPexelsKey } = params;
  const toggles = renderSettings?.visualProviders ?? DEFAULT_RENDER_SETTINGS.visualProviders;
  const userPriority =
    renderSettings?.visualProviderPriority ?? DEFAULT_RENDER_SETTINGS.visualProviderPriority;

  const isNamedEntity =
    moment.category === 'person' ||
    moment.category === 'place' ||
    moment.category === 'named_event' ||
    Boolean(moment.entityName && moment.entityName.trim());

  let baseOrder: VisualProviderName[];
  if (isNamedEntity) {
    // Exact public figures, places and named historical/cultural events:
    // try Openverse and Wikimedia Commons first; Pexels last (and only if exact match).
    const editorialFirst = userPriority.filter(
      (p): p is 'openverse' | 'wikimedia' => p === 'openverse' || p === 'wikimedia'
    );
    for (const p of ['openverse', 'wikimedia'] as const) {
      if (!editorialFirst.includes(p)) editorialFirst.push(p);
    }
    baseOrder = [...editorialFirst, 'pexels'];
  } else {
    // Generic stock situations, actions and emotional scenes:
    // follow userPriority (default: Pexels first when key configured, then Openverse, then Wikimedia).
    baseOrder = [...userPriority];
    for (const p of ['pexels', 'openverse', 'wikimedia'] as const) {
      if (!baseOrder.includes(p)) baseOrder.push(p);
    }
  }

  return baseOrder.filter((provider) => {
    if (!toggles[provider]) return false;
    if (provider === 'pexels' && !hasPexelsKey) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Provider API adapters (Pexels, Openverse, Wikimedia Commons)
 * ------------------------------------------------------------------ */

function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchPexelsCandidates(
  query: string,
  apiKey: string,
  timeoutMs = 8_000
): Promise<RawProviderCandidate[]> {
  if (!isUsableSecret(apiKey)) return [];
  if (isProviderCoolingDown('pexels')) return [];

  return withProviderSlot('pexels', async () => {
    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', '15');

    providerStates.pexels.requestsCount += 1;
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    updateProviderRateLimitFromResponse('pexels', response);
    if (!response.ok) {
      providerStates.pexels.lastError = `HTTP ${response.status}`;
      return [];
    }

    const data = (await response.json()) as {
      photos?: Array<{
        id?: number | string;
        width?: number;
        height?: number;
        url?: string;
        photographer?: string;
        photographer_url?: string;
        alt?: string;
        src?: {
          large2x?: string;
          large?: string;
          medium?: string;
          original?: string;
        };
      }>;
    };

    const photos = Array.isArray(data?.photos) ? data.photos : [];
    const results: RawProviderCandidate[] = [];

    for (const photo of photos) {
      const imageUrl =
        photo.src?.large2x || photo.src?.large || photo.src?.medium || photo.src?.original || '';
      const sourcePageUrl = photo.url || 'https://www.pexels.com';
      if (!imageUrl || !photo.id) continue;

      const altText = (photo.alt || '').trim();
      results.push({
        provider: 'pexels',
        assetId: String(photo.id),
        title: altText || `Pexels Photo ${photo.id}`,
        description: altText,
        alt: altText,
        tags: tokenizeContentWords(altText),
        creator: (photo.photographer || 'Pexels Photographer').trim(),
        creatorUrl: photo.photographer_url || undefined,
        licenseRaw: 'Pexels License',
        licenseUrl: 'https://www.pexels.com/license/',
        attributionRaw: `Photo by ${(photo.photographer || 'Photographer').trim()} on Pexels`,
        sourcePageUrl,
        imageUrl,
        width: Number(photo.width) || 1200,
        height: Number(photo.height) || 1200,
        mimeType: 'image/jpeg',
      });
    }

    return results;
  });
}

async function resolveOpenverseBearerToken(
  clientId?: string,
  clientSecret?: string,
  timeoutMs = 6_000
): Promise<string | null> {
  const id = clientId?.trim() ?? '';
  const secret = clientSecret?.trim() ?? '';
  if (!isUsableSecret(id) || !isUsableSecret(secret)) return null;

  if (
    openverseTokenCache &&
    openverseTokenCache.clientId === id &&
    openverseTokenCache.expiresAtMs > Date.now() + 30_000
  ) {
    return openverseTokenCache.accessToken;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    });
    const response = await fetch('https://api.openverse.org/v1/auth_tokens/token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data?.access_token) return null;
    const ttlSeconds = Number(data.expires_in) || 3600;
    openverseTokenCache = {
      clientId: id,
      accessToken: data.access_token,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    };
    return data.access_token;
  } catch {
    return null;
  }
}

export async function searchOpenverseCandidates(
  query: string,
  options: {
    clientId?: string;
    clientSecret?: string;
    timeoutMs?: number;
  } = {}
): Promise<RawProviderCandidate[]> {
  if (isProviderCoolingDown('openverse')) return [];

  return withProviderSlot('openverse', async () => {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const token = await resolveOpenverseBearerToken(
      options.clientId,
      options.clientSecret,
      timeoutMs
    );

    const url = new URL('https://api.openverse.org/v1/images/');
    url.searchParams.set('q', query);
    url.searchParams.set('page_size', '15');
    url.searchParams.set('license_type', 'modification');
    url.searchParams.set('mature', 'false');
    url.searchParams.set('filter_dead', 'true');

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    providerStates.openverse.requestsCount += 1;
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    updateProviderRateLimitFromResponse('openverse', response);
    if (!response.ok) {
      providerStates.openverse.lastError = `HTTP ${response.status}`;
      return [];
    }

    const data = (await response.json()) as {
      results?: Array<{
        id?: string;
        title?: string;
        foreign_landing_url?: string;
        url?: string;
        thumbnail?: string;
        creator?: string;
        creator_url?: string;
        license?: string;
        license_version?: string;
        license_url?: string;
        attribution?: string;
        mature?: boolean;
        width?: number;
        height?: number;
        filetype?: string;
        tags?: Array<{ name?: string } | string>;
      }>;
    };

    const rows = Array.isArray(data?.results) ? data.results : [];
    const results: RawProviderCandidate[] = [];

    for (const row of rows) {
      const imageUrl = row.url || row.thumbnail || '';
      const sourcePageUrl = row.foreign_landing_url || row.url || '';
      if (!row.id || !imageUrl || !sourcePageUrl) continue;

      const tags: string[] = [];
      if (Array.isArray(row.tags)) {
        for (const t of row.tags) {
          if (typeof t === 'string') tags.push(t);
          else if (t && typeof t.name === 'string') tags.push(t.name);
        }
      }

      const filetype = (row.filetype || '').toLowerCase();
      const mimeType =
        filetype === 'png'
          ? 'image/png'
          : filetype === 'webp'
            ? 'image/webp'
            : filetype === 'svg'
              ? 'image/svg+xml'
              : 'image/jpeg';

      results.push({
        provider: 'openverse',
        assetId: String(row.id),
        title: (row.title || 'Openverse Image').trim(),
        description: (row.attribution || row.title || '').trim(),
        alt: (row.title || '').trim(),
        tags,
        creator: (row.creator || 'Unknown Creator').trim(),
        creatorUrl: row.creator_url || undefined,
        licenseRaw: (row.license || '').trim(),
        licenseVersion: row.license_version || undefined,
        licenseUrl: row.license_url || undefined,
        attributionRaw: row.attribution || undefined,
        mature: Boolean(row.mature),
        sourcePageUrl,
        imageUrl,
        width: Number(row.width) || 1000,
        height: Number(row.height) || 1000,
        mimeType,
      });
    }

    return results;
  });
}

export async function searchWikimediaCandidates(
  query: string,
  options: {
    userAgent?: string;
    timeoutMs?: number;
  } = {}
): Promise<RawProviderCandidate[]> {
  if (isProviderCoolingDown('wikimedia')) return [];

  return withProviderSlot('wikimedia', async () => {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const userAgent =
      options.userAgent?.trim() || DEFAULT_AI_SETTINGS.wikimediaUserAgent;

    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', `filetype:bitmap ${query}`);
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', '15');
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
    url.searchParams.set('iiurlwidth', '1280');
    url.searchParams.set('format', 'json');

    providerStates.wikimedia.requestsCount += 1;
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Api-User-Agent': userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    updateProviderRateLimitFromResponse('wikimedia', response);
    if (!response.ok) {
      providerStates.wikimedia.lastError = `HTTP ${response.status}`;
      return [];
    }

    const data = (await response.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            pageid?: number;
            title?: string;
            imageinfo?: Array<{
              url?: string;
              thumburl?: string;
              descriptionurl?: string;
              width?: number;
              height?: number;
              thumbwidth?: number;
              thumbheight?: number;
              mime?: string;
              extmetadata?: Record<string, { value?: string }>;
            }>;
          }
        >;
      };
    };

    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    const results: RawProviderCandidate[] = [];

    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;

      const imageUrl = info.thumburl || info.url || '';
      const sourcePageUrl =
        info.descriptionurl ||
        (page.title
          ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`
          : '');
      if (!imageUrl || !sourcePageUrl) continue;

      const ext = info.extmetadata ?? {};
      const licenseShort = stripHtmlTags(ext.LicenseShortName?.value ?? '');
      const usageTerms = stripHtmlTags(ext.UsageTerms?.value ?? '');
      const licenseUrl = stripHtmlTags(ext.LicenseUrl?.value ?? '');
      const artist = stripHtmlTags(ext.Artist?.value ?? '');
      const description = stripHtmlTags(ext.ImageDescription?.value ?? '');
      const objectName = stripHtmlTags(ext.ObjectName?.value ?? '');
      const categories = stripHtmlTags(ext.Categories?.value ?? '');
      const nonFreeRaw = (ext.NonFree?.value ?? '').trim().toLowerCase();
      const nonFree = nonFreeRaw === 'true' || nonFreeRaw === '1';

      const cleanTitle =
        objectName ||
        (page.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');

      results.push({
        provider: 'wikimedia',
        assetId: String(page.pageid ?? page.title ?? imageUrl),
        title: cleanTitle.trim() || 'Wikimedia Commons Image',
        description,
        alt: `${cleanTitle} ${description}`.trim(),
        tags: tokenizeContentWords(`${categories} ${cleanTitle}`),
        creator: artist || 'Wikimedia Commons Contributor',
        licenseRaw: licenseShort || usageTerms,
        licenseUrl: licenseUrl || undefined,
        attributionRaw: artist
          ? `${cleanTitle} by ${artist} via Wikimedia Commons`
          : `${cleanTitle} via Wikimedia Commons`,
        nonFree,
        sourcePageUrl,
        imageUrl,
        width: Number(info.thumbwidth || info.width) || 1000,
        height: Number(info.thumbheight || info.height) || 1000,
        mimeType: info.mime || 'image/jpeg',
      });
    }

    return results;
  });
}

/* ------------------------------------------------------------------ *
 * Safe HTTPS Image Downloader & Binary Inspection
 * ------------------------------------------------------------------ */

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') {
    return true;
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local
  }
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('::ffff:')) {
    const v4Part = lower.slice('::ffff:'.length);
    if (net.isIPv4(v4Part)) return isPrivateOrReservedIpv4(v4Part);
  }
  return false;
}

const ALLOWED_IMAGE_HOST_SUFFIXES = [
  'pexels.com',
  'wikimedia.org',
  'wikipedia.org',
  'openverse.org',
  'staticflickr.com',
  'flickr.com',
  'nasa.gov',
  'si.edu',
  'nypl.org',
  'metmuseum.org',
  'europeana.eu',
  'rawpixel.com',
  'wp.com',
  'wordpress.com',
  'geograph.org.uk',
  'phylopic.org',
  'deviantart.net',
  'behance.net',
  'inaturalist.org',
  'eol.org',
  'clevelandart.org',
  'artic.edu',
  'rijksmuseum.nl',
  'loc.gov',
  'wellcomecollection.org',
  'brooklynmuseum.org',
];

function isAllowedProviderImageHost(host: string): boolean {
  return ALLOWED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

/**
 * Validates that a download URL uses HTTPS, has no embedded credentials,
 * does not target localhost, loopback, link-local, or private IP space,
 * and belongs to an allowed provider image host.
 */
export function validateSafeProviderDownloadUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid image URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS image download protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refusing image URL with embedded credentials.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    throw new Error(`Refusing unsafe image host: ${host}`);
  }

  const ipType = net.isIP(host);
  if (ipType === 4 && isPrivateOrReservedIpv4(host)) {
    throw new Error(`Refusing private or loopback IPv4 address: ${host}`);
  }
  if (ipType === 6 && isPrivateOrReservedIpv6(host)) {
    throw new Error(`Refusing private or loopback IPv6 address: ${host}`);
  }

  if (!isAllowedProviderImageHost(host)) {
    throw new Error(`Refusing unapproved image host: ${host}`);
  }

  return parsed;
}

export interface InspectedImageBinary {
  format: 'jpeg' | 'png' | 'webp';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

/**
 * Verifies magic bytes and extracts actual pixel dimensions from a PNG, JPEG, or WebP buffer.
 * Rejects any buffer that is not a genuine image or has unsafe dimensions.
 */
export function inspectImageBuffer(buffer: Buffer): InspectedImageBinary {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new Error('Image buffer is too small to be a valid image.');
  }
  if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error(`Image exceeds maximum byte size (${MAX_IMAGE_DOWNLOAD_BYTES} bytes).`);
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR width/height at bytes 16..23
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    validateDimensions(width, height);
    return {
      format: 'png',
      mimeType: 'image/png',
      extension: 'png',
      width,
      height,
    };
  }

  // 2. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const segLength = buffer.readUInt16BE(offset + 2);
      if (segLength < 2 || offset + 2 + segLength > buffer.length) break;

      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        validateDimensions(width, height);
        return {
          format: 'jpeg',
          mimeType: 'image/jpeg',
          extension: 'jpg',
          width,
          height,
        };
      }
      offset += 2 + segLength;
    }
    throw new Error('JPEG buffer is missing a valid SOF dimension header.');
  }

  // 3. WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.length >= 30
  ) {
    const chunkType = buffer.toString('ascii', 12, 16);
    let width = 0;
    let height = 0;
    if (chunkType === 'VP8 ' && buffer.length >= 30) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunkType === 'VP8X' && buffer.length >= 30) {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    }
    validateDimensions(width, height);
    return {
      format: 'webp',
      mimeType: 'image/webp',
      extension: 'webp',
      width,
      height,
    };
  }

  throw new Error('Unsupported or invalid image magic bytes.');
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_IMAGE_DIMENSION ||
    height < MIN_IMAGE_DIMENSION ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error(`Unsafe or invalid image dimensions: ${width}x${height}`);
  }
}

export async function downloadVisualAssetSafely(params: {
  imageUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRedirects?: number;
}): Promise<{
  buffer: Buffer;
  contentHash: string;
  inspected: InspectedImageBinary;
  localFilePath: string;
  mediaUrl: string;
}> {
  const maxRedirects = params.maxRedirects ?? 3;
  const timeoutMs = params.timeoutMs ?? 10_000;
  let currentUrl = validateSafeProviderDownloadUrl(params.imageUrl);

  const headers: Record<string, string> = {
    Accept: 'image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.5',
    'User-Agent': params.userAgent?.trim() || DEFAULT_AI_SETTINGS.wikimediaUserAgent,
  };

  let response: Response | null = null;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(currentUrl.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Redirect response (${res.status}) missing Location header.`);
      }
      if (hop === maxRedirects) {
        throw new Error(`Exceeded maximum redirects (${maxRedirects}) downloading image.`);
      }
      const resolvedNext = new URL(location, currentUrl).toString();
      currentUrl = validateSafeProviderDownloadUrl(resolvedNext);
      continue;
    }

    response = res;
    break;
  }

  if (!response || !response.ok) {
    throw new Error(`Image download failed with HTTP ${response?.status ?? 'unknown'}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error(`Image Content-Length (${contentLength}) exceeds limit.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (
    contentType &&
    contentType !== 'application/octet-stream' &&
    !ALLOWED_IMAGE_MIMES.has(contentType)
  ) {
    throw new Error(`Refusing unexpected Content-Type: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const inspected = inspectImageBuffer(buffer);
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);

  const cacheDir = getVisualCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const fileName = `${contentHash}.${inspected.extension}`;
  const localFilePath = path.join(cacheDir, fileName);

  if (!fs.existsSync(localFilePath)) {
    const tempPath = `${localFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, localFilePath);
  }

  return {
    buffer,
    contentHash,
    inspected,
    localFilePath,
    mediaUrl: `/api/media/visual-cache/${fileName}`,
  };
}

/* ------------------------------------------------------------------ *
 * Attribution builder for a candidate + license
 * ------------------------------------------------------------------ */

export function buildCandidateAttribution(
  candidate: RawProviderCandidate,
  license: EvaluatedLicense
): VisualAssetAttribution {
  const creator = candidate.creator || 'Unknown Creator';
  const title = candidate.title || 'Untitled Image';
  const licenseCode = license.licenseCode ?? 'cc0';

  if (candidate.provider === 'pexels') {
    return {
      provider: 'pexels',
      assetId: candidate.assetId,
      title,
      creator,
      ...(candidate.creatorUrl ? { creatorUrl: candidate.creatorUrl } : {}),
      license: 'Pexels License',
      licenseCode: 'pexels',
      ...(candidate.licenseUrl ? { licenseUrl: candidate.licenseUrl } : {}),
      sourcePageUrl: candidate.sourcePageUrl,
      imageUrl: candidate.imageUrl,
      attributionText: `Photo by ${creator} on Pexels`,
      requiresAttribution: true,
      shareAlike: false,
      providerAttributionText: 'Photos provided by Pexels',
      providerAttributionUrl: 'https://www.pexels.com',
    };
  }

  const providerLabel =
    candidate.provider === 'wikimedia' ? 'Wikimedia Commons' : 'Openverse';
  const defaultAttribution = `${title} by ${creator} (${license.displayLabel}) via ${providerLabel}`;

  return {
    provider: candidate.provider,
    assetId: candidate.assetId,
    title,
    creator,
    ...(candidate.creatorUrl ? { creatorUrl: candidate.creatorUrl } : {}),
    license: license.displayLabel,
    licenseCode,
    ...(candidate.licenseVersion ? { licenseVersion: candidate.licenseVersion } : {}),
    ...(candidate.licenseUrl ? { licenseUrl: candidate.licenseUrl } : {}),
    sourcePageUrl: candidate.sourcePageUrl,
    imageUrl: candidate.imageUrl,
    attributionText: candidate.attributionRaw?.trim() || defaultAttribution,
    requiresAttribution: license.requiresAttribution,
    shareAlike: license.shareAlike,
  };
}

/* ------------------------------------------------------------------ *
 * End-to-end provider router & resolver for a clip's visual overlays
 * ------------------------------------------------------------------ */

export interface ResolveVisualOverlaysOptions {
  renderSettings?: Partial<RenderDefaults>;
  pexelsApiKey?: string;
  openverseClientId?: string;
  openverseClientSecret?: string;
  wikimediaUserAgent?: string;
  timeoutMs?: number;
}

function normalizeQueryCacheKey(provider: VisualProviderName, query: string): string {
  return `${provider}:${ tokenizeWords(query).join(' ') }`;
}

async function searchProviderWithCache(
  provider: VisualProviderName,
  query: string,
  options: ResolveVisualOverlaysOptions,
  category = 'general'
): Promise<RawProviderCandidate[]> {
  const key = normalizeQueryCacheKey(provider, query);
  const ttlMs = getVisualSearchCacheTtlMs();
  const cached = searchMemoryCache.get(key);
  if (cached && Date.now() - cached.createdAtMs < ttlMs) {
    providerStates[provider].cacheHits += 1;
    return cached.candidates;
  }

  const sqliteCached = readSqliteSearchCache(key);
  if (sqliteCached && sqliteCached.length > 0) {
    providerStates[provider].cacheHits += 1;
    searchMemoryCache.set(key, {
      key,
      provider,
      query,
      createdAtMs: Date.now(),
      candidates: sqliteCached,
    });
    return sqliteCached;
  }

  let candidates: RawProviderCandidate[] = [];
  if (provider === 'pexels') {
    candidates = await searchPexelsCandidates(
      query,
      options.pexelsApiKey ?? '',
      options.timeoutMs
    );
  } else if (provider === 'openverse') {
    candidates = await searchOpenverseCandidates(query, {
      clientId: options.openverseClientId,
      clientSecret: options.openverseClientSecret,
      timeoutMs: options.timeoutMs,
    });
  } else if (provider === 'wikimedia') {
    candidates = await searchWikimediaCandidates(query, {
      userAgent: options.wikimediaUserAgent,
      timeoutMs: options.timeoutMs,
    });
  }

  if (candidates.length > 0) {
    searchMemoryCache.set(key, {
      key,
      provider,
      query,
      createdAtMs: Date.now(),
      candidates,
    });
    writeSqliteSearchCache({
      cacheKey: key,
      provider,
      query,
      category,
      candidates,
      ttlMs,
    });
  }

  return candidates;
}

/**
 * Resolves a single `ClipVisualOverlay` by routing across allowed providers,
 * ranking candidates locally, and downloading the winning image to the local cache.
 * Never throws: provider failures or lack of suitable images return `status: 'skipped'`.
 */
export async function resolveSingleVisualOverlay(
  overlay: ClipVisualOverlay,
  options: ResolveVisualOverlaysOptions = {},
  usedAssetIds: Set<string> = new Set()
): Promise<ClipVisualOverlay> {
  if (overlay.status === 'removed') return overlay;

  // If already resolved and its cached file exists on disk, reuse without any network request!
  if (
    overlay.status === 'resolved' &&
    overlay.localFilePath &&
    fs.existsSync(overlay.localFilePath) &&
    overlay.attribution
  ) {
    return overlay;
  }

  const pexelsKey =
    options.pexelsApiKey?.trim() || (process.env.PEXELS_API_KEY?.trim() ?? '');
  const hasPexelsKey = isUsableSecret(pexelsKey);

  const providerOrder = getProviderOrderForMoment({
    moment: overlay,
    renderSettings: options.renderSettings,
    hasPexelsKey,
  });

  if (providerOrder.length === 0) {
    return {
      ...overlay,
      status: 'skipped',
      skipReason: 'No visual providers are enabled or configured.',
    };
  }

  const primaryQuery =
    overlay.searchQueries[0]?.trim() ||
    [overlay.entityName, overlay.visualIntent].filter(Boolean).join(' ').trim();

  if (!primaryQuery) {
    return {
      ...overlay,
      status: 'skipped',
      skipReason: 'Visual moment has no usable search query.',
    };
  }

  // Check the persistent SQLite image_bank first so repeat concepts/tags reuse
  // already-accepted local images before making any API call.
  const bankMatch = findMatchingImageBankEntry({
    moment: overlay,
    allowedProviders: providerOrder,
    usedAssetIds,
  });
  if (bankMatch) {
    providerStates[bankMatch.provider].cacheHits += 1;
    usedAssetIds.add(bankMatch.id);
    const isEntityCategory =
      overlay.category === 'person' ||
      overlay.category === 'place' ||
      overlay.category === 'named_event' ||
      Boolean(overlay.entityName && overlay.entityName.trim());
    return {
      ...overlay,
      status: 'resolved',
      skipReason: undefined,
      framing: bankMatch.provider === 'pexels' || !isEntityCategory ? 'illustrative' : 'editorial',
      localFilePath: bankMatch.localPath,
      mediaUrl: `/api/media/visual-cache/${path.basename(bankMatch.localPath)}`,
      contentHash: bankMatch.contentHash,
      width: bankMatch.width,
      height: bankMatch.height,
      relevanceScore: 0.9,
      attribution: bankMatch.attribution,
    };
  }

  for (const provider of providerOrder) {
    try {
      // Single search request per provider per visual moment
      const rawCandidates = await searchProviderWithCache(
        provider,
        primaryQuery,
        {
          ...options,
          pexelsApiKey: pexelsKey,
        },
        overlay.category
      );

      if (rawCandidates.length === 0) continue;

      const scored = rawCandidates
        .filter((cand) => !usedAssetIds.has(`${cand.provider}:${cand.assetId}`))
        .map((cand) => scoreVisualCandidate(cand, overlay))
        .filter((entry) => entry.accepted)
        .sort((a, b) => b.score - a.score);

      for (const winner of scored.slice(0, 2)) {
        const assetKey = `${winner.candidate.provider}:${winner.candidate.assetId}`;
        const cachedAsset = assetMemoryCache.get(assetKey);
        if (cachedAsset && fs.existsSync(cachedAsset.localFilePath)) {
          providerStates[provider].cacheHits += 1;
          usedAssetIds.add(assetKey);
          return {
            ...overlay,
            status: 'resolved',
            skipReason: undefined,
            framing: winner.framing,
            localFilePath: cachedAsset.localFilePath,
            mediaUrl: cachedAsset.mediaUrl,
            contentHash: cachedAsset.contentHash,
            width: cachedAsset.width,
            height: cachedAsset.height,
            relevanceScore: winner.score,
            attribution: cachedAsset.attribution,
          };
        }

        try {
          const downloaded = await downloadVisualAssetSafely({
            imageUrl: winner.candidate.imageUrl,
            userAgent: options.wikimediaUserAgent,
            timeoutMs: options.timeoutMs,
          });
          const attribution = buildCandidateAttribution(winner.candidate, winner.license);
          const assetEntry: CachedDownloadedAsset = {
            key: assetKey,
            provider: winner.candidate.provider,
            assetId: winner.candidate.assetId,
            contentHash: downloaded.contentHash,
            localFilePath: downloaded.localFilePath,
            mediaUrl: downloaded.mediaUrl,
            width: downloaded.inspected.width,
            height: downloaded.inspected.height,
            mimeType: downloaded.inspected.mimeType,
            attribution,
            createdAtMs: Date.now(),
          };
          assetMemoryCache.set(assetKey, assetEntry);
          usedAssetIds.add(assetKey);

          const combinedTags = [
            ...winner.candidate.tags,
            ...tokenizeContentWords(winner.candidate.title),
            ...tokenizeContentWords(overlay.entityName || ''),
            ...overlay.searchQueries.flatMap((q) => tokenizeContentWords(q)),
          ];
          upsertImageBankEntry({
            provider: winner.candidate.provider,
            assetId: winner.candidate.assetId,
            localPath: downloaded.localFilePath,
            tags: combinedTags,
            width: downloaded.inspected.width,
            height: downloaded.inspected.height,
            fileSize: downloaded.buffer.length,
            contentHash: downloaded.contentHash,
            attribution,
          });
          pruneVisualCacheDirectory();

          return {
            ...overlay,
            status: 'resolved',
            skipReason: undefined,
            framing: winner.framing,
            localFilePath: downloaded.localFilePath,
            mediaUrl: downloaded.mediaUrl,
            contentHash: downloaded.contentHash,
            width: downloaded.inspected.width,
            height: downloaded.inspected.height,
            relevanceScore: winner.score,
            attribution,
          };
        } catch {
          // Try next candidate or next provider if download/magic-byte check failed
          continue;
        }
      }
    } catch {
      // Provider failed or timed out -> bounded fallback to next allowed provider
      continue;
    }
  }

  return {
    ...overlay,
    status: 'skipped',
    skipReason: 'No candidate passed relevance, license, and safety checks.',
  };
}

/**
 * Resolves all planned visual overlays for a clip before the final video encode.
 * De-duplicates assets within the clip so the same image is never shown twice.
 */
export async function resolveVisualOverlaysForClip(
  overlays: ClipVisualOverlay[],
  options: ResolveVisualOverlaysOptions = {}
): Promise<ClipVisualOverlay[]> {
  if (!Array.isArray(overlays) || overlays.length === 0) return [];
  const autoVisuals =
    options.renderSettings?.autoVisuals ?? DEFAULT_RENDER_SETTINGS.autoVisuals;
  if (!autoVisuals) return overlays;

  const usedAssetIds = new Set<string>();
  const resolved: ClipVisualOverlay[] = [];

  for (const overlay of overlays) {
    const updated = await resolveSingleVisualOverlay(overlay, options, usedAssetIds);
    resolved.push(updated);
  }

  return resolved;
}
