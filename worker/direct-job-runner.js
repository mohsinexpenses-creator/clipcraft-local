/* eslint-disable @typescript-eslint/no-require-imports */

try {
  require('ts-node').register({ transpileOnly: true });
} catch {
  // Ignore: ts-node is optional here because this direct runner is no longer the primary path.
}

async function run() {
  const jsonArg = process.argv[2] || process.env.JOB_DATA_JSON;
  if (!jsonArg) {
    console.error('[Direct Worker Runner] No JOB_DATA_JSON passed');
    process.exit(1);
  }

  const jobData = JSON.parse(jsonArg);
  console.log('[Direct Worker Runner] Running direct background job:', jobData.clipId);

  try {
    const { processClipJob } = require('./processor');
    await processClipJob(jobData, (progress) => {
      console.log(`[Direct Worker Runner] Clip ${jobData.clipId} progress: ${progress}%`);
    });
    console.log('[Direct Worker Runner] Job completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('[Direct Worker Runner] Job failed:', error);
    process.exit(1);
  }
}

run();
