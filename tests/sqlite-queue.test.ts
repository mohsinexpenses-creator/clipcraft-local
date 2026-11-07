import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelClipWorkSync,
  cancelVideoPipelineSync,
  deleteClip,
  deleteVideo,
  getClip,
  getVideo,
  saveClip,
  saveClipForRunningJob,
  saveVideo,
  updateClip,
  updateClipForRunningJob,
  updateVideoForRunningJob,
} from '../lib/db';
import { RenderCancelledError } from '../lib/errors';
import type { ClipRecord, JobData, VideoRecord } from '../lib/types';
import {
  claimNextJob,
  completeJob,
  enqueue,
  enqueueBrollJob,
  enqueueClipJob,
  enqueueTranscriptionJob,
  failJob,
  getJob,
  recoverRunningJobs,
  updateJobProgress,
  watchJobClaim,
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
    captionPresetId: record.captionPresetId ?? 'preset-bold-yellow',
    layout: record.layout,
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

test('render and B-roll claims honor video registration order and skip paused pipelines', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const firstVideo = video('registered-first');
  const secondVideo = video('registered-second');
  await saveVideo(firstVideo);
  await saveVideo(secondVideo);
  assert.equal(firstVideo.queueOrder, 1);
  assert.equal(secondVideo.queueOrder, 2);

  // Enqueue in reverse order: the worker must still serve registration order.
  enqueue('clip-processing', { videoId: secondVideo._id }, { id: 'render-second', videoId: secondVideo._id }, db);
  enqueue('broll', { videoId: firstVideo._id }, { id: 'broll-first', videoId: firstVideo._id }, db);
  const claimedFirst = claimNextJob(['clip-processing', 'broll'], db);
  assert.equal(claimedFirst?.id, 'broll-first');

  cancelVideoPipelineSync(db, secondVideo._id);
  // Even a stale producer that manages to enqueue after the cancel transaction
  // cannot get work claimed while the durable marker remains set.
  enqueue('clip-processing', { videoId: secondVideo._id }, { id: 'render-after-cancel', videoId: secondVideo._id }, db);
  assert.equal(claimNextJob(['clip-processing', 'broll'], db), null, 'cancelled video work is never claimable');
});

test('automatic downstream hand-offs cannot revive a cancelled pipeline or clip', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-handoff-fence');
  const record = clip('clip-handoff-fence', source._id);
  await saveVideo(source);
  await saveClip(record);

  enqueue('viral-detection', { videoId: source._id }, {
    id: 'detect-handoff-fence',
    videoId: source._id,
  }, db);
  const cancelledSource = claimNextJob(['viral-detection'], db)!;
  assert.ok(cancelledSource.startedAt);
  assert.ok(cancelledSource.claimToken);
  cancelVideoPipelineSync(db, source._id);

  await assert.rejects(
    () => enqueueBrollJob(
      { clipId: record._id, videoId: source._id, trigger: 'auto' },
      {
        sourceClaim: {
          jobId: cancelledSource.id,
          startedAt: cancelledSource.startedAt!,
          claimToken: cancelledSource.claimToken,
        },
      },
    ),
    RenderCancelledError,
  );
  assert.equal(getJob(`broll:${record._id}`, db), null, 'a stale detector cannot add B-roll after pipeline cancel');

  const manualSource = video('video-clip-handoff-fence');
  const manuallyCancelled = clip('clip-manual-handoff-fence', manualSource._id);
  await saveVideo(manualSource);
  await saveClip(manuallyCancelled);
  enqueue('viral-detection', { videoId: manualSource._id }, {
    id: 'detect-clip-handoff-fence',
    videoId: manualSource._id,
  }, db);
  const stillCurrentSource = claimNextJob(['viral-detection'], db)!;
  assert.ok(stillCurrentSource.startedAt);
  cancelClipWorkSync(db, manuallyCancelled._id);
  assert.equal((await getClip(manuallyCancelled._id))?.workCancelled, true);

  await assert.rejects(
    () => enqueueBrollJob(
      { clipId: manuallyCancelled._id, videoId: manualSource._id, trigger: 'auto' },
      {
        sourceClaim: {
          jobId: stillCurrentSource.id,
          startedAt: stillCurrentSource.startedAt!,
          claimToken: stillCurrentSource.claimToken,
        },
      },
    ),
    RenderCancelledError,
  );
  assert.equal(getJob(`broll:${manuallyCancelled._id}`, db), null);

  // Even a malformed/stale raw enqueue cannot bypass the physical clip fence at
  // claim time. The explicit manual request below replaces this audit row.
  enqueue('broll', { clipId: manuallyCancelled._id, videoId: manualSource._id }, {
    id: `broll:${manuallyCancelled._id}`,
    clipId: manuallyCancelled._id,
    videoId: manualSource._id,
  }, db);
  assert.equal(claimNextJob(['broll'], db), null);

  // A deliberate user retry clears only the per-clip fence and creates normal
  // work again; it does not require an upstream job to be current.
  await enqueueBrollJob(
    { clipId: manuallyCancelled._id, videoId: manualSource._id, trigger: 'manual' },
    { resumeCancelledClip: true },
  );
  assert.equal((await getClip(manuallyCancelled._id))?.workCancelled, undefined);
  assert.equal(claimNextJob(['broll'], db)?.id, `broll:${manuallyCancelled._id}`);
});

test('a stale claim cannot update, fail, or complete a newer claim with the same stable job id', (t) => {
  const { db } = createTemporaryDatabase(t);
  enqueue('fenced-claim', { value: 1 }, { id: 'stable-fenced-job', maxAttempts: 2, retryDelayMs: 0 }, db);

  const first = claimNextJob(['fenced-claim'], db);
  assert.ok(first?.startedAt);
  assert.ok(first?.claimToken);
  assert.equal(failJob(first!.id, 'retry this attempt', db, first!.startedAt, first!.claimToken), 'retry');

  const second = claimNextJob(['fenced-claim'], db);
  assert.ok(second?.startedAt);
  assert.ok(second?.claimToken);
  assert.notEqual(second!.claimToken, first!.claimToken, 'each claim must receive a fresh opaque fence');

  assert.equal(updateJobProgress(first!.id, 97, db, first!.startedAt, first!.claimToken), false);
  assert.equal(completeJob(first!.id, { stale: true }, db, first!.startedAt, first!.claimToken), false);
  assert.equal(failJob(first!.id, 'late failure', db, first!.startedAt, first!.claimToken), 'ignored');
  assert.equal(getJob(first!.id, db)?.status, 'running');
  assert.equal(getJob(first!.id, db)?.progress, 0);

  assert.equal(updateJobProgress(second!.id, 64, db, second!.startedAt, second!.claimToken), true);
  assert.equal(completeJob(second!.id, { fresh: true }, db, second!.startedAt, second!.claimToken), true);
  assert.deepEqual(getJob(second!.id, db)?.result, { fresh: true });
});

test('claim fences also block stale video and clip record persistence', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-record-fence');
  const record = clip('clip-record-fence', source._id);
  await saveVideo(source);
  await saveClip(record);
  enqueue('viral-detection', { videoId: source._id }, { id: 'detect-record-fence', videoId: source._id, maxAttempts: 2, retryDelayMs: 0 }, db);
  const first = claimNextJob(['viral-detection'], db)!;
  assert.equal(failJob(first.id, 'retry', db, first.startedAt, first.claimToken), 'retry');
  const second = claimNextJob(['viral-detection'], db)!;

  const staleVideo = (await getVideo(source._id))!;
  staleVideo.status = 'transcribed';
  staleVideo.error = undefined;
  assert.equal(
    await updateVideoForRunningJob(staleVideo, first.id, first.startedAt!, first.claimToken),
    false,
  );
  assert.equal((await getVideo(source._id))?.status, 'uploaded');

  const staleClip = (await getClip(record._id))!;
  staleClip.status = 'done';
  staleClip.outputPath = '/generated-clips/should-not-exist.mp4';
  assert.equal(
    await updateClipForRunningJob(staleClip, first.id, first.startedAt!, first.claimToken),
    false,
  );
  assert.equal((await getClip(record._id))?.outputPath, undefined);

  const staleNewClip = clip('clip-created-by-stale-worker', source._id);
  assert.equal(
    await saveClipForRunningJob(staleNewClip, first.id, first.startedAt!, first.claimToken),
    false,
  );
  assert.equal(await getClip(staleNewClip._id), null);

  // The current attempt remains able to write, proving this is a fence rather
  // than a broad lock on the record.
  assert.equal(
    await updateClipForRunningJob(staleClip, second.id, second.startedAt!, second.claimToken),
    true,
  );
});

test('claim watcher aborts promptly when its running job disappears', async (t) => {
  const { db } = createTemporaryDatabase(t);
  enqueue('watch-claim', { value: 1 }, { id: 'watched-job' }, db);
  const job = claimNextJob(['watch-claim'], db);
  assert.ok(job?.startedAt);
  const control = watchJobClaim(job!, db, 300);
  try {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job!.id);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(control.signal.aborted, true);
  } finally {
    control.dispose();
  }
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

test('a failed render is terminal until an explicit enqueue resets it', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-manual-retry');
  const record = clip('clip-manual-retry', source._id);
  await saveVideo(source);
  await saveClip(record);

  await enqueueClipJob(renderPayload(record));
  const firstAttempt = claimNextJob(['clip-processing'], db);
  assert.equal(firstAttempt?.maxAttempts, 1);
  assert.equal(failJob(firstAttempt!.id, 'render failed', db), 'failed');
  assert.equal(getJob(firstAttempt!.id, db)?.status, 'failed');
  assert.equal(claimNextJob(['clip-processing'], db), null);

  await enqueueClipJob(renderPayload(record));
  const manuallyQueued = getJob(firstAttempt!.id, db);
  assert.equal(manuallyQueued?.status, 'queued');
  assert.equal(manuallyQueued?.attempts, 0);
  assert.equal(claimNextJob(['clip-processing'], db)?.attempts, 1);
});

test('deleting a clip invalidates an active worker claim before it can persist again', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const source = video('video-delete-active');
  const record = clip('clip-delete-active', source._id);
  await saveVideo(source);
  await saveClip(record);
  await enqueueClipJob(renderPayload(record));
  const active = claimNextJob(['clip-processing'], db);
  assert.ok(active?.startedAt);
  const control = watchJobClaim(active!, db, 300);
  try {
    assert.equal(await deleteClip(record._id), true);
    assert.equal(getJob(active!.id, db), null);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(control.signal.aborted, true, 'the active process sees its deleted claim within the watch interval');
  } finally {
    control.dispose();
  }
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
