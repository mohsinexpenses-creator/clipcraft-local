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
 * THE FALLBACK CHAIN - tried in this exact order.
 *
 * Model ids below were re-verified against provider documentation, third-party
 * free-tier trackers and live API error responses as of 2026-09-25 (sources
 * cited per entry). The Llama
 * models from the original chain (llama-3.3-70b-versatile on Groq,
 * llama-3.1-8b-instant, llama-3.3-70b on Cerebras, gemini-2.0-flash-exp:free
 * on OpenRouter) are all GONE from their free tiers by September 2026 -
 * Groq's free plan dropped Llama entirely, and OpenRouter no longer has any
 * $0 Google/Mistral/DeepSeek models.
 *
 *   Tier 1  Groq (qwen3.8-27b, gpt-oss-120b) / Google AI Studio (gemini-3.6-flash)
 *   Tier 2  Google AI Studio (gemini-2.5-flash) / Cerebras (qwen-3-235b) / OpenRouter (qwen3.8-27b)
 *   Tier 3  OpenRouter (gpt-oss-120b, llama-3.3-70b) / Mistral (mistral-small)
 *   Tier 4  NVIDIA NIM (llama-3.3-70b, optional key) / Groq (gpt-oss-20b)
 *
 * Move entries up or down to change priority; delete an entry to stop using
 * it; add a new one with the same shape to introduce a provider.
 */
export const LLM_PROVIDER_CHAIN: LlmProviderEntry[] = [
  {
    // Groq free tier (Sep 2026): qwen3.8-27b is the best free chat model left
    // on Groq after Llama was dropped from the free plan. 30 RPM / 1,000 RPD /
    // 200K tokens per day, 131K context.
    id: 'groq-qwen3-8-27b',
    provider: 'Groq',
    model: 'qwen/qwen3.8-27b',
    apiKeyEnv: 'GROQ_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    // Confirmed live on AI Studio in 2026-09 (503 = high-demand spike, not a
    // bad id). Gemini free tier: Flash models only since 2026-04-01, 1M context,
    // ~1,500 RPD. Strong multilingual support (Urdu/Hindi content).
    id: 'gemini-studio-3-6',
    provider: 'Google AI Studio',
    model: 'gemini-3.6-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    kind: 'gemini-native',
    retries: 1,
  },
  {
    // Groq free tier (Sep 2026): 131K context, separate per-model rate pool
    // from the qwen slot above.
    id: 'groq-gpt-oss-120b',
    provider: 'Groq',
    model: 'openai/gpt-oss-120b',
    apiKeyEnv: 'GROQ_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    // gemini-2.5-flash 404s as of late Sep 2026: "no longer available to new
    // users. Please update your code to use models/gemini-3.8-flash" (Google's
    // own error text). 1M context, ~1,500 RPD - a SEPARATE daily pool from
    // gemini-3.6-flash, so the two Gemini slots double the free Google budget.
    id: 'gemini-studio-3-8',
    provider: 'Google AI Studio',
    model: 'gemini-3.8-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    kind: 'gemini-native',
    retries: 1,
  },
  {
    // Cerebras free tier: gpt-oss-120b (listed online/free Aug-Sep 2026, 131K
    // context). qwen-3-235b-a22b-instruct-2507 was 404 on some accounts
    // ("model does not exist or you do not have access") - Cerebras rotates its
    // free list, and qwen-3.8-27b there is PAID (402). If this id 404s on your
    // account, check the Cerebras Cloud console and swap it here; the chain
    // logs it and moves on either way.
    id: 'cerebras-gpt-oss-120b',
    provider: 'Cerebras',
    model: 'gpt-oss-120b',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
  {
    // OpenRouter free (Sep 2026): 50 RPD per free model (1,000 RPD after a
    // one-time $10 top-up). "Safest default" per current free-model trackers.
    id: 'openrouter-qwen3-8-27b',
    provider: 'OpenRouter',
    model: 'qwen/qwen3.8-27b:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    // OpenRouter free (Jul 2026, still listed): 131K context, strong general
    // reasoning for a free model.
    id: 'openrouter-gpt-oss-120b',
    provider: 'OpenRouter',
    model: 'openai/gpt-oss-120b:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    // La Plateforme free tier (confirmed live 2026-09 - answers, then 429s on
    // bursts; ~1 RPM). 429s are transient - retries: 1 helps.
    id: 'mistral-small',
    provider: 'Mistral',
    model: 'mistral-small-latest',
    apiKeyEnv: 'MISTRAL_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    retries: 1,
  },
  {
    // OpenRouter free (Jul 2026): "most established pick - live and stable".
    // If it has been delisted by the time you run this, the slot 404s, the
    // chain logs it and moves on - swap the id here.
    id: 'openrouter-llama-70b',
    provider: 'OpenRouter',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    // OPTIONAL 6th key: NVIDIA NIM (build.nvidia.com, 40 RPM, free credits).
    // meta/llama-4-scout-17b-16e-instruct: verified in the NIM catalog
    // (Sep 2026), 128K context. meta/llama-3.3-70b-instruct returned HTTP 410
    // (Gone) - NIM retires models without much notice. NIM has also been
    // flaky lately (504s/timeouts), so this stays near the bottom of the chain.
    // Skipped automatically when NVIDIA_API_KEY is empty.
    id: 'nvidia-llama-4-scout',
    provider: 'NVIDIA NIM',
    model: 'meta/llama-4-scout-17b-16e-instruct',
    apiKeyEnv: 'NVIDIA_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  {
    // Last resort (Sep 2026): Groq's fastest free model (1,000+ t/s), 131K
    // context, own rate pool. Lower quality than the 120B/235B slots but
    // rarely rate-limited.
    id: 'groq-gpt-oss-20b',
    provider: 'Groq',
    model: 'openai/gpt-oss-20b',
    apiKeyEnv: 'GROQ_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
]

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
          : status === 413
            ? 'request too large (the transcript exceeds this provider\'s free per-minute INPUT token cap - long videos should be handled by the large-context providers later in the chain)'
            : status === 410
              ? 'model gone (the provider retired this model id - update lib/llm.ts)'
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
        'Set at least one working key in .env.local (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ' +
        'CEREBRAS_API_KEY, MISTRAL_API_KEY, optionally NVIDIA_API_KEY), check the per-provider ' +
        'reasons in the details above, and retry.',
    }
  );
}
