/**
 * Manual check for the B-roll step: plan one clip and print exactly what the
 * renderer would use - every image with its provider, author, licence, time range
 * and (for full-screen images) the Gemini verdict, plus why anything was skipped.
 *
 *   npm run verify:broll -- <clipId>
 *   npm run verify:broll -- <clipId> --json
 *
 * It runs the SAME code path as the worker (`runBrollJob`), so a green result here
 * means the background job will behave the same way.
 */

import fs from 'node:fs';
import { getClip, getClipBrollPlan, getVideo } from '../lib/db';
import { cachedImagePath } from '../lib/broll/cache';
import { runBrollJob } from '../worker/broll-job';

function usage(): void {
  console.error('Usage: npm run verify:broll -- <clipId> [--json]');
  console.error('  The clip must exist in the database (`data/clipcraft.db` by default).');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((entry) => entry !== '--');
  const clipId = args.find((entry) => !entry.startsWith('--'));
  const asJson = args.includes('--json');

  if (!clipId) {
    usage();
    process.exitCode = 2;
    return;
  }

  const clip = await getClip(clipId);
  if (!clip) {
    console.error(`Clip not found: ${clipId}`);
    process.exitCode = 1;
    return;
  }
  const video = await getVideo(clip.videoId);
  if (!video) {
    console.error(`Video not found for clip ${clipId}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Clip ${clip._id} · video "${video.originalName}" · ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s`);

  const startedAt = Date.now();
  const result = await runBrollJob(
    { clipId: clip._id, videoId: clip.videoId, trigger: 'manual' },
    (progress) => {
      if (!asJson) process.stdout.write(`\r  planning… ${progress}%   `);
    }
  );
  if (!asJson) process.stdout.write('\r');
  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s · status=${result.status}`);

  const plan = result.plan ?? (await getClipBrollPlan(clip._id));
  if (!plan) {
    console.error('No plan was produced.');
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(
    `\nImages: ${plan.items.length} (target ${plan.counts.targetMin}–${plan.counts.targetMax}) · ` +
      `full-screen ${plan.counts.fullscreen} · cards ${plan.counts.landscape}`
  );
  console.log(`Timeline: ${plan.clipDuration.toFixed(1)}s clip + ${plan.hookDuration.toFixed(1)}s hook replay`);

  for (const [index, item] of plan.items.entries()) {
    const file = cachedImagePath(item.renderFile);
    console.log(
      `\n${index + 1}. [${item.kind}] ${item.start.toFixed(2)}–${item.end.toFixed(2)}s  "${item.entityName ?? item.query}"`
    );
    console.log(`   provider : ${item.attribution.provider}`);
    console.log(`   page     : ${item.attribution.sourceUrl}`);
    console.log(
      `   credit   : ${item.attribution.author ?? 'unknown author'}${item.attribution.license ? ` · ${item.attribution.license}` : ''}`
    );
    if (item.verification) {
      console.log(
        `   vision   : confidence ${item.verification.confidence.toFixed(2)} — ${item.verification.reason}`
      );
    }
    if (item.crop) {
      console.log(
        `   crop     : ${item.crop.mode} ${item.crop.width}x${item.crop.height} of ${item.crop.sourceWidth}x${item.crop.sourceHeight}` +
          `${item.crop.faceCentered ? ' (face-centred)' : ''}`
      );
    }
    console.log(`   file     : ${file}${fs.existsSync(file) ? '' : '  (MISSING)'}`);
  }

  if (plan.skipped.length > 0) {
    console.log(`\nSkipped (${plan.skipped.length}):`);
    for (const skip of plan.skipped) {
      console.log(`  · ${skip.stage}${skip.entity ? ` · ${skip.entity}` : ''}: ${skip.reason}`);
    }
  }
  if (plan.notes && plan.notes.length > 0) {
    console.log('\nNotes:');
    for (const note of plan.notes) console.log(`  · ${note}`);
  }

  const missing = plan.items.filter((item) => !fs.existsSync(cachedImagePath(item.renderFile)));
  if (missing.length > 0) {
    console.error(`\n${missing.length} prepared image(s) are missing from the cache.`);
    process.exitCode = 1;
  }
  if (plan.items.some((item) => item.kind === 'fullscreen' && !item.verification)) {
    console.error('\nA full-screen image has no Gemini verdict - this must never happen.');
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
