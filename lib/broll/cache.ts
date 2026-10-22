/**
 * On-disk cache for B-roll: downloaded images and provider/Gemini JSON answers.
 *
 * Two reasons this exists:
 *  1. Chromium never fetches a remote URL during a render (it cannot be trusted
 *     with third-party hosts, and a slow host would stall the render), so every
 *     image is downloaded once to a hash-keyed file and served from loopback.
 *  2. Re-running B-roll for a clip must be fast and cheap: the same query gets
 *     the same search results, and the same image gets the same verdict.
 *
 * Location: `<data dir>/broll-cache/` - next to clipcraft.db, ignored by git,
 * cleared by deleting the folder (the next B-roll run simply re-downloads).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getDatabasePath } from "../db";
import type { BrollFetch } from "./http";
import { fetchBytes } from "./http";
import { cacheKeyFor } from "./providers/types";

/** How long a cached provider answer is trusted. */
export const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Verdicts are stable (the same image, the same entity); a month is fine. */
export const VERDICT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Files on disk older than this are pruned opportunistically. */
export const IMAGE_CACHE_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

export function getBrollCacheRoot(): string {
  const dbPath = getDatabasePath();
  const base = dbPath === ":memory:" ? path.join(process.cwd(), "data") : path.dirname(dbPath);
  return path.join(base, "broll-cache");
}

export function brollImageDir(root = getBrollCacheRoot()): string {
  return path.join(root, "images");
}

export function brollJsonDir(root = getBrollCacheRoot()): string {
  return path.join(root, "json");
}

export async function ensureBrollCacheDirs(root = getBrollCacheRoot()): Promise<void> {
  await fs.mkdir(brollImageDir(root), { recursive: true });
  await fs.mkdir(brollJsonDir(root), { recursive: true });
}

/** Stable name for a provider answer (query + provider + options). */
export function jsonCacheKey(parts: Array<string | number | boolean>): string {
  return cacheKeyFor(parts.join("|"), "q");
}

interface CacheEnvelope<T> {
  cachedAt: number;
  value: T;
}

/** Read a JSON cache entry; anything unreadable or stale is a miss. */
export async function readJsonCache<T>(
  key: string,
  options: { ttlMs: number; root?: string; now?: number } = { ttlMs: SEARCH_CACHE_TTL_MS }
): Promise<T | null> {
  const file = path.join(brollJsonDir(options.root), `${key}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.cachedAt !== "number") return null;
    const now = options.now ?? Date.now();
    if (now - parsed.cachedAt > options.ttlMs) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export async function writeJsonCache<T>(
  key: string,
  value: T,
  options: { root?: string; now?: number } = {}
): Promise<void> {
  const dir = brollJsonDir(options.root);
  try {
    await fs.mkdir(dir, { recursive: true });
    const envelope: CacheEnvelope<T> = { cachedAt: options.now ?? Date.now(), value };
    const file = path.join(dir, `${key}.json`);
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(envelope), "utf8");
    await fs.rename(temp, file);
  } catch {
    // A cache write must never fail a B-roll run.
  }
}

function extensionForMime(mime: string, url: string): string {
  const normalised = mime.toLowerCase();
  if (normalised === "image/png") return ".png";
  if (normalised === "image/webp") return ".webp";
  if (normalised === "image/jpeg") return ".jpg";
  const fromUrl = path.extname(new URL(url, "https://example.invalid").pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(fromUrl) ? fromUrl : ".jpg";
}

export interface CachedImage {
  /** sha1 prefix of the source URL - the plan's `cacheKey`. */
  cacheKey: string;
  /** Original download in the cache dir. */
  sourceFile: string;
  bytes: Buffer;
}

/**
 * Download an image into the cache, or reuse the existing file. Concurrent runs
 * are safe: the write goes to a temp file and is renamed into place.
 */
export async function cacheImage(
  candidate: { imageUrl: string; mime?: string },
  options: { fetcher: BrollFetch; root?: string; timeoutMs?: number; provider: string }
): Promise<CachedImage> {
  const root = options.root ?? getBrollCacheRoot();
  const dir = brollImageDir(root);
  await fs.mkdir(dir, { recursive: true });

  const cacheKey = cacheKeyFor(candidate.imageUrl, "img");
  const extension = extensionForMime(candidate.mime ?? "image/jpeg", candidate.imageUrl);
  const sourceFile = `${cacheKey}${extension}`;
  const filePath = path.join(dir, sourceFile);

  try {
    const bytes = await fs.readFile(filePath);
    if (bytes.length > 0) return { cacheKey, sourceFile, bytes };
  } catch {
    // Cache miss - download below.
  }

  const bytes = await fetchBytes(candidate.imageUrl, {
    fetcher: options.fetcher,
    provider: options.provider,
    timeoutMs: options.timeoutMs,
  });
  if (bytes.length === 0) {
    throw new Error(`${options.provider} returned an empty image body.`);
  }
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, filePath);
  return { cacheKey, sourceFile, bytes };
}

/** Write a prepared render frame into the image cache (atomic replace). */
export async function writeBrollImage(
  fileName: string,
  buffer: Buffer,
  root = getBrollCacheRoot()
): Promise<string> {
  const dir = brollImageDir(root);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, path.basename(fileName));
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, buffer);
  await fs.rename(temp, filePath);
  return path.basename(filePath);
}

/** Absolute path of a cached image, used when serving it to Chromium. */
export function cachedImagePath(fileName: string, root = getBrollCacheRoot()): string {
  return path.join(brollImageDir(root), path.basename(fileName));
}

/** Delete anything older than the retention window. Best effort, never throws. */
export async function pruneImageCache(
  options: { root?: string; now?: number; maxAgeMs?: number } = {}
): Promise<number> {
  const dir = brollImageDir(options.root);
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? IMAGE_CACHE_MAX_AGE_MS;
  let removed = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > maxAge) {
          await fs.unlink(file);
          removed += 1;
        }
      } catch {
        // Raced with another prune; nothing to do.
      }
    }
  } catch {
    // No cache dir yet.
  }
  return removed;
}
