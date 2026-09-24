import { Queue } from 'bullmq';
import { getClip, saveClip } from './db';
import { AppError, ensureEnvVar, toErrorMessage } from './errors';
import { JobData, TranscriptionJobData } from './types';

export const CLIP_QUEUE_NAME = 'clip-processing';
export const TRANSCRIPTION_QUEUE_NAME = 'transcription';

const queueCache = new Map<string, Promise<Queue<unknown>>>();

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
    };
  } catch {
    throw new AppError('REDIS_URL is invalid.', {
      status: 500,
      details: url,
      resolution: 'Set REDIS_URL to a valid redis:// URL, for example redis://127.0.0.1:6379.',
    });
  }
}

function createQueue<T>(name: string): Promise<Queue<T>> {
  const cached = queueCache.get(name);
  if (cached) return cached as Promise<Queue<T>>;

  const promise = (async () => {
    const redisUrl = ensureEnvVar('REDIS_URL', 'connect to Redis for background jobs');
    const connection = parseRedisUrl(redisUrl);

    try {
      const queue = new Queue<T>(name, {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 2000 },
          // Keeping the last few completed/failed jobs makes debugging possible in
          // `redis-cli` / BullMQ dashboards without growing Redis forever.
          removeOnComplete: { age: 3600, count: 50 },
          removeOnFail: { age: 7 * 24 * 3600, count: 200 },
        },
      });

      queue.on('error', (error) => {
        console.error(`[BullMQ] Queue "${name}" connection error:`, error.message);
      });

      await queue.waitUntilReady();
      console.log(`[BullMQ] Connected to Redis queue "${name}".`);
      return queue;
    } catch (error) {
      queueCache.delete(name);
      throw new AppError(`Redis connection failed for the "${name}" queue.`, {
        status: 500,
        details: toErrorMessage(error),
        resolution: 'Start Redis (`docker compose up -d`) and confirm REDIS_URL points to it.',
      });
    }
  })();

  queueCache.set(name, promise as Promise<Queue<unknown>>);
  return promise;
}

export async function getClipQueue(): Promise<Queue<JobData>> {
  return createQueue<JobData>(CLIP_QUEUE_NAME);
}

export async function getTranscriptionQueue(): Promise<Queue<TranscriptionJobData>> {
  return createQueue<TranscriptionJobData>(TRANSCRIPTION_QUEUE_NAME);
}

/**
 * BullMQ silently ignores `queue.add()` when a job with the same jobId already
 * exists. Because we use the clipId as jobId and keep failed jobs around
 * (`removeOnFail`), every "Re-render clip" after a failure used to be a no-op:
 * the UI flipped the clip to `pending` and then nothing ever happened.
 *
 * Removing the previous job first makes re-rendering deterministic.
 */
/** Generic so both Queue<JobData> and Queue<TranscriptionJobData> can use it. */
async function removeStaleJob<T>(
  queue: Queue<T>,
  jobId: string,
  activeMessage: string
): Promise<void> {
  try {
    const existing = await queue.getJob(jobId);
    if (!existing) return;

    const state = await existing.getState();
    if (state === 'active') {
      throw new AppError(activeMessage, {
        status: 409,
        resolution:
          'Wait for the running job to finish (or stop the worker with Ctrl+C) before queueing it again.',
      });
    }

    await existing.remove();
    console.log(`[Queue] Removed stale ${state} job ${jobId} before re-enqueueing.`);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // A leftover job we cannot remove should not block a fresh render forever.
    console.warn(`[Queue] Could not remove stale job ${jobId}: ${toErrorMessage(error)}`);
  }
}

export async function enqueueClipJob(jobData: JobData): Promise<void> {
  const clip = await getClip(jobData.clipId);
  if (clip) {
    clip.status = 'pending';
    clip.progress = 0;
    clip.error = undefined;
    await saveClip(clip);
  }

  try {
    const queue = await getClipQueue();
    await removeStaleJob(queue, jobData.clipId, `Clip ${jobData.clipId} is already being rendered.`);

    console.log(`[Queue] Adding clip render job ${jobData.clipId} to "${CLIP_QUEUE_NAME}"...`);
    await queue.add('process-clip', jobData, { jobId: jobData.clipId });
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError('Failed to enqueue the clip render job.', {
      status: 500,
      details: toErrorMessage(error),
      resolution:
        'Make sure Redis is running (`docker compose up -d`) and start the worker with `npm run worker`, then retry.',
    });
  }
}

/**
 * Transcription used to run inside the Next.js request handler as a fire-and-forget
 * promise. A dev-server reload (or a closed browser tab) orphaned it and the video
 * stayed stuck in `transcribing` forever. It now goes through BullMQ like renders do.
 */
export async function enqueueTranscriptionJob(jobData: TranscriptionJobData): Promise<void> {
  try {
    const queue = await getTranscriptionQueue();
    await removeStaleJob(
      queue,
      jobData.videoId,
      `Video ${jobData.videoId} is already being transcribed.`
    );

    console.log(`[Queue] Adding transcription job ${jobData.videoId} to "${TRANSCRIPTION_QUEUE_NAME}"...`);
    await queue.add('transcribe-video', jobData, { jobId: jobData.videoId });
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError('Failed to enqueue the transcription job.', {
      status: 500,
      details: toErrorMessage(error),
      resolution:
        'Start Redis (`docker compose up -d`) and the worker (`npm run worker`), then use the "Transcribe" button on the dashboard.',
    });
  }
}
