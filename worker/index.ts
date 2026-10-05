import {
  closeDatabase,
  getClip,
  getDatabase,
  getDatabasePath,
  getVideo,
  updateClip,
  updateVideo,
} from '../lib/db';
import { toErrorMessage } from '../lib/errors';
import {
  CLIP_QUEUE_NAME,
  QUEUE_POLL_INTERVAL_MS,
  TRANSCRIPTION_QUEUE_NAME,
  QueueJob,
  claimNextJob,
  completeJob,
  failJob,
  recoverRunningJobs,
  updateJobProgress,
} from '../lib/queue';
import { JobData, TranscriptionJobData } from '../lib/types';
import { transcribeVideo } from '../lib/whisper';
import { processClipJob } from './processor';
import { color, log } from '../lib/logger';

// NOTE: .env.local is loaded by lib/errors.ts (loadEnvConfig), which this file imports
// transitively - that only works when the worker is started from the repository root.

function readConcurrency(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
  return fallback;
}

async function transcribeVideoJob(data: TranscriptionJobData): Promise<{ status: string; videoId: string }> {
  const video = await getVideo(data.videoId);
  if (!video) {
    throw new Error(`Video ${data.videoId} no longer exists in SQLite - nothing to transcribe.`);
  }

  log.section(`Transcribe ${color.bold(data.videoId)}` + color.gray(`  ·  ${video.originalName}`));
  video.status = 'transcribing';
  video.error = undefined;
  if (!(await updateVideo(video))) return { status: 'cancelled', videoId: data.videoId };

  try {
    const transcript = await transcribeVideo(data.filePath);
    // A user may delete the source while whisper is running. Do not recreate its row.
    const current = await getVideo(data.videoId);
    if (!current) return { status: 'cancelled', videoId: data.videoId };

    current.transcript = transcript;
    current.status = 'transcribed';
    current.error = undefined;
    await updateVideo(current);
    log.ok(
      `Transcription done: ${transcript.segments.length} segments, ${transcript.words.length} words.`
    );
    return { status: 'done', videoId: data.videoId };
  } catch (error) {
    const current = await getVideo(data.videoId);
    if (current) {
      current.status = 'failed';
      current.error = toErrorMessage(error, 'Transcription failed.');
      await updateVideo(current);
    }
    throw error;
  }
}

interface LoopState {
  stopping: boolean;
}

type JobHandler = (job: QueueJob, onProgress: (progress: number) => void) => Promise<unknown>;

async function markRecordRetrying(job: QueueJob): Promise<void> {
  try {
    if (job.clipId) {
      const clip = await getClip(job.clipId);
      if (clip) {
        clip.status = 'pending';
        clip.progress = 0;
        clip.error = undefined;
        clip.cancelling = false;
        await updateClip(clip);
      }
    } else if (job.type === TRANSCRIPTION_QUEUE_NAME && job.videoId) {
      const video = await getVideo(job.videoId);
      if (video) {
        video.status = 'transcribing';
        video.error = undefined;
        await updateVideo(video);
      }
    }
  } catch (error) {
    log.warn(`Could not refresh record status for retrying job ${job.id}: ${toErrorMessage(error)}`);
  }
}

async function executeJob(job: QueueJob, label: string, handler: JobHandler): Promise<void> {
  log.detail(`Received ${label} job ${job.id} (attempt ${job.attempts}/${job.maxAttempts}).`);
  try {
    const result = await handler(job, (progress) => {
      updateJobProgress(job.id, progress);
    });
    if (completeJob(job.id, result)) {
      log.ok(`${label} job ${job.id} completed.`);
    }
  } catch (error) {
    const message = toErrorMessage(error);
    const outcome = failJob(job.id, message);
    if (outcome === 'retry') {
      await markRecordRetrying(job);
      log.warn(
        `${label} job ${job.id} failed on attempt ${job.attempts}/${job.maxAttempts}; ` +
        `queued for retry: ${message}`
      );
    } else if (outcome === 'failed') {
      log.error(`${label} job ${job.id} failed permanently: ${message}`);
    }
  }
}

/** Each loop owns its own concurrency and polls only its own job type(s). */
async function runQueueLoop(
  type: string,
  label: string,
  concurrency: number,
  handler: JobHandler,
  state: LoopState
): Promise<void> {
  const runSlot = async (): Promise<void> => {
    while (!state.stopping) {
      let job: QueueJob | null;
      try {
        job = claimNextJob([type]);
      } catch (error) {
        log.error(`${label} queue claim failed: ${toErrorMessage(error)}`);
        await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
        continue;
      }

      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
        continue;
      }
      await executeJob(job, label, handler);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runSlot()));
}

async function startWorker(): Promise<void> {
  // Opening the database applies the schema and enables WAL + the five-second busy wait.
  getDatabase();
  const recovered = recoverRunningJobs();
  const clipConcurrency = readConcurrency('WORKER_CONCURRENCY', 1);
  const transcriptionConcurrency = 1;

  log.section('ClipCraft worker starting');
  log.detail(`SQLite: ${getDatabasePath()} (WAL, busy_timeout=5000ms)`);
  log.detail(`Clip concurrency: ${clipConcurrency}`);
  log.detail(`Transcription concurrency: ${transcriptionConcurrency}`);
  if (recovered > 0) log.warn(`Recovered ${recovered} job(s) left running by a previous worker process.`);

  const state: LoopState = { stopping: false };
  const loops = Promise.all([
    runQueueLoop(
      CLIP_QUEUE_NAME,
      'clip',
      clipConcurrency,
      async (job, onProgress) => {
        return processClipJob(job.payload as JobData, async (progress) => onProgress(progress));
      },
      state
    ),
    runQueueLoop(
      TRANSCRIPTION_QUEUE_NAME,
      'transcription',
      transcriptionConcurrency,
      async (job) => transcribeVideoJob(job.payload as TranscriptionJobData),
      state
    ),
  ]);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.stopping = true;
    log.warn(`${signal} received - stopping queue polling and finishing active jobs...`);

    const timer = setTimeout(() => {
      log.error('Forced exit after 30s; any remaining running jobs will be recovered on next startup.');
      process.exit(1);
    }, 30_000);
    timer.unref?.();

    try {
      await loops;
      clearTimeout(timer);
      closeDatabase();
      log.ok('Worker stopped cleanly.');
    } catch (error) {
      clearTimeout(timer);
      log.error(`Error while shutting down: ${toErrorMessage(error)}`);
      closeDatabase();
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await loops;
}

startWorker().catch((error) => {
  log.error(`Startup error: ${toErrorMessage(error)}`);
  closeDatabase();
  process.exit(1);
});
