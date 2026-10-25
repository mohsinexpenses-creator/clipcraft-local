import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrollPlan, type BrollPlanDeps } from '../lib/broll/plan';
import { verifyEntityImage } from '../lib/broll/vision';
import { fetchBytes, parseRetryAfterMs, ProviderQuotaError } from '../lib/broll/http';
import type { BrollFetch, BrollHttpResponse } from '../lib/broll/http';
import type { BrollCandidate } from '../lib/broll/providers/types';
import { DEFAULT_BROLL_OPTIONS, type WordTimestamp } from '../lib/types';

/**
 * Regression tests for the "full-screen images never show up" bug: Commons 429s /
 * timeouts on download, and Gemini 503s on the vision gate. Offline, like the rest.
 */

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

/* ------------------------------- downloads ------------------------------- */

test('Retry-After is read as seconds or as an HTTP date', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('soon'), undefined);
  const now = () => Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:05 GMT', now), 5000);
});

test('a 429 on a download carries the server-requested wait', async () => {
  const fetcher: BrollFetch = async () => response(429, {}, { 'retry-after': '4' });
  await assert.rejects(
    fetchBytes('https://upload.wikimedia.org/x.jpg', { fetcher, provider: 'Wikimedia Commons' }),
    (error: unknown) => error instanceof ProviderQuotaError && error.retryAfterMs === 4000
  );
});

/* --------------------------- vision: busy Gemini --------------------------- */

const okBody = {
  candidates: [
    {
      content: {
        parts: [
          { text: '{"pickIndex":0,"confidence":0.9,"reason":"It is her.","hasTextOrWatermark":false,"isSafe":true}' },
        ],
      },
    },
  ],
};
const visionInput = {
  entityName: 'Alex Cooper',
  entityType: 'person' as const,
  context: 'she hosts the podcast',
  images: [{ index: 0, data: 'aGVsbG8=', mime: 'image/jpeg' }],
};

test('a 503 is not retried on the same Gemini model', async () => {
  const statuses = [503, 200];
  const urls: string[] = [];
  const fetcher: BrollFetch = async (url) => {
    urls.push(url);
    const status = statuses.shift() ?? 200;
    return response(status, status === 200 ? okBody : {});
  };
  await assert.rejects(
    verifyEntityImage(visionInput, { fetcher, keys: ['k1'], retryDelayMs: 0 }),
    /could not verify/
  );
  assert.equal(urls.length, 1);
});

test('a busy Gemini model is not replaced with another model', async () => {
  const urls: string[] = [];
  const fetcher: BrollFetch = async (url) => {
    urls.push(url);
    return url.includes('gemini-3.5-flash-lite') ? response(200, okBody) : response(503);
  };
  await assert.rejects(
    verifyEntityImage(visionInput, {
      fetcher,
      keys: ['k1'],
      model: 'gemini-3.8-flash',
      retryDelayMs: 0,
    }),
    /could not verify/
  );
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('gemini-3.8-flash'));
});

test('a rejected key is not retried', async () => {
  let calls = 0;
  const fetcher: BrollFetch = async () => {
    calls += 1;
    return response(403);
  };
  await assert.rejects(verifyEntityImage(visionInput, { fetcher, keys: ['bad'], model: 'm1', retryDelayMs: 0 }));
  assert.equal(calls, 1, 'one request total, no key rotation or model fallback');
});

/* ----------------------- plan: Openverse second source ----------------------- */

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
    title: `${id} title`,
  };
}

function makeDeps(downloadFails: (item: BrollCandidate) => boolean) {
  const calls = { verify: 0, fallback: 0 };
  const deps: BrollPlanDeps & { calls: typeof calls } = {
    calls,
    visionAvailable: true,
    async analyze() {
      return {
        entities: [{ type: 'person' as const, name: 'Alex Cooper', searchQuery: 'Alex Cooper', start: 10, end: 14 }],
        broll: [],
      };
    },
    async searchEntity() {
      return [candidate('wikimedia', 'file-1')];
    },
    async searchStock() {
      return { candidates: [], provider: undefined, notes: [] };
    },
    async download(item) {
      if (downloadFails(item)) throw new Error('Wikimedia Commons is rate-limited or out of quota.');
      return { cacheKey: `img-${item.providerId}`, sourceFile: `${item.providerId}.jpg`, bytes: Buffer.from('fake') };
    },
    async prepareFullscreen(_bytes, _type, cacheKey) {
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
      return { cacheKey, sourceFile: `${cacheKey}.jpg`, renderFile: `card-${cacheKey}.jpg` };
    },
    async thumbnail() {
      return { data: 'ZmFrZQ==', mime: 'image/jpeg' };
    },
    async verify() {
      calls.verify += 1;
      return { pickIndex: 0, confidence: 0.92, reason: 'Her.', hasTextOrWatermark: false, isSafe: true };
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

test('when no Openverse image downloads, the Wikimedia fallback is tried and still passes the vision gate', async () => {
  const deps = makeDeps((item) => item.provider === 'openverse');
  deps.searchEntity = async () => [candidate('openverse', 'ov-primary')];
  deps.searchEntityFallback = async () => {
    deps.calls.fallback += 1;
    return [candidate('wikimedia', 'commons-1')];
  };
  const plan = await buildBrollPlan(baseInput, deps);
  const fullscreen = plan.items.filter((item) => item.kind === 'fullscreen');
  assert.equal(deps.calls.fallback, 1);
  assert.equal(fullscreen.length, 1);
  assert.equal(fullscreen[0].attribution.provider, 'wikimedia');
  assert.equal(deps.calls.verify, 1);
});

test('the fallback is not used when an Openverse image downloaded fine', async () => {
  const deps = makeDeps(() => false);
  deps.searchEntityFallback = async () => {
    deps.calls.fallback += 1;
    return [candidate('openverse', 'ov-1')];
  };
  await buildBrollPlan(baseInput, deps);
  assert.equal(deps.calls.fallback, 0);
});

test('an entity is skipped, never replaced, when the fallback has nothing either', async () => {
  const deps = makeDeps(() => true);
  deps.searchEntityFallback = async () => [];
  const plan = await buildBrollPlan(baseInput, deps);
  assert.equal(plan.items.filter((item) => item.kind === 'fullscreen').length, 0);
  assert.ok(plan.skipped.some((skip) => skip.stage === 'download' && skip.entity === 'Alex Cooper'));
});
