import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from './errors';
import {
  assertUploadSizeAllowed,
  buildStoredFileName,
  formatBytes,
  getChunkSizeBytes,
  getMaxUploadBytes,
  registerUploadedVideo,
  resolveUploadDir,
  validateUploadFileName,
} from './upload';
import { VideoRecord } from './types';

/**
 * Resumable, chunked upload sessions for long recordings.
 *
 * A session is a directory inside `UPLOAD_DIR/.upload-sessions/<id>/`:
 *
 *   data       - the partially received file, written sequentially
 *   meta.json  - original name, declared size, byte counters
 *
 * The browser slices the file and PUTs one chunk per request. Nothing is buffered in
 * memory (bytes go straight to disk with backpressure) and a dropped connection, a
 * dev-server restart or a 5-minute proxy timeout no longer kills the upload: the client
 * asks for the current `receivedBytes` and continues from there.
 *
 * Finalising moves the file into `UPLOAD_DIR` with `fs.rename` - an instant metadata
 * operation even for a multi-gigabyte file - and only then probes/saves/queues.
 */

export interface UploadSessionMeta {
  id: string;
  originalName: string;
  /** What the client says it will send. 0 when unknown; used to detect truncated files. */
  declaredSize: number;
  /** Bytes on disk right now (always measured, never trusted from meta.json). */
  receivedBytes: number;
  chunkSize: number;
  createdAt: string;
  updatedAt: string;
}

const SESSION_DIR_NAME = '.upload-sessions';
const ID_PATTERN = /^[a-z0-9]{8,64}$/;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_HOURS = 24;

let lastCleanupAt = 0;

/** Raised when a chunk arrives for the wrong offset; carries the truth for re-syncing. */
export class UploadOffsetMismatchError extends AppError {
  public readonly receivedBytes: number;
  public readonly expectedOffset: number;

  constructor(expectedOffset: number, receivedBytes: number) {
    super('Chunk offset does not match the server.', {
      status: 409,
      details: `Client started chunk at ${expectedOffset}, server has ${receivedBytes} bytes.`,
      resolution:
        'GET the session to read `receivedBytes` and continue from there (the uploader does this automatically).',
    });
    this.name = 'UploadOffsetMismatchError';
    this.receivedBytes = receivedBytes;
    this.expectedOffset = expectedOffset;
  }
}

export function getSessionTtlMs(): number {
  const hours = Number(process.env.UPLOAD_SESSION_TTL_HOURS?.trim() ?? '');
  const value = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_TTL_HOURS;
  return value * 60 * 60 * 1000;
}

function sessionsRoot(): string {
  return path.join(resolveUploadDir(), SESSION_DIR_NAME);
}

function assertSessionId(id: string): string {
  if (!ID_PATTERN.test(id || '')) {
    throw new AppError('Unknown upload session.', {
      status: 404,
      details: id,
      resolution: 'Start a new upload - the session id is invalid or has expired.',
    });
  }
  return id;
}

function sessionDir(id: string): string {
  return path.join(sessionsRoot(), assertSessionId(id));
}

function sessionDataPath(id: string): string {
  return path.join(sessionDir(id), 'data');
}

function sessionMetaPath(id: string): string {
  return path.join(sessionDir(id), 'meta.json');
}

function statSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function writeMeta(meta: UploadSessionMeta): void {
  const target = sessionMetaPath(meta.id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2));
  // Atomic replace so a crash mid-write cannot leave a half-written meta.json behind.
  fs.renameSync(temp, target);
}

function readMeta(id: string): UploadSessionMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMetaPath(id), 'utf8')) as UploadSessionMeta;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function getSessionInfo(id: string): UploadSessionMeta {
  assertSessionId(id);
  const meta = readMeta(id);

  if (!meta) {
    throw new AppError('Upload session not found.', {
      status: 404,
      details: id,
      resolution:
        'The session expired or was cleaned up (see UPLOAD_SESSION_TTL_HOURS). Start the upload again.',
    });
  }

  // Trust the file, not meta.json: an aborted request can leave extra bytes on disk.
  return {
    ...meta,
    id,
    receivedBytes: statSize(sessionDataPath(id)),
    chunkSize: meta.chunkSize || getChunkSizeBytes(),
  };
}

/** Start a session and create its (empty) data file. */
export async function createUploadSession(input: {
  fileName: string;
  fileSize?: number;
}): Promise<UploadSessionMeta> {
  const originalName = validateUploadFileName(input.fileName);

  const declaredSize =
    typeof input.fileSize === 'number' && Number.isFinite(input.fileSize) && input.fileSize > 0
      ? Math.floor(input.fileSize)
      : 0;

  if (declaredSize > 0) assertUploadSizeAllowed(declaredSize);

  // Opportunistic housekeeping: abandoned multi-GB sessions must not fill the disk.
  cleanupStaleUploadSessions().catch(() => undefined);

  const id = randomBytes(9).toString('hex');
  fs.mkdirSync(sessionDir(id), { recursive: true });
  fs.writeFileSync(sessionDataPath(id), '');

  const now = new Date().toISOString();
  const meta: UploadSessionMeta = {
    id,
    originalName,
    declaredSize,
    receivedBytes: 0,
    chunkSize: getChunkSizeBytes(),
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(meta);

  console.log(
    `[Upload] Session ${id} created for "${originalName}"${
      declaredSize ? ` (${formatBytes(declaredSize)})` : ''
    } - chunk size ${formatBytes(meta.chunkSize)}.`
  );

  return meta;
}

/**
 * Append one chunk to the session file.
 *
 * `expectedOffset` is what the client believes it already sent (its `?offset=` query
 * parameter). If it disagrees with the file on disk the server refuses the chunk and
 * reports the real size, so a lost chunk can never silently corrupt the file.
 */
export async function appendUploadChunk(
  id: string,
  expectedOffset: number | null,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadSessionMeta> {
  const session = getSessionInfo(id);

  if (expectedOffset !== null && expectedOffset !== session.receivedBytes) {
    throw new UploadOffsetMismatchError(expectedOffset, session.receivedBytes);
  }

  if (!body) {
    throw new AppError('No chunk payload was received.', {
      status: 400,
      resolution: 'Send the raw bytes of the chunk as the request body.',
    });
  }

  if (session.declaredSize > 0 && session.receivedBytes >= session.declaredSize) {
    throw new AppError('This upload already has all of its bytes.', {
      status: 409,
      details: `${formatBytes(session.receivedBytes)} received of ${formatBytes(session.declaredSize)}.`,
      resolution: 'POST to the session to finish it (finalize), or start a new upload.',
    });
  }

  const dataPath = sessionDataPath(id);
  // `r+` keeps the existing bytes and writes sequentially from the current end of file.
  const fileStream = fs.createWriteStream(dataPath, {
    flags: 'r+',
    start: session.receivedBytes,
  });

  const maxUploadBytes = getMaxUploadBytes();
  let written = 0;
  let streamError: Error | null = null;

  fileStream.on('error', (error) => {
    streamError = error;
  });

  const abort = new AbortController();

  try {
    for await (const chunk of webStreamToAsyncIterable(body, abort.signal)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buffer.byteLength;

      const totalAfterChunk = session.receivedBytes + written;

      if (maxUploadBytes > 0 && totalAfterChunk > maxUploadBytes) {
        throw new AppError(
          `Upload is larger than the configured MAX_UPLOAD_MB (${formatBytes(maxUploadBytes)}).`,
          {
            status: 413,
            resolution:
              'Raise or remove MAX_UPLOAD_MB in .env.local (0 = unlimited), then start a new upload.',
          }
        );
      }

      if (session.declaredSize > 0 && totalAfterChunk > session.declaredSize) {
        throw new AppError('Chunk is bigger than the declared file size.', {
          status: 400,
          details: `${formatBytes(totalAfterChunk)} received, ${formatBytes(session.declaredSize)} declared.`,
          resolution: 'Start a new upload session - the client and server sizes disagree.',
        });
      }

      if (!fileStream.write(buffer)) {
        // Respect backpressure: memory stays flat no matter how big the chunk is.
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            fileStream.off('error', onError);
            resolve();
          };
          const onError = (error: Error) => {
            fileStream.off('drain', onDrain);
            reject(error);
          };
          fileStream.once('drain', onDrain);
          fileStream.once('error', onError);
        });
      }

      if (streamError) throw streamError;
    }

    // A late write error can arrive between the last write() and end() - surface it
    // instead of reporting a truncated chunk as successful.
    if (streamError) throw streamError;

    await new Promise<void>((resolve, reject) => {
      fileStream.once('finish', () => resolve());
      fileStream.once('error', reject);
      fileStream.end();
    });

    if (streamError) throw streamError;
  } catch (error) {
    fileStream.destroy();
    abort.abort();
    // Keep whatever actually reached the disk - the next request resumes exactly there.
    syncReceivedBytes(id, session);
    throw error;
  }

  return syncReceivedBytes(id, session);
}

/** Rewrites meta.receivedBytes from the real file size and returns the fresh session. */
function syncReceivedBytes(id: string, session: UploadSessionMeta): UploadSessionMeta {
  const receivedBytes = statSize(sessionDataPath(id));
  const updated: UploadSessionMeta = {
    ...session,
    receivedBytes,
    updatedAt: new Date().toISOString(),
  };

  try {
    writeMeta(updated);
  } catch (error) {
    console.warn(
      `[Upload] Could not update session ${id} metadata: ${toErrorMessage(error)}`
    );
  }

  return updated;
}

/**
 * Bridge a web ReadableStream (what `request.body` is inside a Route Handler) to an
 * async iterable of Uint8Array chunks, cancelling the reader if the caller aborts.
 */
async function* webStreamToAsyncIterable(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock?.();
    }
  }

  // Fallback for a Node stream that somehow reaches us in place of a web stream.
  const nodeStream = body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of nodeStream) {
    yield chunk;
  }
}

/**
 * Finish an upload: move the assembled file into UPLOAD_DIR, probe it, store the record
 * and queue transcription.
 *
 * If the record cannot be saved (MongoDB down, ...) the file is moved back into the
 * session so the user can retry the finish step without re-uploading gigabytes.
 */
export async function finalizeUploadSession(id: string): Promise<{
  video: VideoRecord;
  transcriptionQueued: boolean;
  receivedBytes: number;
}> {
  const session = getSessionInfo(id);
  const dataPath = sessionDataPath(id);

  if (session.receivedBytes === 0) {
    throw new AppError('The uploaded file is empty.', {
      status: 400,
      resolution: 'Re-export the video and upload it again.',
    });
  }

  if (session.declaredSize > 0 && session.receivedBytes < session.declaredSize) {
    throw new AppError('The upload is incomplete.', {
      status: 409,
      details: `${formatBytes(session.receivedBytes)} of ${formatBytes(session.declaredSize)} received.`,
      resolution: `Resume the upload: PUT the remaining bytes starting at offset ${session.receivedBytes}.`,
    });
  }

  assertUploadSizeAllowed(session.receivedBytes);
  const originalName = validateUploadFileName(session.originalName);

  const uploadDir = resolveUploadDir();
  const storedName = buildStoredFileName(originalName);
  const finalPath = path.join(uploadDir, storedName);

  // rename() is metadata-only inside the same filesystem, so this is instant even for
  // a 5 GB recording. copyFile() only kicks in when UPLOAD_DIR sits on another drive.
  await moveFile(dataPath, finalPath);

  try {
    const { video, queued } = await registerUploadedVideo(originalName, storedName, finalPath);
    await removeSessionDir(id);
    console.log(
      `[Upload] Session ${id} finalized: ${formatBytes(session.receivedBytes)} -> ${finalPath}`
    );
    return { video, transcriptionQueued: queued, receivedBytes: session.receivedBytes };
  } catch (error) {
    try {
      await moveFile(finalPath, dataPath);
    } catch (revertError) {
      console.error(
        `[Upload] Session ${id} could not be restored after a failed finalize (the file stays at ${finalPath}): ${toErrorMessage(revertError)}`
      );
    }
    throw error;
  }
}

/** Discard a session and its partial file. Safe to call for an unknown session. */
export async function abortUploadSession(id: string): Promise<void> {
  assertSessionId(id);
  await removeSessionDir(id);
  console.log(`[Upload] Session ${id} cancelled - partial file deleted.`);
}

async function removeSessionDir(id: string): Promise<void> {
  await fs.promises.rm(sessionDir(id), { recursive: true, force: true });
}

/** Move a file, falling back to copy + unlink across filesystems (EXDEV). */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error;

    // EPERM/EACCES happens on Windows when a virus scanner or the media player holds the
    // file open - a copy is slow but always works.
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

/**
 * Delete sessions nobody finished (browser closed, dev-server restart, ...). Without
 * this, every abandoned multi-GB upload would keep its bytes on disk forever.
 * Throttled so the check costs nothing on a normal upload.
 */
export async function cleanupStaleUploadSessions(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return 0;
  lastCleanupAt = now;

  const root = sessionsRoot();
  let removed = 0;

  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return 0; // Nothing uploaded yet.
  }

  const ttlMs = getSessionTtlMs();

  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;

    const dir = path.join(root, entry.name);
    let lastTouched = 0;
    try {
      const stat = await fs.promises.stat(dir);
      lastTouched = stat.mtimeMs;
    } catch {
      continue;
    }

    const meta = readMeta(entry.name);
    if (meta?.updatedAt) {
      const updatedAt = Date.parse(meta.updatedAt);
      if (Number.isFinite(updatedAt)) lastTouched = Math.max(lastTouched, updatedAt);
    }

    if (now - lastTouched < ttlMs) continue;

    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed += 1;
      console.log(
        `[Upload] Removed stale upload session ${entry.name} (no activity for ${(ttlMs / 3_600_000).toFixed(0)} h).`
      );
    } catch (error) {
      console.warn(
        `[Upload] Could not remove stale session ${entry.name}: ${toErrorMessage(error)}`
      );
    }
  }

  return removed;
}
