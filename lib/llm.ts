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
 * No SDKs on purpose: Groq, Cerebras, OpenRouter and Mistral all expose an
 * OpenAI-compatible `/chat/completions` endpoint, and Google AI Studio has a
 * plain REST `generateContent` endpoint. Node 18+ global `fetch` is enough,
 * so the chain adds zero dependencies.
 */

import { AppError, toErrorMessage } from './errors';

export type LlmProviderKind = 'openai-compatible' | 'gemini-native';

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
 * THE FALLBACK CHAIN — tried in this exact order.
 *
 *   Tier 1  Groq / Cerebras                     best free quality, low latency
 *   Tier 2  OpenRouter (Gemini Flash) / Google AI Studio   large context
 *   Tier 3  OpenRouter (Llama 70B) / Mistral   backup
 *   Tier 4  Groq gpt-oss-20b / OpenRouter (Llama 8B)  last resort, lower quality
 *
 * Move entries up or down to change priority; delete an entry to stop using
 * it; add a new one with the same shape to introduce a provider.
 */
export const LLM_PROVIDER_CHAIN: LlmProviderEntry[] = [
  {
    id: 'groq-llama-70b',
    provider: 'Groq',
    model: 'llama-3.3-70b-versatile',
    apiKeyEnv: 'GROQ_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'cerebras-llama-70b',
    provider: 'Cerebras',
    model: 'llama-3.3-70b',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
  {
    // Experimental OpenRouter slot — OpenRouter can delist ":free" experimental
    // models at any time; swap in any other free model id here if that happens.
    id: 'openrouter-gemini-flash',
    provider: 'OpenRouter',
    model: 'google/gemini-2.0-flash-exp:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    // `gemini-1.5-flash` was retired by Google on 2025-09-29 (404). Confirmed
    // live on AI Studio as of 2026-09 (served with 503 "high demand" spikes);
    // if Google renames it again, pick a current id from the AI Studio console.
    id: 'gemini-studio',
    provider: 'Google AI Studio',
    model: 'gemini-3.6-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    kind: 'gemini-native',
  },
  {
    id: 'openrouter-llama-70b',
    provider: 'OpenRouter',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    // La Plateforme free tier (confirmed live 2026-09 - answers, then 429s
    // under burst). `mistral-large-latest` is a PAID model; use it only with
    // a billed account. 429s here are transient - retries: 1 helps.
    id: 'mistral-small',
    provider: 'Mistral',
    model: 'mistral-small-latest',
    apiKeyEnv: 'MISTRAL_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    retries: 1,
  },
  {
    // `llama-3.1-8b-instant` started returning 404 "does not exist or you do
    // not have access to it" on Groq accounts in 2026. gpt-oss-20b is Groq's
    // verified small chat model (1000+ t/s, 131K context). If Groq renames it,
    // check the current list in the Groq console (Models) or via GET
    // https://api.groq.com/openai/v1/models.
    id: 'groq-gpt-oss-20b',
    provider: 'Groq',
    model: 'openai/gpt-oss-20b',
    apiKeyEnv: 'GROQ_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'openrouter-llama-8b',
    provider: 'OpenRouter',
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
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
    this.name = 'LlmCallFailure';
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
  return Boolean(value && !value.toLowerCase().includes('your_api_key'));
}

/** Pull a human-readable message out of a provider error body, when possible. */
function describeHttpError(status: number, rawBody: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === 'object' && parsed.error?.message) detail = parsed.error.message;
    else if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.message) detail = parsed.message;
  } catch {
    // Non-JSON error body — the status code is enough.
  }

  const kind =
    status === 429 || status === 503
      ? 'rate limited / temporarily unavailable'
      : status === 404
        ? 'model not found / no access (the id may have been renamed or removed - check the provider\'s model list and update lib/llm.ts)'
        : status === 402
          ? 'payment required (this provider account needs billing set up)'
          : 'request failed';
  return `${kind} (HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''})`;
}

async function callOpenAiCompatible(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  maxTokens: number
): Promise<string> {
  if (!entry.baseUrl) {
    throw new LlmCallFailure(entry, 'no baseUrl configured for this entry (lib/llm.ts)');
  }

  let response: Response;
  try {
    response = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        // OpenRouter uses X-Title for attribution on the free tier.
        ...(entry.provider === 'OpenRouter' ? { 'x-title': 'ClipCraft Local' } : {}),
      },
      body: JSON.stringify({
        model: entry.model,
        messages: [
          ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
          { role: 'user' as const, content: request.prompt },
        ],
        max_tokens: maxTokens,
        temperature: request.temperature ?? 0.5,
      }),
      signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure, DNS, TLS or the per-call timeout.
    throw new LlmCallFailure(entry, toErrorMessage(error));
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw new LlmCallFailure(entry, describeHttpError(response.status, rawBody), response.status);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new LlmCallFailure(entry, 'returned a non-JSON response body');
  }

  const content = (json as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]
    ?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    throw new LlmCallFailure(entry, 'returned an empty completion');
  }
  return text;
}

async function callGeminiNative(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest,
  maxTokens: number
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(entry.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header form so the key never ends up in URLs/logs.
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.5,
            maxOutputTokens: maxTokens,
          },
        }),
        signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new LlmCallFailure(entry, toErrorMessage(error));
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw new LlmCallFailure(entry, describeHttpError(response.status, rawBody), response.status);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new LlmCallFailure(entry, 'returned a non-JSON response body');
  }

  const data = json as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
  };

  const text = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
  if (!text) {
    const blockReason = data.promptFeedback?.blockReason;
    throw new LlmCallFailure(entry, blockReason ? `blocked by safety filter (${blockReason})` : 'returned an empty completion');
  }
  return text;
}

/**
 * Effective max_tokens for one entry: the request's value (1500/100 per task)
 * capped by the model's own limit, when the entry declares one. This is what
 * keeps 512-context models (e.g. Groq's prompt-guard family) from 400ing.
 */
function effectiveMaxTokens(entry: LlmProviderEntry, request: LlmCompletionRequest): number {
  return Math.min(request.maxTokens ?? 1500, entry.maxTokens ?? Number.MAX_SAFE_INTEGER);
}

async function callEntry(entry: LlmProviderEntry, request: LlmCompletionRequest): Promise<string> {
  const apiKey = process.env[entry.apiKeyEnv]?.trim() ?? '';
  const maxTokens = effectiveMaxTokens(entry, request);
  return entry.kind === 'gemini-native'
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
  chain: LlmProviderEntry[] = LLM_PROVIDER_CHAIN
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
          error instanceof LlmCallFailure ? error : new LlmCallFailure(entry, toErrorMessage(error));
        const transient = failure.statusCode === 429 || failure.statusCode === 503;

        if (transient && attempt < maxAttempts) {
          console.warn(
            `[LLM] ${label} got HTTP ${failure.statusCode} - transient, retrying in ${LLM_RETRY_DELAY_MS}ms ` +
            `(attempt ${attempt + 1}/${maxAttempts})`
          );
          await sleep(LLM_RETRY_DELAY_MS);
          continue;
        }

        console.warn(
          `[LLM] ${label} ${
            transient
              ? `was rate limited / unavailable (HTTP ${failure.statusCode}) - moving to the next provider`
              : `failed (${failure.message}) - moving to the next provider`
          }`
        );
        attempts.push(
          `${label}: ${failure.message}${transient ? ` (after ${attempt} attempt${attempt > 1 ? 's' : ''})` : ''}`
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
      details: attempts.join(' • '),
      resolution:
        'Set at least one working key in .env.local (GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, ' +
        'GEMINI_API_KEY, MISTRAL_API_KEY), check the per-provider reasons in the details above, and retry.',
    }
  );
}
