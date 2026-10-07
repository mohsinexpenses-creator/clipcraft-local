/**
 * Layout-aware overlay placement: in a split screen the captions / hook / CTA must
 * stay off the faces (and off each other); speaker focus is left exactly as it was.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLayoutPlan, SplitPlan } from '../worker/layout';
import { AsdResult } from '../worker/asd/index';
import { Track } from '../worker/asd/tracker';
import {
  Band,
  OverlayAdaptation,
  adaptOverlaysToLayout,
  estimateCtaHeight,
  estimateHookHeight,
  estimateLineCount,
} from '../worker/overlay-layout';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import type { CaptionEngine, CaptionPreset, OverlayStylePreset } from '../lib/types';

function track(id: number, cx: number, cy: number, w: number, seconds: number): Track {
  const points = Array.from({ length: Math.floor(seconds * 4) }, (_, i) => ({
    t: i * 0.25,
    cx,
    cy,
    w,
    mouthOpen: null,
    motion: 0.5,
  }));
  return {
    id,
    points,
    visibleTime: seconds,
    avgW: w,
    maxW: w,
    cx,
    cy,
    vx: 0,
    vy: 0,
    lastT: seconds,
    missed: 0,
  };
}

function asd(tracks: Track[], seconds: number): AsdResult {
  return {
    tracks,
    speakerSegments: [{ trackId: tracks[0].id, t0: 0, t1: seconds }],
    speakerCount: 1,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: tracks.length,
    framesUsed: Math.floor(seconds * 4),
    framesTotal: Math.floor(seconds * 4),
    sampleFps: 4,
    voicedRatio: 0.5,
  };
}

/** Two hosts of a 1080p wide shot (~110px faces), 32 s long. */
function twoHostPlan(faceW = 110): SplitPlan {
  const plan = buildLayoutPlan(
    asd([track(1, 400, 400, faceW, 32), track(2, 1500, 400, faceW, 32)], 32),
    'split-screen',
    1920,
    1080
  );
  assert.equal(plan.mode, 'split');
  return plan as SplitPlan;
}

const hookStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'hook' && p.isDefault)!;
const ctaStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'cta' && p.isDefault)!;
const HOOK_TEXT = 'WHY BROADWAY ROXY CASTING IS WILD';
const CTA_TEXT = 'FOLLOW FOR MORE CLIPS LIKE THIS';
const TIMING = { clipDuration: 32, hookStart: 10, hookVisibleSeconds: 2.5, ctaDuration: 2.5 };

function adapt(
  plan: SplitPlan,
  engine: CaptionEngine,
  caption: CaptionPreset = DEFAULT_CAPTION_PRESETS[0],
  hook: OverlayStylePreset = hookStyle,
  cta: OverlayStylePreset = ctaStyle,
  withTiming = true
): OverlayAdaptation {
  return adaptOverlaysToLayout({
    plan,
    engine,
    timing: withTiming ? TIMING : undefined,
    caption,
    hook: { style: hook, text: HOOK_TEXT },
    cta: { style: cta, text: CTA_TEXT },
  });
}

function intersects(a: Band, b: { top: number; bottom: number }): boolean {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
}

test('speaker focus: presets are returned untouched (they were designed for that framing)', () => {
  const plan = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'speaker-focus', 1920, 1080);
  const result = adaptOverlaysToLayout({
    plan,
    engine: 'native',
    caption: DEFAULT_CAPTION_PRESETS[0],
    hook: { style: hookStyle, text: HOOK_TEXT },
    cta: { style: ctaStyle, text: CTA_TEXT },
  });
  assert.equal(result.adapted, false);
  assert.equal(result.caption, DEFAULT_CAPTION_PRESETS[0], 'same object');
  assert.equal(result.hookStyle, hookStyle);
  assert.equal(result.ctaStyle, ctaStyle);
  assert.equal(result.captionLiftScale, 1, 'the usual caption lift while the CTA shows');
  assert.deepEqual(result.notes, []);
});

test('split-screen fallback to a single window (only one person found) keeps the presets too', () => {
  const plan = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'split-screen', 1920, 1080);
  assert.equal(plan.mode, 'single', 'one person -> the explained single-window fallback');
  const result = adaptOverlaysToLayout({ plan, engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0] });
  assert.equal(result.adapted, false);
});

for (const engine of ['native', 'remotion'] as const) {
  test(`split screen (${engine}): with the DEFAULT presets nothing covers a face and nothing overlaps`, () => {
    const plan = twoHostPlan();
    const result = adapt(plan, engine);
    assert.equal(result.adapted, true);

    const { caption, hook, cta } = result.placements;
    assert.ok(caption && hook && cta, 'all three overlays are placed');
    for (const [name, band] of Object.entries({ caption, hook, cta })) {
      assert.ok(band!.top >= 0 && band!.bottom <= 1920, `${name} stays on the canvas (${band!.top}-${band!.bottom})`);
      for (const cell of plan.cells) {
        assert.ok(
          !intersects(band!, cell.faceZone),
          `${name} ${Math.round(band!.top)}-${Math.round(band!.bottom)} must not cover the face at ` +
            `${Math.round(cell.faceZone.top)}-${Math.round(cell.faceZone.bottom)}`
        );
      }
    }
    assert.ok(!intersects(caption!, hook!), 'hook and captions are on screen together - they must not overlap');
    assert.ok(!intersects(caption!, cta!), 'CTA and captions are on screen together - they must not overlap');
    assert.equal(result.captionLiftScale, 0, 'the CTA no longer shares the captions\' area, so no lift');
  });
}

test('split screen: the preset positions DID land on the faces (so moving them was necessary)', () => {
  // The default caption (28% from the bottom) sits right on the lower person's face ...
  const plan = twoHostPlan();
  const lower = plan.cells.find((c) => c.cellY === 960)!;
  const captionPresetY = 1920 * (1 - DEFAULT_CAPTION_PRESETS[0].positionY / 100);
  assert.ok(captionPresetY > lower.faceZone.top && captionPresetY < lower.faceZone.bottom, 'caption preset is on the lower face');
  // ... and the default hook (12% from the top) on the upper person's brow / hair.
  const upper = plan.cells.find((c) => c.cellY === 0)!;
  const hookPresetTop = (hookStyle.positionY / 100) * 1920;
  assert.ok(hookPresetTop + estimateHookHeight(hookStyle, HOOK_TEXT) > upper.headZone.top, 'hook preset runs into the upper head');
  const result = adapt(plan, 'native');
  assert.ok(result.notes.some((n) => n.startsWith('captions moved')), result.notes.join('; '));
  assert.ok(result.notes.some((n) => n.startsWith('hook moved')), result.notes.join('; '));
});

test('split screen: captions go to the seam and the hook moves into the clear band below the upper head', () => {
  const plan = twoHostPlan();
  const result = adapt(plan, 'native');
  const { caption, hook } = result.placements;
  const upper = plan.cells.find((c) => c.cellY === 0)!;
  const lower = plan.cells.find((c) => c.cellY === 960)!;
  const captionMid = (caption!.top + caption!.bottom) / 2;
  assert.ok(captionMid > upper.faceZone.bottom && captionMid < lower.faceZone.top, 'captions sit between the two faces');
  assert.ok(hook!.top >= upper.headZone.bottom, 'the hook sits below the upper person\'s head');
  assert.ok(hook!.bottom <= result.placements.caption!.top, 'the hook stays above the caption seam');
  assert.ok(hook!.top >= 0);
});

test('a preset position that is already clear is KEPT (nothing moves unless it has to)', () => {
  const plan = twoHostPlan();
  const first = adapt(plan, 'native');
  assert.ok(first.notes.length > 0, 'the defaults needed moving');

  // Feed the planner its own answer: now every position is clear, so nothing may change.
  const second = adapt(plan, 'native', first.caption, first.hookStyle, first.ctaStyle);
  assert.deepEqual(second.notes, [], 'no overlay was moved the second time');
  assert.equal(second.caption.positionY, first.caption.positionY);
  assert.equal(second.hookStyle!.positionY, first.hookStyle!.positionY);
  assert.equal(second.ctaStyle!.positionY, first.ctaStyle!.positionY);
});

test('only positionY changes - fonts, colours and animation of every preset are preserved', () => {
  const result = adapt(twoHostPlan(), 'native');
  assert.deepEqual({ ...result.caption, positionY: 0 }, { ...DEFAULT_CAPTION_PRESETS[0], positionY: 0 });
  assert.deepEqual({ ...result.hookStyle!, positionY: 0 }, { ...hookStyle, positionY: 0 });
  assert.deepEqual({ ...result.ctaStyle!, positionY: 0 }, { ...ctaStyle, positionY: 0 });
  assert.equal(DEFAULT_CAPTION_PRESETS[0].positionY, 28, 'the shared default preset object is not mutated');
  assert.equal(hookStyle.positionY, 12);
});

test('positionY maths: hook / CTA are % from the TOP, captions follow each engine\'s own anchor', () => {
  const plan = twoHostPlan();
  const native = adapt(plan, 'native');
  const remotion = adapt(plan, 'remotion');

  assert.ok(Math.abs(native.hookStyle!.positionY - (native.placements.hook!.top / 1920) * 100) < 0.06);
  assert.ok(Math.abs(native.ctaStyle!.positionY - (native.placements.cta!.top / 1920) * 100) < 0.06);

  // native (ASS \an8): line top = 1920*(1-p/100) - 0.625*size, size = round(fontSize*1.2)
  const size = Math.round(DEFAULT_CAPTION_PRESETS[0].fontSize * 1.2);
  const nativeTop = 1920 * (1 - native.caption.positionY / 100) - 0.625 * size;
  assert.ok(Math.abs(nativeTop - native.placements.caption!.top) < 2.5, `native top ${nativeTop} vs ${native.placements.caption!.top}`);

  // Remotion: the BOTTOM edge of the box sits at positionY from the bottom
  const remotionBottom = 1920 * (1 - remotion.caption.positionY / 100);
  assert.ok(Math.abs(remotionBottom - remotion.placements.caption!.bottom) < 2.5, `remotion bottom ${remotionBottom} vs ${remotion.placements.caption!.bottom}`);
});

test('hook / CTA switched off: nothing is placed for them', () => {
  const result = adaptOverlaysToLayout({ plan: twoHostPlan(), engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0], hook: null, cta: null });
  assert.equal(result.adapted, true);
  assert.equal(result.hookStyle, undefined);
  assert.equal(result.ctaStyle, undefined);
  assert.equal(result.placements.hook, undefined);
  assert.equal(result.placements.cta, undefined);
  assert.ok(result.placements.caption);

  const blank = adaptOverlaysToLayout({ plan: twoHostPlan(), engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0], hook: { style: hookStyle, text: '   ' } });
  assert.equal(blank.placements.hook, undefined, 'whitespace-only hook text draws nothing, so it reserves nothing');
});

test('the hook and the CTA are placed against the faces DURING THEIR OWN seconds, not the whole clip', () => {
  const plan = twoHostPlan();
  // Doctor the lower person's trace: they sit low in the pane until t=28, then lean far enough down to clear the CTA keep-out.
  const lower = plan.cells.find((c) => c.cellY === 960)!;
  for (const p of lower.trace) {
    if (p.t >= 28) {
      p.faceTop += 350; p.faceBottom += 350; p.headTop += 350; p.headBottom += 350;
    }
  }
  const col = (key: 'faceTop' | 'faceBottom' | 'headTop' | 'headBottom'): number[] => lower.trace.map((p) => p[key]);
  lower.faceZone = { top: Math.min(...col('faceTop')), bottom: Math.max(...col('faceBottom')) };
  lower.headZone = { top: Math.min(...col('headTop')), bottom: Math.max(...col('headBottom')) };

  // CTA window = the last 2.5 s: there the face is ~350px LOWER than usual, so the preset spot
  // (1229) is clear even after the forehead/chin safety padding. Judged against the whole clip
  // it overlaps the face and has to move.
  const windowed = adapt(plan, 'native');
  const whole = adapt(plan, 'native', DEFAULT_CAPTION_PRESETS[0], hookStyle, ctaStyle, false);
  assert.ok(!windowed.notes.some((n) => n.startsWith('cta moved')), `CTA stays put: ${windowed.notes.join('; ')}`);
  assert.ok(whole.notes.some((n) => n.startsWith('cta moved')), 'without timing the whole-clip extent forces a move');
});

test('three and four pane grids: every overlay is placed clear of every face', () => {
  const three = buildLayoutPlan(
    asd([track(1, 300, 400, 100, 20), track(2, 960, 400, 100, 20), track(3, 1600, 400, 100, 20)], 20),
    'split-screen', 1920, 1080
  );
  const four = buildLayoutPlan(
    asd([track(1, 300, 300, 100, 20), track(2, 800, 300, 100, 20), track(3, 1200, 600, 100, 20), track(4, 1650, 600, 100, 20)], 20),
    'split-screen', 1920, 1080
  );
  for (const plan of [three, four]) {
    assert.equal(plan.mode, 'split');
    const split = plan as SplitPlan;
    const result = adaptOverlaysToLayout({
      plan: split, engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0],
      hook: { style: hookStyle, text: HOOK_TEXT }, cta: { style: ctaStyle, text: CTA_TEXT },
    });
    for (const band of Object.values(result.placements)) {
      for (const cell of split.cells) {
        assert.ok(!intersects(band!, cell.faceZone), `${split.cells.length} panes: ${JSON.stringify(band)} vs ${JSON.stringify(cell.faceZone)}`);
      }
    }
  }
});

test('faces so big that no free band exists: still valid, on-canvas positions (and says so)', () => {
  // ~420px faces in a 1080p frame fill their whole panes.
  const plan = buildLayoutPlan(
    asd([track(1, 500, 500, 420, 20), track(2, 1450, 500, 420, 20)], 20),
    'split-screen', 1920, 1080
  );
  assert.equal(plan.mode, 'split');
  const result = adaptOverlaysToLayout({
    plan, engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0],
    hook: { style: hookStyle, text: HOOK_TEXT }, cta: { style: ctaStyle, text: CTA_TEXT },
  });
  for (const band of Object.values(result.placements)) {
    assert.ok(band!.top >= 0 && band!.bottom <= 1920);
  }
  for (const style of [result.caption, result.hookStyle!, result.ctaStyle!]) {
    assert.ok(style.positionY >= 0 && style.positionY <= 100);
  }
});

test('estimateLineCount: word wrap, monotonic in size, an over-long single word is one line', () => {
  assert.equal(estimateLineCount('WAIT FOR IT', 900, 38, true, 1), 1);
  assert.equal(estimateLineCount('', 900, 38, true, 1), 1);
  const long = 'THE ONE THING NOBODY TELLS YOU ABOUT GETTING CAST IN A BROADWAY MUSICAL AFTER THIRTY';
  const small = estimateLineCount(long, 900, 30, true, 1);
  const big = estimateLineCount(long, 900, 60, true, 1);
  assert.ok(big > small, `${big} > ${small}`);
  assert.equal(estimateLineCount('SUPERCALIFRAGILISTICEXPIALIDOCIOUSSUPERCALIFRAGILISTIC', 300, 38, true, 0), 1);
  assert.ok(estimateLineCount(long, 900, 38, false, 1) <= estimateLineCount(long, 900, 38, true, 1), 'mixed case is narrower');
});

/**
 * REAL sizes of the hook / CTA cards, measured in headless Chrome through Remotion
 * (alpha bounding box of the rendered PNG, default presets). The estimate must never be
 * SMALLER (an under-estimate is what could put a card on a face) and must not be wildly bigger.
 */
const MEASURED_HOOK_PX: Array<[string, string, number]> = [
  ['hook-midnight-glass', 'WAIT FOR IT', 125],
  ['hook-midnight-glass', 'WHY BROADWAY ROXY CASTING IS WILD', 171],
  ['hook-midnight-glass', 'THE ONE THING NOBODY TELLS YOU ABOUT GETTING CAST IN A BROADWAY MUSICAL AFTER THIRTY', 217],
  ['hook-midnight-glass', 'THIS CHANGED EVERYTHING I KNEW ABOUT CASTING DIRECTORS AND WHAT THEY REALLY LOOK FOR IN AN AUDITION ROOM', 262],
  ['hook-crimson-alert', 'WAIT FOR IT', 128],
  ['hook-crimson-alert', 'WHY BROADWAY ROXY CASTING IS WILD', 180],
  ['hook-crimson-alert', 'THE ONE THING NOBODY TELLS YOU ABOUT GETTING CAST IN A BROADWAY MUSICAL AFTER THIRTY', 230],
  ['hook-crimson-alert', 'THIS CHANGED EVERYTHING I KNEW ABOUT CASTING DIRECTORS AND WHAT THEY REALLY LOOK FOR IN AN AUDITION ROOM', 280],
];
const MEASURED_CTA_PX: Array<[string, string, number]> = [
  ['cta-aurora-gradient', 'FOLLOW', 81],
  ['cta-aurora-gradient', 'FOLLOW FOR MORE CLIPS LIKE THIS', 81],
  ['cta-aurora-gradient', 'FOLLOW FOR PART TWO OF THIS STORY AND MANY MORE CLIPS LIKE IT EVERY SINGLE WEEK', 162],
  ['cta-mono-pill', 'FOLLOW', 78],
  ['cta-mono-pill', 'FOLLOW FOR MORE CLIPS LIKE THIS', 78],
  ['cta-mono-pill', 'FOLLOW FOR PART TWO OF THIS STORY AND MANY MORE CLIPS LIKE IT EVERY SINGLE WEEK', 155],
];

test('card-height estimates are never smaller than what Chrome really renders (and not wildly larger)', () => {
  const styleById = (id: string) => DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p._id === id)!;
  for (const [id, text, real] of MEASURED_HOOK_PX) {
    const est = estimateHookHeight(styleById(id), text);
    assert.ok(est >= real, `hook ${id} "${text.slice(0, 24)}...": estimate ${est} < real ${real}`);
    assert.ok(est <= real + 70, `hook ${id}: estimate ${est} is wildly above real ${real}`);
  }
  for (const [id, text, real] of MEASURED_CTA_PX) {
    const est = estimateCtaHeight(styleById(id), text);
    assert.ok(est >= real, `cta ${id} "${text.slice(0, 24)}...": estimate ${est} < real ${real}`);
    assert.ok(est <= real + 70, `cta ${id}: estimate ${est} is wildly above real ${real}`);
  }
});
