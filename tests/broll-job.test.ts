import assert from 'node:assert/strict';
import test from 'node:test';
import { getClip, saveClip, saveVideo } from '../lib/db';
import { DEFAULT_BROLL_OPTIONS, type ClipRecord, type PipelineOptions, type VideoRecord } from '../lib/types';
import { runBrollJob } from '../worker/broll-job';
import { createTemporaryDatabase } from './sqlite-test-helpers';

/**
 * The job's own bookkeeping, without any provider call: a clip with no spoken
 * words must still end up with a (empty, explained) plan instead of failing, and a
 * video that has B-roll switched off must not be planned by the automatic chain.
 */

function makeVideo(id: string, broll: Partial<typeof DEFAULT_BROLL_OPTIONS> = {}): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: 'silent.mp4',
    fileName: `${id}.mp4`,
    filePath: `/tmp/${id}.mp4`,
    duration: 60,
    width: 1920,
    height: 1080,
    fileSize: 1000,
    status: 'transcribed',
    createdAt: now,
    updatedAt: now,
    // No transcript words: the job must not call the LLM or any provider.
    transcript: { text: '', segments: [], words: [] },
    pipeline: {
      autoDetect: false,
      autoRender: true,
      viral: { clipCount: 3, minClipDuration: 15, includeHookText: true, includeCta: true },
      broll: { ...DEFAULT_BROLL_OPTIONS, ...broll },
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

test('a clip with no spoken words gets an explained empty plan, not a failure', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-silent');
  await saveVideo(video);
  const clip = makeClip('clip-silent', video._id);
  await saveClip(clip);

  const result = await runBrollJob({ clipId: clip._id, videoId: video._id, trigger: 'auto' }, () => undefined);
  assert.equal(result.status, 'done');
  assert.equal(result.plan?.items.length, 0);

  const stored = await getClip(clip._id);
  assert.equal(stored?.brollStatus, 'done');
  assert.equal(stored?.broll?.items.length, 0);
  assert.ok(stored?.broll?.skipped.some((skip) => skip.stage === 'analysis'));
});

test('the automatic chain leaves a clip alone when B-roll is switched off', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-off', { autoBroll: false });
  await saveVideo(video);
  const clip = makeClip('clip-off', video._id);
  await saveClip(clip);

  const result = await runBrollJob({ clipId: clip._id, videoId: video._id, trigger: 'auto' }, () => undefined);
  assert.equal(result.status, 'skipped');
  // The tile must not keep saying "planning…" for a clip nothing is planning.
  assert.equal((await getClip(clip._id))?.brollStatus, undefined);

  // A manual re-run still works, because the user explicitly asked for it.
  const manual = await runBrollJob({ clipId: clip._id, videoId: video._id, trigger: 'manual' }, () => undefined);
  assert.equal(manual.status, 'done');
});

test('a missing clip is a clear 404 rather than silent work', async (t) => {
  createTemporaryDatabase(t);
  await assert.rejects(
    () => runBrollJob({ clipId: 'nope', videoId: 'nope', trigger: 'auto' }, () => undefined),
    /no longer exists/
  );
});
