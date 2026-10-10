/**
 * Overlay placement contract:
 *  - captions keep their preset position; in a split screen they move ONLY when
 *    that position would cover a face;
 *  - the hook card and the CTA card are ALWAYS stacked directly above the
 *    caption block (card bottom one gap above the captions' top), in every
 *    framing layout and for both caption engines;
 *  - captions never lift out of the way of a card (captionLiftScale = 0).
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
import {
  OVERLAY_STACK_GAP,
  OVERLAY_TOP_MARGIN,
  captionReservedBand,
} from '../lib/overlay-stack';
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
  cta: OverlayStylePreset = ctaStyle
): OverlayAdaptation {
  return adaptOverlaysToLayout({
    plan,
    engine,
    timing: TIMING,
    caption,
    hook: { style: hook, text: HOOK_TEXT },
    cta: { style: cta, text: CTA_TEXT },
  });
}

function intersects(a: Band, b: { top: number; bottom: number }): boolean {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
}

/** The stacked invariant: card bottom sits OVERLAY_STACK_GAP above the caption band. */
function assertStackedAbove(card: Band, caption: Band): void {
  const expectedBottom = Math.max(OVERLAY_TOP_MARGIN + (card.bottom - card.top), caption.top - OVERLAY_STACK_GAP);
  assert.ok(
    Math.abs(card.bottom - expectedBottom) <= 1,
    `card ${Math.round(card.top)}-${Math.round(card.bottom)} must end ${OVERLAY_STACK_GAP}px above captions ` +
      `(top ${Math.round(caption.top)}), expected bottom ${Math.round(expectedBottom)}`
  );
}

test('speaker focus: captions keep their preset position', () => {
  const plan = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'speaker-focus', 1920, 1080);
  const result = adaptOverlaysToLayout({
    plan,
    engine: 'native',
    caption: DEFAULT_CAPTION_PRESETS[0],
    hook: { style: hookStyle, text: HOOK_TEXT },
    cta: { style: ctaStyle, text: CTA_TEXT },
  });
  assert.equal(result.caption, DEFAULT_CAPTION_PRESETS[0], 'caption preset object unchanged');
  assert.equal(result.captionLiftScale, 0, 'cards stack above captions, so captions never lift');
  assert.deepEqual(result.placements.caption, captionReservedBand('native', DEFAULT_CAPTION_PRESETS[0]));
});

test('every layout: hook and CTA are stacked directly above the captions', () => {
  const single = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'speaker-focus', 1920, 1080);
  const split = twoHostPlan();
  for (const plan of [single, split]) {
    for (const engine of ['native', 'remotion'] as const) {
      const result = plan.mode === 'split'
        ? adapt(plan, engine)
        : adaptOverlaysToLayout({
            plan,
            engine,
            caption: DEFAULT_CAPTION_PRESETS[0],
            hook: { style: hookStyle, text: HOOK_TEXT },
            cta: { style: ctaStyle, text: CTA_TEXT },
          });
      const { caption, hook, cta } = result.placements;
      assert.ok(caption && hook && cta, `placements complete (${plan.mode}/${engine})`);
      assertStackedAbove(hook!, caption!);
      assertStackedAbove(cta!, caption!);
      assert.equal(result.captionLiftScale, 0);
    }
  }
});

test('split-screen fallback to a single window (only one person found) still stacks the cards', () => {
  const plan = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'split-screen', 1920, 1080);
  assert.equal(plan.mode, 'single', 'one person -> the explained single-window fallback');
  const result = adaptOverlaysToLayout({
    plan,
    engine: 'native',
    caption: DEFAULT_CAPTION_PRESETS[0],
    hook: { style: hookStyle, text: HOOK_TEXT },
    cta: { style: ctaStyle, text: CTA_TEXT },
  });
  assert.equal(result.caption, DEFAULT_CAPTION_PRESETS[0], 'captions keep the preset position');
  assertStackedAbove(result.placements.hook!, result.placements.caption!);
  assertStackedAbove(result.placements.cta!, result.placements.caption!);
});

for (const engine of ['native', 'remotion'] as const) {
  test(`split screen (${engine}): captions dodge the faces, the cards stack above them`, () => {
    const plan = twoHostPlan();
    const result = adapt(plan, engine);
    assert.equal(result.adapted, true);

    const { caption, hook, cta } = result.placements;
    assert.ok(caption && hook && cta, 'all three overlays are placed');
    for (const cell of plan.cells) {
      assert.ok(
        !intersects(caption!, cell.faceZone),
        `captions ${Math.round(caption!.top)}-${Math.round(caption!.bottom)} must not cover the face at ` +
          `${Math.round(cell.faceZone.top)}-${Math.round(cell.faceZone.bottom)}`
      );
    }
    assertStackedAbove(hook!, caption!);
    assertStackedAbove(cta!, caption!);
    assert.equal(result.captionLiftScale, 0);
  });
}

test('split screen: the caption preset position DID land on a face (so moving it was necessary)', () => {
  const plan = twoHostPlan();
  const lower = plan.cells.find((c) => c.cellY === 960)!;
  const captionPresetY = 1920 * (1 - DEFAULT_CAPTION_PRESETS[0].positionY / 100);
  assert.ok(captionPresetY > lower.faceZone.top && captionPresetY < lower.faceZone.bottom, 'caption preset is on the lower face');
  const result = adapt(plan, 'native');
  assert.ok(result.notes.some((n) => n.startsWith('captions moved')), result.notes.join('; '));
  assert.ok(result.notes.some((n) => n.startsWith('hook stacked')), result.notes.join('; '));
  assert.ok(result.notes.some((n) => n.startsWith('CTA stacked')), result.notes.join('; '));
});

test('split screen: captions go to the seam between the panes', () => {
  const plan = twoHostPlan();
  const result = adapt(plan, 'native');
  const { caption } = result.placements;
  const upper = plan.cells.find((c) => c.cellY === 0)!;
  const lower = plan.cells.find((c) => c.cellY === 960)!;
  const captionMid = (caption!.top + caption!.bottom) / 2;
  assert.ok(captionMid > upper.faceZone.bottom && captionMid < lower.faceZone.top, 'captions sit between the two faces');
});

test('a placement that is already stacked is KEPT (re-rendering an adapted clip changes nothing)', () => {
  const plan = twoHostPlan();
  const first = adapt(plan, 'native');
  assert.ok(first.notes.length > 0, 'the defaults needed moving');

  // Feed the planner its own answer: caption is clear and the cards already sit
  // at the stacked spot, so nothing may move and no new objects are needed.
  const second = adapt(plan, 'native', first.caption, first.hookStyle!, first.ctaStyle!);
  assert.equal(second.adapted, false, 'no overlay moved the second time');
  assert.deepEqual(second.notes, []);
  assert.equal(second.caption, first.caption, 'same caption object');
  assert.equal(second.hookStyle, first.hookStyle, 'same hook object');
  assert.equal(second.ctaStyle, first.ctaStyle, 'same CTA object');
});

test('only positionY changes - fonts, colours and animation of every preset are preserved', () => {
  const result = adapt(twoHostPlan(), 'native');
  assert.deepEqual({ ...result.caption, positionY: 0 }, { ...DEFAULT_CAPTION_PRESETS[0], positionY: 0 });
  assert.deepEqual({ ...result.hookStyle!, positionY: 0 }, { ...hookStyle, positionY: 0 });
  assert.deepEqual({ ...result.ctaStyle!, positionY: 0 }, { ...ctaStyle, positionY: 0 });
  assert.equal(DEFAULT_CAPTION_PRESETS[0].positionY, 28, 'the shared default preset object is not mutated');
  assert.equal(hookStyle.positionY, DEFAULT_OVERLAY_STYLE_PRESETS.find((preset) => preset.isDefault)!.positionY);
});

test('positionY maths: hook / CTA are % from the TOP, caption bands match each engine\'s geometry', () => {
  const plan = twoHostPlan();
  for (const engine of ['native', 'remotion'] as const) {
    const result = adapt(plan, engine);
    assert.ok(Math.abs(result.hookStyle!.positionY - (result.placements.hook!.top / 1920) * 100) < 0.06);
    assert.ok(Math.abs(result.ctaStyle!.positionY - (result.placements.cta!.top / 1920) * 100) < 0.06);
    assert.deepEqual(
      result.placements.caption,
      captionReservedBand(engine, result.caption),
      `caption band matches the ${engine} geometry`
    );
  }
});

test('hook / CTA switched off: nothing is placed for them', () => {
  const result = adaptOverlaysToLayout({ plan: twoHostPlan(), engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0], hook: null, cta: null });
  assert.equal(result.hookStyle, undefined);
  assert.equal(result.ctaStyle, undefined);
  assert.equal(result.placements.hook, undefined);
  assert.equal(result.placements.cta, undefined);
  assert.ok(result.placements.caption);

  const blank = adaptOverlaysToLayout({ plan: twoHostPlan(), engine: 'native', caption: DEFAULT_CAPTION_PRESETS[0], hook: { style: hookStyle, text: '   ' } });
  assert.equal(blank.placements.hook, undefined, 'whitespace-only hook text draws nothing, so it reserves nothing');
});

test('captions pinned very high: the cards clamp to the top margin instead of escaping the frame', () => {
  const plan = buildLayoutPlan(asd([track(1, 900, 400, 110, 20)], 20), 'speaker-focus', 1920, 1080);
  const highCaptions: CaptionPreset = { ...DEFAULT_CAPTION_PRESETS[0], positionY: 96 };
  const result = adaptOverlaysToLayout({
    plan,
    engine: 'remotion',
    caption: highCaptions,
    hook: { style: hookStyle, text: HOOK_TEXT },
    cta: { style: ctaStyle, text: CTA_TEXT },
  });
  for (const band of [result.placements.hook!, result.placements.cta!]) {
    assert.ok(band.top >= OVERLAY_TOP_MARGIN, `card stays on the canvas (top=${band.top})`);
    assert.ok(band.bottom <= 1920);
  }
});

test('three and four pane grids: captions clear of every face, cards stacked above them', () => {
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
    const { caption, hook, cta } = result.placements;
    for (const cell of split.cells) {
      assert.ok(!intersects(caption!, cell.faceZone), `${split.cells.length} panes: caption vs face`);
    }
    assertStackedAbove(hook!, caption!);
    assertStackedAbove(cta!, caption!);
  }
});

test('faces so big that no free band exists: still valid, on-canvas positions', () => {
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
 * SMALLER (an under-estimate is what could stack the next overlay onto the card) and
 * must not be wildly bigger.
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
