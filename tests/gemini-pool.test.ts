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
    // One corrective planner retry after an invalid plan is allowed, then capped.
    assert.equal(await requestGeminiJson(options), '{}');
    assert.equal(budget.attempts, 4);
    assert.equal(budget.chargedAttempts, 2);
    await assert.rejects(requestGeminiJson(options), /planner call cap/);
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(budget.attempts, 5);
    await requestGeminiJson({ ...options, task: 'vision' });
    assert.equal(budget.chargedAttempts, 4);
    assert.equal(budget.attempts, 6);
    await assert.rejects(requestGeminiJson({ ...options, task: 'vision' }), /charged attempt cap/);
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

test('a timed-out model falls through to the next chain model instead of aborting every visual', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] });
  };
  try {
    const budget = createVisualApiBudget(30_000);
    const options = { keys: ['network-test-key'], models: ['slow-fixture', 'working-fixture'], rpm: 1000, task: 'planner' as const, body: {}, budget };
    assert.equal(await requestGeminiJson(options), '{}');
    assert.equal(budget.attempts, 2);
    assert.equal(budget.chargedAttempts, 1, 'a network failure is refunded like other routing failures');
    assert.match(urls[0], /slow-fixture/);
    assert.match(urls[1], /working-fixture/);
    assert.deepEqual(budget.geminiCalls.map(({ task, attempts, outcome }) => ({ task, attempts, outcome })), [{ task: 'planner', attempts: 2, outcome: 'ok' }]);
  } finally { globalThis.fetch = original; }
});

test('a hard network failure reports its real cause and how many models were tried', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' });
    throw Object.assign(new TypeError('fetch failed'), { cause });
  };
  try {
    const budget = createVisualApiBudget(30_000);
    await assert.rejects(
      requestGeminiJson({ keys: ['network-test-key'], models: ['offline-a', 'offline-b'], rpm: 1000, task: 'planner', body: {}, budget }),
      (error: Error) => /network unavailable/i.test(error.message) && /ENOTFOUND/.test(error.message)
        && /offline-b/.test(error.message) && /internet\/VPN\/DNS/.test(error.message),
    );
    assert.equal(budget.attempts, 2, 'the whole chain is tried before giving up');
    assert.equal(budget.chargedAttempts, 0);
  } finally { globalThis.fetch = original; }
});

test('a slow-but-streaming model finishes instead of being cut off, and no-progress streams still time out', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const text of ['{"beats":', '[{"id":1}]', '}']) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`));
        }
        controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":""}]}}]}\r\n\r\n'));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const budget = createVisualApiBudget(30_000);
    // 150ms idle cap: every chunk resets it, so the 3 x 60ms stream succeeds.
    const text = await requestGeminiJson({ keys: ['stream-key'], models: ['stream-fixture'], rpm: 1000, task: 'planner', timeoutMs: 150, body: {}, budget });
    assert.equal(text, '{"beats":[{"id":1}]}');
    assert.match(urls[0], /:streamGenerateContent\?alt=sse/);
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const budget = createVisualApiBudget(30_000);
    await assert.rejects(
      requestGeminiJson({ keys: ['stream-key'], models: ['idle-fixture'], rpm: 1000, task: 'vision', timeoutMs: 1200, body: {}, budget }),
      /network unavailable or request timed out \(vision; no response for 1s; idle-fixture\)/,
    );
    assert.equal(budget.chargedAttempts, 0);
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
