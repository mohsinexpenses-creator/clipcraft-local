import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePipelineStatus,
  pipelineStatusForVideo,
  countClips,
} from '../lib/pipeline-status';
import type { ClipRecord, VideoRecord } from '../lib/types';

/**
 * The pipeline stage is derived, never stored - so these tests are the contract
 * for "what the dashboard shows". Each case is written the way the real
 * transitions happen: upload queued, transcript running, detection chained,
 * renders running, everything finished, and the two failure shapes.
 */

const TRANSCRIPT = { text: 'a b', segments: [{ id: 0, start: 0, end: 1, text: 'a b' }], words: [] };

function clip(overrides: Partial<ClipRecord>): ClipRecord {
  return {
    _id: 'clip-1',
    videoId: 'video-1',
    start: 0,
    end: 60,
    hookDuration: 3,
    hookText: 'HOOK',
    filterPreset: 'vibrant',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function video(overrides: Partial<VideoRecord>): VideoRecord {
  return {
    _id: 'video-1',
    originalName: 'podcast.mp4',
    fileName: '001_podcast.mp4',
    filePath: '/uploads/001_podcast.mp4',
    duration: 600,
    width: 1920,
    height: 1080,
    fileSize: 1000,
    status: 'uploaded',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a fresh upload is queued for transcription, not "failed" and not "ready"', () => {
  const status = derivePipelineStatus({
    videoStatus: 'uploaded',
    transcriptReady: false,
    counts: countClips([]),
    jobs: [{ type: 'transcription', status: 'queued', progress: 0, videoId: 'video-1' }],
  });

  assert.equal(status.stage, 'transcribing');
  assert.equal(status.steps[0].state, 'active');
  assert.equal(status.steps[1].state, 'pending');
  assert.ok(status.progress < 10, 'progress must start near zero');
});

test('a finished transcript moves the chain into viral detection', () => {
  const status = pipelineStatusForVideo(
    video({ status: 'transcribed', transcript: TRANSCRIPT }),
    [],
    [
      { type: 'transcription', status: 'done', progress: 100, videoId: 'video-1' },
      { type: 'viral-detection', status: 'running', progress: 40, videoId: 'video-1' },
    ]
  );

  assert.equal(status.stage, 'analyzing');
  assert.equal(status.steps[0].state, 'done');
  assert.equal(status.steps[1].state, 'active');
  assert.ok(status.progress > 50 && status.progress < 70);
});

test('clips detected and renders running is the rendering stage', () => {
  const clips = [
    clip({ _id: 'a', status: 'done', progress: 100 }),
    clip({ _id: 'b', status: 'processing', progress: 45 }),
    clip({ _id: 'c', status: 'pending', progress: 0 }),
  ];
  const status = pipelineStatusForVideo(
    video({ status: 'transcribed', transcript: TRANSCRIPT }),
    clips
  );

  assert.equal(status.stage, 'rendering');
  assert.equal(status.counts.done, 1);
  assert.equal(status.activeClips, 2);
  assert.equal(status.steps[2].state, 'active');
});

test('every clip finished is the ready stage at 100%', () => {
  const clips = [clip({ _id: 'a', status: 'done', progress: 100 }), clip({ _id: 'b', status: 'done', progress: 100 })];
  const status = pipelineStatusForVideo(video({ status: 'transcribed', transcript: TRANSCRIPT }), clips);

  assert.equal(status.stage, 'ready');
  assert.equal(status.progress, 100);
  assert.equal(status.steps[2].state, 'done');
});

test('one failed clip among finished ones stays ready (the failure is per clip)', () => {
  const clips = [
    clip({ _id: 'a', status: 'done', progress: 100 }),
    clip({ _id: 'b', status: 'failed', error: 'No face found in this window.' }),
  ];
  const status = pipelineStatusForVideo(video({ status: 'transcribed', transcript: TRANSCRIPT }), clips);

  assert.equal(status.stage, 'ready');
  assert.equal(status.counts.failed, 1);
});

test('a failed detection run surfaces the job error on the analysis step', () => {
  const status = pipelineStatusForVideo(
    video({ status: 'transcribed', transcript: TRANSCRIPT, error: 'AI analysis returned zero viral segments.' }),
    [],
    [
      {
        type: 'viral-detection',
        status: 'failed',
        progress: 0,
        videoId: 'video-1',
        error: 'AI analysis returned zero viral segments.',
      },
    ]
  );

  assert.equal(status.stage, 'failed');
  assert.equal(status.error, 'AI analysis returned zero viral segments.');
  assert.equal(status.steps[1].state, 'failed');
});

test('a failed transcription surfaces on the transcript step', () => {
  const status = pipelineStatusForVideo(
    video({ status: 'failed', error: 'whisper.cpp binary not found.' }),
    [],
    [{ type: 'transcription', status: 'failed', progress: 0, videoId: 'video-1', error: 'whisper.cpp binary not found.' }]
  );

  assert.equal(status.stage, 'failed');
  assert.equal(status.steps[0].state, 'failed');
  assert.match(status.steps[0].error ?? '', /whisper/);
});

test('autoRender off leaves detected clips awaiting a manual render', () => {
  const clips = [clip({ _id: 'a', status: 'pending' })];
  const status = pipelineStatusForVideo(video({ status: 'transcribed', transcript: TRANSCRIPT }), clips, [], {
    autoDetect: true,
    autoRender: false,
    viral: {
      clipCount: 10,
      minClipDuration: 60,
      maxClipDuration: 90,
      includeHookText: true,
      includeCta: true,
    },
  });

  assert.equal(status.stage, 'awaiting-render');
  assert.equal(status.steps[2].state, 'paused');
});

test('detection paused (autoDetect off) is awaiting-detection, never "ready"', () => {
  const status = derivePipelineStatus({
    videoStatus: 'transcribed',
    transcriptReady: true,
    transcriptSegmentCount: 12,
    counts: countClips([]),
    pipeline: {
      autoDetect: false,
      autoRender: false,
      viral: {
        clipCount: 10,
        minClipDuration: 60,
        maxClipDuration: 90,
        includeHookText: true,
        includeCta: true,
      },
    },
  });

  assert.equal(status.stage, 'awaiting-detection');
  assert.equal(status.steps[1].state, 'paused');
});

test('the newest job of a type wins, so an old failure cannot shadow a newer run', () => {
  const status = pipelineStatusForVideo(video({ status: 'transcribed', transcript: TRANSCRIPT }), [], [
    { type: 'viral-detection', status: 'failed', progress: 0, error: 'old timeout' },
    { type: 'viral-detection', status: 'running', progress: 10 },
  ]);

  assert.equal(status.stage, 'analyzing');
  assert.equal(status.error, undefined);
});
