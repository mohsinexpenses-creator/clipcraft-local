/**
 * Dashboard ordering: newest detection run first, best AI rank first inside a run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sortClipsForDisplay } from '../lib/clip-order';

const clip = (id: string, createdAt: string, rank?: number) => ({ id, createdAt, rank });

test('inside one detection run the best rank comes first, whatever order the API returned', () => {
  const run = '2026-10-06T08:00:00.000Z';
  const sorted = sortClipsForDisplay([clip('c', run, 3), clip('a', run, 1), clip('d', run, 4), clip('b', run, 2)]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['a', 'b', 'c', 'd']
  );
});

test('a newer run is listed before an older one, each in rank order', () => {
  const older = '2026-10-06T08:00:00.000Z';
  const newer = '2026-10-06T09:30:00.000Z';
  const sorted = sortClipsForDisplay([
    clip('old1', older, 1),
    clip('new2', newer, 2),
    clip('old2', older, 2),
    clip('new1', newer, 1),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['new1', 'new2', 'old1', 'old2']
  );
});

test('clips without a rank keep the order they arrived in, so existing dashboards look the same', () => {
  const sorted = sortClipsForDisplay([
    clip('newest', '2026-10-06T09:00:00.000Z'),
    clip('middle', '2026-10-05T09:00:00.000Z'),
    clip('oldest', '2026-10-04T09:00:00.000Z'),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['newest', 'middle', 'oldest']
  );

  const sameMoment = '2026-10-06T09:00:00.000Z';
  assert.deepEqual(
    sortClipsForDisplay([clip('first', sameMoment), clip('second', sameMoment), clip('third', sameMoment)]).map((entry) => entry.id),
    ['first', 'second', 'third'],
    'ties are stable'
  );
});

test('ranked clips of a run come before unranked ones from the same moment, and the input is not mutated', () => {
  const run = '2026-10-06T08:00:00.000Z';
  const input = [clip('plain', run), clip('ranked', run, 5)];
  const sorted = sortClipsForDisplay(input);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['ranked', 'plain']
  );
  assert.deepEqual(
    input.map((entry) => entry.id),
    ['plain', 'ranked'],
    'the caller\'s array is left alone'
  );
});
