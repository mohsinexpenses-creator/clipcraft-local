import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import {
  deleteBrollAssetByNormalizedUrl,
  getBrollAssetByContentHash,
  getBrollAssetByNormalizedUrl,
  getCachedBrollSearch,
  listCachedBrollAssets,
  saveBrollAsset,
  saveCachedBrollSearch,
} from '../db';
import { resolveBrollCacheDir } from '../paths';
import {
  ALLOWED_BROLL_MIME_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  MIN_IMAGE_HEIGHT,
  MIN_IMAGE_WIDTH,
  MIN_RELEVANCE_SCORE,
  WIKIMEDIA_USER_AGENT,
  canonicalizeMediaStem,
  normalizeImageUrl,
  scoreCandidateRelevance,
  searchWikimediaCommons,
  type FetchLike,
} from './wikimedia';
import type {
  BrollAssetRecord,
  BrollSearchCandidate,
  BrollSubjectKind,
  ResolvedBrollAsset,
} from './types';

export const DEFAULT_FOCAL_X = 0.5;
export const DEFAULT_FOCAL_Y = 0.35;

export interface ValidatedImageBuffer {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
  contentHash: string;
  focalX: number;
  focalY: number;
}

function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (
    buf.length < 30 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const riffSize = buf.readUInt32LE(4);
  // Reject truncated WebP containers where the declared RIFF payload exceeds actual bytes
  if (riffSize + 8 > buf.length) return null;

  const chunkType = buf.toString('ascii', 12, 16);
  if (chunkType === 'VP8X' && buf.length >= 30) {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { width, height };
  }
  if (chunkType === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b1 = buf[21];
    const b2 = buf[22];
    const b3 = buf[23];
    const b4 = buf[24];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { width, height };
  }
  if (chunkType === 'VP8 ' && buf.length >= 30) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  return null;
}

function detectMagicMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionForMime(mime: 'image/jpeg' | 'image/png' | 'image/webp'): 'jpg' | 'png' | 'webp' {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Compute face-aware focal position when YuNet finds a clear human subject in a
 * landscape/portrait photograph; falls back cleanly to `(0.5, 0.35)`.
 */
async function computeSmartFocalPoint(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<{ focalX: number; focalY: number }> {
  try {
    const { loadYuNet, detectFacesYunet } = await import('../../worker/yunet-detector');
    const runtime = await loadYuNet();
    if (!runtime) {
      return { focalX: DEFAULT_FOCAL_X, focalY: DEFAULT_FOCAL_Y };
    }
    const faces = await detectFacesYunet(runtime, { data: rgba, width, height });
    if (!faces || faces.length === 0) {
      return { focalX: DEFAULT_FOCAL_X, focalY: DEFAULT_FOCAL_Y };
    }
    const best = [...faces].sort(
      (a, b) => b.box.width * b.box.height * b.score - a.box.width * a.box.height * a.score,
    )[0];
    const centerX = Math.max(0, Math.min(1, (best.box.x + best.box.width / 2) / width));
    const centerY = Math.max(0.15, Math.min(0.65, (best.box.y + best.box.height * 0.45) / height));
    return {
      focalX: Math.round(centerX * 1000) / 1000,
      focalY: Math.round(centerY * 1000) / 1000,
    };
  } catch {
    return { focalX: DEFAULT_FOCAL_X, focalY: DEFAULT_FOCAL_Y };
  }
}

/**
 * Strictly validate actual binary image bytes, decode integrity, format, and
 * minimum dimensions before persisting anything to disk or SQLite.
 */
export async function inspectAndValidateImageBuffer(
  buffer: Buffer,
  options: {
    minWidth?: number;
    minHeight?: number;
    detectFaces?: boolean;
  } = {},
): Promise<ValidatedImageBuffer | null> {
  const minW = options.minWidth ?? MIN_IMAGE_WIDTH;
  const minH = options.minHeight ?? MIN_IMAGE_HEIGHT;

  const mimeType = detectMagicMime(buffer);
  if (!mimeType || !ALLOWED_BROLL_MIME_TYPES.has(mimeType)) {
    return null;
  }

  const contentHash = createHash('sha256').update(buffer).digest('hex');

  if (mimeType === 'image/webp') {
    const dims = parseWebpDimensions(buffer);
    if (!dims || dims.width < minW || dims.height < minH) {
      return null;
    }
    const aspect = dims.width / dims.height;
    if (aspect < 0.2 || aspect > 3.2) return null;
    return {
      mimeType,
      extension: 'webp',
      width: dims.width,
      height: dims.height,
      contentHash,
      focalX: DEFAULT_FOCAL_X,
      focalY: DEFAULT_FOCAL_Y,
    };
  }

  // Full decode validation via Jimp for JPEG/PNG rejects truncated/corrupted payloads
  try {
    const decoded = await Jimp.fromBuffer(buffer);
    const width = decoded.bitmap.width;
    const height = decoded.bitmap.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < minW || height < minH) {
      return null;
    }
    const aspect = width / height;
    if (aspect < 0.2 || aspect > 3.2) return null;

    let focal = { focalX: DEFAULT_FOCAL_X, focalY: DEFAULT_FOCAL_Y };
    if (options.detectFaces !== false) {
      // Resize copy if large so face detection never buffers multi-megapixel RGB frames
      const sample = width > 640 ? decoded.clone().resize({ w: 640 }) : decoded;
      focal = await computeSmartFocalPoint(
        sample.bitmap.data as Buffer,
        sample.bitmap.width,
        sample.bitmap.height,
      );
    }

    return {
      mimeType,
      extension: extensionForMime(mimeType),
      width,
      height,
      contentHash,
      focalX: focal.focalX,
      focalY: focal.focalY,
    };
  } catch {
    return null;
  }
}

/**
 * Safely resolve `<cacheDir>/images/<localPath>` while strictly blocking path traversal
 * (`..`, absolute paths, drive letters, or backslashes).
 */
export function resolveSafeCachedImagePath(cacheDir: string, localFileName: string): string {
  const safeBase = path.basename(localFileName);
  if (
    !safeBase ||
    safeBase !== localFileName ||
    !/^[a-f0-9]{16,64}\.(jpg|png|webp)$/.test(safeBase)
  ) {
    throw new Error(`Unsafe cached B-roll filename rejected: ${localFileName}`);
  }
  const imagesRoot = path.resolve(cacheDir, 'images');
  const fullPath = path.resolve(imagesRoot, safeBase);
  const rel = path.relative(imagesRoot, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Cached B-roll path escaped cache directory: ${localFileName}`);
  }
  return fullPath;
}

async function readResponseWithSizeCap(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    abortController.abort();
    return null;
  }

  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          abortController.abort();
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  return Buffer.concat(chunks, total);
}

/** In-flight download deduplication map so concurrent clips requesting the same URL share one fetch. */
const inFlightDownloads = new Map<string, Promise<ResolvedBrollAsset | null>>();

export interface EnsureCachedAssetOptions {
  searchTerms?: string[];
  cacheDir?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxImageBytes?: number;
  minWidth?: number;
  minHeight?: number;
  detectFaces?: boolean;
  signal?: AbortSignal;
}

/**
 * Retrieve a validated local B-roll image from the persistent cache if already
 * downloaded, or download, validate, content-hash deduplicate, write atomically
 * under `<cacheDir>/images/<sha256>.<ext>`, and save metadata in SQLite.
 */
export async function ensureCachedBrollAsset(
  candidate: BrollSearchCandidate,
  options: EnsureCachedAssetOptions = {},
): Promise<ResolvedBrollAsset | null> {
  const normalizedUrl = normalizeImageUrl(candidate.sourceUrl);
  if (!normalizedUrl) return null;

  const cacheDir = resolveBrollCacheDir(options.cacheDir);
  const incomingTerms = [
    ...(options.searchTerms ?? []),
    ...(candidate.title ? [candidate.title] : []),
  ].filter(Boolean);

  // 1) Fast persistent URL cache check in SQLite + local disk existence check
  const existingByUrl = getBrollAssetByNormalizedUrl(normalizedUrl);
  if (existingByUrl) {
    try {
      const diskPath = resolveSafeCachedImagePath(cacheDir, existingByUrl.localPath);
      const stat = fs.existsSync(diskPath) ? fs.statSync(diskPath) : null;
      if (stat && stat.isFile() && stat.size > 0) {
        const updated = saveBrollAsset({
          ...existingByUrl,
          searchTerms: incomingTerms,
          lastUsedAt: new Date().toISOString(),
        });
        return {
          ...updated,
          absolutePath: diskPath,
          cacheHit: true,
        };
      }
    } catch {
      // Stale or tampered metadata row -> clean up and re-fetch
    }
    deleteBrollAssetByNormalizedUrl(normalizedUrl);
  }

  // Deduplicate simultaneous downloads of the exact same normalized URL across parallel tasks
  const inflightKey = `${cacheDir}::${normalizedUrl}`;
  const pending = inFlightDownloads.get(inflightKey);
  if (pending) {
    const shared = await pending;
    return shared ? { ...shared, cacheHit: true } : null;
  }

  const task = (async (): Promise<ResolvedBrollAsset | null> => {
    const fetchFn = options.fetchImpl ?? fetch;
    const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const timeoutMs = options.timeoutMs ?? 10_000;

    // Try primary URL (`sourceUrl`), falling back to `originalUrl` only if distinct & needed
    const urlsToTry = [normalizedUrl];
    const fallbackOriginal = normalizeImageUrl(candidate.originalUrl);
    if (fallbackOriginal && fallbackOriginal !== normalizedUrl) {
      urlsToTry.push(fallbackOriginal);
    }

    for (const targetUrl of urlsToTry) {
      if (options.signal?.aborted) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await fetchFn(targetUrl, {
          method: 'GET',
          headers: {
            'user-agent': WIKIMEDIA_USER_AGENT,
            accept: 'image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1',
          },
          redirect: 'follow',
          signal: controller.signal,
        });

        if (!response.ok) continue;

        const headerMime = (response.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        // Reject explicit non-image error responses before buffering
        if (headerMime && !ALLOWED_BROLL_MIME_TYPES.has(headerMime) && !headerMime.startsWith('application/octet-stream')) {
          continue;
        }

        const buffer = await readResponseWithSizeCap(response, maxBytes, controller);
        if (!buffer) continue;

        const validated = await inspectAndValidateImageBuffer(buffer, {
          minWidth: options.minWidth,
          minHeight: options.minHeight,
          detectFaces: options.detectFaces,
        });
        if (!validated) continue;

        // 2) Content-hash deduplication: if another URL already cached identical bytes, reuse the file!
        const existingByHash = getBrollAssetByContentHash(validated.contentHash);
        const localFileName = `${validated.contentHash}.${validated.extension}`;
        const finalFilePath = resolveSafeCachedImagePath(cacheDir, localFileName);

        let reusedExistingDiskBytes = false;
        if (existingByHash) {
          try {
            const hashPath = resolveSafeCachedImagePath(cacheDir, existingByHash.localPath);
            if (fs.existsSync(hashPath) && fs.statSync(hashPath).size > 0) {
              reusedExistingDiskBytes = true;
            }
          } catch {
            reusedExistingDiskBytes = false;
          }
        }

        if (!reusedExistingDiskBytes && !fs.existsSync(finalFilePath)) {
          const tempPath = path.join(
            path.dirname(finalFilePath),
            `.tmp_${validated.contentHash}_${randomUUID()}`,
          );
          fs.writeFileSync(tempPath, buffer);
          fs.renameSync(tempPath, finalFilePath);
        }

        const activeLocalName =
          reusedExistingDiskBytes && existingByHash ? existingByHash.localPath : localFileName;
        const activeDiskPath = resolveSafeCachedImagePath(cacheDir, activeLocalName);
        const diskSize = fs.statSync(activeDiskPath).size;
        const now = new Date().toISOString();

        const saved = saveBrollAsset({
          id: randomUUID(),
          normalizedUrl,
          sourceUrl: normalizedUrl,
          pageUrl: candidate.pageUrl,
          title: candidate.title,
          contentHash: validated.contentHash,
          localPath: activeLocalName,
          mimeType: validated.mimeType,
          // Preserve original Commons dimensions when known, falling back to actual decoded dimensions
          width: candidate.width || validated.width,
          height: candidate.height || validated.height,
          fileSize: diskSize,
          focalX: existingByHash?.focalX ?? validated.focalX,
          focalY: existingByHash?.focalY ?? validated.focalY,
          attribution: candidate.attribution,
          license: candidate.license,
          description: candidate.description,
          searchTerms: incomingTerms,
          createdAt: now,
          lastUsedAt: now,
        });

        return {
          ...saved,
          absolutePath: activeDiskPath,
          cacheHit: reusedExistingDiskBytes,
        };
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }

    return null;
  })();

  inFlightDownloads.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inFlightDownloads.delete(inflightKey);
  }
}

/**
 * Search Wikimedia Commons with persistent SQLite query caching (`broll_search_cache`).
 */
export async function searchWithPersistentCache(
  query: string,
  options: {
    subjectKind?: BrollSubjectKind;
    limit?: number;
    timeoutMs?: number;
    maxImageBytes?: number;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    cacheTtlMs?: number;
  } = {},
): Promise<{ candidates: BrollSearchCandidate[]; cacheHit: boolean }> {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalizedQuery) return { candidates: [], cacheHit: false };

  const cached = getCachedBrollSearch(normalizedQuery, options.cacheTtlMs);
  if (cached !== null) {
    return { candidates: cached, cacheHit: true };
  }

  const candidates = await searchWikimediaCommons(query, options);
  // Only persist non-empty results so transient network outages never poison future clips!
  if (candidates.length > 0) {
    try {
      saveCachedBrollSearch(normalizedQuery, query.trim(), candidates);
    } catch {
      // Non-fatal SQLite contention guard
    }
  }
  return { candidates, cacheHit: false };
}

/**
 * Reuse already-downloaded local cached images across different clips even when
 * offline or rate-limited, scored with the exact same relevance gate.
 */
export function findRelevantCachedAssetsForQuery(
  query: string,
  options: {
    cacheDir?: string;
    subjectKind?: BrollSubjectKind;
    minRelevanceScore?: number;
  } = {},
): Array<{ asset: ResolvedBrollAsset; score: number; canonicalStem: string }> {
  const cacheDir = resolveBrollCacheDir(options.cacheDir);
  const minScore = options.minRelevanceScore ?? MIN_RELEVANCE_SCORE;
  const rows: BrollAssetRecord[] = listCachedBrollAssets(500);
  const matches: Array<{ asset: ResolvedBrollAsset; score: number; canonicalStem: string }> = [];

  for (const row of rows) {
    let diskPath: string;
    try {
      diskPath = resolveSafeCachedImagePath(cacheDir, row.localPath);
      if (!fs.existsSync(diskPath) || fs.statSync(diskPath).size === 0) continue;
    } catch {
      continue;
    }

    const combinedTitle = [row.title ?? '', ...row.searchTerms].filter(Boolean).join(' ');
    const score = scoreCandidateRelevance({
      title: combinedTitle,
      description: row.description,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      query,
      subjectKind: options.subjectKind,
    });
    if (score < minScore) continue;

    matches.push({
      asset: { ...row, absolutePath: diskPath, cacheHit: true },
      score,
      canonicalStem: canonicalizeMediaStem(row.title || row.localPath),
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}
