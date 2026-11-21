/**
 * LLM fallback chain for ClipCraft's AI analysis (viral segment detection,
 * hook text, CTA text).
 *
 * Why this exists
 * ---------------
 * A single LLM provider fails: rate limits (429), outages (503), expired keys,
 * delisted or retired models. Instead of failing the whole analysis,
 * `completeWithFallback()` walks `LLM_PROVIDER_CHAIN` in order and uses the
 * first provider/model that returns a usable response.
 *
 * How to change the chain
 * -----------------------
 * Edit `LLM_PROVIDER_CHAIN` below: reorder entries, add or remove ones, or
 * change model ids. Nothing else in the codebase needs to change. The only
 * rule is that each entry lists the env var holding its API key — entries
 * without a (non-placeholder) key are skipped with a log line, and a chain
 * where every entry fails throws one clear error listing every attempt.
 *
 * No SDKs on purpose: every supported provider either exposes an
 * OpenAI-compatible `/chat/completions` endpoint or (Google AI Studio) a
 * plain REST `generateContent` endpoint. Node 18+ global `fetch` is enough,
 * so the chain adds zero dependencies.
 *
 * Current chain (Oct 2026): Google AI Studio models are tried in order, once
 * each, with no same-model retry. Retired ids are detected at runtime: a 404
 * marks that model unavailable for the rest of the process (logged once), and a
 * 400 that names a thinking/config field retries once without it. Groq was removed (free per-minute INPUT
 * cap -> HTTP 413 on any transcript over ~5 min, plus constant 429s),
 * Cerebras (free models 402 PAID), Mistral (~1 RPM, 429 bursts) and NVIDIA
 * NIM (models 410 Gone + timeouts) all failed in live use. To add a
 * provider back, append an entry in the same shape - the rest of the file
 * is provider-agnostic.
 */

import { AppError, RenderCancelledError, toErrorMessage } from "./errors";
import { loadEffectiveSettings } from "./app-settings";
import { log } from "./logger";

export type LlmProviderKind = "openai-compatible" | "gemini-native";

export interface LlmProviderEntry {
  /** Stable id used in logs and error details. */
  id: string;
  /** Human-readable provider name for logs. */
  provider: string;
  /** Model id sent to the API. */
  model: string;
  /** Env var that must hold a real API key for this entry to be tried. */
  apiKeyEnv: string;
  /** How to talk to the provider. */
  kind: LlmProviderKind;
  /** Base URL (no trailing slash), required when kind is 'openai-compatible'. */
  baseUrl?: string;
  /**
   * Optional hard cap on max_tokens for THIS model. Some models reject
   * larger values outright (e.g. Groq's 512-context prompt-guard models
   * 400 with "max_tokens must be less than or equal to 512"). When set,
   * the request sends min(requested, this).
   */
  maxTokens?: number;
}

/**
 * A small, explicit task vocabulary lets the LLM layer choose bounded budgets
 * and a suitable model family without callers relying on fragile task strings.
 */
export type LlmTaskKind =
  | "viral-detection"
  | "broll-planning"
  | "safety-review"
  | "overlay-text"
  | "hook-moment"
  | "generic";

export interface LlmTaskRoute {
  /** Human-readable label included in per-attempt logs. */
  name: string;
  /** Per-model attempt deadline. */
  timeoutMs: number;
  /** Maximum output budget for this task. */
  maxTokens?: number;
  /** Disable Gemini thinking only when this task does not benefit from it. */
  thinkingBudget?: number;
  /** Only these model ids are eligible when task routing is switched on. */
  modelIds?: readonly string[];
}

export interface LlmRuntimeConfig {
  /** Off by default: preserves the existing all-model / 120-second behavior. */
  taskRoutingEnabled: boolean;
  /** Off by default: failed models are retried on the next task as before. */
  circuitBreakerEnabled: boolean;
  /** Consecutive transient failures before a model is temporarily skipped. */
  circuitFailureThreshold: number;
  /** How long an open model circuit stays open. */
  circuitCooldownMs: number;
  /**
   * Hedging (`LLM_HEDGE_AFTER_SECONDS`, off by default): when the current model
   * has not answered after this long, start the next model in the chain
   * CONCURRENTLY and keep whichever answers with a usable response first.
   * Without it, a slow-but-healthy model burns its whole timeout before the
   * next one is even tried (the real run: 3.8-flash timed out at 90 s and
   * viral detection took 1 m 41 s).
   */
  hedgeAfterMs?: { quality: number; fast: number };
}

/** Timeout caps for the two route classes (seconds, from env). */
export interface LlmTimeoutConfig {
  /** First model on a quality route (viral detection). */
  qualitySeconds: number;
  /** Every fast route (B-roll planning, hook, overlay, safety). */
  fastSeconds: number;
}

const FAST_LITE_MODEL_IDS = [
  "gemini-studio-3-5-lite",
  "gemini-studio-3-1-lite",
] as const;

/**
 * Opt-in latency routes. The standard route is intentionally the prior behavior:
 * every configured model, caller-selected budget, and a 120-second deadline.
 */
const OPTIMIZED_TASK_ROUTES: Record<Exclude<LlmTaskKind, "generic">, LlmTaskRoute> = {
  "viral-detection": {
    name: "viral-quality",
    // Ceiling. The effective deadline is LLM_QUALITY_TIMEOUT_SECONDS (45 s)
    // scaled by transcript size; this is the hard cap it can never exceed.
    timeoutMs: 90_000,
    // Preserves normal 1-6 clip detection responses while preventing an
    // accidentally huge request from monopolising every fallback model.
    maxTokens: 16_000,
  },
  "broll-planning": {
    name: "broll-fast",
    // Was 45 s: a fast lite model that has not answered in 20 s is not going to.
    timeoutMs: 20_000,
    maxTokens: 1_200,
    thinkingBudget: 0,
    modelIds: FAST_LITE_MODEL_IDS,
  },
  "safety-review": {
    name: "safety-fast",
    timeoutMs: 15_000,
    maxTokens: 128,
    thinkingBudget: 0,
    modelIds: FAST_LITE_MODEL_IDS,
  },
  "overlay-text": {
    name: "overlay-fast",
    timeoutMs: 15_000,
    maxTokens: 128,
    thinkingBudget: 0,
    modelIds: FAST_LITE_MODEL_IDS,
  },
  "hook-moment": {
    name: "hook-fast",
    timeoutMs: 20_000,
    maxTokens: 192,
    thinkingBudget: 0,
    modelIds: FAST_LITE_MODEL_IDS,
  },
};

const LEGACY_TASK_ROUTE: LlmTaskRoute = {
  name: "legacy",
  timeoutMs: 120_000,
};

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function envInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

/** Default per-model deadlines. The old single value was 120 s everywhere. */
export const LLM_TIMEOUT_DEFAULTS: LlmTimeoutConfig = {
  qualitySeconds: 45,
  fastSeconds: 20,
};

/** Default hedge delays (`LLM_HEDGE_AFTER_SECONDS`); 0 disables hedging. */
export const LLM_HEDGE_DEFAULTS = { qualitySeconds: 25, fastSeconds: 8 } as const;

/** Read at request time so settings can be toggled without restarting the worker. */
export function getLlmRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LlmRuntimeConfig {
  const hedge = env.LLM_HEDGE_AFTER_SECONDS?.trim();
  // Format: "quality,fast" seconds, or a single number for both. 0 disables.
  const parseHedge = (): { quality: number; fast: number } | undefined => {
    if (hedge === undefined || hedge === "") return undefined;
    const parts = hedge.split(",").map((part) => Number.parseFloat(part.trim()));
    const quality = Number.isFinite(parts[0]) ? Math.max(0, parts[0]) : NaN;
    const fast = Number.isFinite(parts[1]) ? Math.max(0, parts[1]) : quality;
    if (!Number.isFinite(quality) && !Number.isFinite(fast)) return undefined;
    if (quality === 0 && fast === 0) return undefined;
    return {
      quality: (Number.isFinite(quality) ? quality : LLM_HEDGE_DEFAULTS.qualitySeconds) * 1_000,
      fast: (Number.isFinite(fast) ? fast : LLM_HEDGE_DEFAULTS.fastSeconds) * 1_000,
    };
  };
  return {
    taskRoutingEnabled: envFlag(env.LLM_TASK_ROUTING_ENABLED),
    circuitBreakerEnabled: envFlag(env.LLM_CIRCUIT_BREAKER_ENABLED),
    circuitFailureThreshold: envInteger(
      env.LLM_CIRCUIT_FAILURE_THRESHOLD,
      2,
      1,
      10,
    ),
    circuitCooldownMs:
      envInteger(env.LLM_CIRCUIT_COOLDOWN_SECONDS, 90, 5, 3_600) * 1_000,
    ...(parseHedge() ? { hedgeAfterMs: parseHedge() } : {}),
  };
}

/** Per-model deadlines from `LLM_QUALITY_TIMEOUT_SECONDS` / `LLM_FAST_TIMEOUT_SECONDS`. */
export function getLlmTimeoutConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LlmTimeoutConfig {
  return {
    qualitySeconds: envInteger(env.LLM_QUALITY_TIMEOUT_SECONDS, LLM_TIMEOUT_DEFAULTS.qualitySeconds, 5, 300),
    fastSeconds: envInteger(env.LLM_FAST_TIMEOUT_SECONDS, LLM_TIMEOUT_DEFAULTS.fastSeconds, 3, 300),
  };
}

/** True for routes that must stay quick (B-roll planning, hook, overlay, safety). */
export function isFastRoute(route: LlmTaskRoute): boolean {
  return route.name !== "legacy" && route.timeoutMs <= 30_000;
}

/**
 * The deadline for one attempt.
 *
 * Quality routes scale with the transcript: a 3-hour transcript legitimately
 * needs longer than a 40-second one, so we grow the budget with the prompt and
 * cap it hard. `hardCapMs` is the route ceiling and can never be exceeded.
 */
export function resolveAttemptTimeout(
  route: LlmTaskRoute,
  prompt: string,
  timeouts: LlmTimeoutConfig = getLlmTimeoutConfig(),
): number {
  if (route.name === "legacy") return route.timeoutMs;
  if (isFastRoute(route)) {
    return Math.min(route.timeoutMs, timeouts.fastSeconds * 1_000);
  }
  // Quality: baseline from the route, scaled by transcript size.
  const base = Math.min(route.timeoutMs, timeouts.qualitySeconds * 1_000);
  const chars = prompt.length;
  // <= 40k chars (a ~10 min transcript) keeps the baseline; every extra 40k
  // adds 25 % of the baseline, hard-capped at the route ceiling.
  const scale = 1 + Math.min(2, Math.max(0, (chars - 40_000) / 40_000) * 0.25);
  return Math.min(route.timeoutMs, Math.round(base * scale));
}

/** Resolve the effective route while retaining legacy behavior when disabled. */
export function resolveLlmTaskRoute(
  request: Pick<LlmCompletionRequest, "taskKind">,
  config: LlmRuntimeConfig = getLlmRuntimeConfig(),
): LlmTaskRoute {
  if (!config.taskRoutingEnabled || !request.taskKind || request.taskKind === "generic") {
    return LEGACY_TASK_ROUTE;
  }
  return OPTIMIZED_TASK_ROUTES[request.taskKind];
}

/**
 * THE FALLBACK CHAIN - tried in this exact order, once per model.
 *
 * A model is never retried; a failure advances to the next configured model.
 */
export const LLM_PROVIDER_CHAIN: LlmProviderEntry[] = [
  {
    id: "gemini-studio-3-8",
    provider: "Google AI Studio",
    model: "gemini-3.8-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
  },
  {
    id: "gemini-studio-3-6",
    provider: "Google AI Studio",
    model: "gemini-3.6-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
  },
  {
    id: "gemini-studio-3-5",
    provider: "Google AI Studio",
    model: "gemini-3.5-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
  },
  {
    id: "gemini-studio-3-5-lite",
    provider: "Google AI Studio",
    model: "gemini-3.5-flash-lite",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
  },
  {
    id: "gemini-studio-3-1-lite",
    provider: "Google AI Studio",
    model: "gemini-3.1-flash-lite",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
  },
];
// gemini-2.5-flash-lite was removed from the chain: it 404s with
// "no longer available, use gemini-3.5-flash-lite". Model ids age out, so the
// chain now also self-heals at runtime - see `retiredModelReason()` below.

/** One chat completion, expressed provider-neutrally. */
export interface LlmCompletionRequest {
  /** What this completion is for — appears in logs and the final error. */
  task: string;
  /** Opt-in routing category; omitted callers use the legacy fallback behavior. */
  taskKind?: LlmTaskKind;
  /** System instruction from the prompt template (may be empty). */
  system?: string;
  /** User prompt with the template placeholder already filled in. */
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a raw JSON answer (no markdown fences, no prose around it). */
  json?: boolean;
  /** Worker cancellation is forwarded to every provider fetch. */
  signal?: AbortSignal;
}

export interface LlmCompletionResult {
  /** The model's raw response text. */
  text: string;
  /** The provider/model entry that actually answered. */
  entry: LlmProviderEntry;
  /** Milliseconds the successful call took. */
  tookMs: number;
}

/** Per-attempt failure carrying the HTTP status and failure class (when known). */
type LlmFailureKind = "timeout" | "network" | "http" | "response" | "configuration";

class LlmCallFailure extends Error {
  readonly entry: LlmProviderEntry;
  readonly statusCode?: number;
  readonly kind: LlmFailureKind;

  constructor(
    entry: LlmProviderEntry,
    message: string,
    options: { statusCode?: number; kind?: LlmFailureKind } = {},
  ) {
    super(message);
    this.name = "LlmCallFailure";
    this.entry = entry;
    this.statusCode = options.statusCode;
    this.kind = options.kind ?? "response";
  }
}

/** A cancellable timeout signal so a timeout can be logged and circuit-counted exactly. */
interface AttemptAbortSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}

function requestAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AttemptAbortSignal {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  return {
    signal: signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal,
    didTimeout: () => timeoutController.signal.aborted && !signal?.aborted,
    dispose: () => clearTimeout(timeout),
  };
}

/** Return the configured API key pool; each model attempt uses its first key. */
export async function llmKeysFor(entry?: LlmProviderEntry): Promise<string[]> {
  void entry;
  const settings = await loadEffectiveSettings();
  return settings.ai.geminiApiKeys;
}

/** Pull a human-readable message out of a provider error body, when possible. */
function describeHttpError(status: number, rawBody: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.message)
      detail = parsed.error.message;
    else if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.message) detail = parsed.message;
  } catch {
    // Non-JSON error body — the status code is enough.
  }

  const kind =
    status === 429 || status === 503
      ? "rate limited / temporarily unavailable"
      : status === 404
        ? "model not found / no access (the id may have been renamed or removed - check the provider's model list and update lib/llm.ts)"
        : status === 402
          ? "payment required (this provider account needs billing set up)"
          : status === 413
            ? "request too large (the transcript exceeds this provider's free per-minute INPUT token cap - long videos should be handled by the large-context providers later in the chain)"
            : status === 410
              ? "model gone (the provider retired this model id - update lib/llm.ts)"
              : "request failed";
  return `${kind} (HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ""})`;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

interface LlmAttemptOptions {
  maxTokens: number;
  timeoutMs: number;
  thinkingBudget?: number;
}

async function callOpenAiCompatible(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  attempt: LlmAttemptOptions,
): Promise<string> {
  if (!entry.baseUrl) {
    throw new LlmCallFailure(entry, "no baseUrl configured for this entry (lib/llm.ts)", {
      kind: "configuration",
    });
  }

  const abort = requestAbortSignal(request.signal, attempt.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${entry.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          // OpenRouter uses X-Title for attribution on the free tier.
          ...(entry.provider === "OpenRouter"
            ? { "x-title": "ClipCraft Local" }
            : {}),
        },
        body: JSON.stringify({
          model: entry.model,
          messages: [
            ...(request.system
              ? [{ role: "system" as const, content: request.system }]
              : []),
            { role: "user" as const, content: request.prompt },
          ],
          max_tokens: attempt.maxTokens,
          temperature: request.temperature ?? 0.5,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: abort.signal,
      });
    } catch (error) {
      // Network failure, DNS, TLS or the per-call timeout.
      throwIfCancelled(request.signal);
      if (abort.didTimeout()) {
        throw new LlmCallFailure(
          entry,
          `timed out after ${attempt.timeoutMs}ms`,
          { kind: "timeout" },
        );
      }
      throw new LlmCallFailure(entry, toErrorMessage(error), { kind: "network" });
    }

    throwIfCancelled(request.signal);
    const rawBody = await response.text();
    if (!response.ok) {
      throw new LlmCallFailure(entry, describeHttpError(response.status, rawBody), {
        statusCode: response.status,
        kind: "http",
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new LlmCallFailure(entry, "returned a non-JSON response body");
    }

    const content = (
      json as { choices?: Array<{ message?: { content?: string | null } }> }
    ).choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new LlmCallFailure(entry, "returned an empty completion");
    }
    return text;
  } finally {
    abort.dispose();
  }
}

async function callGeminiNative(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  attempt: LlmAttemptOptions,
): Promise<string> {
  const abort = requestAbortSignal(request.signal, attempt.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(entry.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Header form so the key never ends up in URLs/logs.
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            ...(request.system
              ? { systemInstruction: { parts: [{ text: request.system }] } }
              : {}),
            contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            generationConfig: {
              temperature: request.temperature ?? 0.5,
              maxOutputTokens: attempt.maxTokens,
              ...(request.json ? { responseMimeType: "application/json" } : {}),
              ...(attempt.thinkingBudget === undefined
                ? {}
                : { thinkingConfig: { thinkingBudget: attempt.thinkingBudget } }),
            },
          }),
          signal: abort.signal,
        },
      );
    } catch (error) {
      throwIfCancelled(request.signal);
      if (abort.didTimeout()) {
        throw new LlmCallFailure(
          entry,
          `timed out after ${attempt.timeoutMs}ms`,
          { kind: "timeout" },
        );
      }
      throw new LlmCallFailure(entry, toErrorMessage(error), { kind: "network" });
    }

    throwIfCancelled(request.signal);
    const rawBody = await response.text();
    if (!response.ok) {
      throw new LlmCallFailure(entry, describeHttpError(response.status, rawBody), {
        statusCode: response.status,
        kind: "http",
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new LlmCallFailure(entry, "returned a non-JSON response body");
    }

    const data = json as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    // Gemini 3.x models spend part of maxOutputTokens on "thinking" tokens.
    // When the budget runs out mid-answer the API still returns HTTP 200 with
    // finishReason MAX_TOKENS and a silently truncated body - detect it here so
    // the chain logs a real failure instead of feeding half-JSON to the parser.
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      throw new LlmCallFailure(
        entry,
        `output was cut off at the maxOutputTokens limit (${attempt.maxTokens}) before the answer could finish (Gemini 3.x spends part of this budget on thinking tokens)`,
      );
    }

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      const blockReason = data.promptFeedback?.blockReason;
      throw new LlmCallFailure(
        entry,
        blockReason
          ? `blocked by safety filter (${blockReason})`
          : "returned an empty completion",
      );
    }
    return text;
  } finally {
    abort.dispose();
  }
}

/**
 * Effective max_tokens for one entry: the request's value (1500/100 per task)
 * capped by the model's own limit, when the entry declares one. This is what
 * keeps 512-context models (e.g. Groq's prompt-guard family) from 400ing.
 */
function effectiveMaxTokens(
  entry: LlmProviderEntry,
  request: LlmCompletionRequest,
  route: LlmTaskRoute,
): number {
  return Math.min(
    request.maxTokens ?? 1500,
    entry.maxTokens ?? Number.MAX_SAFE_INTEGER,
    route.maxTokens ?? Number.MAX_SAFE_INTEGER,
  );
}

interface ModelCircuitState {
  consecutiveTransientFailures: number;
  openedUntilMs: number | null;
}

const modelCircuits = new Map<string, ModelCircuitState>();

/** Test-only reset: production circuits intentionally live for the worker process. */
export function resetLlmCircuitForTests(): void {
  modelCircuits.clear();
}

function transientCircuitFailure(failure: LlmCallFailure): boolean {
  return (
    failure.kind === "timeout" ||
    failure.kind === "network" ||
    failure.statusCode === 429 ||
    (failure.statusCode !== undefined && failure.statusCode >= 500)
  );
}

function openCircuitReason(
  entry: LlmProviderEntry,
  config: LlmRuntimeConfig,
  now = Date.now(),
): string | null {
  if (!config.circuitBreakerEnabled) return null;
  const circuit = modelCircuits.get(entry.id);
  if (!circuit?.openedUntilMs) return null;
  if (circuit.openedUntilMs <= now) {
    // The cooldown elapsed: keep the failure history only as diagnostics, but
    // allow one attempt to prove the provider is healthy again.
    circuit.openedUntilMs = null;
    return null;
  }
  return `circuit open for ${Math.ceil((circuit.openedUntilMs - now) / 1_000)}s after ` +
    `${circuit.consecutiveTransientFailures} transient failure(s)`;
}

function recordCircuitFailure(
  entry: LlmProviderEntry,
  failure: LlmCallFailure,
  config: LlmRuntimeConfig,
  now = Date.now(),
): string | null {
  if (!config.circuitBreakerEnabled || !transientCircuitFailure(failure)) return null;
  const circuit = modelCircuits.get(entry.id) ?? {
    consecutiveTransientFailures: 0,
    openedUntilMs: null,
  };
  circuit.consecutiveTransientFailures += 1;
  if (circuit.consecutiveTransientFailures >= config.circuitFailureThreshold) {
    circuit.openedUntilMs = now + config.circuitCooldownMs;
    modelCircuits.set(entry.id, circuit);
    return `opened circuit for ${Math.ceil(config.circuitCooldownMs / 1_000)}s after ` +
      `${circuit.consecutiveTransientFailures} transient failure(s)`;
  }
  modelCircuits.set(entry.id, circuit);
  return null;
}

function recordCircuitSuccess(entry: LlmProviderEntry, config: LlmRuntimeConfig): void {
  if (!config.circuitBreakerEnabled) return;
  modelCircuits.delete(entry.id);
}

/* -------------------------------------------------------------------------- */
/* Retired models and per-model request capabilities                          */
/* -------------------------------------------------------------------------- */

/**
 * Models this process learned it cannot use, and why.
 *
 * The real run: `gemini-2.5-flash-lite` 404s with "no longer available, use
 * gemini-3.5-flash-lite". Retrying a delisted id on every task wastes a round
 * trip per task and buries the useful lines, so a 404/410 marks the model
 * unavailable for the rest of the process - logged once, with the replacement
 * the provider named when it names one.
 */
export interface RetiredModel {
  entryId: string;
  model: string;
  status: number;
  reason: string;
  retiredAtMs: number;
}

const retiredModels = new Map<string, RetiredModel>();

/** Test-only reset: production retirements last for the worker process. */
export function resetLlmRetirementsForTests(): void {
  retiredModels.clear();
}

/** Every model retired so far (for logs, diagnostics and tests). */
export function listRetiredLlmModels(): RetiredModel[] {
  return [...retiredModels.values()];
}

function retiredModelReason(entry: LlmProviderEntry): string | null {
  const retired = retiredModels.get(entry.id);
  return retired
    ? `model unavailable for this process (${retired.reason})`
    : null;
}

/** A 404/410 means the id is gone - never retry it in this process. */
function isRetiredStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/** Pull "use X instead" out of a provider error message, when it names one. */
export function suggestedReplacement(message: string): string | null {
  const match = /(?:use|try)\s+([a-z0-9][a-z0-9.\-]*[a-z0-9])/i.exec(message);
  return match ? match[1] : null;
}

function retireEntry(entry: LlmProviderEntry, failure: LlmCallFailure): void {
  if (!isRetiredStatus(failure.statusCode)) return;
  if (retiredModels.has(entry.id)) return;
  const replacement = suggestedReplacement(failure.message);
  const reason =
    `HTTP ${failure.statusCode}` + (replacement ? ` - provider suggests ${replacement}` : "");
  retiredModels.set(entry.id, {
    entryId: entry.id,
    model: entry.model,
    status: failure.statusCode ?? 404,
    reason,
    retiredAtMs: Date.now(),
  });
  log.taggedWarn(
    `[LLM] Model ${entry.model} retired for this process (${reason}); ` +
      "it will be skipped on every later task.",
  );
}

/**
 * Models that rejected a `thinkingConfig` (HTTP 400 "invalid argument").
 * `gemini-3.5-flash-lite` 400s with `thinking_budget=0`, so a fast route that
 * sends one must be able to retry WITHOUT it instead of falling through the
 * whole chain. Cached per model so we only learn it once.
 */
const noThinkingConfigModels = new Set<string>();

/** Test-only reset for the per-model capability cache. */
export function resetLlmCapabilityCacheForTests(): void {
  noThinkingConfigModels.clear();
}

export function modelRejectsThinkingConfig(entry: LlmProviderEntry): boolean {
  return noThinkingConfigModels.has(entry.id);
}

/** A 400 that mentions a thinking/config field is a per-model capability issue. */
function isThinkingConfigRejection(failure: LlmCallFailure): boolean {
  if (failure.statusCode !== 400) return false;
  return /thinking|invalid argument|unknown name|unknown field|not supported|unsupported/i.test(
    failure.message,
  );
}

function dropThinkingConfig(entry: LlmProviderEntry, failure: LlmCallFailure): void {
  if (noThinkingConfigModels.has(entry.id)) return;
  noThinkingConfigModels.add(entry.id);
  log.taggedWarn(
    `[LLM] ${entry.model} rejected the thinking config (${failure.message}); ` +
      "retrying it once without thinking_budget and remembering this for the process.",
  );
}

/* -------------------------------------------------------------------------- */
/* Hedged requests                                                            */
/* -------------------------------------------------------------------------- */

/** How long to wait for the current model before starting the next one. */
export function hedgeDelayFor(route: LlmTaskRoute, config: LlmRuntimeConfig): number {
  const delays = config.hedgeAfterMs;
  if (!delays) return 0;
  return isFastRoute(route) ? delays.fast : delays.quality;
}

/** True when the attempt produced a usable (non-empty, parseable-relevant) text. */
function usableResponse(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Run one completion against the model fallback chain.
 *
 * Each model is called at most once (with one capability retry when the model
 * rejects a thinking config), using the first configured key. A failure
 * advances to the next model. With `LLM_HEDGE_AFTER_SECONDS` set, the next
 * model is started CONCURRENTLY when the current one is slow, and the first
 * usable answer wins.
 */
export async function completeWithFallback(
  request: LlmCompletionRequest,
  chain: LlmProviderEntry[] = LLM_PROVIDER_CHAIN,
  config: LlmRuntimeConfig = getLlmRuntimeConfig(),
): Promise<LlmCompletionResult> {
  const attempts: string[] = [];
  const route = resolveLlmTaskRoute(request, config);
  const timeoutMs = resolveAttemptTimeout(route, request.prompt);
  const hedgeDelay = hedgeDelayFor(route, config);

  // All configured models currently use this same Gemini key pool.
  const keyPool = new Map<string, string[]>();
  for (const entry of chain) {
    if (!keyPool.has(entry.apiKeyEnv)) keyPool.set(entry.apiKeyEnv, await llmKeysFor(entry));
  }

  /** Why a model cannot be tried right now, or null when it can. */
  const skipReason = (entry: LlmProviderEntry, label: string): string | null => {
    if (route.modelIds && !route.modelIds.includes(entry.id)) {
      return `task route ${route.name} prefers a fast model family`;
    }
    const retired = retiredModelReason(entry);
    if (retired) {
      // Already announced when it retired; keep the line short on later tasks.
      return retired;
    }
    const circuitReason = openCircuitReason(entry, config);
    if (circuitReason) return circuitReason;
    if ((keyPool.get(entry.apiKeyEnv) ?? []).length === 0) {
      void label;
      return "no key is configured (Settings -> AI providers)";
    }
    return null;
  };

  /** One model attempt, including the one-shot thinking-config retry. */
  const attemptModel = async (
    entry: LlmProviderEntry,
    label: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; attemptMs: number }> => {
    const keys = (keyPool.get(entry.apiKeyEnv) ?? []).slice(0, 1);
    const effectiveRoute: LlmTaskRoute = { ...route, timeoutMs };
    const attempt: LlmAttemptOptions = {
      maxTokens: effectiveMaxTokens(entry, request, effectiveRoute),
      timeoutMs,
      ...(route.thinkingBudget === undefined || modelRejectsThinkingConfig(entry)
        ? {}
        : { thinkingBudget: route.thinkingBudget }),
    };
    const startedAttempt = Date.now();
    // The hedged loser is cancelled through this signal, so its fetch really
    // stops instead of quietly finishing and burning quota.
    const scopedRequest: LlmCompletionRequest = signal
      ? { ...request, signal: request.signal ? AbortSignal.any([request.signal, signal]) : signal }
      : request;
    const call = (withAttempt: LlmAttemptOptions): Promise<string> =>
      entry.kind === "gemini-native"
        ? callGeminiNative(entry, keys[0], scopedRequest, withAttempt)
        : callOpenAiCompatible(entry, keys[0], scopedRequest, withAttempt);
    try {
      const text = await call(attempt);
      return { text, attemptMs: Date.now() - startedAttempt };
    } catch (error) {
      if (error instanceof RenderCancelledError || request.signal?.aborted) {
        throw new RenderCancelledError();
      }
      const failure =
        error instanceof LlmCallFailure
          ? error
          : new LlmCallFailure(entry, toErrorMessage(error), { kind: "network" });
      // A model that rejects the thinking config gets exactly one retry without
      // it (Phase 2b) - the capability is cached so later tasks skip the dance.
      if (attempt.thinkingBudget !== undefined && isThinkingConfigRejection(failure)) {
        dropThinkingConfig(entry, failure);
        const retryStarted = Date.now();
        const text = await call({ ...attempt, thinkingBudget: undefined });
        log.tagged(`[LLM] ${label} answered on the retry without thinking_budget`);
        return { text, attemptMs: Date.now() - retryStarted };
      }
      throw failure;
    }
  };

  /** Report a failed attempt: retire 404s, count the circuit, log once. */
  const recordFailure = (entry: LlmProviderEntry, label: string, error: unknown): string => {
    const failure =
      error instanceof LlmCallFailure
        ? error
        : new LlmCallFailure(entry, toErrorMessage(error), { kind: "network" });
    retireEntry(entry, failure);
    const circuitUpdate = recordCircuitFailure(entry, failure, config);
    log.taggedWarn(
      `[LLM] ${label} failed (${failure.message}) - trying next model` +
        (circuitUpdate ? `; ${circuitUpdate}` : ""),
    );
    return failure.message;
  };

  // Candidates in chain order, minus everything that cannot be tried.
  const candidates: Array<{ entry: LlmProviderEntry; label: string }> = [];
  for (const entry of chain) {
    throwIfCancelled(request.signal);
    const label = `${entry.provider} (${entry.model})`;
    const why = skipReason(entry, label);
    if (why) {
      log.tagged(`[LLM] Skipping ${label} for "${request.task}" — ${why}`);
      attempts.push(`${label}: ${why}`);
      continue;
    }
    candidates.push({ entry, label });
  }

  const describeRoute =
    route.name === "legacy"
      ? ""
      : ` route=${route.name} timeout_ms=${timeoutMs}` +
        (hedgeDelay > 0 ? ` hedge_after_ms=${hedgeDelay}` : "");

  const finish = (
    entry: LlmProviderEntry,
    label: string,
    text: string,
    startedAt: number,
    note = "",
  ): LlmCompletionResult => {
    const tookMs = Date.now() - startedAt;
    recordCircuitSuccess(entry, config);
    log.tagged(`[LLM] ${label} handled "${request.task}" in ${tookMs}ms${note}`);
    return { text, entry, tookMs };
  };

  /** Mark every loser of a race as abandoned so its fetch is cancelled. */
  let raceController: AbortController | null = null;

  interface StartedTask {
    entry: LlmProviderEntry;
    label: string;
    /** Resolves when this attempt settles: `ok` with text, or `failed`. */
    settled: Promise<{ ok: true; text: string } | { ok: false; message: string }>;
  }

  /**
   * Race at most two candidates at a time. The first starts alone; if it has
   * not answered after `hedgeDelay`, the next candidate starts concurrently.
   * The first usable answer wins, and every other in-flight attempt is aborted.
   */
  const runHedged = async (
    group: Array<{ entry: LlmProviderEntry; label: string }>,
  ): Promise<LlmCompletionResult | null> => {
    if (group.length === 0) return null;
    const startedAt = Date.now();
    const controller = new AbortController();
    raceController = controller;
    const failures: Array<{ label: string; message: string }> = [];
    const running: StartedTask[] = [];
    const finished = new Set<StartedTask>();
    let nextIndex = 0;

    const start = (candidate: { entry: LlmProviderEntry; label: string }): StartedTask => {
      log.tagged(`[LLM] Trying ${candidate.label} for "${request.task}"...${describeRoute}`);
      const task: StartedTask = {
        entry: candidate.entry,
        label: candidate.label,
        settled: attemptModel(candidate.entry, candidate.label, controller.signal).then(
          (outcome) =>
            usableResponse(outcome.text)
              ? ({ ok: true, text: outcome.text } as const)
              : ({ ok: false, message: "returned no usable text" } as const),
          (error: unknown) => {
            if (error instanceof RenderCancelledError) throw error;
            if (controller.signal.aborted && !(error instanceof LlmCallFailure)) {
              // Aborted by the hedge winner: not this model's fault.
              return { ok: false, message: "aborted (another model answered first)" } as const;
            }
            return {
              ok: false,
              message: recordFailure(candidate.entry, candidate.label, error),
            } as const;
          },
        ),
      };
      running.push(task);
      return task;
    };

    start(group[nextIndex]);
    nextIndex += 1;

    try {
      for (;;) {
        throwIfCancelled(request.signal);
        const inFlight = running.filter((task) => !finished.has(task));
        if (inFlight.length === 0) {
          if (nextIndex >= group.length) break;
          // Everything tried so far failed: move on to the next candidate.
          start(group[nextIndex]);
          nextIndex += 1;
          continue;
        }

        // A hedge timer only exists while there is another candidate to start.
        let hedgeTimer: Promise<{ hedge: true }> | null = null;
        let hedgeHandle: ReturnType<typeof setTimeout> | null = null;
        if (nextIndex < group.length && hedgeDelay > 0) {
          hedgeTimer = new Promise((resolve) => {
            hedgeHandle = setTimeout(() => resolve({ hedge: true }), hedgeDelay);
          });
        }

        const winner = await Promise.race([
          ...inFlight.map((task) => task.settled.then((outcome) => ({ task, outcome }))),
          ...(hedgeTimer ? [hedgeTimer] : []),
        ]);
        if (hedgeHandle) clearTimeout(hedgeHandle);

        if ("hedge" in winner) {
          const next = group[nextIndex];
          nextIndex += 1;
          log.tagged(
            `[LLM] hedge: starting ${next.label} for "${request.task}" after ` +
              `${((Date.now() - startedAt) / 1000).toFixed(1)}s while ` +
              `${inFlight.map((task) => task.label).join(", ")} is still answering`,
          );
          start(next);
          continue;
        }

        finished.add(winner.task);
        if (winner.outcome.ok) {
          controller.abort();
          const others = running.filter((task) => task !== winner.task).map((task) => task.label);
          const note = others.length > 0 ? ` (hedge: beat ${others.join(", ")})` : "";
          return finish(winner.task.entry, winner.task.label, winner.outcome.text, startedAt, note);
        }
        failures.push({ label: winner.task.label, message: winner.outcome.message });
      }
      for (const failure of failures) attempts.push(`${failure.label}: ${failure.message}`);
      return null;
    } finally {
      controller.abort();
      if (raceController === controller) raceController = null;
    }
  };

  const result = await runHedged(candidates);
  if (result) return result;

  void raceController;
  throw new AppError(
    `Every model in the LLM fallback chain failed for "${request.task}".`,
    {
      status: 502,
      details: attempts.join(" • "),
      resolution:
        "Add a working key under Settings -> AI providers, check the per-provider reasons " +
        "in the details above, and retry. If LLM task routing is enabled, disable it " +
        "to restore the full fallback chain.",
    },
  );
}
