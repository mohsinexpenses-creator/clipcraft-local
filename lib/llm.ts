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
 * Current chain (Sep 2026, after trimming every provider that proved
 * uncapable in live use): Google AI Studio only, with two Flash models as
 * separate daily-pool redundancy. Groq was removed (free per-minute INPUT
 * cap -> HTTP 413 on any transcript over ~5 min, plus constant 429s),
 * Cerebras (free models 402 PAID), Mistral (~1 RPM, 429 bursts) and NVIDIA
 * NIM (models 410 Gone + timeouts) all failed in live use. To add a
 * provider back, append an entry in the same shape - the rest of the file
 * is provider-agnostic.
 */

import { AppError, toErrorMessage } from "./errors";

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
  /**
   * Optional extra attempts on TRANSIENT failures (HTTP 429/503 only),
   * spaced LLM_RETRY_DELAY_MS apart, before giving up on this entry and
   * moving to the next provider. Defaults to 0 = move on immediately
   * (the original spec). Free tiers are bursty, so consider `retries: 1`
   * on slots you rely on.
   */
  retries?: number;
}

/**
 * THE FALLBACK CHAIN - tried in this exact order.
 *
 * Trimmed to Google AI Studio on 2026-09-27 after live testing: every other
 * free provider in the previous 13-slot chain failed on real workloads
 * (Groq 413 on long transcripts + 429s, Cerebras 402, Mistral 429,
 * NVIDIA NIM 410/timeouts, OpenRouter key unused). Both Flash models use
 * the same GEMINI_API_KEY but draw from SEPARATE free daily pools, so the
 * second slot is real redundancy against 503 high-demand spikes on one
 * model. Add entries below to re-introduce providers.
 */
export const LLM_PROVIDER_CHAIN: LlmProviderEntry[] = [
  {
    id: "gemini-studio-3-8",
    provider: "Google AI Studio",
    model: "gemini-3.8-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
    retries: 1,
  },
  {
    id: "gemini-studio-3-6",
    provider: "Google AI Studio",
    model: "gemini-3.6-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
    retries: 1,
  },
  {
    id: "gemini-studio-3-5-lite",
    provider: "Google AI Studio",
    model: "gemini-3.5-flash-lite",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
    retries: 1,
  },
  {
    id: "gemini-studio-3-1-lite",
    provider: "Google AI Studio",
    model: "gemini-3.1-flash-lite",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
    retries: 1,
  },
  {
    id: "gemini-studio-2-5-lite",
    provider: "Google AI Studio",
    model: "gemini-2.5-flash-lite",
    apiKeyEnv: "GEMINI_API_KEY",
    kind: "gemini-native",
    retries: 1,
  },
];

/** One chat completion, expressed provider-neutrally. */
export interface LlmCompletionRequest {
  /** What this completion is for — appears in logs and the final error. */
  task: string;
  /** System instruction from the prompt template (may be empty). */
  system?: string;
  /** User prompt with the template placeholder already filled in. */
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a raw JSON answer (no markdown fences, no prose around it). */
  json?: boolean;
}

export interface LlmCompletionResult {
  /** The model's raw response text. */
  text: string;
  /** The provider/model entry that actually answered. */
  entry: LlmProviderEntry;
  /** Milliseconds the successful call took. */
  tookMs: number;
}

/** Per-attempt failure carrying the HTTP status (when there was one). */
class LlmCallFailure extends Error {
  readonly entry: LlmProviderEntry;
  readonly statusCode?: number;

  constructor(entry: LlmProviderEntry, message: string, statusCode?: number) {
    super(message);
    this.name = "LlmCallFailure";
    this.entry = entry;
    this.statusCode = statusCode;
  }
}

/** Per-call timeout so one hung provider cannot stall the whole analysis. */
const LLM_CALL_TIMEOUT_MS = 120_000;

/** Pause between retries of a transiently failing (429/503) entry. */
const LLM_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the entry's env var holds a real key. Empty values and the
 * `.env.example` placeholder style (`your_api_key`) count as "not set", so
 * a freshly copied .env.local skips every entry cleanly instead of failing.
 */
export function isLlmKeyConfigured(entry: LlmProviderEntry): boolean {
  const value = process.env[entry.apiKeyEnv]?.trim();
  return Boolean(value && !value.toLowerCase().includes("your_api_key"));
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

async function callOpenAiCompatible(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  maxTokens: number,
): Promise<string> {
  if (!entry.baseUrl) {
    throw new LlmCallFailure(
      entry,
      "no baseUrl configured for this entry (lib/llm.ts)",
    );
  }

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
        max_tokens: maxTokens,
        temperature: request.temperature ?? 0.5,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure, DNS, TLS or the per-call timeout.
    throw new LlmCallFailure(entry, toErrorMessage(error));
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw new LlmCallFailure(
      entry,
      describeHttpError(response.status, rawBody),
      response.status,
    );
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
}

async function callGeminiNative(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  maxTokens: number,
): Promise<string> {
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
            maxOutputTokens: maxTokens,
            ...(request.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
        signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new LlmCallFailure(entry, toErrorMessage(error));
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw new LlmCallFailure(
      entry,
      describeHttpError(response.status, rawBody),
      response.status,
    );
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
      `output was cut off at the maxOutputTokens limit (${maxTokens}) before the answer could finish (Gemini 3.x spends part of this budget on thinking tokens)`,
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
}

/**
 * Effective max_tokens for one entry: the request's value (1500/100 per task)
 * capped by the model's own limit, when the entry declares one. This is what
 * keeps 512-context models (e.g. Groq's prompt-guard family) from 400ing.
 */
function effectiveMaxTokens(
  entry: LlmProviderEntry,
  request: LlmCompletionRequest,
): number {
  return Math.min(
    request.maxTokens ?? 1500,
    entry.maxTokens ?? Number.MAX_SAFE_INTEGER,
  );
}

async function callEntry(
  entry: LlmProviderEntry,
  request: LlmCompletionRequest,
): Promise<string> {
  const apiKey = process.env[entry.apiKeyEnv]?.trim() ?? "";
  const maxTokens = effectiveMaxTokens(entry, request);
  return entry.kind === "gemini-native"
    ? callGeminiNative(entry, apiKey, request, maxTokens)
    : callOpenAiCompatible(entry, apiKey, request, maxTokens);
}

/**
 * Run one completion against the fallback chain.
 *
 * - Entries without a configured key are skipped (and logged as such).
 * - On HTTP 429/503 the next entry is tried immediately.
 * - On any other error the failure is logged and the next entry is tried too.
 * - If every entry fails, an AppError (HTTP 502) is thrown whose `details`
 *   list every attempt and why it failed — the caller can surface that for
 *   the specific chunk without the rest of the pipeline knowing.
 *
 * On success, logs which provider/model handled the request and how long it
 * took.
 */
export async function completeWithFallback(
  request: LlmCompletionRequest,
  chain: LlmProviderEntry[] = LLM_PROVIDER_CHAIN,
): Promise<LlmCompletionResult> {
  const attempts: string[] = [];

  for (const entry of chain) {
    const label = `${entry.provider} (${entry.model})`;

    if (!isLlmKeyConfigured(entry)) {
      const why = `${entry.apiKeyEnv} is not set`;
      console.log(`[LLM] Skipping ${label} — ${why}`);
      attempts.push(`${label}: ${why}`);
      continue;
    }

    const startedAt = Date.now();
    const maxAttempts = (entry.retries ?? 0) + 1;
    console.log(`[LLM] Trying ${label} for "${request.task}" ...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const text = await callEntry(entry, request);
        const tookMs = Date.now() - startedAt;
        console.log(`[LLM] ${label} handled "${request.task}" in ${tookMs}ms`);
        return { text, entry, tookMs };
      } catch (error) {
        const failure =
          error instanceof LlmCallFailure
            ? error
            : new LlmCallFailure(entry, toErrorMessage(error));
        const transient =
          failure.statusCode === 429 || failure.statusCode === 503;

        if (transient && attempt < maxAttempts) {
          console.warn(
            `[LLM] ${label} got HTTP ${failure.statusCode} - transient, retrying in ${LLM_RETRY_DELAY_MS}ms ` +
              `(attempt ${attempt + 1}/${maxAttempts})`,
          );
          await sleep(LLM_RETRY_DELAY_MS);
          continue;
        }

        console.warn(
          `[LLM] ${label} ${
            transient
              ? `was rate limited / unavailable (HTTP ${failure.statusCode}) - moving to the next provider`
              : `failed (${failure.message}) - moving to the next provider`
          }`,
        );
        attempts.push(
          `${label}: ${failure.message}${transient ? ` (after ${attempt} attempt${attempt > 1 ? "s" : ""})` : ""}`,
        );
        break;
      }
    }
  }

  throw new AppError(
    chain.length === LLM_PROVIDER_CHAIN.length
      ? `Every provider in the LLM fallback chain failed for "${request.task}".`
      : `Every provider in the requested LLM chain failed for "${request.task}".`,
    {
      status: 502,
      details: attempts.join(" • "),
      resolution:
        "Set a working GEMINI_API_KEY in .env.local, check the per-provider reasons in the " +
        "details above (and .env.local for typos), and retry.",
    },
  );
}
