import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../lib/errors';
import { resolveHookTiming } from '../worker/hook-timing';

test('resolveHookTiming uses the full detected start-to-end interval', () => {
  const timing = resolveHookTiming({
    enabled: true,
    clipStart: 65,
    clipEnd: 130,
    hookTimestampStart: '00:01:20',
    hookTimestampEnd: '00:01:24',
    fallbackDuration: 3,
  });

  assert.deepEqual(timing, {
    start: 15,
    duration: 4,
    source: 'timestamps',
    startAbsolute: 80,
    endAbsolute: 84,
  });
});

test('resolveHookTiming keeps the hook disabled even when AI timestamps are present', () => {
  assert.deepEqual(
    resolveHookTiming({
      enabled: false,
      clipStart: 65,
      clipEnd: 130,
      hookTimestampStart: '00:01:20',
      hookTimestampEnd: '00:01:24',
    }),
    { start: 0, duration: 0, source: 'disabled' }
  );
});

test('resolveHookTiming falls back to the configured length when the analysis has no usable interval', () => {
  const timing = resolveHookTiming({
    enabled: true,
    clipStart: 65,
    clipEnd: 130,
    hookTimestampStart: '00:01:20',
    hookTimestampEnd: '',
    fallbackDuration: 5,
  });

  // 5s, not 3s: the Settings page owns this number and allows up to 30, so rewriting it
  // here would make the field a lie. A start with no end is "no usable interval".
  assert.deepEqual(timing, { start: 15, duration: 5, source: 'fallback' });
});

test('a fallback intro can never be longer than the clip it replays', () => {
  const short = resolveHookTiming({
    enabled: true,
    clipStart: 10,
    clipEnd: 16, // a 6s clip
    fallbackDuration: 20,
  });
  assert.equal(short.duration, 3, 'bounded by half the segment');
  assert.equal(short.start, 0);

  // Nothing configured at all -> the shipped 3s, when it fits.
  assert.equal(
    resolveHookTiming({ enabled: true, clipStart: 0, clipEnd: 120 }).duration,
    3
  );
});

test('resolveHookTiming rejects a valid timestamp interval that cannot fit inside the selected clip', () => {
  assert.throws(
    () => resolveHookTiming({
      enabled: true,
      clipStart: 65,
      clipEnd: 83,
      hookTimestampStart: '00:01:20',
      hookTimestampEnd: '00:01:24',
    }),
    (error: unknown) => error instanceof AppError && error.status === 400
  );
});
