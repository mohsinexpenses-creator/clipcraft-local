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

test('a full-screen image beats a landscape card and they never overlap', () => {
  const result = scheduleBroll({
    clipDuration: 60,
    hookDuration: 0,
    minCount: 1,
    maxCount: 15,
    candidates: [card('card', 10, 14), fullscreen('entity', 10.5, 13.5)],
  });

  const full = result.items.find((item) => item.id === 'entity');
  const landscape = result.items.find((item) => item.id === 'card');
  assert.ok(full, 'the full-screen mention must be placed');
  assert.ok(landscape, 'the card can still be placed elsewhere');
  const distance = Math.max(
    landscape.start - full.end,
    full.start - landscape.end,
  );
  assert.ok(distance >= SCHEDULE_RULES.minGap - 1e-6, `gap was ${distance}s, expected >= ${SCHEDULE_RULES.minGap}s`);
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

test('the scheduler never places two items on the same second', () => {
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
      sorted[i].start >= sorted[i - 1].end + SCHEDULE_RULES.minGap - 1e-6,
      `overlap/gap violation between ${sorted[i - 1].id} and ${sorted[i].id}`
    );
  }
  // The highest priority keeps the contested slot; the rest are moved to free
  // space (or dropped), never stacked on top of it.
  const winner = result.items.find((item) => item.id === 'a');
  assert.ok(winner, 'the highest-priority candidate must be placed');
  assert.equal(winner.start, 4);
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
