const path = require('path');

// Register ts-node / typescript transpiler on the fly
try {
  require('ts-node').register({ transpileOnly: true });
} catch (e) {
  // if ts-node is not installed, register tsx or swc or basic ts transpiler
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
    await processClipJob(jobData, (p) => {
      console.log(`[Direct Worker Runner] Clip ${jobData.clipId} progress: ${p}%`);
    });
    console.log('[Direct Worker Runner] Job completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('[Direct Worker Runner] Job failed:', err);
    process.exit(1);
  }
}

run();
