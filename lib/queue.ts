import { Queue } from 'bullmq';
import { JobData } from './types';
import { saveClip, getClip } from './db';
import path from 'path';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let clipQueue: Queue | null = null;
let redisAvailable = true;

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
    };
  } catch (e) {
    return { host: 'localhost', port: 6379 };
  }
}

export function getClipQueue(): Queue | null {
  if (!redisAvailable) return null;
  if (clipQueue) return clipQueue;

  try {
    const connection = parseRedisUrl(REDIS_URL);
    clipQueue = new Queue('clip-processing', {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    clipQueue.on('error', (err) => {
      console.warn('[BullMQ] Redis queue connection error:', err.message);
      redisAvailable = false;
      clipQueue = null;
    });

    return clipQueue;
  } catch (err) {
    console.warn('[BullMQ] Failed to initialize BullMQ queue:', err);
    redisAvailable = false;
    return null;
  }
}

export async function enqueueClipJob(jobData: JobData): Promise<void> {
  const clip = await getClip(jobData.clipId);
  if (clip) {
    clip.status = 'pending';
    clip.progress = 0;
    await saveClip(clip);
  }

  const queue = getClipQueue();

  if (queue && redisAvailable) {
    try {
      console.log(`[Queue] Adding job ${jobData.clipId} to BullMQ queue...`);
      await queue.add('process-clip', jobData, { jobId: jobData.clipId });
      return;
    } catch (err) {
      console.warn('[Queue] Enqueuing to BullMQ failed. Falling back to direct background worker fork:', err);
      redisAvailable = false;
    }
  }

  console.log(`[Queue] Dispatching background worker process directly for clip ${jobData.clipId}...`);
  dispatchDirectWorkerJob(jobData);
}

function dispatchDirectWorkerJob(jobData: JobData) {
  try {
    // Dynamically require child_process to avoid bundler tracing
    const cp = eval('require')('child_process');
    const runnerPath = path.resolve(process.cwd(), 'worker', 'direct-job-runner.js');
    const env = { ...process.env, JOB_DATA_JSON: JSON.stringify(jobData) };

    const child = cp.fork(runnerPath, [JSON.stringify(jobData)], {
      env,
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
  } catch (err) {
    console.error('[Queue] Direct background job dispatch failed:', err);
  }
}
