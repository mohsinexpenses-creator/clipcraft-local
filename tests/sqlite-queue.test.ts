import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteClip, deleteVideo, saveClip, saveVideo, getClip, updateClip } from '../lib/db';
import type { ClipRecord, JobData, VideoRecord } from '../lib/types';
import {
  claimNextJob,
  completeJob,
  enqueue,
  enqueueClipJob,
  enqueueTranscriptionJob,
  failJob,
  getJob,
  recoverRunningJobs,
  updateJobProgress,
} from '../lib/queue';
import { createTemporaryDatabase } from './sqlite-test-helpers';

function video(id: string): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: `${id}.mp4`,
    fileName: `${id}.mp4`,
    filePath: `/uploads/${id}.mp4`,
    duration: 90,
    width: 1920,
    height: 1080,
    fileSize: 2048,
    status: 'uploaded',
    createdAt: now,
    updatedAt: now,
  };
}

function clip(id: string, videoId: string): ClipRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    videoId,
    start: 0,
    end: 60,
    hookDuration: 3,
    hookText: 'Hook',
    filterPreset: 'none',
    captionPresetId: 'preset-bold-yellow',
    status: 'done',
    progress: 100,
    createdAt: now,
    updatedAt: now,
  };
}

function renderPayload(record: ClipRecord): JobData {
  return {
    clipId: record._id,
    videoId: record.videoId,
    start: record.start,
    end: record.end,
    hookDuration: record.hookDuration,
    hookText: record.hookText,
    ctaText: record.ctaText,
    ctaDuration: record.ctaDuration,
    filterPreset: record.filterPreset,
    captionPresetId: record.captionPresetId,
    layout: record.layout,
    captionEngine: record.captionEngine,
    hookStylePresetId: record.hookStylePresetId,
    ctaStylePresetId: record.ctaStylePresetId,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(timestamp: string): Promise<void> {
  const remaining = Date.parse(timestamp) - Date.now() + 2;
  if (remaining > 0) await sleep(remaining);
}

test('two SQLite connections atomically claim each queued job at most once', async (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);
  const other = openConnection();
  for (let index = 0; index < 12; index += 1) {
    enqueue('atomic-claim', { index }, { id: `atomic-${index}` }, db);
  }

  const claimedIds = new Set<string>();
  for (let count = 0; count < 6; count += 1) {
    const claims = await Promise.all([
      Promise.resolve().then(() => claimNextJob(['atomic-claim'], db)),
      Promise.resolve().then(() => claimNextJob(['atomic-claim'], other)),
    ]);
    assert.ok(claims[0]);
    assert.ok(claims[1]);
    for (const claimedJob of claims) {
      assert.ok(claimedJob);
      if (!claimedJob) throw new Error('Expected both workers to claim a job.');
      assert.equal(claimedJob.status, 'running');
      assert.equal(claimedIds.has(claimedJob.id), false, `duplicate claim for ${claimedJob.id}`);
      claimedIds.add(claimedJob.id);
    }
  }
  assert.equal(claimedIds.size, 12);
  assert.equal(claimNextJob(['atomic-claim'], db), null);
});

test('job progress, completion, retry count, and exponential backoff are persisted', async (t) => {
  const { db } = createTemporaryDatabase(t);
  enqueue(
    'retry-test',
    { payload: 'kept' },
    { id: 'retry-job', maxAttempts: 3, retryDelayMs: 20 },
    db
  );

  const firstAttempt = claimNextJob(['retry-test'], db);
  assert.equal(firstAttempt?.attempts, 1);
  assert.equal(updateJobProgress('retry-job', 48, db), true);
  assert.equal(getJob('retry-job', db)?.progress, 48);

  const firstFailureAt = Date.now();
  assert.equal(failJob('retry-job', 'temporary failure one', db), 'retry');
  const afterFirstFailure = getJob('retry-job', db);
  assert.equal(afterFirstFailure?.status, 'queued');
  assert.equal(afterFirstFailure?.attempts, 1);
  assert.equal(afterFirstFailure?.progress, 0);
  assert.ok(Date.parse(afterFirstFailure!.availableAt) >= firstFailureAt + 20);
  assert.equal(updateJobProgress('retry-job', 70, db), false);

  await waitUntil(afterFirstFailure!.availableAt);
  const secondAttempt = claimNextJob(['retry-test'], db);
  assert.equal(secondAttempt?.attempts, 2);
  const secondFailureAt = Date.now();
  assert.equal(failJob('retry-job', 'temporary failure two', db), 'retry');
  const afterSecondFailure = getJob('retry-job', db);
  assert.equal(afterSecondFailure?.status, 'queued');
  assert.ok(Date.parse(afterSecondFailure!.availableAt) >= secondFailureAt + 40);

  await waitUntil(afterSecondFailure!.availableAt);
  assert.equal(claimNextJob(['retry-test'], db)?.attempts, 3);
  assert.equal(failJob('retry-job', 'permanent failure', db), 'failed');
  assert.equal(getJob('retry-job', db)?.status, 'failed');

  enqueue('complete-test', { payload: 7 }, { id: 'complete-job' }, db);
  assert.equal(claimNextJob(['complete-test'], db)?.id, 'complete-job');
  assert.equal(updateJobProgress('complete-job', 61, db), true);
  assert.equal(completeJob('complete-job', { result: 'ok' }, db), true);
  const completed = getJob('complete-job', db);
  assert.equal(completed?.status, 'done');
  assert.equal(completed?.progress, 100);
  assert.deepEqual(completed?.result, { result: 'ok' });
});

test('large job payload JSON round-trips without truncation', (t) => {
  const { db } = createTemporaryDatabase(t);
  const payload = { prompt: 'structured input '.repeat(25_000), options: { chunk: 500 } };
  enqueue('large-payload', payload, { id: 'large-payload:1' }, db);
  assert.deepEqual(getJob('large-payload:1', db)?.payload, payload);
});

test('startup recovery requeues running jobs for another worker claim', (t) => {
  const { db } = createTemporaryDatabase(t);
  enqueue('recover-test', { task: 1 }, { id: 'orphaned-job' }, db);
  assert.equal(claimNextJob(['recover-test'], db)?.status, 'running');

  assert.equal(recoverRunningJobs(db), 1);
  const recovered = getJob('orphaned-job', db);
  assert.equal(recovered?.status, 'queued');
  assert.equal(recovered?.attempts, 0);
  assert.equal(recovered?.progress, 0);
  assert.match(recovered?.error ?? '', /Recovered after worker restart/);
  assert.equal(claimNextJob(['recover-test'], db)?.id, 'orphaned-job');
});

test('render queue uniqueness is per clip, and enqueue resets its visible clip state atomically', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-queue');
  await saveVideo(source);
  const first = clip('clip-queue-1', source._id);
  const second = clip('clip-queue-2', source._id);
  await saveClip(first);
  await saveClip(second);

  await enqueueClipJob(renderPayload(first));
  await enqueueClipJob(renderPayload(second));

  assert.equal((await getClip(first._id))?.status, 'pending');
  assert.equal((await getClip(second._id))?.status, 'pending');
  assert.equal(getJob(`clip:${first._id}`, db)?.status, 'queued');
  assert.equal(getJob(`clip:${second._id}`, db)?.status, 'queued');

  const activeJob = claimNextJob(['clip-processing'], db);
  assert.ok(activeJob);
  if (!activeJob) throw new Error('Expected a render job to be claimable.');
  const activeClip = await getClip(activeJob.clipId!);
  assert.ok(activeClip);
  if (!activeClip) throw new Error('Expected the claimed clip record to exist.');
  activeClip.status = 'processing';
  await updateClip(activeClip);

  await assert.rejects(
    () => enqueueClipJob(activeJob.payload as JobData),
    /already running/
  );
  assert.equal((await getClip(activeClip._id))?.status, 'processing');
  assert.equal(getJob(activeJob.id, db)?.status, 'running');
});

test('deleting a clip or video cleans up its queued jobs in SQLite', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-delete-jobs');
  const first = clip('clip-delete-one', source._id);
  const second = clip('clip-delete-two', source._id);
  await saveVideo(source);
  await saveClip(first);
  await saveClip(second);

  await enqueueClipJob(renderPayload(first));
  await enqueueTranscriptionJob({ videoId: source._id, filePath: source.filePath });
  assert.ok(getJob(`clip:${first._id}`, db));
  assert.ok(getJob(`transcription:${source._id}`, db));

  await deleteClip(first._id);
  assert.equal(getJob(`clip:${first._id}`, db), null);
  assert.ok(getJob(`transcription:${source._id}`, db));

  await enqueueClipJob(renderPayload(second));
  await deleteVideo(source._id);
  assert.equal(getJob(`transcription:${source._id}`, db), null);
  assert.equal(getJob(`clip:${second._id}`, db), null);
});
