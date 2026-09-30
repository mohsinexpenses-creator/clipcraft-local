/**
 * Track-fragment merging: one person whose tracker id died through a long
 * occlusion must come back as ONE person (one split-grid cell), and two real
 * people must never be merged together.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTrackFragments } from '../worker/asd/index';
import { Track } from '../worker/asd/tracker';

function track(id: number, t0: number, t1: number, cx: number, w = 240): Track {
  const points = [];
  for (let t = t0; t <= t1; t += 0.25) {
    points.push({ t, cx, cy: 400, w, mouthOpen: null, motion: 0.5 });
  }
  return {
    id,
    points,
    visibleTime: t1 - t0 + 0.25,
    avgW: w,
    maxW: w,
    cx,
    cy: 400,
    vx: 0,
    vy: 0,
    lastT: t1,
    missed: 0,
  };
}

test('disjoint, spatially close tracks merge into one person', () => {
  // Same person re-identified: visible 0-4s at x=400, gone 4-20s, back at
  // x=430 (small drift) 20-24s.
  const a1 = track(1, 0, 4, 400);
  const a2 = track(3, 20, 24, 430);
  const merged = mergeTrackFragments([a1, a2]);
  assert.equal(merged.length, 1, 'two fragments -> one track');
  assert.equal(merged[0].points.length, a1.points.length + a2.points.length);
  assert.ok(Math.abs(merged[0].visibleTime - (a1.visibleTime + a2.visibleTime)) < 0.01);
});

test('tracks that share the screen are never merged', () => {
  const a = track(1, 0, 10, 400);
  const b = track(2, 0, 10, 430); // close in x but co-visible the whole time
  const merged = mergeTrackFragments([a, b]);
  assert.equal(merged.length, 2, 'co-visible = two different people');
});

test('disjoint tracks far apart stay separate (different seats)', () => {
  const a = track(1, 0, 4, 300);
  const b = track(3, 20, 24, 1600);
  const merged = mergeTrackFragments([a, b]);
  assert.equal(merged.length, 2, 'far apart = different people');
});

test('merge is transitive across three fragments', () => {
  const f1 = track(1, 0, 4, 400);
  const f2 = track(2, 10, 14, 415);
  const f3 = track(3, 20, 24, 430);
  const merged = mergeTrackFragments([f1, f2, f3]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].points.length, f1.points.length + f2.points.length + f3.points.length);
});
