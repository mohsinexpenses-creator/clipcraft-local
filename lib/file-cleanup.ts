import fs from 'fs';
import path from 'path';
import {
  clearFileCleanup,
  enqueueFileCleanup,
  listFileCleanup,
} from './db';
import { toErrorMessage } from './errors';

/**
 * Resolve a logical `/generated-clips/...` output path inside the configured
 * clips root. Returning null for anything else prevents a corrupt DB row from
 * becoming a filesystem escape during deletion.
 */
export function outputPathToDiskPath(
  outputPath: string,
  clipsRoot: string,
): string | null {
  const prefix = '/generated-clips/';
  if (!outputPath.startsWith(prefix)) return null;
  return resolveInside(clipsRoot, outputPath.slice(prefix.length));
}

/** Return a normalized child path, or null when `child` escapes the trusted root. */
export function resolveInside(root: string, child: string): string | null {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, child);
  const relative = path.relative(absoluteRoot, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? candidate
    : null;
}

/**
 * Windows-safe removal. Node's native retry options cover transient EPERM and
 * ENOTEMPTY failures; persistent failures are recorded in SQLite for startup
 * sweeping rather than silently orphaning user data.
 */
export async function removePathOrDefer(
  targetPath: string,
  kind: string,
): Promise<boolean> {
  try {
    await fs.promises.rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 200,
    });
    return true;
  } catch (error) {
    try {
      await enqueueFileCleanup(targetPath, kind, toErrorMessage(error));
    } catch {
      // A temporary cleanup must never turn a successful render into a failure
      // merely because SQLite is unavailable while recording its retry.
    }
    return false;
  }
}

/** Retry deferred deletes at worker startup (and safely from a maintenance job). */
export async function sweepDeferredFileCleanup(limit = 250): Promise<{
  removed: number;
  remaining: number;
}> {
  const rows = await listFileCleanup(limit);
  let removed = 0;
  for (const row of rows) {
    try {
      await fs.promises.rm(row.path, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 200,
      });
      await clearFileCleanup(row.id);
      removed += 1;
    } catch {
      // Keep the persisted retry entry; `removePathOrDefer` is intentionally not
      // used here because it would inflate the attempt count on every startup.
    }
  }
  return { removed, remaining: rows.length - removed };
}
