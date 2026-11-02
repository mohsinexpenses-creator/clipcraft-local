import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrollPlan, type BrollPlanDeps } from '../lib/broll/plan';
import { fetchBytes, parseRetryAfterMs, ProviderQuotaError } from '../lib/broll/http';
import type { BrollFetch, BrollHttpResponse } from '../lib/broll/http';
import type { BrollCandidate } from '../lib/broll/providers/types';
import { DEFAULT_BROLL_OPTIONS, type WordTimestamp } from '../lib/types';

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): BrollHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

test('Retry-After is read as seconds or as an HTTP date', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('soon'), undefined);
  const now = () => Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:05 GMT', now), 5000);
});

test('a 429 on a Wikimedia-hosted image carries the server-requested wait', async () => {
  const fetcher: BrollFetch = async () => response(429, {}, { 'retry-after': '4' });
  await assert.rejects(
    fetchBytes('https://upload.wikimedia.org/x.jpg', { fetcher, provider: 'Wikipedia image' }),
    (error: unknown) => error instanceof ProviderQuotaError && error.retryAfterMs === 4000
  );
});

const words: WordTimestamp[] = Array.from({ length: 60 }, (_, index) => ({
  word: `word${index}`,
  start: index,
  end: index + 0.9,
}));

function candidate(): BrollCandidate {
  return {
    provider: 'wikipedia',
    providerId: 'Alex Cooper',
    pageUrl: 'https://en.wikipedia.org/wiki/Alex_Cooper',
    imageUrl: 'https://upload.wikimedia.org/alex.jpg',
    thumbUrl: 'https://upload.wikimedia.org/alex-1600.jpg',
    width: 2000,
    height: 1500,
    mime: 'image/jpeg',
    title: 'Alex Cooper',
  };
}

function makeDeps(options: { missing?: boolean; downloadFails?: boolean } = {}) {
  const calls = { entity: 0 };
  const deps: BrollPlanDeps & { calls: typeof calls } = {
    calls,
    async analyze() {
      return {
        entities: [{ type: 'person' as const, name: 'Alex Cooper', wikipediaTitle: 'Alex Cooper', searchQuery: 'Alex Cooper', start: 10, end: 14 }],
        broll: [],
      };
    },
    async findEntityImage() {
      calls.entity += 1;
      return options.missing ? null : candidate();
    },
    async searchStock() {
      return { candidates: [], provider: undefined, notes: [] };
    },
    async download() {
      if (options.downloadFails) throw new Error('Wikipedia image host is rate-limited.');
      return { cacheKey: 'img-alex', sourceFile: 'alex.jpg', bytes: Buffer.from('fake') };
    },
    async prepareFullscreen(_bytes, _type, cacheKey) {
      return {
        cacheKey,
        renderFile: `fs-${cacheKey}.jpg`,
        crop: {
          mode: 'crop' as const,
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
      return { cacheKey, renderFile: `card-${cacheKey}.jpg` };
    },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  };
  return deps;
}

const baseInput = {
  clipDuration: 60,
  hookDuration: 3,
  words,
  options: { ...DEFAULT_BROLL_OPTIONS, enableLandscape: false },
  trigger: 'auto' as const,
  captionBand: { top: 1300, bottom: 1500 },
};

test('a Wikipedia miss skips the named entity without stock substitution', async () => {
  const deps = makeDeps({ missing: true });
  const plan = await buildBrollPlan(baseInput, deps);
  assert.equal(deps.calls.entity, 1);
  assert.equal(plan.items.filter((item) => item.kind === 'fullscreen').length, 0);
  assert.ok(plan.skipped.some((skip) => skip.stage === 'search' && skip.entity === 'Alex Cooper'));
});

test('a Wikipedia image download failure is recorded as a download skip', async () => {
  const deps = makeDeps({ downloadFails: true });
  const plan = await buildBrollPlan(baseInput, deps);
  assert.ok(plan.skipped.some((skip) => skip.stage === 'download' && skip.entity === 'Alex Cooper'));
});
