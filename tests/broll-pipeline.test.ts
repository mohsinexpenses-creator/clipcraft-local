import assert from 'node:assert/strict';
import test from 'node:test';
import { getClip, saveClip, saveClipBrollPlan, saveVideo } from '../lib/db';
import { BROLL_QUEUE_NAME, CLIP_QUEUE_NAME, listJobs } from '../lib/queue';
import { brollOptionsFor, continueAfterBroll, queueBrollForClips, recoverAutoPipelines } from '../lib/pipeline';
import { DEFAULT_BROLL_OPTIONS, type ClipRecord, type PipelineOptions, type VideoRecord } from '../lib/types';
import { createTemporaryDatabase } from './sqlite-test-helpers';

/**
 * The hand-offs that make B-roll a step of the automatic pipeline instead of a
 * manual button: detection queues B-roll, B-roll queues the render, and a worker
 * restart resumes exactly where it stopped - without duplicating a plan request or
 * rendering a clip whose plan does not exist yet.
 */

function makeVideo(id: string, pipeline: Partial<PipelineOptions>): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: `${id}.mp4`,
    fileName: `${id}.mp4`,
    filePath: `/tmp/${id}.mp4`,
    duration: 60,
    width: 1920,
    height: 1080,
    fileSize: 1000,
    status: 'transcribed',
    createdAt: now,
    updatedAt: now,
    transcript: {
      text: 'hello world',
      segments: [{ id: 0, text: 'hello world', start: 0, end: 1 }],
      words: [
        { word: 'hello', start: 0, end: 0.5 },
        { word: 'world', start: 0.5, end: 1 },
      ],
    },
    pipeline: {
      autoDetect: true,
      autoRender: true,
      viral: {
        clipCount: 3,
        minClipDuration: 15,
        includeHookText: true,
        includeCta: true,
      },
      broll: { ...DEFAULT_BROLL_OPTIONS },
      ...pipeline,
    } as PipelineOptions,
  };
}

function makeClip(id: string, videoId: string): ClipRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    videoId,
    start: 0,
    end: 30,
    hookDuration: 2,
    hookText: 'HOOK',
    filterPreset: 'none',
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test('brollOptionsFor falls back to the defaults for a legacy pipeline snapshot', () => {
  const options = brollOptionsFor({ pipeline: undefined });
  assert.deepEqual(options, DEFAULT_BROLL_OPTIONS);

  const legacy = brollOptionsFor({
    pipeline: { autoDetect: true, autoRender: true, viral: {} } as unknown as PipelineOptions,
  });
  assert.equal(legacy.autoBroll, true);
  assert.deepEqual(legacy.providerOrder, ['pexels', 'pixabay', 'unsplash']);
});

test('clips without a plan get a B-roll job; a clip that already has one does not', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-queue', {});
  await saveVideo(video);

  const fresh = makeClip('clip-fresh', video._id);
  const planned = makeClip('clip-planned', video._id);
  await saveClip(fresh);
  await saveClip(planned);
  await saveClipBrollPlan(planned._id, {
    version: 1,
    generatedAt: new Date().toISOString(),
    trigger: 'auto',
    clipDuration: 30,
    hookDuration: 2,
    totalDuration: 32,
    options: { ...DEFAULT_BROLL_OPTIONS },
    items: [],
    skipped: [],
    counts: { targetMin: 5, targetMax: 7, fullscreen: 0, landscape: 0 },
  });

  const queued = await queueBrollForClips(
    [await getClip(fresh._id), await getClip(planned._id)].filter((clip): clip is ClipRecord => clip !== null)
  );
  assert.deepEqual(queued.map((clip) => clip._id), ['clip-fresh']);
  const jobs = listJobs().filter((job) => job.type === BROLL_QUEUE_NAME);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].clipId, 'clip-fresh');
  assert.equal(jobs[0].status, 'queued');

  // Calling it again does not stack a second job for the same clip.
  const reloaded = await getClip(fresh._id);
  assert.deepEqual(await queueBrollForClips(reloaded ? [reloaded] : []), []);
  assert.equal(listJobs().filter((job) => job.type === BROLL_QUEUE_NAME).length, 1);
});

test('continueAfterBroll queues the render only when autoRender is on', async (t) => {
  createTemporaryDatabase(t);
  const auto = makeVideo('video-auto', { autoRender: true });
  const manual = makeVideo('video-manual', { autoRender: false });
  await saveVideo(auto);
  await saveVideo(manual);

  const autoClip = makeClip('clip-auto', auto._id);
  const manualClip = makeClip('clip-manual', manual._id);
  await saveClip(autoClip);
  await saveClip(manualClip);

  assert.equal(await continueAfterBroll(autoClip._id), true);
  assert.equal(await continueAfterBroll(manualClip._id), false);

  const clipJobs = () => listJobs().filter((job) => job.type === CLIP_QUEUE_NAME);
  assert.deepEqual(clipJobs().map((job) => job.clipId), ['clip-auto']);

  // Calling it twice (a retried job) does not queue a second render.
  assert.equal(await continueAfterBroll(autoClip._id), false);
  assert.equal(clipJobs().length, 1);
});

test('a restart re-queues missing plans and does not render clips still waiting for one', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-recover', { autoRender: true });
  await saveVideo(video);

  const planned = makeClip('clip-with-plan', video._id);
  const missing = makeClip('clip-without-plan', video._id);
  await saveClip(planned);
  await saveClip(missing);
  await saveClipBrollPlan(planned._id, {
    version: 1,
    generatedAt: new Date().toISOString(),
    trigger: 'auto',
    clipDuration: 30,
    hookDuration: 2,
    totalDuration: 32,
    options: { ...DEFAULT_BROLL_OPTIONS },
    items: [],
    skipped: [],
    counts: { targetMin: 5, targetMax: 7, fullscreen: 0, landscape: 0 },
  });

  const { resumed } = await recoverAutoPipelines();
  assert.ok(resumed.some((entry) => entry.includes('broll x1')), resumed.join(', '));

  // The clip that already has a plan is queued for rendering...
  const renderJobs = listJobs().filter((job) => job.type === CLIP_QUEUE_NAME);
  assert.deepEqual(renderJobs.map((job) => job.clipId), ['clip-with-plan']);
  // ...and the one without a plan is only queued for B-roll, never for a render.
  const brollJobs = listJobs().filter((job) => job.type === BROLL_QUEUE_NAME);
  assert.deepEqual(brollJobs.map((job) => job.clipId), ['clip-without-plan']);
});

test('with autoBroll off, recovery renders clips straight away (pre-B-roll behaviour)', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-off', {
    autoRender: true,
    broll: { ...DEFAULT_BROLL_OPTIONS, autoBroll: false },
  });
  await saveVideo(video);
  const clip = makeClip('clip-off', video._id);
  await saveClip(clip);

  await recoverAutoPipelines();
  assert.equal(listJobs().filter((job) => job.type === BROLL_QUEUE_NAME).length, 0);
  assert.deepEqual(
    listJobs()
      .filter((job) => job.type === CLIP_QUEUE_NAME)
      .map((job) => job.clipId),
    ['clip-off']
  );
});

test('a clip whose B-roll job already failed is not retried by a restart', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-failed', { autoRender: false });
  await saveVideo(video);
  const clip = makeClip('clip-failed', video._id);
  await saveClip(clip);

  const { claimNextJob, failJob } = await import('../lib/queue');
  const { enqueueBrollJob } = await import('../lib/queue');
  await enqueueBrollJob({ clipId: clip._id, videoId: video._id, trigger: 'auto' });
  const first = claimNextJob([BROLL_QUEUE_NAME]);
  assert.ok(first, 'the job is claimable');
  // Exhaust the attempts so the row is terminally failed.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = claimNextJob([BROLL_QUEUE_NAME]);
    if (!next) break;
    failJob(next.id, 'provider down');
  }

  await recoverAutoPipelines();
  const jobs = listJobs().filter((job) => job.type === BROLL_QUEUE_NAME);
  assert.equal(jobs.filter((entry) => entry.status === 'queued').length, 0, 'no automatic retry');
  assert.equal((await getClip(clip._id))?.broll, undefined);
});
