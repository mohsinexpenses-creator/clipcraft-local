import { Queue } from 'bullmq';
import { getClip, saveClip } from './db';
import { AppError, ensureEnvVar, toErrorMessage } from './errors';
import { JobData } from './types';

let clipQueuePromise: Promise<Queue<JobData>> | null = null;

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
    };
  } catch {
    throw new AppError('REDIS_URL is invalid.', {
      status: 500,
      details: url,
      resolution: 'Set REDIS_URL to a valid redis:// URL, for example redis://localhost:6379.',
    });
  }
}

export async function getClipQueue(): Promise<Queue<JobData>> {
  if (clipQueuePromise) {
    return clipQueuePromise;
  }

  clipQueuePromise = (async () => {
    const redisUrl = ensureEnvVar('REDIS_URL', 'connect to Redis for background clip jobs');
    const connection = parseRedisUrl(redisUrl);

    try {
      const queue = new Queue<JobData>('clip-processing', {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });

      queue.on('error', (error) => {
        console.error('[BullMQ] Queue connection error:', error.message);
      });

      await queue.waitUntilReady();
      console.log('[BullMQ] Connected to Redis queue successfully.');
      return queue;
    } catch (error) {
      clipQueuePromise = null;
      throw new AppError('Redis connection failed for the clip queue.', {
        status: 500,
        details: toErrorMessage(error),
        resolution:
          'Start Redis and confirm REDIS_URL points to it before trying to render clips.',
      });
    }
  })();

  return clipQueuePromise;
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
    console.log(`[Queue] Adding job ${jobData.clipId} to BullMQ queue...`);
    await queue.add('process-clip', jobData, { jobId: jobData.clipId });
  } catch (error) {
    throw new AppError('Failed to enqueue the clip render job.', {
      status: 500,
      details: toErrorMessage(error),
      resolution:
        'Make sure Redis is running and start the worker with `npm run worker`, then retry rendering the clip.',
    });
  }
}
