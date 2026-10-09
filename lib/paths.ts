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
