import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  closeDatabase,
  getDatabase,
  saveClip,
  saveVideo,
} from '../lib/db';
import { saveSettingsSection } from '../lib/app-settings';
import {
  CLIP_QUEUE_NAME,
  TRANSCRIPTION_QUEUE_NAME,
  VIRAL_DETECTION_QUEUE_NAME,
  VISUAL_PREFETCH_QUEUE_NAME,
  claimNextJob,
  completeJob,
  enqueue,
  getVideoQueuePositions,
  recoverRunningJobs,
} from '../lib/queue';
import { recoverAutoPipelines, processVisualPrefetchJob } from '../lib/pipeline';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-fifo-'));
const dbFile = path.join(tmpDir, 'fifo.sqlite');

before(() => {
  process.env.DATABASE_PATH = dbFile;
  closeDatabase();
});

after(() => {
  closeDatabase();
  delete process.env.DATABASE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeClip(id: string, videoId: string) {
  return {
    _id: id,
    videoId,
    start: 0,
    end: 60,
    hookDuration: 3,
    hookText: 'Hook',
    ctaDuration: 2.5,
    filterPreset: 'vibrant' as const,
    status: 'pending' as const,
    progress: 0,
    createdAt: '2026-10-13T10:05:00.000Z',
    updatedAt: '2026-10-13T10:05:00.000Z',
  };
}

test('strictVideoOrder (default ON) processes 3 uploaded videos strictly one at a time in FIFO upload order', async () => {
  const db = getDatabase();
  db.exec('DELETE FROM jobs; DELETE FROM clips; DELETE FROM videos; DELETE FROM app_settings;');

  // Upload 3 videos in order: v1, v2, v3
  await saveVideo({
    _id: 'v1',
    fileName: 'v1.mp4',
    originalName: 'Video 1.mp4',
    filePath: '/tmp/v1.mp4',
    fileSize: 1024,
    duration: 180,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
  });
  await saveVideo({
    _id: 'v2',
    fileName: 'v2.mp4',
    originalName: 'Video 2.mp4',
    filePath: '/tmp/v2.mp4',
    fileSize: 1024,
    duration: 180,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    createdAt: '2026-10-13T10:01:00.000Z',
    updatedAt: '2026-10-13T10:01:00.000Z',
  });
  await saveVideo({
    _id: 'v3',
    fileName: 'v3.mp4',
    originalName: 'Video 3.mp4',
    filePath: '/tmp/v3.mp4',
    fileSize: 1024,
    duration: 180,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    createdAt: '2026-10-13T10:02:00.000Z',
    updatedAt: '2026-10-13T10:02:00.000Z',
  });

  // All 3 videos enqueue transcription on upload
  enqueue(TRANSCRIPTION_QUEUE_NAME, { videoId: 'v1', filePath: '/tmp/v1.mp4' }, { id: 'transcription:v1', videoId: 'v1' });
  enqueue(TRANSCRIPTION_QUEUE_NAME, { videoId: 'v2', filePath: '/tmp/v2.mp4' }, { id: 'transcription:v2', videoId: 'v2' });
  enqueue(TRANSCRIPTION_QUEUE_NAME, { videoId: 'v3', filePath: '/tmp/v3.mp4' }, { id: 'transcription:v3', videoId: 'v3' });

  // Check queue positions: v1 -> #1, v2 -> #2, v3 -> #3
  const initialPositions = getVideoQueuePositions();
  assert.equal(initialPositions.get('v1'), 1);
  assert.equal(initialPositions.get('v2'), 2);
  assert.equal(initialPositions.get('v3'), 3);

  const executionLog: string[] = [];

  // 1. Transcription worker claims v1
  const t1 = claimNextJob([TRANSCRIPTION_QUEUE_NAME]);
  assert.ok(t1);
  assert.equal(t1.videoId, 'v1');
  executionLog.push(`transcribe:${t1.videoId}`);

  // While v1 is transcribing, a second transcription call or viral/clip worker cannot claim v2 or v3
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);
  assert.equal(claimNextJob([VIRAL_DETECTION_QUEUE_NAME]), null);
  assert.equal(claimNextJob([CLIP_QUEUE_NAME]), null);

  // v1 finishes transcription and chains viral-detection before completing the transcription job
  enqueue(VIRAL_DETECTION_QUEUE_NAME, { videoId: 'v1' }, { id: 'viral-detection:v1', videoId: 'v1' });
  completeJob(t1.id, { ok: true });

  // Even though transcription:v2 was created BEFORE viral-detection:v1,
  // transcription worker MUST NOT claim v2 while v1 still has viral-detection queued!
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);

  // 2. Viral detection worker claims v1
  const d1 = claimNextJob([VIRAL_DETECTION_QUEUE_NAME]);
  assert.ok(d1);
  assert.equal(d1.videoId, 'v1');
  executionLog.push(`detect:${d1.videoId}`);

  // v1 detection enqueues 2 clip renders before completing detection
  await saveClip(makeClip('v1-c1', 'v1'));
  await saveClip(makeClip('v1-c2', 'v1'));
  enqueue(CLIP_QUEUE_NAME, { videoId: 'v1', clipId: 'v1-c1' }, { id: 'clip:v1-c1', videoId: 'v1', clipId: 'v1-c1' });
  enqueue(CLIP_QUEUE_NAME, { videoId: 'v1', clipId: 'v1-c2' }, { id: 'clip:v1-c2', videoId: 'v1', clipId: 'v1-c2' });
  completeJob(d1.id, { ok: true });

  // Still cannot claim v2 transcription while v1 clips are queued/running
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);

  // 3. Clip worker claims and finishes v1's clips
  const c1 = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(c1);
  assert.equal(c1.clipId, 'v1-c1');
  executionLog.push(`render:${c1.clipId}`);
  completeJob(c1.id, { ok: true });

  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null, 'v1 still has 1 clip left');

  const c2 = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(c2);
  assert.equal(c2.clipId, 'v1-c2');
  executionLog.push(`render:${c2.clipId}`);
  completeJob(c2.id, { ok: true });

  // Now v1 has 0 active jobs! Queue positions shift so v2 is #1 and v3 is #2
  const afterV1Positions = getVideoQueuePositions();
  assert.equal(afterV1Positions.has('v1'), false);
  assert.equal(afterV1Positions.get('v2'), 1);
  assert.equal(afterV1Positions.get('v3'), 2);

  // 4. Now v2 runs through transcription -> detection -> render before v3 can start
  const t2 = claimNextJob([TRANSCRIPTION_QUEUE_NAME]);
  assert.ok(t2);
  assert.equal(t2.videoId, 'v2');
  executionLog.push(`transcribe:${t2.videoId}`);
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null, 'v3 must wait for v2');

  enqueue(VIRAL_DETECTION_QUEUE_NAME, { videoId: 'v2' }, { id: 'viral-detection:v2', videoId: 'v2' });
  completeJob(t2.id, { ok: true });

  const d2 = claimNextJob([VIRAL_DETECTION_QUEUE_NAME]);
  assert.ok(d2);
  assert.equal(d2.videoId, 'v2');
  executionLog.push(`detect:${d2.videoId}`);
  await saveClip(makeClip('v2-c1', 'v2'));
  enqueue(CLIP_QUEUE_NAME, { videoId: 'v2', clipId: 'v2-c1' }, { id: 'clip:v2-c1', videoId: 'v2', clipId: 'v2-c1' });
  completeJob(d2.id, { ok: true });

  const v2c1 = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(v2c1);
  assert.equal(v2c1.clipId, 'v2-c1');
  executionLog.push(`render:${v2c1.clipId}`);
  completeJob(v2c1.id, { ok: true });

  // 5. Now v3 is #1 and can run
  const afterV2Positions = getVideoQueuePositions();
  assert.equal(afterV2Positions.get('v3'), 1);

  const t3 = claimNextJob([TRANSCRIPTION_QUEUE_NAME]);
  assert.ok(t3);
  assert.equal(t3.videoId, 'v3');
  executionLog.push(`transcribe:${t3.videoId}`);
  completeJob(t3.id, { ok: true });

  assert.deepEqual(executionLog, [
    'transcribe:v1',
    'detect:v1',
    'render:v1-c1',
    'render:v1-c2',
    'transcribe:v2',
    'detect:v2',
    'render:v2-c1',
    'transcribe:v3',
  ]);
});

test('setting worker.strictVideoOrder = false allows cross-video claims', async () => {
  const db = getDatabase();
  db.exec('DELETE FROM jobs; DELETE FROM clips; DELETE FROM videos; DELETE FROM app_settings;');

  await saveVideo({
    _id: 'v1',
    fileName: 'v1.mp4',
    originalName: 'Video 1.mp4',
    filePath: '/tmp/v1.mp4',
    fileSize: 1024,
    duration: 180,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
  });
  await saveVideo({
    _id: 'v2',
    fileName: 'v2.mp4',
    originalName: 'Video 2.mp4',
    filePath: '/tmp/v2.mp4',
    fileSize: 1024,
    duration: 180,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    createdAt: '2026-10-13T10:01:00.000Z',
    updatedAt: '2026-10-13T10:01:00.000Z',
  });
  await saveClip(makeClip('v1-c1', 'v1'));

  await saveSettingsSection('worker', {
    clipConcurrency: 1,
    viralConcurrency: 1,
    remotionConcurrency: null,
    strictVideoOrder: false,
  });

  enqueue(CLIP_QUEUE_NAME, { videoId: 'v1', clipId: 'v1-c1' }, { id: 'clip:v1-c1', videoId: 'v1', clipId: 'v1-c1' });
  enqueue(TRANSCRIPTION_QUEUE_NAME, { videoId: 'v2', filePath: '/tmp/v2.mp4' }, { id: 'transcription:v2', videoId: 'v2' });

  const c1 = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(c1);
  assert.equal(c1.videoId, 'v1');

  // With strictVideoOrder disabled, v2 transcription can be claimed while v1 is rendering
  const t2 = claimNextJob([TRANSCRIPTION_QUEUE_NAME]);
  assert.ok(t2);
  assert.equal(t2.videoId, 'v2');
});

test('recoverRunningJobs and recoverAutoPipelines preserve FIFO order across restarts', async () => {
  const db = getDatabase();
  db.exec('DELETE FROM jobs; DELETE FROM clips; DELETE FROM videos; DELETE FROM app_settings;');

  await saveVideo({
    _id: 'v-older',
    fileName: 'older.mp4',
    originalName: 'Older.mp4',
    filePath: '/tmp/older.mp4',
    fileSize: 1024,
    duration: 120,
    width: 1920,
    height: 1080,
    status: 'transcribed',
    transcript: { text: 'hello', segments: [], words: [] },
    pipeline: {
      autoDetect: true,
      autoRender: true,
      viral: { clipCount: 5, minClipDuration: 60, maxClipDuration: 90, includeHookText: true, includeCta: true },
    },
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  });
  await saveClip({
    _id: 'c-older-1',
    videoId: 'v-older',
    start: 0,
    end: 60,
    hookDuration: 3,
    hookText: 'Hook',
    ctaDuration: 2.5,
    filterPreset: 'vibrant',
    status: 'pending',
    progress: 0,
    createdAt: '2026-10-13T08:01:00.000Z',
    updatedAt: '2026-10-13T08:01:00.000Z',
  });

  await saveVideo({
    _id: 'v-newer',
    fileName: 'newer.mp4',
    originalName: 'Newer.mp4',
    filePath: '/tmp/newer.mp4',
    fileSize: 1024,
    duration: 120,
    width: 1920,
    height: 1080,
    status: 'uploaded',
    pipeline: {
      autoDetect: true,
      autoRender: true,
      viral: { clipCount: 5, minClipDuration: 60, maxClipDuration: 90, includeHookText: true, includeCta: true },
    },
    createdAt: '2026-10-13T09:00:00.000Z',
    updatedAt: '2026-10-13T09:00:00.000Z',
  });

  recoverRunningJobs();
  const recovered = await recoverAutoPipelines();
  assert.deepEqual(recovered.resumed, ['v-older:render x1', 'v-newer:transcription']);

  // Because v-older was uploaded first, transcription worker cannot claim v-newer until v-older's render finishes
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);
  const prefetch = claimNextJob([VISUAL_PREFETCH_QUEUE_NAME]);
  assert.ok(prefetch, 'the older video resumes its per-clip visual step first');
  await processVisualPrefetchJob(prefetch.payload as import('../lib/types').VisualPrefetchJobData);
  completeJob(prefetch.id, { ok: true });
  const olderClipJob = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(olderClipJob);
  assert.equal(olderClipJob.videoId, 'v-older');
  completeJob(olderClipJob.id, { ok: true });

  const newerTransJob = claimNextJob([TRANSCRIPTION_QUEUE_NAME]);
  assert.ok(newerTransJob);
  assert.equal(newerTransJob.videoId, 'v-newer');
});
