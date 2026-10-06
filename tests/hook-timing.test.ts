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

test('resolveHookTiming preserves a bounded legacy fallback for clips without valid timestamps', () => {
  const timing = resolveHookTiming({
    enabled: true,
    clipStart: 65,
    clipEnd: 130,
    hookTimestampStart: '00:01:20',
    hookTimestampEnd: '',
    fallbackDuration: 5,
  });

  assert.deepEqual(timing, { start: 15, duration: 3, source: 'fallback' });
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
