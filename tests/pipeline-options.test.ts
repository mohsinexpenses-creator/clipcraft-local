import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeClipEdits } from '../lib/clip-edits';
import { sanitizePipelineOptions, sanitizeViralOptions } from '../lib/pipeline-defaults';
import { DEFAULT_VIRAL_OPTIONS } from '../lib/types';

/**
 * The automatic pipeline reads its settings from untrusted input in three
 * places (upload body, detect request body, video PATCH), all of which funnel
 * into these two validators.
 */

test('empty input still produces a complete, valid pipeline configuration', () => {
  const pipeline = sanitizePipelineOptions({});

  assert.deepEqual(pipeline, {
    autoDetect: true,
    autoRender: true,
    viral: { ...DEFAULT_VIRAL_OPTIONS },
  });
});

test('garbage and out-of-range numbers are clamped, never trusted', () => {
  const options = sanitizeViralOptions({
    clipCount: 9999,
    minClipDuration: '3',
    includeHookText: 'false',
    includeCta: 'yes please',
  });

  assert.equal(options.clipCount, 25, 'clipCount is capped at the UI maximum');
  assert.equal(options.minClipDuration, 5, 'minClipDuration is clamped up to the floor');
  assert.equal(options.maxClipDuration, DEFAULT_VIRAL_OPTIONS.maxClipDuration, 'max stays fixed');
  assert.equal(options.includeHookText, false, '"false" means off');
  assert.equal(options.includeCta, true, 'unparsable flag keeps the default');
});

test('a nested { options } body is unwrapped the way the dashboard sends it', () => {
  const options = sanitizeViralOptions({ options: { clipCount: 4, minClipDuration: 45 } });

  assert.equal(options.clipCount, 4);
  assert.equal(options.minClipDuration, 45);
});

test('clip edits are validated and the empty-hook convention is enforced', () => {
  const edits = sanitizeClipEdits(
    { start: '10.5', end: '70.25', hookText: '  ', ctaText: ' FOLLOW FOR MORE ', captionEngine: 'nope', layout: 'split-screen' },
    { duration: 600 }
  );

  assert.equal(edits.start, 10.5);
  assert.equal(edits.end, 70.25);
  assert.equal(edits.hookDuration, 0, 'empty hook text means no hook intro');
  assert.equal(edits.ctaText, 'FOLLOW FOR MORE');
  assert.equal(edits.captionEngine, 'remotion', 'unknown engine falls back to the default');
  assert.equal(edits.layout, 'split-screen');
});

test('a non-empty hook text without an explicit duration re-enables the hook intro', () => {
  const edits = sanitizeClipEdits({ hookText: 'WATCH THIS' });

  assert.equal(edits.hookDuration, 3);
});

test('impossible clip windows are rejected with an actionable error', () => {
  assert.throws(() => sanitizeClipEdits({ start: 30, end: 30 }), /after its start time/);
  assert.throws(() => sanitizeClipEdits({ start: -1, end: 20 }), /cannot be negative/);
  assert.throws(() => sanitizeClipEdits({ start: 0 }), /both "start" and "end"/);
  assert.throws(() => sanitizeClipEdits({ start: 0, end: 700 }, { duration: 600 }), /past the end of the source video/);
  assert.throws(() => sanitizeClipEdits({ start: 'abc', end: 20 }), /not a number/);
});
