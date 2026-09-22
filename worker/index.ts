import { Job, Worker } from 'bullmq';
import { ensureEnvVar, toErrorMessage } from '../lib/errors';
import { JobData } from '../lib/types';
import { processClipJob } from './processor';

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
    };
  } catch {
    throw new Error(`Invalid REDIS_URL: ${url}`);
  }
}

async function startWorker() {
  const redisUrl = ensureEnvVar('REDIS_URL', 'connect the BullMQ worker to Redis');

  console.log('[BullMQ Worker] Starting clip processing worker...');
  console.log(`[BullMQ Worker] Connecting to Redis at ${redisUrl}...`);

  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<JobData>(
    'clip-processing',
    async (job: Job<JobData>) => {
      console.log(`[BullMQ Worker] Received job ${job.id} for clip ${job.data.clipId}`);

      await processClipJob(job.data, (progress) => {
        job.updateProgress(progress);
      });

      return { status: 'done', clipId: job.data.clipId };
    },
    {
      connection,
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[BullMQ Worker] Job ${job.id} completed successfully!`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[BullMQ Worker] Job ${job?.id} failed with error:`, error);
  });

  worker.on('error', (error) => {
    console.error('[BullMQ Worker] Worker connection error:', error.message);
  });

  await worker.waitUntilReady();
  console.log('[BullMQ Worker] Worker is active and listening for jobs.');
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error('[BullMQ Worker] Startup error:', toErrorMessage(error));
    process.exit(1);
  });
}
