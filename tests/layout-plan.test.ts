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
  buildSplitFilterComplex,
  cellCropSize,
  getSplitFramingSettings,
  flattenAndDecimate,
  MAX_CELL_UPSCALE,
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

test('split-screen plan builds adaptive cells (one per person, no emphasis layer)', () => {
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
    const cellIds = plan.cells.map((c) => c.trackId);
    assert.ok(cellIds.includes(1) && cellIds.includes(2));
    // The red "active speaker" frame is gone for good - the plan has no such layer.
    assert.equal('emphasis' in plan, false, 'no emphasis layer in the plan');
  }
});

test('split filter graph draws NOTHING on top of the panes (no red frame)', () => {
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const plan = buildLayoutPlan(
    // Both people speak, in turns - the old planner drew a red box on whoever talked.
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
    const graph = buildSplitFilterComplex(plan, 1920, 1080, '');
    assert.ok(!/drawbox/i.test(graph), 'no drawbox filter');
    assert.ok(!/ef4444|0xef|red/i.test(graph), 'no red colour anywhere in the graph');
    assert.ok(graph.includes('[vout]'), 'still ends in [vout]');
  }
});

test('split panes of people who sit still get CONSTANT crop expressions (no per-frame motion)', () => {
  const a = panTrack(1, Array.from({ length: 40 }, (_, i) => 400 + (i % 2 === 0 ? 3 : -3)));
  const b = panTrack(2, Array.from({ length: 40 }, (_, i) => 1500 + (i % 3 === 0 ? 4 : -2)));
  const plan = buildLayoutPlan(
    asd([a, b], [{ trackId: 1, t0: 0, t1: 10 }]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    for (const cell of plan.cells) {
      assert.equal(cell.camera.moves.length, 0, `pane of person ${cell.trackId} never moves`);
    }
    const graph = buildSplitFilterComplex(plan, 1920, 1080, '');
    const crops = graph.match(/crop=\d+:\d+:'[^']*':'[^']*'/g) ?? [];
    assert.equal(crops.length, 2);
    for (const crop of crops) {
      assert.ok(!/\bt\b/.test(crop.replace(/crop=\d+:\d+/, '')), `no time variable in ${crop}`);
    }
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

test('two people co-existing still get two panes when only ONE is judged the speaker', () => {
  // The reported bug: the speaker timeline (a heuristic) labelled only person
  // A as speaker, and the split grid collapsed to a single full-screen cell.
  // A 2-person conversation must be a 2-pane split regardless.
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const plan = buildLayoutPlan(
    asd([a, b], [{ trackId: 1, t0: 0, t1: 10 }]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2, 'two co-existing people -> two panes');
    const cellIds = plan.cells.map((c) => c.trackId);
    assert.ok(cellIds.includes(1) && cellIds.includes(2), 'both people are shown');
  }
});

test('2-person split: the left person gets the TOP pane, the right person the bottom (stable)', () => {
  // The requested 2-person layout: one person centred in the upper half, the
  // other in the lower half, with a STABLE assignment (it must not swap
  // mid-clip as the speaker changes).
  const a = panTrack(1, Array.from({ length: 40 }, () => 400)); // left person
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500)); // right person
  const plan = buildLayoutPlan(
    asd([a, b], [
      { trackId: 2, t0: 0, t1: 5 }, // the RIGHT person speaks first
      { trackId: 1, t0: 5, t1: 10 }, // ...then the left one takes over
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2);
    const top = plan.cells.find((c) => c.cellY === 0);
    const bottom = plan.cells.find((c) => c.cellY === 960);
    assert.ok(top && bottom, 'two stacked 1080x960 halves');
    assert.equal(top!.trackId, 1, 'left person is always the top pane');
    assert.equal(bottom!.trackId, 2, 'right person is always the bottom pane');
    // Each cell uses the same configured 38% face target while pane identity stays fixed.
    assert.ok(top!.cropW > 0 && top!.cropH > 0);
  }
});

test('split filter graph never consumes a pad label twice (FFmpeg rejects that)', () => {
  // Regression: every cell used to reference [base] directly. A filtergraph
  // pad label can be consumed exactly ONCE, so FFmpeg rejected the whole
  // graph ("Invalid stream specifier: base") and wrote an empty file - the
  // split screen never rendered. The base must be fanned out with split=N.
  const a = panTrack(1, Array.from({ length: 40 }, () => 400));
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500));
  const c = panTrack(3, Array.from({ length: 40 }, () => 960));
  const plan = buildLayoutPlan(
    asd([a, b, c], [
      { trackId: 1, t0: 0, t1: 4 },
      { trackId: 2, t0: 4, t1: 8 },
      { trackId: 3, t0: 8, t1: 10 },
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode !== 'split') return;
  const graph = buildSplitFilterComplex(plan, 1920, 1080, '');
  assert.ok(
    graph.includes(`split=${plan.cells.length}`),
    `base fanned out with split=${plan.cells.length}: ${graph.slice(0, 120)}...`
  );
  // A label may appear at most TWICE in the whole graph string: once where it
  // is PRODUCED (end of a chain) and once where it is CONSUMED (start of a
  // chain). Three occurrences = a pad consumed twice = broken graph.
  const labels = graph.match(/\[[a-z0-9]+\]/gi) ?? [];
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const [label, count] of counts) {
    assert.ok(count <= 2, `pad ${label} appears ${count} times (max 2)`);
  }
});

test('small faces in a wide shot still get their panes (no silent centre crop)', () => {
  // Two real people whose YuNet faces are only ~30px wide in source space
  // (below the candidate threshold, e.g. a wide shot). The split must NOT
  // silently degrade to a single static centred crop - it shows the most
  // visible people anyway.
  const a = panTrack(1, Array.from({ length: 40 }, () => 400), 0.25, 30);
  const b = panTrack(2, Array.from({ length: 40 }, () => 1500), 0.25, 30);
  const plan = buildLayoutPlan(
    asd([a, b], [{ trackId: null, t0: 0, t1: 10 }]), // nobody judged speaker
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode === 'split') {
    assert.equal(plan.cells.length, 2, 'two small faces -> two panes, not a centre crop');
    assert.ok(plan.cells.every((c) => c.trackId !== -1), 'cells track real people');
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

// ---------------------------------------------------------------------------
// Quality + "split screen must really split" regressions
// ---------------------------------------------------------------------------

test('regression: ONE detected person never becomes a one-cell 5x zoom "split"', () => {
  // The reported failure: a split-screen render found a single face (121px
  // wide) and built a one-cell "split" that cropped ~212x378px and enlarged it
  // 5x to 1080x1920 - one blurry face filling the whole frame, no split.
  const only = panTrack(1, Array.from({ length: 40 }, () => 1400), 0.25, 121);
  const plan = buildLayoutPlan(asd([only], [{ trackId: 1, t0: 0, t1: 10 }]), 'split-screen', 1920, 1080);

  assert.equal(plan.mode, 'single', 'one person cannot be a split');
  if (plan.mode === 'single') {
    assert.equal(plan.cropH, 1080, 'the proper full-height 9:16 window');
    assert.ok(1080 / plan.cropW <= 1.8, `magnification ${(1080 / plan.cropW).toFixed(2)}x stays at the speaker-focus level`);
    assert.match(plan.splitFallbackReason ?? '', /two people/i, 'the fallback explains itself');
    assert.match(plan.splitFallbackReason ?? '', /only one/i);
  }
});

test('split with no tracks at all: a static centred single window with a reason (never a crash)', () => {
  const plan = buildLayoutPlan(asd([], [{ trackId: null, t0: 0, t1: 10 }]), 'split-screen', 1920, 1080);
  assert.equal(plan.mode, 'single');
  if (plan.mode === 'single') {
    assert.equal(plan.points.length, 0, 'static crop');
    assert.match(plan.splitFallbackReason ?? '', /none could be confirmed/i);
  }
});

test('speaker-focus never carries a split fallback reason', () => {
  const only = panTrack(1, Array.from({ length: 40 }, () => 1400), 0.25, 121);
  const plan = buildLayoutPlan(asd([only], [{ trackId: 1, t0: 0, t1: 10 }]), 'speaker-focus', 1920, 1080);
  assert.equal(plan.mode, 'single');
  if (plan.mode === 'single') assert.equal(plan.splitFallbackReason, undefined);
});

test('cellCropSize limits default enlargement, keeps pane aspect, and respects source bounds', () => {
  // Small host face: the default 1.5x cap wins over the tighter 38%-face crop.
  const standard = cellCropSize(100, 1080, 960, 1920, 1080);
  assert.deepEqual(standard, { cropW: 720, cropH: 640 });
  assert.ok(1080 / standard.cropW <= 1.5 && 960 / standard.cropH <= 1.5);
  assert.ok(Math.abs(standard.cropW / standard.cropH - 1080 / 960) < 0.02);

  // A no-upscale setting uses a crop exactly the size of the output pane.
  const noUpscale = cellCropSize(
    100,
    1080,
    960,
    1920,
    1080,
    getSplitFramingSettings({ SPLIT_ZOOM: '1.0' })
  );
  assert.deepEqual(noUpscale, { cropW: 1080, cropH: 960 });

  // A larger face may reach the preferred 38% size without exceeding the cap.
  const big = cellCropSize(200, 1080, 960, 1920, 1080);
  assert.ok(Math.abs(250 / big.cropH - 0.38) < 0.005);
  assert.ok(Math.abs(big.cropW / big.cropH - 1080 / 960) < 0.02, 'keeps the pane aspect');

  // Enormous face (close-up): never larger than the source.
  const huge = cellCropSize(900, 1080, 960, 1920, 1080);
  assert.ok(huge.cropH <= 1080 && huge.cropW <= 1920);

  // Narrow 9:16 pane of a 3/4-person grid keeps its aspect and same zoom cap.
  const narrow = cellCropSize(100, 540, 960, 1920, 1080);
  assert.deepEqual(narrow, { cropW: 360, cropH: 640 });
  assert.ok(Math.abs(narrow.cropW / narrow.cropH - 540 / 960) < 0.02);

  // A source too small to honour the requested zoom still yields a crop INSIDE it.
  const tiny = cellCropSize(30, 1080, 960, 640, 360);
  assert.ok(tiny.cropW <= 640 && tiny.cropH <= 360, `${tiny.cropW}x${tiny.cropH}`);
});

test('split framing settings use defaults, parse overrides, and clamp unsafe values', () => {
  assert.deepEqual(getSplitFramingSettings({}), { faceTargetFrac: 0.38, zoom: 1.5 });
  assert.deepEqual(
    getSplitFramingSettings({ SPLIT_FACE_TARGET_FRAC: '0.42', SPLIT_ZOOM: '1.8' }),
    { faceTargetFrac: 0.42, zoom: 1.8 }
  );
  assert.deepEqual(
    getSplitFramingSettings({ SPLIT_FACE_TARGET_FRAC: '0.05', SPLIT_ZOOM: '9' }),
    { faceTargetFrac: 0.25, zoom: 2 }
  );
  assert.deepEqual(
    getSplitFramingSettings({ SPLIT_FACE_TARGET_FRAC: 'invalid', SPLIT_ZOOM: '-2' }),
    { faceTargetFrac: 0.38, zoom: 1 }
  );
});

test('configured split framing is consistent in 2-, 3-, and 4-cell grids', () => {
  const framing = getSplitFramingSettings({ SPLIT_FACE_TARGET_FRAC: '0.42', SPLIT_ZOOM: '4' });
  for (const people of [2, 3, 4]) {
    const xPositions = Array.from({ length: people }, (_, i) => 300 + i * (1300 / Math.max(1, people - 1)));
    const tracks = xPositions.map((x, i) => panTrack(i + 1, Array.from({ length: 40 }, () => x), 0.25, 100));
    const speakers = tracks.map((track) => ({ trackId: track.id, t0: 0, t1: 10 }));
    const plan = buildLayoutPlan(asd(tracks, speakers), 'split-screen', 1920, 1080, framing);
    assert.equal(plan.mode, 'split', people + ' people');
    if (plan.mode !== 'split') continue;
    assert.equal(plan.cells.length, people);
    for (const cell of plan.cells) {
      const faceCentre = (cell.faceZone.top + cell.faceZone.bottom) / 2;
      assert.ok(
        Math.abs(faceCentre - (cell.cellY + 0.42 * cell.cellH)) < 6,
        people + ' cells: configured face target for track ' + cell.trackId
      );
      assert.ok(cell.camera.moves.length === 0, 'static person remains locked in the same cell');
      assert.ok(cell.cellW / cell.cropW <= 2.02 && cell.cellH / cell.cropH <= 2.02, 'zoom remains within the 2x safety cap');
      assert.ok(cell.cropW <= 1920 && cell.cropH <= 1080, 'crop respects the source dimensions');
    }
  }
});

test('1080p split panes respect the default zoom cap across face sizes and 2/3/4-cell grids', () => {
  for (const faceW of [45, 60, 100, 140, 220, 320]) {
    for (const people of [2, 3, 4]) {
      const tracks = Array.from({ length: people }, (_, i) =>
        panTrack(i + 1, Array.from({ length: 40 }, () => 300 + i * 450), 0.25, faceW)
      );
      const plan = buildLayoutPlan(
        asd(tracks, tracks.map((t, i) => ({ trackId: t.id, t0: i * 3, t1: i * 3 + 3 }))),
        'split-screen',
        1920,
        1080
      );
      assert.equal(plan.mode, 'split', `${people} people, face ${faceW}px`);
      if (plan.mode !== 'split') continue;
      assert.equal(plan.cells.length, people);
      for (const cell of plan.cells) {
        const zoomX = cell.cellW / cell.cropW;
        const zoomY = cell.cellH / cell.cropH;
        assert.ok(
          zoomX <= MAX_CELL_UPSCALE + 0.01 && zoomY <= MAX_CELL_UPSCALE + 0.01,
          `face ${faceW}px, ${people} panes: ${zoomX.toFixed(2)}x / ${zoomY.toFixed(2)}x exceeds ${MAX_CELL_UPSCALE}x`
        );
        assert.ok(cell.cropW <= 1920 && cell.cropH <= 1080, 'crop fits inside the source');
        assert.ok(Math.abs(cell.cropW / cell.cropH - cell.cellW / cell.cellH) < 0.02, 'crop matches the pane aspect');
      }
    }
  }
});

test('two ~100px faces avoid excessive enlargement and keep a stable left/right pane assignment', () => {
  // Shape of the reported clip after the detector fix: two hosts, ~100px faces.
  const left = panTrack(1, Array.from({ length: 60 }, () => 650), 0.125, 100);
  const right = panTrack(2, Array.from({ length: 60 }, () => 1270), 0.125, 100);
  const plan = buildLayoutPlan(
    asd([left, right], [
      { trackId: 1, t0: 0, t1: 4 },
      { trackId: 2, t0: 4, t1: 7.5 },
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  if (plan.mode !== 'split') return;
  assert.equal(plan.cells.length, 2);
  assert.deepEqual(plan.cells.map((c) => [c.cellX, c.cellY, c.cellW, c.cellH]), [
    [0, 0, 1080, 960],
    [0, 960, 1080, 960],
  ]);
  assert.deepEqual(plan.cells.map((c) => [c.cropW, c.cropH]), [
    [720, 640],
    [720, 640],
  ]);
  assert.equal(plan.cells[0].trackId, 1, 'left person on top');
});

test('a tiny background face (poster / screen) does not steal the second pane from a real listener', () => {
  const speaker = panTrack(1, Array.from({ length: 60 }, () => 600), 0.25, 110);
  const poster = panTrack(2, Array.from({ length: 60 }, () => 1500), 0.25, 42); // 38% of the speaker's face
  const speakerOnly = buildLayoutPlan(
    asd([speaker, poster], [{ trackId: 1, t0: 0, t1: 15 }]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(speakerOnly.mode, 'single', 'the poster is not a person: only ONE real person -> explained fallback');

  const listener = panTrack(2, Array.from({ length: 60 }, () => 1500), 0.25, 80); // 73% of the speaker's face
  const conversation = buildLayoutPlan(
    asd([speaker, listener], [{ trackId: 1, t0: 0, t1: 15 }]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(conversation.mode, 'split', 'a comparable-size listener does get a pane');
  if (conversation.mode === 'split') assert.equal(conversation.cells.length, 2);
});

test('split panes target face centres at 38% and keep head/overlay zones within each cell', () => {
  const a = panTrack(1, Array.from({ length: 40 }, () => 600), 0.25, 100);
  const b = panTrack(2, Array.from({ length: 40 }, () => 1300), 0.25, 100);
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
  if (plan.mode !== 'split') return;
  const graph = buildSplitFilterComplex(plan, 1920, 1080, '');
  assert.ok(/crop=720:640:'[^']*':'[^']*'/.test(graph), 'expected 1.5x-capped crop: ' + graph.slice(0, 400));

  for (const cell of plan.cells) {
    const faceCentre = cell.cellY + 0.38 * cell.cellH;
    const faceHeight = 125 * cell.cellH / cell.cropH;
    assert.ok(Math.abs((cell.faceZone.top + cell.faceZone.bottom) / 2 - faceCentre) < 6, 'face at 38% of the pane');
    assert.ok(Math.abs(cell.faceZone.bottom - cell.faceZone.top - faceHeight) < 6, 'face size follows the zoomed crop');
    assert.ok(cell.headZone.top >= cell.cellY, 'head zone starts within the cell');
    assert.ok(cell.headZone.top < cell.faceZone.top, 'head zone reaches above the face (hair)');
    assert.ok(cell.headZone.bottom >= cell.faceZone.bottom, 'head zone covers the chin');
    assert.ok(cell.headZone.bottom <= cell.cellY + cell.cellH, 'head zone stays inside the cell');
  }
});

test('two people who never share the screen (camera cuts): single window, and the reason says so', () => {
  // Host A on screen 0-10s, host B 12-22s - never together, so there is nothing
  // to stack. The reason must not claim "only one person" (there are two).
  const a = panTrack(1, Array.from({ length: 40 }, () => 600), 0.25, 140, 0);
  const b = panTrack(2, Array.from({ length: 40 }, () => 1300), 0.25, 140, 12);
  const plan = buildLayoutPlan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 10 },
      { trackId: 2, t0: 12, t1: 22 },
    ]),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'single');
  if (plan.mode === 'single') {
    assert.match(plan.splitFallbackReason ?? '', /never visible together/i);
    assert.ok(plan.points.length > 0, 'still follows the active speaker across the cuts');
  }
});
