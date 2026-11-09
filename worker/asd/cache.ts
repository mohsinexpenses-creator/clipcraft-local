import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { AsdResult } from "./index";

/** Bump whenever an ASD algorithm/input interpretation changes. */
export const ASD_CACHE_VERSION = 1;
const DEFAULT_ASD_CACHE_MAX_MB = 512;
const MIN_ASD_CACHE_MAX_MB = 32;
const MAX_ASD_CACHE_MAX_MB = 4_096;

export interface AsdCacheSettings {
  enabled: boolean;
  directory: string;
  maxBytes: number;
}

export interface AsdSourceIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  key: string;
}

export interface AsdResultCacheKeyInput {
  source: AsdSourceIdentity;
  start: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  hasAudio: boolean;
  adaptive: boolean;
  initialProfile: string;
  maxSampleFps?: number;
  maxFrames?: number;
  detectionConcurrency: number;
  skipFullFrameOnWideShots: boolean;
}

interface AsdCacheEnvelope {
  version: number;
  createdAt: number;
  result: AsdResult;
}

interface AsdProfileEnvelope {
  version: number;
  updatedAt: number;
  profile: "quality";
}

function disabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? "");
}

function cacheMaxBytes(env: Readonly<Record<string, string | undefined>>): number {
  const configured = Number(env.ASD_CACHE_MAX_MB?.trim());
  const mb = Number.isFinite(configured)
    ? Math.max(MIN_ASD_CACHE_MAX_MB, Math.min(MAX_ASD_CACHE_MAX_MB, configured))
    : DEFAULT_ASD_CACHE_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** ASD cache controls are read on every job, so no worker restart is required. */
export function getAsdCacheSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AsdCacheSettings {
  const configuredDirectory = env.ASD_CACHE_DIR?.trim();
  return {
    enabled: !disabled(env.ASD_CACHE_ENABLED),
    directory: path.resolve(configuredDirectory || path.join(process.cwd(), ".tmp", "asd-cache")),
    maxBytes: cacheMaxBytes(env),
  };
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The requested path + immutable file metadata prevents stale source reuse. */
export function getAsdSourceIdentity(videoPath: string): AsdSourceIdentity | null {
  try {
    const stat = fs.statSync(videoPath);
    if (!stat.isFile()) return null;
    const resolvedPath = path.resolve(videoPath);
    const size = stat.size;
    const mtimeMs = Math.round(stat.mtimeMs);
    return {
      path: resolvedPath,
      size,
      mtimeMs,
      key: hash({ path: resolvedPath, size, mtimeMs }),
    };
  } catch {
    return null;
  }
}

export function buildAsdResultCacheKey(input: AsdResultCacheKeyInput): string {
  return hash({ version: ASD_CACHE_VERSION, ...input });
}

function resultPath(settings: AsdCacheSettings, key: string): string {
  return path.join(settings.directory, "results", `${key}.json`);
}

function profilePath(settings: AsdCacheSettings, sourceKey: string): string {
  return path.join(settings.directory, "source-profiles", `${sourceKey}.json`);
}

function touch(filePath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch {
    // LRU touching is best effort only.
  }
}

function isCachedResult(value: unknown): value is AsdResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AsdResult>;
  return (
    Array.isArray(result.tracks) &&
    Array.isArray(result.speakerSegments) &&
    typeof result.speakerCount === "number" &&
    typeof result.sampleFps === "number" &&
    typeof result.framesTotal === "number" &&
    typeof result.hasAudio === "boolean"
  );
}

/** Cache corruption is treated as a miss; it can never block a render. */
export function readAsdResultCache(
  settings: AsdCacheSettings,
  key: string,
): AsdResult | null {
  if (!settings.enabled) return null;
  const filePath = resultPath(settings, key);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AsdCacheEnvelope>;
    if (parsed.version !== ASD_CACHE_VERSION || !isCachedResult(parsed.result)) return null;
    touch(filePath);
    return parsed.result;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
    fs.renameSync(temporary, filePath);
    return true;
  } catch {
    return false;
  }
}

interface CacheFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

function filesUnder(directory: string): CacheFile[] {
  const files: CacheFile[] = [];
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        try {
          const stat = fs.statSync(candidate);
          files.push({ path: candidate, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // A concurrent cleanup can remove it between readdir and stat.
        }
      }
    }
  };
  visit(directory);
  return files;
}

/** Remove least-recently-used entries until the bounded disk cache fits. */
export function enforceAsdCacheLimit(settings: AsdCacheSettings): void {
  if (!settings.enabled) return;
  const files = filesUnder(settings.directory).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of files) {
    if (total <= settings.maxBytes) break;
    try {
      fs.rmSync(file.path, { force: true });
      total -= file.bytes;
    } catch {
      // Leave it for the next job's best-effort sweep.
    }
  }
}

export function writeAsdResultCache(
  settings: AsdCacheSettings,
  key: string,
  result: AsdResult,
): boolean {
  if (!settings.enabled) return false;
  const written = writeJsonAtomic(resultPath(settings, key), {
    version: ASD_CACHE_VERSION,
    createdAt: Date.now(),
    result,
  } satisfies AsdCacheEnvelope);
  if (written) enforceAsdCacheLimit(settings);
  return written;
}

/** A quality retry is remembered per immutable source identity, not per clip. */
export function readAsdSourceProfile(
  settings: AsdCacheSettings,
  source: AsdSourceIdentity | null,
): "quality" | null {
  if (!settings.enabled || !source) return null;
  const filePath = profilePath(settings, source.key);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AsdProfileEnvelope>;
    if (parsed.version !== ASD_CACHE_VERSION || parsed.profile !== "quality") return null;
    touch(filePath);
    return "quality";
  } catch {
    return null;
  }
}

export function writeAsdSourceProfile(
  settings: AsdCacheSettings,
  source: AsdSourceIdentity | null,
  profile: "quality",
): boolean {
  if (!settings.enabled || !source) return false;
  const written = writeJsonAtomic(profilePath(settings, source.key), {
    version: ASD_CACHE_VERSION,
    updatedAt: Date.now(),
    profile,
  } satisfies AsdProfileEnvelope);
  if (written) enforceAsdCacheLimit(settings);
  return written;
}

/** Shared by the Phase 5 Settings action; harmless if the cache is absent. */
export function clearAsdCache(settings = getAsdCacheSettings()): void {
  try {
    fs.rmSync(settings.directory, { recursive: true, force: true });
  } catch {
    // A cache can always be rebuilt, so a locked file is non-fatal.
  }
}
