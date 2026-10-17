import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiKeyPool, createVisualApiBudget, requestGeminiJson } from '../lib/gemini-pool';

test('round robin key rotation, per-key RPM, cooldown and deadline are enforced with an injectable clock', async () => {
  let now = 1000;
  const pool = new GeminiKeyPool(() => now, async (ms) => { now += ms; });
  assert.equal(await pool.acquire(['a', 'b'], 1, 100000), 'a');
  assert.equal(await pool.acquire(['a', 'b'], 1, 100000), 'b');
  await assert.rejects(pool.acquire(['a', 'b'], 1, 2000), /RPM\/quota/);
  assert.equal(await pool.acquire(['a', 'b'], 1, 100000), 'a');
  assert.equal(now, 61000);
  pool.block('b', 60000);
  await assert.rejects(pool.acquire(['b'], 100, 62000), /invalid/);
});

test('429/5xx retry uses backoff, rotates keys, and fallback routing is refunded while physical attempts stay observable', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get('x-goog-api-key')!);
    if (seen.length === 1) return new Response('', { status: 429 });
    if (seen.length === 2) return new Response('', { status: 503 });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] });
  };
  try {
    const budget = createVisualApiBudget(10000);
    const options = { keys: ['test-a', 'test-b'], rpm: 100, task: 'planner' as const, body: {}, budget, pool: new GeminiKeyPool() };
    assert.equal(await requestGeminiJson(options), '{}');
    assert.equal(budget.attempts, 3);
    assert.deepEqual(budget.geminiCalls.map(({ task, attempts, outcome }) => ({ task, attempts, outcome })), [{ task: 'planner', attempts: 3, outcome: 'ok' }]);
    assert.equal(budget.chargedAttempts, 1);
    assert.notEqual(seen[0], seen[1]);
    await assert.rejects(requestGeminiJson(options), /planner call cap/);
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(budget.attempts, 4);
    await requestGeminiJson({ ...options, task: 'vision' });
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(budget.chargedAttempts, 4);
    assert.equal(budget.attempts, 6);
    await assert.rejects(requestGeminiJson({ ...options, task: 'vision' }), /vision call cap/);
  } finally { globalThis.fetch = original; }
});

test('404 falls through without charging budget and a missing model is not requested again', async () => {
  const original = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(String(input));
    return String(input).includes('gone-fixture') ? new Response('', { status: 404 }) : Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] });
  };
  try {
    const budget = createVisualApiBudget();
    const options = { keys: ['404-test-key'], models: ['gone-fixture', 'working-fixture'], rpm: 1000, task: 'planner' as const, body: {}, budget };
    await requestGeminiJson(options);
    assert.equal(budget.attempts, 2); assert.equal(budget.chargedAttempts, 1);
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(seen.filter((url) => url.includes('gone-fixture')).length, 1);
  } finally { globalThis.fetch = original; }
});

test('model discovery uses paginated names and supportedGenerationMethods, not a memorized model', async () => {
  const { probeVisualGeminiModels } = await import('../lib/gemini-pool');
  const original = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input)); assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'discovery-test');
    return Response.json(urls.length === 1 ? { models: [{ name: 'models/not-a-generator', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next-page' } : { models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] });
  };
  try {
    const result = await probeVisualGeminiModels(['discovery-test']);
    assert.equal(result.model, 'gemini-3.6-flash'); assert.equal(urls.length, 2);
    assert.match(urls[1], /pageToken=next-page/);
  } finally { globalThis.fetch = original; }
});
