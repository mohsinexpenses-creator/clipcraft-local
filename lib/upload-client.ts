import { VideoRecord } from './types';

/**
 * Browser half of the resumable upload protocol (app/api/upload/session/*).
 *
 * The file is sliced into chunks that are PUT one at a time, so:
 *   - a 3 GB podcast never sits in the dev server's RAM (bytes stream to disk),
 *   - no single request lives long enough to hit a proxy or Node request timeout,
 *   - a dropped connection resumes from the last byte the server confirmed,
 *   - the UI can show real progress, speed and ETA.
 *
 * Chunk size adapts to the measured throughput so weak connections keep each request
 * short (a chunk should take ~20 s), while fast local uploads use bigger chunks.
 */

const MIN_CHUNK_BYTES = 1 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const TARGET_SECONDS_PER_CHUNK = 20;
const MAX_CHUNK_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 700;

export interface UploadFileProgress {
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export type UploadPhase = 'uploading' | 'finalizing';

export interface UploadVideoFileOptions {
  /**
   * Resume an existing server session (e.g. after "Resume upload"). When omitted a new
   * session is created.
   */
  sessionId?: string;
  /** Called once the server assigned an id, so the caller can offer a resume later. */
  onSessionCreated?: (sessionId: string) => void;
  onProgress?: (progress: UploadFileProgress) => void;
  onPhase?: (phase: UploadPhase) => void;
  signal?: AbortSignal;
}

export interface UploadVideoFileResult {
  video: VideoRecord;
  transcriptionQueued: boolean;
  message?: string;
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadAbortedError';
  }
}

/** Thrown for a fatal server answer (bad request, disk full, ...). Not retried. */
export class UploadRequestError extends Error {
  public readonly status: number;
  public readonly resolution?: string;

  constructor(message: string, status: number, resolution?: string) {
    super(message);
    this.name = 'UploadRequestError';
    this.status = status;
    this.resolution = resolution;
  }
}

interface SessionInfo {
  id: string;
  chunkSize: number;
  receivedBytes: number;
  declaredSize: number;
  originalName?: string;
}

type JsonRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadAbortedError();
}

function parseJson(text: string): JsonRecord {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  } catch {
    return {};
  }
}

function describeServerError(body: JsonRecord, fallback: string): string {
  const message = asString(body.error) || asString(body.message) || fallback;
  const resolution = asString(body.resolution);
  return resolution ? `${message} ${resolution}` : message;
}

async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<{ status: number; ok: boolean; data: JsonRecord }> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  return { status: response.status, ok: response.ok, data: parseJson(text) };
}

/** PUT one chunk with XMLHttpRequest - `fetch()` cannot report upload progress. */
function putChunk(
  url: string,
  offset: number,
  chunk: Blob,
  onBytesSent: (sent: number) => void,
  signal?: AbortSignal
): Promise<{ receivedBytes: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${url}?offset=${offset}`, true);
    xhr.responseType = 'text';

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      xhr.abort();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onBytesSent(event.loaded);
    };

    xhr.onload = () => {
      const body = parseJson(xhr.responseText || '');

      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ receivedBytes: asNumber(body.receivedBytes) ?? offset + chunk.size });
          return;
        }

        reject(
          new UploadRequestError(
            describeServerError(body, `Upload failed (HTTP ${xhr.status}).`),
            xhr.status,
            asString(body.resolution)
          )
        );
      });
    };

    xhr.onerror = () => {
      finish(() => reject(new UploadRequestError('Network error while uploading.', 0)));
    };

    xhr.onabort = () => {
      finish(() => reject(new UploadAbortedError()));
    };

    xhr.send(chunk);
  });
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UploadAbortedError) return false;
  if (error instanceof UploadRequestError) {
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadAbortedError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function createSession(file: File, signal?: AbortSignal): Promise<SessionInfo> {
  const { ok, status, data } = await requestJson(
    '/api/upload/session',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
    },
    signal
  );

  if (!ok) {
    throw new UploadRequestError(
      describeServerError(data, 'Could not start the upload.'),
      status,
      asString(data.resolution)
    );
  }

  return {
    id: String(data.id),
    chunkSize: asNumber(data.chunkSize) || 8 * 1024 * 1024,
    receivedBytes: asNumber(data.receivedBytes) || 0,
    declaredSize: asNumber(data.declaredSize) || file.size,
  };
}

async function getSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const { ok, status, data } = await requestJson(
    `/api/upload/session/${sessionId}`,
    { method: 'GET' },
    signal
  );

  if (!ok) {
    throw new UploadRequestError(
      describeServerError(data, 'The upload session is no longer available.'),
      status,
      asString(data.resolution)
    );
  }

  return {
    id: sessionId,
    chunkSize: asNumber(data.chunkSize) || 8 * 1024 * 1024,
    receivedBytes: asNumber(data.receivedBytes) || 0,
    declaredSize: asNumber(data.declaredSize) || 0,
  };
}

/** Cancel a session and delete its partial file on the server. */
export async function deleteUploadSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/upload/session/${sessionId}`, { method: 'DELETE' });
  } catch {
    // Best effort: the stale-session cleanup removes it later.
  }
}

export async function uploadVideoFile(
  file: File,
  options: UploadVideoFileOptions = {}
): Promise<UploadVideoFileResult> {
  const { signal, onProgress, onPhase } = options;

  abortIfRequested(signal);
  onPhase?.('uploading');

  const session = options.sessionId
    ? await getSession(options.sessionId, signal)
    : await createSession(file, signal);

  options.onSessionCreated?.(session.id);

  let sent = clamp(session.receivedBytes, 0, file.size);
  let chunkBytes = clamp(session.chunkSize, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES);
  let bytesPerSecond = 0;

  const report = (uploadedBytes: number) => {
    const remaining = Math.max(file.size - uploadedBytes, 0);
    onProgress?.({
      uploadedBytes,
      totalBytes: file.size,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.ceil(remaining / bytesPerSecond) : null,
    });
  };

  report(sent);

  while (sent < file.size) {
    abortIfRequested(signal);

    const chunk = file.slice(sent, sent + chunkBytes);
    let attempt = 0;
    let chunkSentBase = sent;

    for (;;) {
      abortIfRequested(signal);
      const startedAt = Date.now();

      try {
        const result = await putChunk(
          `/api/upload/session/${session.id}`,
          sent,
          chunk,
          (loaded) => report(Math.min(chunkSentBase + loaded, file.size)),
          signal
        );

        const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.05);
        const measured = (result.receivedBytes - sent) / elapsed;
        if (Number.isFinite(measured) && measured > 0) {
          // Exponential moving average keeps the ETA from jumping around.
          bytesPerSecond = bytesPerSecond > 0 ? bytesPerSecond * 0.7 + measured * 0.3 : measured;
        }

        sent = result.receivedBytes;
        chunkBytes = clamp(
          Math.round(bytesPerSecond * TARGET_SECONDS_PER_CHUNK) || chunkBytes,
          MIN_CHUNK_BYTES,
          MAX_CHUNK_BYTES
        );
        chunkSentBase = sent;
        report(sent);
        break;
      } catch (error) {
        if (error instanceof UploadAbortedError) throw error;

        // 409: the server has a different number of bytes than the client thinks (a
        // request was cut off mid-chunk). Re-sync and continue from the real offset.
        if (error instanceof UploadRequestError && error.status === 409) {
          const resync = await getSession(session.id, signal);
          if (resync.receivedBytes !== sent) {
            sent = clamp(resync.receivedBytes, 0, file.size);
            chunkSentBase = sent;
            report(sent);
            break; // Re-slice from the new offset.
          }
        }

        if (attempt + 1 >= MAX_CHUNK_ATTEMPTS || !isRetryable(error)) {
          throw error instanceof UploadRequestError
            ? error
            : new UploadRequestError(
                error instanceof Error ? error.message : 'Upload failed.',
                0
              );
        }

        attempt += 1;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
      }
    }
  }

  onPhase?.('finalizing');

  const { ok, status, data } = await requestJson(
    `/api/upload/session/${session.id}`,
    { method: 'POST' },
    signal
  );

  if (!ok) {
    throw new UploadRequestError(
      describeServerError(data, 'The upload could not be finished.'),
      status,
      asString(data.resolution)
    );
  }

  onProgress?.({
    uploadedBytes: file.size,
    totalBytes: file.size,
    bytesPerSecond,
    etaSeconds: 0,
  });

  return {
    video: data.video as VideoRecord,
    transcriptionQueued: Boolean(data.transcriptionQueued),
    message: asString(data.message),
  };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  return `${formatFileSize(bytesPerSecond)}/s`;
}
