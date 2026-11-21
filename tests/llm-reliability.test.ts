/**
 * Phase 2: LLM chain reliability - retired models, thinking-config capability,
 * route timeouts and hedged requests.
 *
 * Every case is driven through `completeWithFallback` with a mocked `fetch`, so
 * these test the real chain logic rather than a helper.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setSettingsStoreForTests } from '../lib/app-settings';
import {
  completeWithFallback,
  getLlmRuntimeConfig,
  getLlmTimeoutConfig,
  hedgeDelayFor,
  isFastRoute,
  listRetiredLlmModels,
  LLM_PROVIDER_CHAIN,
  resetLlmCapabilityCacheForTests,
  resetLlmCircuitForTests,
  resetLlmRetirementsForTests,
  resolveAttemptTimeout,
  resolveLlmTaskRoute,
  suggestedReplacement,
  type LlmProviderEntry,
  type LlmRuntimeConfig,
} from '../lib/llm';

const TEST_KEY = 'test-gemini-key-for-llm-reliability';

const QUALITY: LlmProviderEntry = {
  id: 'gemini-studio-3-8',
  provider: 'Test Gemini',
  model: 'quality-model',
  apiKeyEnv: 'GEMINI_API_KEY',
  kind: 'gemini-native',
};

const LITE: LlmProviderEntry = {
  id: 'gemini-studio-3-5-lite',
  provider: 'Test Gemini',
  model: 'lite-model',
  apiKeyEnv: 'GEMINI_API_KEY',
  kind: 'gemini-native',
};

const config: LlmRuntimeConfig = {
  taskRoutingEnabled: true,
  circuitBreakerEnabled: false,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 60_000,
};

function prepare(t: TestContext): string[] {
  setSettingsStoreForTests({
    read: () => [{ key: 'ai', value: { geminiApiKeys: [TEST_KEY] } }],
    write: () => new Date().toISOString(),
  });
  t.after(() => setSettingsStoreForTests(null));
  resetLlmCircuitForTests();
  resetLlmRetirementsForTests();
  resetLlmCapabilityCacheForTests();
  t.after(() => {
    resetLlmCircuitForTests();
    resetLlmRetirementsForTests();
    resetLlmCapabilityCacheForTests();
  });
  const messages: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  });
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  });
  return messages;
}

function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200 },
  );
}

test('the retired gemini-2.5-flash-lite is gone from the default chain', () => {
  const models = LLM_PROVIDER_CHAIN.map((entry) => entry.model);
  assert.equal(models.includes('gemini-2.5-flash-lite'), false, 'the 404 model is removed');
  assert.ok(models.includes('gemini-3.5-flash-lite'), 'a currently valid fast model replaces it');
  assert.equal(new Set(LLM_PROVIDER_CHAIN.map((entry) => entry.id)).size, LLM_PROVIDER_CHAIN.length, 'ids unique');
});

test('a 404 retires the model for the process and is announced once', async (t) => {
  const logs = prepare(t);
  let qualityCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).includes('quality-model')) {
      qualityCalls += 1;
      return new Response(
        JSON.stringify({ error: { message: 'gemini-2.5-flash-lite is no longer available, use gemini-3.5-flash-lite' } }),
        { status: 404 },
      );
    }
    return geminiOk('{"ok":true}');
  });

  const first = await completeWithFallback(
    { task: 'viral', taskKind: 'viral-detection', prompt: 'x', json: true },
    [QUALITY, LITE],
    config,
  );
  assert.equal(first.entry.id, LITE.id, 'the next model answered');
  assert.deepEqual(listRetiredLlmModels().map((model) => model.model), ['quality-model']);

  const second = await completeWithFallback(
    { task: 'broll', taskKind: 'broll-planning', prompt: 'x', json: true },
    [QUALITY, LITE],
    config,
  );
  assert.equal(second.entry.id, LITE.id);
  assert.equal(qualityCalls, 1, 'the retired model is not called again on the next task');
  assert.ok(logs.some((line) => line.includes('retired for this process')));
  assert.ok(logs.some((line) => line.includes('provider suggests gemini-3.5-flash-lite')));
  // The skip on the SECOND task is one line, not a retirement announcement again.
  const announcements = logs.filter((line) => line.includes('retired for this process')).length;
  assert.equal(announcements, 1);
});

test('a 400 on the thinking config retries the SAME model without it, once', async (t) => {
  const logs = prepare(t);
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const generation = body.generationConfig as Record<string, unknown>;
    if (generation.thinkingConfig) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid argument: thinking_budget is not supported by this model' } }),
        { status: 400 },
      );
    }
    return geminiOk('{"moments":[]}');
  });

  const result = await completeWithFallback(
    { task: 'broll', taskKind: 'broll-planning', prompt: 'x', json: true },
    [LITE],
    config,
  );
  assert.equal(result.entry.id, LITE.id, 'the same model answered on the retry');
  assert.equal(bodies.length, 2, 'exactly one retry');
  assert.deepEqual((bodies[0].generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0 });
  assert.equal((bodies[1].generationConfig as Record<string, unknown>).thinkingConfig, undefined);
  assert.ok(logs.some((line) => line.includes('rejected the thinking config')));

  // The capability is cached: the next task must not send it at all.
  bodies.length = 0;
  await completeWithFallback(
    { task: 'hook', taskKind: 'hook-moment', prompt: 'y', json: true },
    [LITE],
    config,
  );
  assert.equal(bodies.length, 1, 'no second 400 round trip');
  assert.equal((bodies[0].generationConfig as Record<string, unknown>).thinkingConfig, undefined);
});

test('timeouts: quality 45 s scaled by transcript size (cap 90 s), fast routes 20 s', () => {
  const quality = resolveLlmTaskRoute({ taskKind: 'viral-detection' }, config);
  const fast = resolveLlmTaskRoute({ taskKind: 'broll-planning' }, config);
  assert.equal(isFastRoute(quality), false);
  assert.equal(isFastRoute(fast), true);

  assert.equal(resolveAttemptTimeout(quality, 'x'.repeat(10_000), getLlmTimeoutConfig({})), 45_000);
  const big = resolveAttemptTimeout(quality, 'x'.repeat(200_000), getLlmTimeoutConfig({}));
  assert.ok(big > 45_000 && big <= 90_000, `scaled but capped: ${big}`);
  assert.equal(resolveAttemptTimeout(fast, 'x'.repeat(200_000), getLlmTimeoutConfig({})), 20_000);

  // Env overrides, clamped.
  const tuned = getLlmTimeoutConfig({ LLM_QUALITY_TIMEOUT_SECONDS: '30', LLM_FAST_TIMEOUT_SECONDS: '8' });
  assert.equal(tuned.qualitySeconds, 30);
  assert.equal(tuned.fastSeconds, 8);
  assert.equal(resolveAttemptTimeout(fast, 'x', tuned), 8_000);
  assert.equal(getLlmTimeoutConfig({ LLM_FAST_TIMEOUT_SECONDS: '999999' }).fastSeconds, 300);
});

test('hedging is off by default and configurable per route class', () => {
  assert.deepEqual(getLlmRuntimeConfig({}), {
    taskRoutingEnabled: false,
    circuitBreakerEnabled: false,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 90_000,
  });
  const off = getLlmRuntimeConfig({});
  assert.equal(hedgeDelayFor(resolveLlmTaskRoute({ taskKind: 'viral-detection' }, config), off), 0, 'no hedging by default');

  const on = getLlmRuntimeConfig({ LLM_HEDGE_AFTER_SECONDS: '25,8' });
  assert.deepEqual(on.hedgeAfterMs, { quality: 25_000, fast: 8_000 });
  assert.equal(hedgeDelayFor(resolveLlmTaskRoute({ taskKind: 'viral-detection' }, config), on), 25_000);
  assert.equal(hedgeDelayFor(resolveLlmTaskRoute({ taskKind: 'broll-planning' }, config), on), 8_000);
  // A single number applies to both classes; 0 disables.
  assert.deepEqual(getLlmRuntimeConfig({ LLM_HEDGE_AFTER_SECONDS: '10' }).hedgeAfterMs, {
    quality: 10_000,
    fast: 10_000,
  });
  assert.equal(getLlmRuntimeConfig({ LLM_HEDGE_AFTER_SECONDS: '0' }).hedgeAfterMs, undefined);
});

test('a hedge starts the next model early and the first answer wins', async (t) => {
  const logs = prepare(t);
  let released: () => void = () => {};
  const slowAnswered = new Promise<void>((resolve) => {
    released = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).includes('quality-model')) {
      // Slow but healthy: never answers until we release it.
      await slowAnswered;
      return geminiOk('{"from":"slow"}');
    }
    return geminiOk('{"from":"fast"}');
  });

  const hedged: LlmRuntimeConfig = { ...config, hedgeAfterMs: { quality: 20, fast: 20 } };
  const startedAt = Date.now();
  const result = await completeWithFallback(
    { task: 'viral', taskKind: 'viral-detection', prompt: 'x', json: true },
    [QUALITY, LITE],
    hedged,
  );
  const tookMs = Date.now() - startedAt;
  released();
  assert.equal(result.entry.id, LITE.id, 'the fast model won the race');
  assert.ok(result.text.includes('fast'));
  assert.ok(tookMs < 5_000, `did not wait for the slow model's timeout (${tookMs}ms)`);
  assert.ok(logs.some((line) => line.includes('hedge: starting')), 'the hedge is logged');
  assert.ok(logs.some((line) => line.includes('hedge: beat')), 'the winner says who it beat');
});

test('without hedging the slow first model is used when it answers', async (t) => {
  prepare(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"from":"first"}' }] }, finishReason: 'STOP' }] }),
      { status: 200 },
    );
  });
  const result = await completeWithFallback(
    { task: 'viral', taskKind: 'viral-detection', prompt: 'x', json: true },
    [QUALITY, LITE],
    { ...config, hedgeAfterMs: undefined },
  );
  assert.equal(result.entry.id, QUALITY.id);
  assert.equal(calls, 1, 'exactly one request: no speculative second call');
});

test('suggestedReplacement reads the model the provider names', () => {
  assert.equal(
    suggestedReplacement('gemini-2.5-flash-lite is no longer available, use gemini-3.5-flash-lite'),
    'gemini-3.5-flash-lite',
  );
  assert.equal(suggestedReplacement('model not found'), null);
});
