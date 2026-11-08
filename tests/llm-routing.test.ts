import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setSettingsStoreForTests } from "../lib/app-settings";
import {
  completeWithFallback,
  getLlmRuntimeConfig,
  resetLlmCircuitForTests,
  resolveLlmTaskRoute,
  type LlmProviderEntry,
  type LlmRuntimeConfig,
} from "../lib/llm";

const TEST_KEY = "test-gemini-key-for-llm-routing";

const QUALITY: LlmProviderEntry = {
  id: "gemini-studio-3-8",
  provider: "Test Gemini",
  model: "quality-model",
  apiKeyEnv: "GEMINI_API_KEY",
  kind: "gemini-native",
};

const LITE: LlmProviderEntry = {
  id: "gemini-studio-3-5-lite",
  provider: "Test Gemini",
  model: "lite-model",
  apiKeyEnv: "GEMINI_API_KEY",
  kind: "gemini-native",
};

const optimizedConfig: LlmRuntimeConfig = {
  taskRoutingEnabled: true,
  circuitBreakerEnabled: true,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 60_000,
};

function configureKeyPool(t: TestContext): void {
  setSettingsStoreForTests({
    read: () => [{ key: "ai", value: { geminiApiKeys: [TEST_KEY] } }],
    write: () => new Date().toISOString(),
  });
  t.after(() => setSettingsStoreForTests(null));
}

function quietLogs(t: TestContext): string[] {
  const messages: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  return messages;
}

test("LLM runtime flags are opt-in and clamp circuit limits", () => {
  assert.deepEqual(getLlmRuntimeConfig({}), {
    taskRoutingEnabled: false,
    circuitBreakerEnabled: false,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 90_000,
  });
  assert.deepEqual(
    getLlmRuntimeConfig({
      LLM_TASK_ROUTING_ENABLED: "true",
      LLM_CIRCUIT_BREAKER_ENABLED: "yes",
      LLM_CIRCUIT_FAILURE_THRESHOLD: "999",
      LLM_CIRCUIT_COOLDOWN_SECONDS: "1",
    }),
    {
      taskRoutingEnabled: true,
      circuitBreakerEnabled: true,
      circuitFailureThreshold: 10,
      circuitCooldownMs: 5_000,
    },
  );
  assert.equal(
    resolveLlmTaskRoute({ taskKind: "safety-review" }, { ...optimizedConfig, taskRoutingEnabled: false }).name,
    "legacy",
  );
});

test("fast safety routing skips quality models and sends its bounded Gemini request", async (t) => {
  configureKeyPool(t);
  resetLlmCircuitForTests();
  t.after(resetLlmCircuitForTests);
  const logs = quietLogs(t);
  const requestBodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"indexes":[]}' }] }, finishReason: "STOP" }],
      }),
      { status: 200 },
    );
  });

  const result = await completeWithFallback(
    {
      task: "render safety context review",
      taskKind: "safety-review",
      prompt: "0: harmless",
      json: true,
      maxTokens: 250,
    },
    [QUALITY, LITE],
    optimizedConfig,
  );

  assert.equal(result.entry.id, LITE.id);
  assert.equal(requestBodies.length, 1);
  const generation = requestBodies[0].generationConfig as Record<string, unknown>;
  assert.equal(generation.maxOutputTokens, 128);
  assert.deepEqual(generation.thinkingConfig, { thinkingBudget: 0 });
  assert.ok(logs.some((line) => line.includes("Skipping Test Gemini (quality-model)") && line.includes("fast model family")));
  assert.ok(logs.some((line) => line.includes("route=safety-fast") && line.includes("timeout_ms=15000")));
});

test("circuit breaker skips a model after configured transient failures", async (t) => {
  configureKeyPool(t);
  resetLlmCircuitForTests();
  t.after(resetLlmCircuitForTests);
  const logs = quietLogs(t);
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
  });

  const request = { task: "test circuit", taskKind: "generic" as const, prompt: "hello" };
  await assert.rejects(() => completeWithFallback(request, [LITE], optimizedConfig), /Every model/);
  await assert.rejects(() => completeWithFallback(request, [LITE], optimizedConfig), /Every model/);
  await assert.rejects(() => completeWithFallback(request, [LITE], optimizedConfig), /Every model/);

  assert.equal(fetchCalls, 2, "the third request was skipped by the open circuit");
  assert.ok(logs.some((line) => line.includes("opened circuit for 60s")));
  assert.ok(logs.some((line) => line.includes("circuit open for") && line.includes("Skipping")));
});
