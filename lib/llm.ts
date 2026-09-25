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
}

/**
 * THE FALLBACK CHAIN — tried in this exact order.
 *
 *   Tier 1  Groq / Cerebras                     best free quality, low latency
 *   Tier 2  OpenRouter (Gemini Flash) / Google AI Studio   large context
 *   Tier 3  OpenRouter (Llama 70B) / Mistral   backup
 *   Tier 4  Groq 8B / OpenRouter (Llama 8B)    last resort, lower quality
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
    // NOTE: Google retired `gemini-1.5-flash` on 2025-09-29, so this slot
    // currently 404s and the chain falls through to Tier 3. If you have a
    // Google AI Studio key, change the model to `gemini-flash-latest` (or a
    // current pinned version) to keep this slot in play.
    id: 'gemini-studio',
    provider: 'Google AI Studio',
    model: 'gemini-1.5-flash',
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
    // NOTE: on La Plateforme `mistral-large-latest` is a paid model; the free
    // tier normally covers e.g. `mistral-small-latest`. If this slot returns
    // 401/403, change the model id here.
    id: 'mistral-large',
    provider: 'Mistral',
    model: 'mistral-large-latest',
    apiKeyEnv: 'MISTRAL_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'groq-llama-8b',
    provider: 'Groq',
    model: 'llama-3.1-8b-instant',
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

  const kind = status === 429 || status === 503 ? 'rate limited / temporarily unavailable' : 'request failed';
  return `${kind} (HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''})`;
}

async function callOpenAiCompatible(
  entry: LlmProviderEntry,
  apiKey: string,
  request: LlmCompletionRequest
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
        max_tokens: request.maxTokens ?? 1500,
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
  request: LlmCompletionRequest
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
            maxOutputTokens: request.maxTokens ?? 1500,
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

async function callEntry(entry: LlmProviderEntry, request: LlmCompletionRequest): Promise<string> {
  const apiKey = process.env[entry.apiKeyEnv]?.trim() ?? '';
  return entry.kind === 'gemini-native'
    ? callGeminiNative(entry, apiKey, request)
    : callOpenAiCompatible(entry, apiKey, request);
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
export async function completeWithFallback(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
  const attempts: string[] = [];

  for (const entry of LLM_PROVIDER_CHAIN) {
    const label = `${entry.provider} (${entry.model})`;

    if (!isLlmKeyConfigured(entry)) {
      const why = `${entry.apiKeyEnv} is not set`;
      console.log(`[LLM] Skipping ${label} — ${why}`);
      attempts.push(`${label}: ${why}`);
      continue;
    }

    const startedAt = Date.now();
    console.log(`[LLM] Trying ${label} for "${request.task}" ...`);
    try {
      const text = await callEntry(entry, request);
      const tookMs = Date.now() - startedAt;
      console.log(`[LLM] ${label} handled "${request.task}" in ${tookMs}ms`);
      return { text, entry, tookMs };
    } catch (error) {
      const failure =
        error instanceof LlmCallFailure ? error : new LlmCallFailure(entry, toErrorMessage(error));
      const rateLimited = failure.statusCode === 429 || failure.statusCode === 503;
      console.warn(
        `[LLM] ${label} ${
          rateLimited
            ? `was rate limited / unavailable (HTTP ${failure.statusCode}) — moving to the next provider`
            : `failed (${failure.message}) — moving to the next provider`
        }`
      );
      attempts.push(`${label}: ${failure.message}`);
    }
  }

  throw new AppError(`Every provider in the LLM fallback chain failed for "${request.task}".`, {
    status: 502,
    details: attempts.join(' • '),
    resolution:
      'Set at least one working key in .env.local (GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, ' +
      'GEMINI_API_KEY, MISTRAL_API_KEY), check the per-provider reasons in the details above, and retry.',
  });
}
