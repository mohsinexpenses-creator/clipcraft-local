import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { saveVideo, updateVideo } from './db';
import { AppError, getErrorResponse, toErrorMessage } from './errors';
import { getVideoMetadata } from './ffmpeg';
import { enqueueTranscriptionJob, findActiveJob, TRANSCRIPTION_QUEUE_NAME } from './queue';
import { sanitizePipelineOptions } from './pipeline-defaults';
import { PipelineOptions, VideoRecord } from './types';
import { getPlannedTranscriptionEngine } from './whisper';

/**
 * Helpers shared by every upload endpoint:
 *
 *   POST /api/upload                    - small single-shot multipart upload (+ YouTube import)
 *   POST /api/upload/session            - start a resumable chunked upload (no size limit)
 *   PUT  /api/upload/session/[id]       - append one chunk
 *   POST /api/upload/session/[id]       - finalise (probe + save + enqueue transcription)
 *
 * Long podcast recordings are the primary use case, so the size limits that used to
 * live here (a hard-coded 512 MB) are gone: the default is unlimited and the app
 * streams bytes straight to disk instead of buffering them in RAM.
 */

export const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

/**
 * Default chunk size for the resumable uploader when the client does not pick one.
 * 8 MB keeps a single HTTP request short (Node closes a request that has been open for
 * `server.requestTimeout`, 5 minutes by default) while keeping the request count low.
 */
const DEFAULT_CHUNK_MB = 8;

/**
 * `request.formData()` buffers the ENTIRE multipart body in memory (undici has no
 * streaming multipart parser), so the single-shot endpoint refuses requests above this
 * size and points clients at the resumable endpoint instead. This is a memory guard for
 * the legacy/compat path - NOT a product limit: the app's own uploader always streams
 * through /api/upload/session, which has no size limit at all.
 */
const DEFAULT_MULTIPART_LIMIT_MB = 256;

function positiveEnvNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Absolute path of UPLOAD_DIR (defaults to ./uploads), created if missing. */
export function resolveUploadDir(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  const dir = configured ? path.resolve(configured) : path.join(process.cwd(), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Optional ceiling for a single upload. `0` / unset (the default) means UNLIMITED - a
 * three-hour podcast is a normal input here, so ClipCraft does not invent a limit.
 * Set MAX_UPLOAD_MB only if you want a guard rail on a small disk.
 */
export function getMaxUploadBytes(): number {
  const mb = positiveEnvNumber('MAX_UPLOAD_MB');
  return mb ? Math.floor(mb * 1024 * 1024) : 0;
}

/** Bytes per chunk advertised to the resumable uploader. */
export function getChunkSizeBytes(): number {
  const mb = positiveEnvNumber('UPLOAD_CHUNK_MB') ?? DEFAULT_CHUNK_MB;
  const bytes = Math.floor(mb * 1024 * 1024);
  return Math.min(Math.max(bytes, 1024 * 1024), 64 * 1024 * 1024);
}

/** Guard rail for the buffered single-shot multipart path. */
export function getMultipartLimitBytes(): number {
  const mb = positiveEnvNumber('MAX_MULTIPART_MB') ?? DEFAULT_MULTIPART_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Throws a 413 when MAX_UPLOAD_MB is configured and the upload is bigger than it. */
export function assertUploadSizeAllowed(bytes: number): void {
  const max = getMaxUploadBytes();
  if (max > 0 && bytes > max) {
    throw new AppError(`Upload is larger than the configured MAX_UPLOAD_MB (${formatBytes(max)}).`, {
      status: 413,
      details: `${formatBytes(bytes)} requested`,
      resolution:
        'Raise or remove MAX_UPLOAD_MB in .env.local (0 = unlimited), or split the recording.',
    });
  }
}

/** Rejects anything that could escape UPLOAD_DIR or that FFmpeg cannot open. */
export function validateUploadFileName(fileName: string): string {
  const trimmed = (fileName || '').trim();

  // Reject path separators outright - this name is later appended to UPLOAD_DIR.
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new AppError('Invalid file name.', {
      status: 400,
      details: fileName,
      resolution: 'Re-upload with a plain file name (no path separators or control characters).',
    });
  }

  if (!ALLOWED_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) {
    throw new AppError('Unsupported file extension.', {
      status: 400,
      details: trimmed,
      resolution: `Upload one of: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
    });
  }

  return trimmed;
}

/**
 * On-disk base name from the user's file name: only `[A-Za-z0-9 ._-]`
 * survives (everything else becomes `_`, runs collapsed), capped at 60 chars
 * so the final stored name always stays well inside OS path limits.
 */
export function sanitizeFileBase(originalName: string): string {
  const extIndex = originalName.lastIndexOf('.');
  const base = extIndex > 0 ? originalName.slice(0, extIndex) : originalName;
  const cleaned = base
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60).trim() || 'video';
}

/**
 * Next sequence number for the `NNN_` upload prefix: the highest number
 * already present in UPLOAD_DIR (matching `^(\d{3,})_`) plus one. State-free -
 * works without a database, and deleting files just reuses numbers, which is
 * fine for a personal tool.
 */
export function nextUploadSequenceNumber(): number {
  const dir = resolveUploadDir();
  let max = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const match = entry.match(/^(\d{3,})_/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
  } catch {
    // Upload dir missing/unreadable -> start at 1 (it is created on first use).
  }
  return max + 1;
}

/**
 * On-disk name: `<NNN>_<user's own file name>` (e.g. `001_my_recording.mp4`),
 * where NNN is a 3-digit sequence number so uploads are ordered by upload
 * time in the file explorer. Falls back gracefully if the dir cannot be read.
 */
export function buildStoredFileName(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  let number = nextUploadSequenceNumber();
  let candidate: string;
  do {
    candidate = `${String(number).padStart(3, '0')}_${sanitizeFileBase(originalName)}${extension}`;
    number += 1;
  } while (fs.existsSync(path.join(resolveUploadDir(), candidate)));
  return candidate;
}

/**
 * Build a complete VideoRecord.
 *
 * `duration` / `width` / `height` / `fileSize` are required fields that the dashboard
 * renders - the old code saved a record without any of them, so every uploaded video
 * showed as 0x0 / 0s. A probe failure is downgraded to zeros instead of rejecting an
 * upload that is already safely on disk.
 */
export async function buildVideoRecord(
  originalName: string,
  fileName: string,
  filePath: string,
  pipeline?: PipelineOptions
): Promise<VideoRecord> {
  const now = new Date().toISOString();
  let width = 0;
  let height = 0;
  let duration = 0;

  try {
    const meta = await getVideoMetadata(filePath);
    width = meta.width;
    height = meta.height;
    duration = meta.duration;
  } catch (error) {
    console.warn(
      `[Upload] FFmpeg could not read ${fileName} - saving it with zeroed media facts: ${toErrorMessage(error)}`
    );
  }

  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    // Leave 0; the record is still useful.
  }

  // The uploader UI shows which engine will run, so resolve it up-front. If no engine is
  // configured yet the upload still succeeds - the queued job reports the real error and
  // the user can fix .env.local and press "Transcribe again".
  let transcriptionProvider: VideoRecord['transcriptionProvider'];
  let transcriptionModel: string | undefined;
  try {
    const engine = getPlannedTranscriptionEngine();
    transcriptionProvider = engine.provider;
    transcriptionModel = engine.model;
  } catch (error) {
    console.warn(`[Upload] Transcription engine not ready yet: ${toErrorMessage(error)}`);
  }

  return {
    _id: '', // saveVideo() assigns a UUID
    originalName,
    fileName,
    /** Names the output folder: `001_my_recording` (stored name minus extension). */
    fileBase: fileName.replace(/\.[^.]+$/, ''),
    filePath,
    duration,
    width,
    height,
    fileSize,
    status: 'uploaded',
    ...(transcriptionProvider ? { transcriptionProvider } : {}),
    ...(transcriptionModel ? { transcriptionModel } : {}),
    /**
     * What the automatic chain should do after the bytes are on disk. Stored on the
     * record (not just used once) so a worker restart, a retry or "run it again"
     * reuse exactly the settings the upload was started with.
     */
    pipeline: pipeline ?? sanitizePipelineOptions({}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Queue the transcription (step 1 of the automatic chain) and persist the
 * outcome; never throws. An already queued/running pass is left alone, so a
 * retried finalize cannot stack two whisper runs for the same video.
 */
export async function queueTranscription(video: VideoRecord): Promise<boolean> {
  try {
    if (findActiveJob(TRANSCRIPTION_QUEUE_NAME, { videoId: video._id })) return true;
    await enqueueTranscriptionJob({ videoId: video._id, filePath: video.filePath });
    return true;
  } catch (error) {
    video.status = 'failed';
    video.error = toErrorMessage(error, 'Could not queue the transcription job.');
    await updateVideo(video).catch((saveError) =>
      console.error('[Upload] Could not persist the queue failure:', saveError)
    );
    return false;
  }
}

/**
 * Probe the finished file, store the record and queue transcription.
 *
 * Throws only when the record cannot be saved (SQLite unavailable), so callers
 * can put the file back and let the user retry the finish step without re-uploading.
 */
export async function registerUploadedVideo(
  originalName: string,
  fileName: string,
  filePath: string,
  pipeline?: PipelineOptions
): Promise<{ video: VideoRecord; queued: boolean }> {
  const video = await buildVideoRecord(originalName, fileName, filePath, pipeline);
  await saveVideo(video);
  const queued = await queueTranscription(video);
  return { video, queued };
}

export const QUEUE_MESSAGES = {
  queued:
    'Upload complete. The pipeline is running: transcript -> viral detection -> render.',
  notQueued:
    'Upload complete, but the transcription job could not be queued. Is the worker database path writable?',
} as const;

/** Error responses must carry the real HTTP status, not a 200 with an error body. */
export function jsonError(error: unknown): NextResponse {
  const payload = getErrorResponse(error);
  return NextResponse.json(payload, { status: payload.statusCode });
}
