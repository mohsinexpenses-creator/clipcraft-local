import fs from 'fs';
import path from 'path';
import { getStoredPathSettings } from './app-settings';

/**
 * Where rendered 9:16 clips live: the directory saved on the Settings page,
 * otherwise `./generated-clips` next to the code. Clip records reference their
 * files with a logical `/generated-clips/...` prefix (see `ClipRecord.outputPath`),
 * and the media route maps that prefix onto this directory - so moving the
 * folder never orphans already-rendered clips.
 */
export function getClipsDirValue(): string {
  const stored = getStoredPathSettings().clipsDir;
  if (stored) return path.resolve(stored);
  return path.join(process.cwd(), 'generated-clips');
}

/** Same as `getClipsDirValue()` but guarantees the directory exists. */
export function resolveClipsDir(): string {
  const dir = getClipsDirValue();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isSubPathOrSame(parentDir: string, candidateDir: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidateDir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Persistent local directory for cached B-roll images, stored alongside SQLite
 * under `./data/broll-cache` by default so cached files survive restarts and
 * stay strictly outside `./generated-clips`.
 */
export function getBrollCacheDirValue(explicitDir?: string): string {
  const defaultDir = path.join(process.cwd(), 'data', 'broll-cache');
  const raw = explicitDir?.trim() || process.env.BROLL_CACHE_DIR?.trim();
  const resolved = raw ? path.resolve(raw) : defaultDir;
  const clipsDir = getClipsDirValue();
  if (isSubPathOrSame(clipsDir, resolved)) {
    return defaultDir;
  }
  return resolved;
}

/** Same as `getBrollCacheDirValue()` but guarantees the directory exists. */
export function resolveBrollCacheDir(explicitDir?: string): string {
  const dir = getBrollCacheDirValue(explicitDir);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  return dir;
}

