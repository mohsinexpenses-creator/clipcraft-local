import { randomUUID } from 'crypto';
import { AppError, RenderCancelledError } from './errors';
import {
  getDatabase,
  getClip,
  updateClipRecordSync,
  updateVideoRecordSync,
} from './db';
import {
  BrollJobData,
  JobData,
  TranscriptionJobData,
  VideoRecord,
  ViralDetectionJobData,
} from './types';
import type { SqliteDatabase } from './db';

export const CLIP_QUEUE_NAME = 'clip-processing';
export const TRANSCRIPTION_QUEUE_NAME = 'transcription';
/**
 * Viral-segment detection is a queue job rather than a request the browser has
 * to keep open: an LLM pass over a three-hour transcript outlives proxies and
 * page refreshes, and queueing it gives the same retry + restart-recovery
 * behaviour transcription and rendering already have.
 */
export const VIRAL_DETECTION_QUEUE_NAME = 'viral-detection';
/**
 * B-roll planning is its own queue job: it calls the LLM, Wikipedia and the stock
 * providers, downloads and crops images, and can take minutes on a slow network.
 * Keeping it out of the render means a retry re-fetches only what failed, and the
 * render itself never talks to a provider (it only reads the stored plan).
 */
export const BROLL_QUEUE_NAME = 'broll';
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 2000;
export const QUEUE_POLL_INTERVAL_MS = 1000;
/**
 * A running job owns an attempt token (`started_at`). Worker processes poll it
 * at this cadence, so a transactional cancellation reaches FFmpeg/Chromium and
 * network work without waiting for the next queue claim.
 */
export const JOB_CANCELLATION_POLL_INTERVAL_MS = 400;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface QueueJob<T = unknown> {
  id: string;
  type: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  error?: string;
  progress: number;
  result?: unknown;
  createdAt: string;
  availableAt: string;
  startedAt?: string;
  /** Opaque per-attempt fence; only the worker that claimed it may finish it. */
  claimToken?: string;
  finishedAt?: string;
  retryDelayMs: number;
  videoId?: string;
  clipId?: string;
}

export interface EnqueueOptions {
  /** Stable IDs let a retry/re-render replace an old terminal row for that item. */
  id?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  videoId?: string;
  clipId?: string;
}

/** Exact upstream attempt that is allowed to hand work to a downstream queue. */
export interface QueueHandoffGuard {
  jobId: string;
  startedAt: string;
  claimToken?: string;
}

/**
 * Preconditions for specialized pipeline enqueues. Automatic hand-offs carry a
 * source claim so cancellation/retry cannot enqueue work after the source has
 * lost ownership. Explicit UI actions opt in to clearing durable pause/cancel
 * fences in the same SQLite transaction as their new job.
 */
export interface PipelineEnqueueContext {
  sourceClaim?: QueueHandoffGuard;
  resumePipeline?: boolean;
  resumeCancelledClip?: boolean;
}

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  error: string | null;
  progress: number;
  result_json: string | null;
  created_at: string;
  available_at: string;
  started_at: string | null;
  claim_token: string | null;
  finished_at: string | null;
  retry_delay_ms: number;
  video_id: string | null;
  clip_id: string | null;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Queue payload/result must be JSON serializable.');
  return encoded;
}

function mapJob(row: JobRow): QueueJob {
  let payload: unknown;
  let result: unknown;
  try {
    payload = JSON.parse(row.payload_json);
    result = row.result_json === null ? undefined : JSON.parse(row.result_json);
  } catch (error) {
    throw new Error(`Job ${row.id} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    id: row.id,
    type: row.type,
    payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.error !== null ? { error: row.error } : {}),
    progress: row.progress,
    ...(row.result_json !== null ? { result } : {}),
    createdAt: row.created_at,
    availableAt: row.available_at,
  ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
  ...(row.claim_token !== null ? { claimToken: row.claim_token } : {}),
  ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    retryDelayMs: row.retry_delay_ms,
    ...(row.video_id !== null ? { videoId: row.video_id } : {}),
    ...(row.clip_id !== null ? { clipId: row.clip_id } : {}),
  };
}

function timestampAfter(milliseconds: number): string {
  return new Date(Date.now() + Math.max(0, milliseconds)).toISOString();
}

function readPayloadId(payload: unknown, field: 'videoId' | 'clipId'): string | undefined {
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' && value ? value : undefined;
  }
  return undefined;
}

/** Insert or replace a job row and return its id. */
export function enqueue<T>(
  type: string,
  payload: T,
  options: EnqueueOptions = {},
  db: SqliteDatabase = getDatabase()
): string {
  if (!type.trim()) throw new Error('Job type is required.');
  const id = options.id || randomUUID();
  const now = new Date().toISOString();
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const videoId = options.videoId ?? readPayloadId(payload, 'videoId') ?? null;
  const clipId = options.clipId ?? readPayloadId(payload, 'clipId') ?? null;
  const payloadJson = json(payload);
  // Render jobs are unique per clip, not per video: different clips from the same
  // source video may render concurrently. Transcription jobs are unique per video.
  const identityColumn = clipId ? 'clip_id' : videoId ? 'video_id' : null;
  const identityValue = clipId ?? videoId;

  const insert = db.transaction(() => {
    const sameId = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as
      | { status: JobStatus }
      | undefined;
    if (sameId?.status === 'running') {
      throw new AppError(`Job ${id} is already running.`, {
        status: 409,
        resolution: 'Wait for the current job to finish before queueing it again.',
      });
    }

    if (identityColumn && identityValue) {
      const existing = db.prepare(`
        SELECT id, status FROM jobs
        WHERE type = ? AND status IN ('queued', 'running')
          AND ${identityColumn} = ? AND id <> ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(type, identityValue, id) as
        | { id: string; status: JobStatus }
        | undefined;
      if (existing?.status === 'running') {
        throw new AppError(`A ${type} job for this record is already running.`, {
          status: 409,
          resolution: 'Wait for the current job to finish before queueing it again.',
        });
      }
      if (existing?.status === 'queued') {
        db.prepare(`
          UPDATE jobs
          SET status = 'failed', error = 'Superseded by a newer queued job.', finished_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(now, existing.id);
      }
    }

    db.prepare(`
      INSERT INTO jobs (
        id, type, payload_json, status, attempts, max_attempts, error, progress,
        result_json, created_at, available_at, started_at, claim_token, finished_at,
        retry_delay_ms, video_id, clip_id
      ) VALUES (?, ?, ?, 'queued', 0, ?, NULL, 0, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        payload_json = excluded.payload_json,
        status = 'queued',
        attempts = 0,
        max_attempts = excluded.max_attempts,
        error = NULL,
        progress = 0,
        result_json = NULL,
        created_at = excluded.created_at,
        available_at = excluded.available_at,
        started_at = NULL,
        claim_token = NULL,
        finished_at = NULL,
        retry_delay_ms = excluded.retry_delay_ms,
        video_id = excluded.video_id,
        clip_id = excluded.clip_id
    `).run(id, type, payloadJson, maxAttempts, now, now, retryDelayMs, videoId, clipId);
  });

  insert.immediate();
  return id;
}

/**
 * Claim one eligible job with a single atomic UPDATE ... RETURNING statement.
 * SQLite serializes concurrent writers, so independent worker connections cannot
 * claim the same row.
 */
export function claimNextJob(
  types: string[],
  db: SqliteDatabase = getDatabase()
): QueueJob | null {
  if (types.length === 0) return null;
  const now = new Date().toISOString();
  const claimToken = randomUUID();
  const placeholders = types.map(() => '?').join(', ');
  const row = db.prepare(`
    UPDATE jobs
    SET status = 'running', attempts = attempts + 1, started_at = ?, claim_token = ?, error = NULL
    WHERE id = (
      SELECT j.id
      FROM jobs AS j
      LEFT JOIN clips AS c ON c.id = j.clip_id
      LEFT JOIN videos AS direct_video ON direct_video.id = j.video_id
      LEFT JOIN videos AS clip_video ON clip_video.id = c.video_id
      WHERE j.status = 'queued'
        AND j.available_at <= ?
        AND j.type IN (${placeholders})
        -- A cancel transaction may leave historical rows in the queue for audit;
        -- never let a resumed/recovered worker reclaim them. Clip cancellation
        -- is separate so it also blocks a stale upstream hand-off after the
        -- video's pipeline has later been resumed.
        AND COALESCE(direct_video.pipeline_cancelled, clip_video.pipeline_cancelled, 0) = 0
        AND COALESCE(c.work_cancelled, 0) = 0
      ORDER BY
        CASE WHEN j.type IN ('broll', 'clip-processing')
          THEN COALESCE(direct_video.queue_order, clip_video.queue_order, 9223372036854775807)
          ELSE 0
        END ASC,
        j.created_at ASC,
        j.id ASC
      LIMIT 1
    ) AND status = 'queued'
    RETURNING *
  `).get(now, claimToken, now, ...types) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

/** True only while this exact claimed attempt still owns the job row. */
export function isJobClaimCurrent(
  id: string,
  startedAt: string,
  db: SqliteDatabase = getDatabase(),
  claimToken?: string,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM jobs
    WHERE id = ? AND status = 'running' AND started_at = ?
      AND (? IS NULL OR claim_token = ?)
  `).get(id, startedAt, claimToken ?? null, claimToken ?? null);
  return Boolean(row);
}

export interface JobExecutionControl {
  /** Aborts as soon as this worker's claimed attempt is cancelled/superseded. */
  signal: AbortSignal;
  isCancelled: () => boolean;
  /** Stop the 400ms DB poll after the handler settles. */
  dispose: () => void;
}

/**
 * Bind a job's `started_at` attempt token to an AbortSignal. The worker, rather
 * than a UI route, owns this controller so every long-running stage gets the
 * same cancellation source and old workers cannot write after a requeue.
 */
export function watchJobClaim(
  job: Pick<QueueJob, 'id' | 'startedAt' | 'claimToken'>,
  db: SqliteDatabase = getDatabase(),
  intervalMs = JOB_CANCELLATION_POLL_INTERVAL_MS,
): JobExecutionControl {
  const controller = new AbortController();
  const startedAt = job.startedAt;
  let disposed = false;
  const poll = (): void => {
    if (disposed || controller.signal.aborted) return;
    if (!startedAt || !isJobClaimCurrent(job.id, startedAt, db, job.claimToken)) controller.abort();
  };
  // Covers cancellation racing the claim before the first interval tick.
  poll();
  const timer = setInterval(poll, Math.max(300, Math.min(500, intervalMs)));
  timer.unref?.();
  return {
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}

/**
 * Persist progress only for the current attempt when `startedAt` is supplied.
 * Stable job ids are reused for retries, so the started timestamp is the fence
 * that prevents a late old worker from updating a newer claim.
 */
export function updateJobProgress(
  id: string,
  progress: number,
  db: SqliteDatabase = getDatabase(),
  startedAt?: string,
  claimToken?: string,
): boolean {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const result = db.prepare(`
    UPDATE jobs SET progress = ?
    WHERE id = ? AND status = 'running'
      AND (? IS NULL OR started_at = ?)
      AND (? IS NULL OR claim_token = ?)
  `).run(value, id, startedAt ?? null, startedAt ?? null, claimToken ?? null, claimToken ?? null);
  return result.changes > 0;
}

/** Complete only this exact attempt; see `updateJobProgress` for why. */
export function completeJob(
  id: string,
  resultValue: unknown,
  db: SqliteDatabase = getDatabase(),
  startedAt?: string,
  claimToken?: string,
): boolean {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'done', progress = 100, result_json = ?, error = NULL, finished_at = ?
    WHERE id = ? AND status = 'running'
      AND (? IS NULL OR started_at = ?)
      AND (? IS NULL OR claim_token = ?)
  `).run(json(resultValue), now, id, startedAt ?? null, startedAt ?? null, claimToken ?? null, claimToken ?? null);
  return result.changes > 0;
}

export type JobFailureOutcome = 'retry' | 'failed' | 'ignored';

export function failJob(
  id: string,
  errorMessage: string,
  db: SqliteDatabase = getDatabase(),
  startedAt?: string,
  claimToken?: string,
): JobFailureOutcome {
  const row = db.prepare(`
    SELECT attempts, max_attempts, retry_delay_ms, status, started_at, claim_token
    FROM jobs WHERE id = ?
  `).get(id) as
    | { attempts: number; max_attempts: number; retry_delay_ms: number; status: JobStatus; started_at: string | null; claim_token: string | null }
    | undefined;
  if (
    !row ||
    row.status !== 'running' ||
    (startedAt !== undefined && row.started_at !== startedAt) ||
    (claimToken !== undefined && row.claim_token !== claimToken)
  ) {
    return 'ignored';
  }

  if (row.attempts < row.max_attempts) {
    const delay = row.retry_delay_ms * 2 ** Math.max(0, row.attempts - 1);
    const result = db.prepare(`
      UPDATE jobs
      SET status = 'queued', error = ?, available_at = ?, started_at = NULL, claim_token = NULL,
          finished_at = NULL, progress = 0, result_json = NULL
      WHERE id = ? AND status = 'running'
        AND (? IS NULL OR started_at = ?)
        AND (? IS NULL OR claim_token = ?)
    `).run(
      errorMessage,
      timestampAfter(delay),
      id,
      startedAt ?? null,
      startedAt ?? null,
      claimToken ?? null,
      claimToken ?? null,
    );
    return result.changes > 0 ? 'retry' : 'ignored';
  }

  const result = db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, finished_at = ?
    WHERE id = ? AND status = 'running'
      AND (? IS NULL OR started_at = ?)
      AND (? IS NULL OR claim_token = ?)
  `).run(
    errorMessage,
    new Date().toISOString(),
    id,
    startedAt ?? null,
    startedAt ?? null,
    claimToken ?? null,
    claimToken ?? null,
  );
  return result.changes > 0 ? 'failed' : 'ignored';
}

/** Requeue claims left running by a process that crashed or was force-stopped. */
export function recoverRunningJobs(db: SqliteDatabase = getDatabase()): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        attempts = MAX(0, attempts - 1),
        error = 'Recovered after worker restart; retrying.',
        progress = 0, result_json = NULL,
        available_at = ?, started_at = NULL, claim_token = NULL, finished_at = NULL
    WHERE status = 'running'
  `).run(now);
  return result.changes;
}

export function getJob(id: string, db: SqliteDatabase = getDatabase()): QueueJob | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

/**
 * Delete a job only while it is still QUEUED. Returns true when a row was
 * removed. A running job is never deleted here - the process executing it owns
 * that row, and the per-record cancellation flags (`clip.cancelling`) are the
 * safe way to stop work that already started.
 */
export function removeJobIfQueued(id: string, db: SqliteDatabase = getDatabase()): boolean {
  const result = db.prepare(`DELETE FROM jobs WHERE id = ? AND status = 'queued'`).run(id);
  return result.changes > 0;
}

export function listJobs(db: SqliteDatabase = getDatabase()): QueueJob[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at, id').all() as JobRow[];
  return rows.map(mapJob);
}

/**
 * Validate a queue hand-off and its target while holding the writer lock. This
 * makes "source still owns its claim" + "target is not paused/cancelled" +
 * insertion one critical section: cancellation either wins first (no new job),
 * or sees and terminally fails the just-inserted job.
 */
function preparePipelineEnqueue(
  db: SqliteDatabase,
  videoId: string,
  clipId: string | undefined,
  context: PipelineEnqueueContext,
): void {
  const source = context.sourceClaim;
  if (
    source &&
    !isJobClaimCurrent(source.jobId, source.startedAt, db, source.claimToken)
  ) {
    throw new RenderCancelledError('The upstream job was cancelled before it could queue downstream work.');
  }

  if (context.resumePipeline) {
    const resumed = db.prepare(`
      UPDATE videos
      SET pipeline_cancelled = 0,
          error = CASE WHEN error = 'Cancelled by user.' THEN NULL ELSE error END,
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), videoId);
    if (resumed.changes === 0) {
      throw new AppError(`Video ${videoId} was deleted before work could be queued.`, { status: 404 });
    }
  }

  if (!clipId) {
    const video = db.prepare(`SELECT pipeline_cancelled FROM videos WHERE id = ?`).get(videoId) as
      | { pipeline_cancelled: number }
      | undefined;
    if (!video) {
      throw new AppError(`Video ${videoId} was deleted before work could be queued.`, { status: 404 });
    }
    if (video.pipeline_cancelled === 1) {
      throw new RenderCancelledError('The video pipeline is cancelled; resume it before queueing more automatic work.');
    }
    return;
  }

  const target = db.prepare(`
    SELECT c.video_id, c.work_cancelled, v.pipeline_cancelled
    FROM clips AS c
    JOIN videos AS v ON v.id = c.video_id
    WHERE c.id = ?
  `).get(clipId) as
    | { video_id: string; work_cancelled: number; pipeline_cancelled: number }
    | undefined;
  if (!target) {
    throw new AppError(`Clip ${clipId} was deleted before work could be queued.`, { status: 404 });
  }
  if (target.video_id !== videoId) {
    throw new AppError(`Clip ${clipId} does not belong to video ${videoId}.`, { status: 400 });
  }
  if (target.pipeline_cancelled === 1) {
    throw new RenderCancelledError('The video pipeline is cancelled; resume it before queueing more automatic work.');
  }
  if (target.work_cancelled === 1) {
    if (!context.resumeCancelledClip) {
      throw new RenderCancelledError('This clip was cancelled; only an explicit manual action may restart it.');
    }
    db.prepare(`UPDATE clips SET work_cancelled = 0, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), clipId);
  }
}

export async function enqueueClipJob(
  jobData: JobData,
  context: PipelineEnqueueContext = {},
): Promise<void> {
  const clip = await getClip(jobData.clipId);
  if (!clip) {
    throw new AppError(`Clip record ${jobData.clipId} was not found.`, {
      status: 404,
      resolution: 'Create the clip again from viral detection before attempting to render it.',
    });
  }
  if (clip.videoId !== jobData.videoId) {
    throw new AppError(`Clip ${jobData.clipId} does not belong to video ${jobData.videoId}.`, {
      status: 400,
    });
  }

  // Apply request edits and queue reset in one transaction so an active-job
  // conflict cannot leave the clip row looking pending instead of processing.
  clip.start = jobData.start;
  clip.end = jobData.end;
  clip.hookDuration = jobData.hookDuration;
  if (jobData.hookText !== undefined) clip.hookText = jobData.hookText;
  if (jobData.ctaText !== undefined) clip.ctaText = jobData.ctaText;
  if (jobData.ctaDuration !== undefined) clip.ctaDuration = jobData.ctaDuration;
  clip.filterPreset = jobData.filterPreset;
  clip.captionPresetId = jobData.captionPresetId;
  if (jobData.layout !== undefined) clip.layout = jobData.layout;
  if (jobData.hookStylePresetId !== undefined) clip.hookStylePresetId = jobData.hookStylePresetId;
  if (jobData.ctaStylePresetId !== undefined) clip.ctaStylePresetId = jobData.ctaStylePresetId;
  clip.status = 'pending';
  clip.progress = 0;
  clip.error = undefined;
  clip.cancelling = false;
  const db = getDatabase();
  db.transaction(() => {
    preparePipelineEnqueue(db, jobData.videoId, jobData.clipId, context);
    if (!updateClipRecordSync(db, clip)) {
      throw new AppError(`Clip ${jobData.clipId} was deleted while its render job was being queued.`, {
        status: 409,
      });
    }
    enqueue(CLIP_QUEUE_NAME, jobData, {
      id: `clip:${jobData.clipId}`,
      maxAttempts: 1,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      clipId: jobData.clipId,
      videoId: jobData.videoId,
    }, db);
  }).immediate();
}

export async function enqueueTranscriptionJob(
  jobData: TranscriptionJobData,
  videoToUpdate?: VideoRecord,
  context: PipelineEnqueueContext = {},
): Promise<void> {
  const db = getDatabase();
  const enqueueOptions = {
    id: `transcription:${jobData.videoId}`,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    videoId: jobData.videoId,
  };

  db.transaction(() => {
    preparePipelineEnqueue(db, jobData.videoId, undefined, context);
    if (videoToUpdate && !updateVideoRecordSync(db, videoToUpdate)) {
      throw new AppError(`Video ${jobData.videoId} was deleted before transcription could be queued.`, {
        status: 404,
      });
    }
    enqueue(TRANSCRIPTION_QUEUE_NAME, jobData, enqueueOptions, db);
  }).immediate();
}

/**
 * Queue the viral-detection step for one video. Stable job id, so a retry or a
 * second "detect again" press replaces the queued run instead of stacking
 * duplicates; an already-running pass is refused with 409 (the caller decides
 * whether that is "already in progress" or an error).
 */
export async function enqueueViralDetectionJob(
  videoId: string,
  context: PipelineEnqueueContext = {},
): Promise<string> {
  const db = getDatabase();
  return db.transaction(() => {
    preparePipelineEnqueue(db, videoId, undefined, context);
    return enqueue(
      VIRAL_DETECTION_QUEUE_NAME,
      { videoId } satisfies ViralDetectionJobData,
      {
        id: `viral-detection:${videoId}`,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        videoId,
      },
      db,
    );
  }).immediate();
}

/**
 * Queue the B-roll step for one clip. Stable id per clip, so pressing "re-run
 * B-roll" twice replaces the queued job instead of stacking duplicates, and a
 * running pass is refused with 409 rather than racing the plan write.
 */
export async function enqueueBrollJob(
  data: BrollJobData,
  context: PipelineEnqueueContext = {},
): Promise<string> {
  const db = getDatabase();
  return db.transaction(() => {
    preparePipelineEnqueue(db, data.videoId, data.clipId, context);
    return enqueue(
      BROLL_QUEUE_NAME,
      data,
      {
        id: `broll:${data.clipId}`,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        clipId: data.clipId,
        videoId: data.videoId,
      },
      db,
    );
  }).immediate();
}

/**
 * All jobs of the given types, oldest first. The video list uses this to attach
 * the latest transcription/detection job to every row in one query instead of
 * one query per video.
 */
export function listJobsByTypes(
  types: string[],
  db: SqliteDatabase = getDatabase()
): QueueJob[] {
  if (!types.length) return [];
  const placeholders = types.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE type IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
    .all(...types) as JobRow[];
  return rows.map(mapJob);
}

/** One queued/running job for this record and type, if any. */
export function findActiveJob(
  type: string,
  selector: { videoId?: string; clipId?: string },
  db: SqliteDatabase = getDatabase()
): QueueJob | null {
  const { videoId, clipId } = selector;
  const row = (
    clipId
      ? db
          .prepare(`SELECT * FROM jobs WHERE type = ? AND status IN ('queued','running') AND clip_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(type, clipId)
      : db
          .prepare(`SELECT * FROM jobs WHERE type = ? AND status IN ('queued','running') AND video_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(type, videoId ?? '')
  ) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

/**
 * The jobs that describe one video's pipeline: its transcription, its detection
 * run and every render of its clips, oldest first. The dashboard polls this to
 * show live progress without touching clip records.
 */
export function listVideoPipelineJobs(
  videoId: string,
  db: SqliteDatabase = getDatabase()
): QueueJob[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM jobs
      WHERE video_id = ?
         OR clip_id IN (SELECT id FROM clips WHERE video_id = ?)
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(videoId, videoId) as JobRow[];
  return rows.map(mapJob);
}

/** Terminal job state for a record (used to report why a step failed). */
export function findLatestJob(
  type: string,
  selector: { videoId?: string; clipId?: string },
  db: SqliteDatabase = getDatabase()
): QueueJob | null {
  const { videoId, clipId } = selector;
  const row = (
    clipId
      ? db
          .prepare(`SELECT * FROM jobs WHERE type = ? AND clip_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(type, clipId)
      : db
          .prepare(`SELECT * FROM jobs WHERE type = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(type, videoId ?? '')
  ) as JobRow | undefined;
  return row ? mapJob(row) : null;
}
