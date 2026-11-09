import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeOverlayCanvasRegion,
  sameOverlayCanvasRegion,
  type OverlayCanvasRegion,
} from "../lib/overlay-canvas";
import { getTempDirValue } from "../lib/paths";

/**
 * Bump this whenever the transparent Remotion composition, its bundled assets,
 * or the interpretation of a cache-key field changes. Cache directories are
 * deliberately disposable, so an explicit version is safer than guessing from
 * a source checkout timestamp.
 */
export const OVERLAY_FRAME_CACHE_VERSION = 1;

const DEFAULT_OVERLAY_FRAME_CACHE_MAX_MB = 1_024;
const MIN_OVERLAY_FRAME_CACHE_MAX_MB = 128;
const MAX_OVERLAY_FRAME_CACHE_MAX_MB = 8_192;
const DEFAULT_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS = 14;
const MIN_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS = 1;
const MAX_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS = 90;
const STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

export type OverlayFrameCacheKind = "caption" | "broll";

export interface OverlayFrameCacheSettings {
  enabled: boolean;
  directory: string;
  maxBytes: number;
  maxAgeMs: number;
}

export interface OverlayFrameCacheDescriptor {
  kind: OverlayFrameCacheKind;
  /** SHA-256 cache identity built from every visual input to this sequence. */
  key: string;
  /** Normalized `ov_00001.png` through `ov_NNNNN.png` frame count. */
  frameCount: number;
  /** Physical transparent PNG canvas and its virtual output origin. */
  canvas: OverlayCanvasRegion;
}

export interface OverlayFrameCacheEntry extends OverlayFrameCacheDescriptor {
  directory: string;
  inputPattern: string;
  bytes: number;
}

interface OverlayFrameCacheManifest {
  version: number;
  kind: OverlayFrameCacheKind;
  key: string;
  frameCount: number;
  canvas: OverlayCanvasRegion;
  createdAt: number;
}

interface CacheDirectoryStats {
  directory: string;
  bytes: number;
  mtimeMs: number;
}

function isDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? "");
}

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw?.trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Overlay-frame cache controls are read at the start of every render job. No
 * worker restart is necessary after changing a cache env value.
 */
export function getOverlayFrameCacheSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OverlayFrameCacheSettings {
  const configuredDirectory = env.OVERLAY_RENDER_CACHE_DIR?.trim();
  const maxMb = boundedNumber(
    env.OVERLAY_RENDER_CACHE_MAX_MB,
    DEFAULT_OVERLAY_FRAME_CACHE_MAX_MB,
    MIN_OVERLAY_FRAME_CACHE_MAX_MB,
    MAX_OVERLAY_FRAME_CACHE_MAX_MB,
  );
  const maxAgeDays = boundedNumber(
    env.OVERLAY_RENDER_CACHE_MAX_AGE_DAYS,
    DEFAULT_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS,
    MIN_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS,
    MAX_OVERLAY_FRAME_CACHE_MAX_AGE_DAYS,
  );
  return {
    enabled: !isDisabled(env.OVERLAY_RENDER_CACHE_ENABLED),
    directory: path.resolve(
      configuredDirectory || path.join(getTempDirValue(), "overlay-frame-cache"),
    ),
    maxBytes: Math.floor(maxMb * 1024 * 1024),
    maxAgeMs: Math.floor(maxAgeDays * 24 * 60 * 60 * 1_000),
  };
}

/**
 * Canonical JSON prevents an object property's insertion order from producing
 * a needless cache miss. `undefined`, non-finite numbers, and bigint values
 * are made explicit too, rather than inheriting JSON.stringify's omissions.
 */
function stableValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`$number:${String(value)}`);
    case "bigint":
      return JSON.stringify(`$bigint:${value.toString()}`);
    case "undefined":
      return JSON.stringify("$undefined");
    case "object":
      if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    default:
      return JSON.stringify(`$${typeof value}:${String(value)}`);
  }
}

/**
 * Create a cache key from visual inputs only. Callers intentionally leave out
 * runtime-only knobs such as Chrome tab count, loopback port, and progress
 * callbacks so a host tune-up never invalidates correct transparent frames.
 */
export function buildOverlayFrameCacheKey(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`overlay-frame-cache:${OVERLAY_FRAME_CACHE_VERSION}:${stableValue(input)}`)
    .digest("hex");
}

function cacheKindDirectory(settings: OverlayFrameCacheSettings, kind: OverlayFrameCacheKind): string {
  return path.join(settings.directory, kind);
}

function isSafeCacheKey(key: string): boolean {
  return /^[a-f\d]{64}$/i.test(key);
}

function entryDirectory(
  settings: OverlayFrameCacheSettings,
  kind: OverlayFrameCacheKind,
  key: string,
): string {
  if (!isSafeCacheKey(key)) throw new Error("Overlay frame cache key is not a SHA-256 digest.");
  return path.join(cacheKindDirectory(settings, kind), key);
}

function inputPattern(directory: string): string {
  return path.join(directory, "ov_%05d.png");
}

function manifestPath(directory: string): string {
  return path.join(directory, "manifest.json");
}

function framePath(directory: string, frameNumber: number): string {
  return path.join(directory, `ov_${String(frameNumber).padStart(5, "0")}.png`);
}

/** Read only the PNG shape fields needed to reject a half-written/bad entry. */
function hasExpectedPngShape(filePath: string, canvas: OverlayCanvasRegion): boolean {
  try {
    const descriptor = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(26);
      if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
      if (header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
      return (
        header.subarray(12, 16).toString("ascii") === "IHDR" &&
        header.readUInt32BE(16) === canvas.width &&
        header.readUInt32BE(20) === canvas.height &&
        // grayscale+alpha or truecolor+alpha; Remotion uses truecolor+alpha.
        (header[25] === 4 || header[25] === 6)
      );
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function expectedFrames(
  directory: string,
  frameCount: number,
  canvas: OverlayCanvasRegion,
): { paths: string[]; bytes: number } | null {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) return null;
  const paths: string[] = [];
  let bytes = 0;
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const candidate = framePath(directory, frame);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size < 26 || !hasExpectedPngShape(candidate, canvas)) return null;
      paths.push(candidate);
      bytes += stat.size;
    } catch {
      return null;
    }
  }
  return { paths, bytes };
}

function parseManifest(directory: string): OverlayFrameCacheManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(directory), "utf8")) as Partial<OverlayFrameCacheManifest>;
    if (
      parsed.version !== OVERLAY_FRAME_CACHE_VERSION ||
      (parsed.kind !== "caption" && parsed.kind !== "broll") ||
      typeof parsed.key !== "string" ||
      !isSafeCacheKey(parsed.key) ||
      !Number.isSafeInteger(parsed.frameCount) ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return {
      version: OVERLAY_FRAME_CACHE_VERSION,
      kind: parsed.kind,
      key: parsed.key,
      frameCount: parsed.frameCount as number,
      canvas: normalizeOverlayCanvasRegion(parsed.canvas),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function touch(directory: string): void {
  try {
    const now = new Date();
    fs.utimesSync(directory, now, now);
  } catch {
    // LRU touching is opportunistic; a valid hit remains valid when it fails.
  }
}

/**
 * Return only a complete, version-matching entry. A corrupt/partial entry is
 * removed as a cache miss; never feed partial frames to FFmpeg.
 */
export function readOverlayFrameCache(
  settings: OverlayFrameCacheSettings,
  descriptor: OverlayFrameCacheDescriptor,
): OverlayFrameCacheEntry | null {
  if (!settings.enabled) return null;
  const canvas = normalizeOverlayCanvasRegion(descriptor.canvas);
  let directory: string;
  try {
    directory = entryDirectory(settings, descriptor.kind, descriptor.key);
  } catch {
    return null;
  }
  const manifest = parseManifest(directory);
  const matches =
    manifest &&
    manifest.kind === descriptor.kind &&
    manifest.key === descriptor.key &&
    manifest.frameCount === descriptor.frameCount &&
    sameOverlayCanvasRegion(manifest.canvas, canvas);
  const frames = matches ? expectedFrames(directory, descriptor.frameCount, canvas) : null;
  if (!frames) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // A concurrent renderer/clear may own the path now; a later job can repair it.
    }
    return null;
  }
  touch(directory);
  return {
    ...descriptor,
    canvas,
    directory,
    inputPattern: inputPattern(directory),
    bytes: frames.bytes,
  };
}

/**
 * A render always writes into an unpublished sibling directory. The final
 * publish is an atomic rename, so a second process can only ever observe a
 * complete manifest plus all numbered PNGs.
 */
export function createOverlayFrameCacheStagingDirectory(
  settings: OverlayFrameCacheSettings,
  kind: OverlayFrameCacheKind,
  key: string,
): string | null {
  if (!settings.enabled || !isSafeCacheKey(key)) return null;
  try {
    const directory = cacheKindDirectory(settings, kind);
    fs.mkdirSync(directory, { recursive: true });
    return fs.mkdtempSync(path.join(directory, `.staging-${key.slice(0, 12)}-`));
  } catch {
    return null;
  }
}

/** Best-effort removal for a staging directory that did not become a cache hit. */
export function removeOverlayFrameCacheStaging(directory: string | null | undefined): void {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch {
    // The next bounded cleanup will sweep old staging directories.
  }
}

function writeManifestAtomic(directory: string, manifest: OverlayFrameCacheManifest): boolean {
  const target = manifestPath(directory);
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest), "utf8");
    fs.renameSync(temporary, target);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // best effort
    }
    return false;
  }
}

/**
 * Publish a normalized staging directory, or return the already-published
 * winner if another worker rendered the same key concurrently. A publish error
 * is a cache miss; the caller still owns usable frames in its work directory.
 */
export function publishOverlayFrameCache(
  settings: OverlayFrameCacheSettings,
  descriptor: OverlayFrameCacheDescriptor,
  stagingDirectory: string,
): OverlayFrameCacheEntry | null {
  if (!settings.enabled) return null;
  const canvas = normalizeOverlayCanvasRegion(descriptor.canvas);
  if (!expectedFrames(stagingDirectory, descriptor.frameCount, canvas)) return null;
  const manifest: OverlayFrameCacheManifest = {
    version: OVERLAY_FRAME_CACHE_VERSION,
    kind: descriptor.kind,
    key: descriptor.key,
    frameCount: descriptor.frameCount,
    canvas,
    createdAt: Date.now(),
  };
  if (!writeManifestAtomic(stagingDirectory, manifest)) return null;

  let target: string;
  try {
    target = entryDirectory(settings, descriptor.kind, descriptor.key);
  } catch {
    return null;
  }
  try {
    fs.renameSync(stagingDirectory, target);
  } catch {
    // The usual cause is a concurrent job publishing an identical immutable
    // entry. Discard our staging copy, then validate the winner before using it.
    removeOverlayFrameCacheStaging(stagingDirectory);
  }
  return readOverlayFrameCache(settings, descriptor);
}

/**
 * Give the active job a stable copy of cached frames. Hard links avoid a second
 * multi-hundred-MB write on normal local filesystems; copy is a safe fallback
 * on filesystems that do not support links. This makes Settings -> Clear cache
 * harmless to an FFmpeg process that has already prepared its inputs.
 */
export function materializeOverlayFrameCache(
  entry: OverlayFrameCacheEntry,
  destinationDirectory: string,
): string | null {
  const canvas = normalizeOverlayCanvasRegion(entry.canvas);
  const frames = expectedFrames(entry.directory, entry.frameCount, canvas);
  if (!frames) return null;
  try {
    fs.rmSync(destinationDirectory, { recursive: true, force: true });
    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (let index = 0; index < frames.paths.length; index += 1) {
      const source = frames.paths[index];
      const destination = framePath(destinationDirectory, index + 1);
      try {
        fs.linkSync(source, destination);
      } catch {
        fs.copyFileSync(source, destination);
      }
    }
    return inputPattern(destinationDirectory);
  } catch {
    try {
      fs.rmSync(destinationDirectory, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return null;
  }
}

function directorySize(directory: string): number {
  let total = 0;
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) visit(candidate);
        else if (entry.isFile()) total += fs.statSync(candidate).size;
      } catch {
        // Another cache cleanup may have removed it between readdir and stat.
      }
    }
  };
  visit(directory);
  return total;
}

function cacheDirectories(settings: OverlayFrameCacheSettings): CacheDirectoryStats[] {
  const entries: CacheDirectoryStats[] = [];
  for (const kind of ["caption", "broll"] as const) {
    const directory = cacheKindDirectory(settings, kind);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const candidate = path.join(directory, child.name);
      if (!child.isDirectory()) continue;
      if (child.name.startsWith(".staging-")) {
        try {
          const stat = fs.statSync(candidate);
          if (Date.now() - stat.mtimeMs > STAGING_MAX_AGE_MS) {
            fs.rmSync(candidate, { recursive: true, force: true });
          }
        } catch {
          // best effort only
        }
        continue;
      }
      if (!isSafeCacheKey(child.name) || !parseManifest(candidate)) {
        try {
          fs.rmSync(candidate, { recursive: true, force: true });
        } catch {
          // best effort only
        }
        continue;
      }
      try {
        const stat = fs.statSync(candidate);
        entries.push({ directory: candidate, bytes: directorySize(candidate), mtimeMs: stat.mtimeMs });
      } catch {
        // a concurrent clear removed this entry
      }
    }
  }
  return entries;
}

/**
 * Drop expired entries, then least-recently-used entries until bounded disk
 * storage fits. It is called after publishing a complete entry and may be
 * invoked by maintenance/tests without affecting a cache miss.
 */
export function enforceOverlayFrameCacheLimit(
  settings: OverlayFrameCacheSettings = getOverlayFrameCacheSettings(),
): void {
  if (!settings.enabled) return;
  const now = Date.now();
  const usable: CacheDirectoryStats[] = [];
  for (const entry of cacheDirectories(settings)) {
    if (now - entry.mtimeMs > settings.maxAgeMs) {
      try {
        fs.rmSync(entry.directory, { recursive: true, force: true });
      } catch {
        // Keep a stubborn entry in the next LRU sweep.
        usable.push(entry);
      }
    } else {
      usable.push(entry);
    }
  }
  const oldestFirst = usable.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of oldestFirst) {
    if (total <= settings.maxBytes) break;
    try {
      fs.rmSync(entry.directory, { recursive: true, force: true });
      total -= entry.bytes;
    } catch {
      // Retain it for the next job's best-effort cleanup.
    }
  }
}

export interface ClearedOverlayFrameCache {
  entries: number;
  bytes: number;
}

/**
 * Settings action: remove only rendered transparent-frame entries, never source
 * uploads, finished clips, B-roll downloads, or user fonts. Active jobs use
 * linked/copied workdir inputs, so clearing this cache cannot invalidate their
 * already-prepared FFmpeg sequences.
 */
export function clearOverlayFrameCache(
  settings: Pick<OverlayFrameCacheSettings, "directory"> = getOverlayFrameCacheSettings(),
): ClearedOverlayFrameCache {
  const cacheSettings: OverlayFrameCacheSettings = {
    enabled: true,
    directory: settings.directory,
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
  };
  const entries = cacheDirectories(cacheSettings);
  const result = {
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  try {
    fs.rmSync(settings.directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch {
    // Cache rebuilding is always safe. Return the observed scope even if a locked
    // filesystem leaves a later startup/job cleanup to finish the deletion.
  }
  return result;
}
