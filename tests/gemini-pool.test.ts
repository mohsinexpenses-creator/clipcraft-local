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

test('429/5xx retry uses backoff, rotates keys, and all logical batches share four physical attempts', async () => {
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
    assert.ok(budget.geminiCalls[0].elapsedMs >= 350);
    assert.notEqual(seen[0], seen[1]);
    await assert.rejects(requestGeminiJson(options), /planner call cap/);
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(budget.attempts, 4);
    await assert.rejects(requestGeminiJson({ ...options, task: 'vision' }), /attempt cap/);
  } finally { globalThis.fetch = original; }
});
