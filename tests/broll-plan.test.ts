import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrollPlan, type BrollPlanDeps } from '../lib/broll/plan';
import type { BrollCandidate } from '../lib/broll/providers/types';
import { DEFAULT_BROLL_OPTIONS, type WordTimestamp } from '../lib/types';

/**
 * The orchestration, with every side effect faked. These are the rules that make
 * the feature trustworthy:
 *  - a full-screen image is ONLY used when Gemini picked it with enough confidence;
 *  - a rejected entity is skipped, never replaced by a stock lookalike;
 *  - nothing lands inside the hook replay window;
 *  - a full-screen image and a landscape card never overlap;
 *  - a provider outage degrades to fewer images, never to a failed clip.
 */

const words: WordTimestamp[] = Array.from({ length: 60 }, (_, index) => ({
  word: `word${index}`,
  start: index,
  end: index + 0.9,
}));

function candidate(provider: BrollCandidate['provider'], id: string): BrollCandidate {
  return {
    provider,
    providerId: id,
    pageUrl: `https://example.test/${provider}/${id}`,
    imageUrl: `https://cdn.example.test/${provider}/${id}.jpg`,
    thumbUrl: `https://cdn.example.test/${provider}/${id}-512.jpg`,
    width: 2000,
    height: 1500,
    mime: 'image/jpeg',
    author: 'A Photographer',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    title: `${id} title`,
  };
}

interface Options {
  entities?: Array<{ type: 'person' | 'place' | 'event'; name: string; searchQuery: string; start: number; end: number }>;
  keywords?: Array<{ visualKeywords: string[]; start: number; end: number }>;
  entityResults?: BrollCandidate[];
  stockResults?: Array<BrollCandidate[]>;
  verdicts?: Array<{ pickIndex: number | null; confidence: number; reason: string; hasTextOrWatermark: boolean; isSafe: boolean }>;
  analyzeThrows?: boolean;
  visionAvailable?: boolean;
  stockThrows?: boolean;
}

function makeDeps(options: Options = {}) {
  const calls = { entity: 0, stock: 0, verify: 0, prepare: 0 };
  const deps: BrollPlanDeps & { calls: typeof calls } = {
    calls,
    visionAvailable: options.visionAvailable ?? true,
    async analyze() {
      if (options.analyzeThrows) throw new Error('LLM exploded');
      return {
        entities: options.entities ?? [],
        broll: options.keywords ?? [],
      };
    },
    async searchEntity() {
      calls.entity += 1;
      return options.entityResults ?? [candidate('wikimedia', 'file-1')];
    },
    async searchStock() {
      calls.stock += 1;
      if (options.stockThrows) throw new Error('provider down');
      const list = options.stockResults?.[calls.stock - 1] ?? [candidate('pexels', `pexels-${calls.stock}`)];
      return { candidates: list, provider: list[0]?.provider, notes: [] };
    },
    async download(item) {
      return { cacheKey: `img-${item.providerId}`, sourceFile: `${item.providerId}.jpg`, bytes: Buffer.from('fake') };
    },
    async prepareFullscreen(_bytes, _type, cacheKey) {
      calls.prepare += 1;
      return {
        cacheKey,
        sourceFile: `${cacheKey}.jpg`,
        renderFile: `fs-${cacheKey}.jpg`,
        crop: {
          mode: 'crop',
          sourceWidth: 2000,
          sourceHeight: 1500,
          x: 0,
          y: 0,
          width: 844,
          height: 1500,
          faceCentered: true,
          outputWidth: 1080,
          outputHeight: 1920,
        },
      };
    },
    async prepareCard(_bytes, cacheKey) {
      calls.prepare += 1;
      return { cacheKey, sourceFile: `${cacheKey}.jpg`, renderFile: `card-${cacheKey}.jpg` };
    },
    async thumbnail() {
      return { data: 'ZmFrZQ==', mime: 'image/jpeg' };
    },
    async verify() {
      calls.verify += 1;
      const verdict = options.verdicts?.[calls.verify - 1];
      return (
        verdict ?? {
          pickIndex: 0,
          confidence: 0.92,
          reason: 'It is the named person.',
          hasTextOrWatermark: false,
          isSafe: true,
        }
      );
    },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  };
  return deps;
}

const baseInput = {
  clipDuration: 60,
  hookDuration: 3,
  words,
  options: { ...DEFAULT_BROLL_OPTIONS },
  trigger: 'auto' as const,
  captionBand: { top: 1300, bottom: 1500 },
};

test('an accepted entity becomes one full-screen item, after the hook window', async () => {
  const deps = makeDeps({
    entities: [{ type: 'person', name: 'Elon Musk', searchQuery: 'Elon Musk', start: 10, end: 14 }],
  });
  const plan = await buildBrollPlan(baseInput, deps);

  const fullscreen = plan.items.filter((item) => item.kind === 'fullscreen');
  assert.equal(fullscreen.length, 1);
  assert.ok(fullscreen[0].start >= 3, 'never inside the hook replay');
  assert.equal(fullscreen[0].entityName, 'Elon Musk');
  assert.equal(fullscreen[0].attribution.provider, 'wikimedia');
  assert.equal(fullscreen[0].attribution.author, 'A Photographer');
  assert.equal(fullscreen[0].attribution.license, 'CC BY-SA 4.0');
  assert.ok(fullscreen[0].verification && fullscreen[0].verification.confidence >= 0.9);
  assert.ok(fullscreen[0].renderFile.endsWith('.jpg'));
  assert.ok(fullscreen[0].crop);
});

test('a low-confidence verdict skips the mention and never falls back to stock', async () => {
  const deps = makeDeps({
    entities: [{ type: 'person', name: 'Some Person', searchQuery: 'Some Person', start: 10, end: 14 }],
    verdicts: [
      { pickIndex: 0, confidence: 0.3, reason: 'Possibly not the same person.', hasTextOrWatermark: false, isSafe: true },
    ],
  });
  const plan = await buildBrollPlan(
    { ...baseInput, options: { ...baseInput.options, enableLandscape: false } },
    deps
  );

  assert.equal(plan.items.filter((item) => item.kind === 'fullscreen').length, 0);
  const skip = plan.skipped.find((entry) => entry.entity === 'Some Person');
  assert.ok(skip, 'the skip is recorded');
  assert.equal(skip!.stage, 'verify');
  assert.match(skip!.reason, /Not confident enough/);
  // No stock image was fetched to replace the entity.
  assert.equal(deps.calls.stock, 0);
  assert.equal(deps.calls.prepare, 0, 'the rejected image was never prepared');
});

test('an unsafe or watermarked pick is rejected', async () => {
  for (const bad of [
    { pickIndex: 0, confidence: 0.95, reason: 'Watermark across the face.', hasTextOrWatermark: true, isSafe: true },
    { pickIndex: 0, confidence: 0.95, reason: 'A collage.', hasTextOrWatermark: false, isSafe: false },
    { pickIndex: null, confidence: 0, reason: 'Different person.', hasTextOrWatermark: false, isSafe: true },
  ]) {
    const deps = makeDeps({
      entities: [{ type: 'person', name: 'Named Person', searchQuery: 'Named Person', start: 5, end: 9 }],
      verdicts: [bad],
    });
    const plan = await buildBrollPlan(baseInput, deps);
    assert.equal(plan.items.filter((item) => item.kind === 'fullscreen').length, 0, JSON.stringify(bad));
    assert.ok(plan.skipped.some((entry) => entry.stage === 'verify'));
  }
});

test('words become landscape cards with a card rect clear of the captions', async () => {
  const keywords = Array.from({ length: 12 }, (_, index) => ({
    visualKeywords: [`city scene ${index}`],
    start: index * 4,
    end: index * 4 + 3,
  }));
  const plan = await buildBrollPlan({ ...baseInput, options: { ...baseInput.options, enableFullscreen: false } }, makeDeps({ keywords }));

  const cards = plan.items.filter((item) => item.kind === 'landscape');
  assert.ok(cards.length >= 10 && cards.length <= 15, `expected 10-15 cards, got ${cards.length}`);
  for (const card of cards) {
    assert.ok(card.start >= 3, `card at ${card.start} is inside the hook window`);
    assert.ok(card.end - card.start >= 2.4 && card.end - card.start <= 4.05);
    assert.ok(card.card, 'card placement is stored');
    assert.ok(card.card!.y + card.card!.height <= 1300, 'card never covers the caption band');
    assert.equal(card.attribution.provider, 'pexels');
  }
  // Sorted and non-overlapping.
  for (let index = 1; index < cards.length; index += 1) {
    assert.ok(cards[index].start >= cards[index - 1].end, 'cards never overlap');
  }
});

test('full-screen and landscape items never overlap', async () => {
  const deps = makeDeps({
    entities: [
      { type: 'person', name: 'Person A', searchQuery: 'A', start: 8, end: 12 },
      { type: 'place', name: 'Place B', searchQuery: 'B', start: 25, end: 29 },
    ],
    keywords: Array.from({ length: 10 }, (_, index) => ({
      visualKeywords: [`moment ${index}`],
      start: index * 5,
      end: index * 5 + 4,
    })),
  });
  const plan = await buildBrollPlan(baseInput, deps);
  const items = [...plan.items].sort((a, b) => a.start - b.start);
  assert.ok(items.length > 3);
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(items[index].start >= items[index - 1].end, 'no overlap at all');
  }
  for (const item of items) {
    assert.ok(item.start >= 3, 'nothing in the hook window');
    assert.ok(item.end <= plan.totalDuration + 0.001);
  }
});

test('when the LLM fails, keyword moments are derived from the transcript', async () => {
  const deps = makeDeps({ analyzeThrows: true });
  const plan = await buildBrollPlan(baseInput, deps);

  assert.ok(plan.items.length > 0, 'the clip still gets B-roll');
  assert.ok(plan.skipped.some((entry) => entry.stage === 'analysis'));
  assert.ok((plan.notes ?? []).some((note) => /fell back to keywords/i.test(note)));
});

test('with no Gemini key, entities are skipped with a reason and cards still work', async () => {
  const deps = makeDeps({
    visionAvailable: false,
    entities: [{ type: 'person', name: 'Elon Musk', searchQuery: 'Elon Musk', start: 10, end: 14 }],
    keywords: [{ visualKeywords: ['city skyline'], start: 20, end: 24 }],
  });
  const plan = await buildBrollPlan(baseInput, deps);

  assert.equal(deps.calls.entity, 0, 'no point searching an entity that cannot be verified');
  assert.equal(deps.calls.verify, 0);
  assert.equal(plan.items.filter((item) => item.kind === 'fullscreen').length, 0);
  assert.ok(plan.skipped.some((entry) => /Gemini/.test(entry.reason)));
  assert.ok(plan.items.some((item) => item.kind === 'landscape'));
});

test('a provider outage produces a plan with fewer items, not an error', async () => {
  const deps = makeDeps({ stockThrows: true });
  const plan = await buildBrollPlan(baseInput, deps);
  assert.equal(plan.items.length, 0);
  assert.ok(plan.skipped.length > 0);
  assert.ok((plan.notes ?? []).length > 0);
  assert.equal(plan.trigger, 'auto');
});

test('the 60 s target budget is carried into the plan', async () => {
  const deps = makeDeps({
    keywords: Array.from({ length: 20 }, (_, index) => ({
      visualKeywords: [`scene ${index}`],
      start: index * 3,
      end: index * 3 + 2,
    })),
  });
  const plan = await buildBrollPlan(baseInput, deps);
  assert.deepEqual(plan.counts.targetMin, 10);
  assert.deepEqual(plan.counts.targetMax, 15);
  assert.ok(plan.items.length <= 15);
  assert.equal(plan.clipDuration, 60);
  assert.equal(plan.totalDuration, 63);
  assert.equal(plan.version, 1);
});

test('a 3 s hook is excluded even when the first mention is inside it', async () => {
  const deps = makeDeps({
    entities: [{ type: 'person', name: 'Early Bird', searchQuery: 'Early Bird', start: 0.5, end: 2.2 }],
    keywords: [{ visualKeywords: ['opening shot'], start: 0, end: 2 }],
  });
  const plan = await buildBrollPlan(baseInput, deps);
  for (const item of plan.items) {
    assert.ok(item.start >= 3, `item starts at ${item.start}`);
  }
});
