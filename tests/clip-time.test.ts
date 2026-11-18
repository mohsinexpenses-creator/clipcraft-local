import assert from 'node:assert/strict';
import test from 'node:test';
import { wordWithinClip } from '../lib/clip-time';

test('word timestamps convert from source time to clip-relative time and clamp at both boundaries', () => {
  const clipStart = 5632;
  const clipEnd = 5688;
  const first = wordWithinClip({ word: 'start', start: 5631.8, end: 5632.2 }, clipStart, clipEnd);
  const last = wordWithinClip({ word: 'end', start: 5687.8, end: 5688.3 }, clipStart, clipEnd);
  assert.equal(first?.start, 0);
  assert.ok(Math.abs((first?.end ?? 0) - 0.2) < 1e-9);
  assert.ok(Math.abs((last?.start ?? 0) - 55.8) < 1e-9);
  assert.equal(last?.end, 56);
  assert.equal(wordWithinClip({ word: 'outside', start: 5688.1, end: 5688.4 }, clipStart, clipEnd), null);
});