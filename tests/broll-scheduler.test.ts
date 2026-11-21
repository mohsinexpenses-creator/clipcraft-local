import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEDULE_RULES,
  brollImageBudget,
  scheduleBroll,
  type BrollCandidateInput,
} from '../lib/broll/scheduler';

/**
 * The scheduler is the contract between "the AI found 14 relevant images" and
 * "the renderer paints them without ever breaking a product rule". Every test
 * here fails silently in production (an image over the hook, a card over a
 * portrait, 20 images in a 60 s clip), which is exactly why it is pure.
 */

function fullscreen(id: string, start: number, end: number, priority = 5): BrollCandidateInput {
  return { id, kind: 'fullscreen', desiredStart: start, desiredEnd: end, priority };
}

function card(id: string, start: number, end: number, priority = 1): BrollCandidateInput {
  return { id, kind: 'landscape', desiredStart: start, desiredEnd: end, priority };
}

test('image budget scales from the per-60s numbers', () => {
  assert.deepEqual(brollImageBudget(60, 10, 15), { targetMin: 10, targetMax: 15 });
  assert.deepEqual(brollImageBudget(30, 10, 15), { targetMin: 5, targetMax: 7 });
  assert.deepEqual(brollImageBudget(120, 10, 15), { targetMin: 20, targetMax: 30 });
  assert.deepEqual(brollImageBudget(0, 10, 15), { targetMin: 1, targetMax: 1 });
  // Garbage never produces an impossible range.
  assert.deepEqual(brollImageBudget(60, 40, 2), { targetMin: 40, targetMax: 40 });
});

test('nothing is ever scheduled inside the hook replay window', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 4,
    minCount: 1,
    maxCount: 15,
    candidates: [fullscreen('hook-mention', 0, 3), card('early', 0.5, 3)],
  });

  assert.ok(result.items.length >= 1);
  for (const item of result.items) {
    assert.ok(item.start >= 4, `item ${item.id} starts at ${item.start}, inside the hook`);
  }
});

test('a full-screen image beats a landscape card and starts never move', () => {
  // DELIBERATE (Phase 4b): the old scheduler slid the card out of the way. That
  // is exactly what desynced the picture from the sentence, so now the later
  // full-screen item keeps its exact start and the earlier card is either
  // truncated to >= 1.2 s or dropped.
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 1,
    maxCount: 15,
    candidates: [card('card', 10, 14), fullscreen('entity', 10.5, 13.5)],
  });

  const full = result.items.find((item) => item.id === 'entity');
  assert.ok(full, 'the full-screen mention must be placed');
  assert.equal(full.start, 10.5, 'its start is its anchor word, never moved');

  const landscape = result.items.find((item) => item.id === 'card');
  if (landscape) {
    assert.equal(landscape.start, 10, 'an earlier start is never moved either');
    assert.ok(
      landscape.end <= full.start - 0.2 + 1e-6,
      `the card must exit 0.2 s before the entity (${landscape.end} vs ${full.start})`,
    );
    assert.ok(landscape.end - landscape.start >= 1.2 - 1e-6, 'never shorter than 1.2 s');
  } else {
    assert.match(result.notes.join(' '), /no room|takes the slot|Dropped/);
  }
});

test('a conflict truncates the previous card to the exit gap instead of moving anything', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 0,
    maxCount: 5,
    candidates: [card('early', 5, 9, 1), fullscreen('later', 7, 10, 9)],
  });
  const early = result.items.find((item) => item.id === 'early');
  const later = result.items.find((item) => item.id === 'later');
  assert.ok(early && later);
  assert.equal(early.start, 5);
  assert.equal(later.start, 7);
  assert.equal(early.end, Number((7 - 0.2).toFixed(3)), 'truncated to leave the 0.2 s exit gap');
});

test('a card that cannot survive the 1.2 s minimum is dropped, the winner keeps its start', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 0,
    maxCount: 5,
    candidates: [card('stub', 5, 6), fullscreen('winner', 5.6, 9)],
  });
  assert.deepEqual(result.items.map((item) => item.id), ['winner']);
  assert.equal(result.items[0].start, 5.6);
});

test('items last between 2.5 and 4 seconds and keep the 1.5 second gap', () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    card(`c${index}`, index * 4, index * 4 + 2)
  );
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 2,
    minCount: 10,
    maxCount: 15,
    candidates,
  });

  for (const item of result.items) {
    const duration = item.end - item.start;
    assert.ok(duration >= SCHEDULE_RULES.minDuration - 1e-6, `duration ${duration} too short`);
    assert.ok(duration <= SCHEDULE_RULES.maxDuration + 1e-6, `duration ${duration} too long`);
    assert.ok(item.start >= 2, 'after the hook');
  }
  for (let i = 1; i < result.items.length; i += 1) {
    const gap = result.items[i].start - result.items[i - 1].end;
    assert.ok(gap >= SCHEDULE_RULES.minGap - 1e-6, `gap ${gap} between ${i - 1} and ${i}`);
  }
});

test('a 60 second clip can host 10-15 images, and maxCount is a hard ceiling', () => {
  const candidates = Array.from({ length: 40 }, (_, index) =>
    card(`c${index}`, index * 2.5, index * 2.5 + 3)
  );
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 10,
    maxCount: 15,
    candidates,
  });
  // Capacity is physical: 3 s images + 1.5 s gaps fit ~13 into 60 s, and the
  // scheduler must never exceed the configured maximum of 15.
  assert.ok(result.items.length >= 10, `only ${result.items.length} images placed`);
  assert.ok(result.items.length <= 15, `the maximum was exceeded: ${result.items.length}`);
  assert.equal(result.belowMinimum, false);

  const limited = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 10,
    maxCount: 5,
    candidates,
  });
  assert.equal(limited.items.length, 5);
  // A minimum larger than the maximum is impossible, so it is clamped - the plan
  // can never claim to be short of a minimum it could not reach anyway.
  assert.equal(limited.belowMinimum, false);
});

test('longer mentions are trimmed to the 4 s maximum instead of being dropped', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 1,
    maxCount: 5,
    candidates: [fullscreen('long', 5, 20)],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].end - result.items[0].start, SCHEDULE_RULES.maxDuration);
  assert.equal(result.items[0].start, 5, 'the item still starts on the mention');
});

test('mentions shorter than one image duration are moved, not stretched into a wrong claim', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 1,
    maxCount: 5,
    candidates: [fullscreen('blink', 30, 30.4)],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].end - result.items[0].start, SCHEDULE_RULES.minDuration);
});

test('an empty or too-short clip returns no items and says why', () => {
  const empty = scheduleBroll({ clipDuration: 60, hookDuration: 0, minCount: 10, maxCount: 15, candidates: [] });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.belowMinimum, true);
  assert.ok(empty.notes.length >= 1);

  const tiny = scheduleBroll({
    clipDuration: 1,
    hookDuration: 0,
    minCount: 1,
    maxCount: 5,
    candidates: [card('c', 0, 1)],
  });
  assert.equal(tiny.items.length, 0);
  assert.match(tiny.notes.join(' '), /too short/i);
});

test('dense conflicting candidates: the highest relevance keeps the slot, the rest never move', () => {
  const result = scheduleBroll({
    clipDuration: 30,
    hookDuration: 3,
    minCount: 8,
    maxCount: 15,
    candidates: [
      fullscreen('a', 4, 8, 10),
      fullscreen('b', 4, 8, 9),
      fullscreen('c', 4, 8, 8),
      card('d', 5, 9, 4),
      card('e', 5, 9, 3),
    ],
  });
  const sorted = [...result.items].sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].start >= sorted[i - 1].end + 0.2 - 1e-6,
      `overlap/gap violation between ${sorted[i - 1].id} and ${sorted[i].id}`,
    );
  }
  const winner = result.items.find((item) => item.id === 'a');
  assert.ok(winner, 'the highest-priority candidate must be placed');
  assert.equal(winner.start, 7, 'final timeline includes the three-second hook replay, unmoved');
  for (const item of result.items) {
    assert.equal(
      item.start,
      Number((item.desiredStart + 3).toFixed(3)),
      `${item.id} starts on its own anchor`,
    );
  }
});

test('the output is ordered by time and carries the mention window for review', () => {
  const result = scheduleBroll({
    clipDuration: 30,
    hookDuration: 1.5,
    minCount: 2,
    maxCount: 5,
    candidates: [card('late', 20, 24), fullscreen('early', 5, 8)],
  });
  assert.deepEqual(result.items.map((item) => item.id), ['early', 'late']);
  const early = result.items[0];
  assert.equal(early.desiredStart, 5);
  assert.equal(early.desiredEnd, 8);
  assert.ok(early.start >= 1.5);
});
