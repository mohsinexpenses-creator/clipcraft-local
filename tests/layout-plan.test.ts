/**
 * Layout-plan tests: the smoothed pan keyframes the FFmpeg crop expression is
 * built from (shake-free, ENAMETOOLONG-safe) and both layout modes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLayoutPlan,
  buildPanExpression,
  buildSinglePlan,
  flattenAndDecimate,
  PanPoint,
} from '../worker/layout';
import { AsdResult } from '../worker/asd/index';
import { Track } from '../worker/asd/tracker';

function panTrack(id: number, xs: number[], tStep = 0.25, w = 240, t0 = 0): Track {
  const points = xs.map((x, i) => ({
    t: t0 + i * tStep,
    cx: x,
    cy: 400,
    w,
    mouthOpen: null,
    motion: 0.5,
  }));
  return {
    id,
    points,
    visibleTime: xs.length * tStep,
    avgW: w,
    maxW: w,
    cx: xs[Math.floor(xs.length / 2)],
    cy: 400,
    vx: 0,
    vy: 0,
    lastT: t0 + (xs.length - 1) * tStep,
    missed: 0,
  };
}

function asd(tracks: Track[], speakers: Array<{ trackId: number | null; t0: number; t1: number }>): AsdResult {
  return {
    tracks,
    speakerSegments: speakers,
    speakerCount: new Set(speakers.map((s) => s.trackId).filter((x): x is number => x !== null)).size,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: tracks.length,
    framesUsed: 40,
    framesTotal: 40,
    sampleFps: 4,
    voicedRatio: 0.5,
  };
}

test('flattenAndDecimate: a jittering but straight pan collapses to a few keyframes', () => {
  // 80 samples of a smooth diagonal with sub-deadzone jitter: the FFmpeg
  // expression must stay tiny (the old 200-branch chain broke Windows spawn
  // with ENAMETOOLONG) while keeping the first/last anchors.
  const points: PanPoint[] = [];
  for (let i = 0; i < 80; i += 1) {
    points.push({ t: i * 0.25, x: 100 + i * 2, y: 300 + i });
  }
  const out = flattenAndDecimate(points);
  assert.ok(out.length <= 24, `capped at 24 keyframes (got ${out.length})`);
  assert.ok(out.length < points.length / 2, `decimated (got ${out.length}/${points.length})`);
  assert.equal(out[0].t, points[0].t);
  assert.equal(out[out.length - 1].t, points[points.length - 1].t);
});

test('flattenAndDecimate: micro-jitter under the dead zone is dropped (no shake)', () => {
  const points: PanPoint[] = [];
  for (let i = 0; i < 20; i += 1) {
    // Alternate +/- 2px around 500: below the 6px dead zone -> no keyframes added.
    points.push({ t: i * 0.25, x: 500 + (i % 2 === 0 ? 2 : -2), y: 300 });
  }
  const out = flattenAndDecimate(points, 24, 6);
  assert.ok(out.length <= 3, `jitter suppressed (got ${out.length})`);
});

test('buildPanExpression: a static face becomes a clamped constant, not an if-chain', () => {
  const expr = buildPanExpression(
    [
      { t: 0, x: 800, y: 300 },
      { t: 1, x: 800, y: 300 },
      { t: 2, x: 800, y: 300 },
    ],
    'x',
    1920,
    606,
    0.5
  );
  assert.ok(!expr.includes('if('), expr);
  assert.ok(expr.includes('min(max(') || !Number.isNaN(Number(expr)), expr);
});

test('buildPanExpression: a moving face interpolates and stays clamped', () => {
  const expr = buildPanExpression(
    [
      { t: 0, x: 100, y: 300 },
      { t: 2, x: 1500, y: 300 },
    ],
    'x',
    1920,
    606,
    0.5
  );
  assert.ok(expr.includes('if(gte(t,'), expr);
  assert.ok(expr.includes('min(max('), `clamped: ${expr}`);
  assert.ok(expr.length < 200, `short expression (ENAMETOOLONG guard): ${expr.length} chars`);
});

test('speaker-focus plan follows the talking person and glides at the change', () => {
  // A on the left talking first, B on the right after the switch.
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const plan = buildSinglePlan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    1920,
    1080,
    0.32
  );

  assert.equal(plan.mode, 'single');
  assert.ok(plan.points.length > 0, 'has a pan path');
  const firstX = plan.points[0].x;
  const lastX = plan.points[plan.points.length - 1].x;
  assert.ok(firstX < 800, `starts on the left speaker (x=${firstX})`);
  assert.ok(lastX > 1100, `ends on the right speaker (x=${lastX})`);
});

test('split-screen plan builds adaptive cells with active-speaker emphasis', () => {
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const plan = buildLayoutPlan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    'split-screen',
    1920,
    1080
  );

  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2, 'two people -> two cells');
    // Active-speaker emphasis follows the speaker timeline.
    assert.ok(plan.emphasis.length >= 1, 'emphasis timeline present');
    const cellIds = plan.cells.map((c) => c.trackId);
    assert.ok(cellIds.includes(1) && cellIds.includes(2));
  }
});

test('no usable tracks: speaker-focus falls back to a static centred crop', () => {
  const plan = buildSinglePlan(asd([], [{ trackId: null, t0: 0, t1: 10 }]), 1920, 1080, 0.32);
  assert.equal(plan.mode, 'single');
  assert.equal(plan.points.length, 0, 'empty path = static crop');
  assert.ok(plan.cropW > 0 && plan.cropH > 0);
});

test('split grid size follows PEAK concurrent faces, not raw track count', () => {
  // Person A's track is fragmented into ids 1 and 3 (long occlusion in the
  // middle); person B is one track. All three ids speak at some point, so the
  // speaker-count rule alone would ask for 3 panes - but only TWO people ever
  // share the screen, so the split must show exactly 2.
  const a1 = panTrack(1, Array.from({ length: 16 }, () => 400), 0.25, 240, 0); // 0-3.75s
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500), 0.25, 240, 0); // 0-9.75s
  const a2 = panTrack(3, Array.from({ length: 16 }, () => 420), 0.25, 240, 20); // 20-23.75s

  const plan = buildLayoutPlan(
    asd([a1, b, a2], [
      { trackId: 1, t0: 0, t1: 2 },
      { trackId: 2, t0: 2, t1: 6 },
      { trackId: 3, t0: 20, t1: 23 },
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2, 'two people at peak -> exactly two panes');
  }
});

test('a 2-person conversation never becomes a 4-cell grid', () => {
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const plan = buildLayoutPlan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2, 'two tracks -> two stacked panes (1080x960 each)');
    assert.ok(plan.cells.every((c) => c.cellW === 1080 && c.cellH === 960));
  }
});
