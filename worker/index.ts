import { Worker, Job } from 'bullmq';
import { processClipJob } from './processor';
import { JobData } from '../lib/types';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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

async function startWorker() {
  console.log('[BullMQ Worker] Starting clip processing worker...');
  console.log(`[BullMQ Worker] Connecting to Redis at ${REDIS_URL}...`);

  const connection = parseRedisUrl(REDIS_URL);

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

  worker.on('failed', (job, err) => {
    console.error(`[BullMQ Worker] Job ${job?.id} failed with error:`, err);
  });

  worker.on('error', (err) => {
    console.error('[BullMQ Worker] Worker connection error:', err.message);
  });

  console.log('[BullMQ Worker] Worker is active and listening for jobs.');
}

if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[BullMQ Worker] Startup error:', err);
  });
}
