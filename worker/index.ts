import { Job, Worker } from 'bullmq';
import { getVideo, saveVideo } from '../lib/db';
import { ensureEnvVar, toErrorMessage } from '../lib/errors';
import { CLIP_QUEUE_NAME, TRANSCRIPTION_QUEUE_NAME } from '../lib/queue';
import { JobData, TranscriptionJobData } from '../lib/types';
import { transcribeVideo } from '../lib/whisper';
import { processClipJob } from './processor';
import { color, log } from '../lib/logger';

// NOTE: .env.local is loaded by lib/errors.ts (loadEnvConfig) which this file imports
// transitively - that only works when the worker is started from the repository root.

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      // BullMQ requires `maxRetriesPerRequest: null` on its *blocking* connections;
      // the Worker adds that itself, and the Queue side must NOT set it, so we leave
      // it out here and let each class configure its own connection semantics.
      enableReadyCheck: true,
    };
  } catch {
    throw new Error(`Invalid REDIS_URL: ${url}. Expected something like redis://127.0.0.1:6379`);
  }
}

function readConcurrency(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return fallback;
}

async function transcribeVideoJob(data: TranscriptionJobData): Promise<void> {
  const video = await getVideo(data.videoId);
  if (!video) {
    throw new Error(`Video ${data.videoId} no longer exists in MongoDB - nothing to transcribe.`);
  }

  log.section(`Transcribe ${color.bold(data.videoId)}` + color.gray(`  ·  ${video.originalName}`));
  video.status = 'transcribing';
  video.error = undefined;
  await saveVideo(video);

  try {
    const transcript = await transcribeVideo(data.filePath);
    video.transcript = transcript;
    video.status = 'transcribed';
    video.error = undefined;
    await saveVideo(video);
    log.ok(
      `Transcription done: ${transcript.segments.length} segments, ${transcript.words.length} words.`
    );
  } catch (error) {
    video.status = 'failed';
    video.error = toErrorMessage(error, 'Transcription failed.');
    await saveVideo(video);
    throw error;
  }
}

async function startWorker() {
  const redisUrl = ensureEnvVar('REDIS_URL', 'connect the BullMQ worker to Redis');
  const connection = parseRedisUrl(redisUrl);

  // One render at a time: each clip job runs ffmpeg AND a headless Chrome render.
  // Two in parallel is the easiest way to OOM a normal PC.
  const clipConcurrency = readConcurrency('WORKER_CONCURRENCY', 1);

  log.section('ClipCraft worker starting');
  log.detail(`Redis: ${redisUrl}`);
  log.detail(`Clip concurrency: ${clipConcurrency}`);

  const clipWorker = new Worker<JobData>(
    CLIP_QUEUE_NAME,
    async (job: Job<JobData>) => {
      log.detail(`Received render job ${job.id}`);

      await processClipJob(job.data, async (progress) => {
        // Awaited: an unhandled rejection here used to be able to crash the worker.
        await job.updateProgress(progress);
      });

      return { status: 'done', clipId: job.data.clipId };
    },
    {
      connection,
      concurrency: clipConcurrency,
      // A render can legitimately take many minutes; the default 30s lock renewal is
      // fine but a longer stalled interval avoids false "stalled" reprocessing.
      lockDuration: 120_000,
      stalledInterval: 60_000,
    }
  );

  const transcriptionWorker = new Worker<TranscriptionJobData>(
    TRANSCRIPTION_QUEUE_NAME,
    async (job: Job<TranscriptionJobData>) => {
      log.detail(`Received transcription job ${job.id}`);
      await transcribeVideoJob(job.data);
      return { status: 'done', videoId: job.data.videoId };
    },
    {
      connection,
      // whisper.cpp already uses every core we give it.
      concurrency: 1,
      lockDuration: 120_000,
      stalledInterval: 60_000,
    }
  );

  // Generic helper (instead of an `as Array<[string, Worker<unknown>]>` cast, which
  // does not type-check across the two different job payload types).
  function attachLogging<T>(worker: Worker<T>, label: string): void {
    worker.on('completed', (job) => {
      log.ok(`${label} job ${job.id} completed.`);
    });

    worker.on('failed', (job, error) => {
      log.error(`${label} job ${job?.id} failed: ${toErrorMessage(error)}`);
    });

    worker.on('stalled', (jobId) => {
      log.warn(`${label} job ${jobId} stalled (it will be retried).`);
    });

    worker.on('error', (error) => {
      log.error(`${label} worker error: ${toErrorMessage(error)}`);
    });
  }

  attachLogging(clipWorker, 'clip');
  attachLogging(transcriptionWorker, 'transcription');

  await Promise.all([clipWorker.waitUntilReady(), transcriptionWorker.waitUntilReady()]);
  log.ok(`Listening on "${CLIP_QUEUE_NAME}" and "${TRANSCRIPTION_QUEUE_NAME}". Press Ctrl+C to stop.`);

  // Graceful shutdown: finish the current job instead of leaving a clip stuck in
  // `processing` forever after a Ctrl+C.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.warn(`${signal} received - closing workers after the current job...`);
    const timer = setTimeout(() => {
      log.error('Forced exit after 30s.');
      process.exit(1);
    }, 30_000);
    timer.unref?.();

    try {
      await Promise.all([clipWorker.close(), transcriptionWorker.close()]);
      log.ok('Closed cleanly.');
      process.exit(0);
    } catch (error) {
      log.error(`Error while closing: ${toErrorMessage(error)}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Unconditional start.
 *
 * This used to be guarded by `if (require.main === module)`. That works today only
 * because package.json has no `"type": "module"`; the moment anyone adds it, tsx runs
 * this file as ESM, `require` is undefined and the worker silently never starts.
 * A top-level catch keeps the same "exit(1) on startup failure" behaviour safely.
 */
startWorker().catch((error) => {
  log.error(`Startup error: ${toErrorMessage(error)}`);
  process.exit(1);
});
