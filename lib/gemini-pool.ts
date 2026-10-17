import { LLM_PROVIDER_CHAIN } from './llm';
import { log } from './logger';
import type { VisualGeminiCallTiming } from './types';
import { createHash } from 'node:crypto';

export interface VisualApiBudget {
  deadline: number;
  plannerCalls: number;
  visionCalls: number;
  attempts: number;
  chargedAttempts: number;
  geminiMs: number;
  cacheHits: number;
  lastFailure?: string;
  geminiCalls: VisualGeminiCallTiming[];
}
export function createVisualApiBudget(timeoutMs = 25000): VisualApiBudget {
  return { deadline: Date.now() + timeoutMs, plannerCalls: 0, visionCalls: 0, attempts: 0, chargedAttempts: 0, geminiMs: 0, cacheHits: 0, geminiCalls: [] };
}
export function remainingVisualMs(budget?: VisualApiBudget, cap = 7000): number {
  const remaining = budget ? budget.deadline - Date.now() : cap;
  if (remaining <= 0) throw new Error('Visual prefetch deadline exceeded; unresolved beats skipped');
  return Math.max(1, Math.min(cap, remaining));
}

/** Per-attempt cap for visual planning/vision calls that do not pass their own. */
export const DEFAULT_VISUAL_CALL_TIMEOUT_MS = 7000;

/**
 * Turn a rejected `fetch` into one short, actionable cause.
 *
 * The old code collapsed every network failure into "network unavailable or
 * request timed out", which hides the difference between a slow model (raise the
 * cap), a dead DNS/offline machine (fix the network) and a TLS-intercepting
 * proxy/VPN (trust or bypass it). The cause chain is preserved by Node's fetch
 * (`TypeError: fetch failed` with `cause.code`), so report it.
 */
export function describeGeminiFetchFailure(error: unknown, capMs: number): string {
  const seconds = Math.max(1, Math.round(capMs / 1000));
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'TimeoutError' || name === 'AbortError') return `request timed out after ${seconds}s`;
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `DNS lookup failed (${code}) for generativelanguage.googleapis.com - check internet/VPN/DNS`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/i.test(code)) return `TLS handshake failed (${code}) - a proxy/VPN is intercepting HTTPS`;
  if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/i.test(code)) return `connection failed (${code}) - network or firewall blocked generativelanguage.googleapis.com`;
  const detail = causeMessage || (error instanceof Error ? error.message : String(error));
  return `network unavailable${detail ? ` (${detail.slice(0, 160)})` : ''}`;
}

interface KeyState { timestamps: number[]; blockedUntil: number }
/** One worker per DB. Pool is shared by planner/vision and uses hashed key identities. */
export class GeminiKeyPool {
  private cursor = 0;
  private states = new Map<string, KeyState>();
  constructor(private now = Date.now, private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {}
  private state(key: string): KeyState {
    const id = createHash('sha256').update(key).digest('hex');
    let state = this.states.get(id);
    if (!state) { state = { timestamps: [], blockedUntil: 0 }; this.states.set(id, state); }
    state.timestamps = state.timestamps.filter((time) => time > this.now() - 60000);
    return state;
  }
  block(key: string, ms: number) { this.state(key).blockedUntil = this.now() + ms; }
  async acquire(keys: string[], rpm: number, deadline: number): Promise<string> {
    const unique = [...new Set(keys.filter((key) => key.trim()))];
    if (!unique.length) throw new Error('Gemini API key not configured (Settings -> AI providers)');
    const limit = Math.max(1, Math.floor(rpm));
    while (true) {
      let wait = Infinity;
      for (let offset = 0; offset < unique.length; offset++) {
        const index = (this.cursor + offset) % unique.length;
        const key = unique[index]; const state = this.state(key);
        const available = Math.max(state.blockedUntil, state.timestamps.length >= limit ? state.timestamps[0] + 60000 : 0);
        if (available <= this.now()) {
          state.timestamps.push(this.now()); this.cursor = (index + 1) % unique.length; return key;
        }
        wait = Math.min(wait, available - this.now());
      }
      if (this.now() + wait >= deadline) throw new Error('Gemini RPM/quota exhausted or keys invalid; visual deadline reached');
      await this.sleep(Math.max(1, wait));
    }
  }
}
const sharedPool = new GeminiKeyPool();

const missingModels = new Set<string>();
let discoveredModels: Set<string> | undefined;
export const visualGeminiModels = (): string[] => LLM_PROVIDER_CHAIN.filter((entry) => entry.kind === 'gemini-native')
  .map((entry) => entry.model).filter((model) => !missingModels.has(model) && (!discoveredModels || discoveredModels.has(model)));

/** Verify names against this key's models.list response, never a guessed release date. */
export async function probeVisualGeminiModels(keys: string[]): Promise<{ model?: string; available: string[] }> {
  let lastError = 'No Gemini API key configured';
  for (const key of [...new Set(keys)]) {
    try {
      const available = new Set<string>(); let token: string | undefined;
      do {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('pageSize', '1000'); if (token) url.searchParams.set('pageToken', token);
        const response = await fetch(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`models.list HTTP ${response.status}`);
        const data = await response.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string };
        for (const model of data.models ?? []) if (model.supportedGenerationMethods?.includes('generateContent')) available.add(model.name.replace(/^models\//, ''));
        token = data.nextPageToken;
      } while (token);
      discoveredModels = available;
      return { model: visualGeminiModels()[0], available: [...available] };
    } catch (error) { lastError = error instanceof Error ? error.message : 'models.list unreachable'; }
  }
  throw new Error(lastError);
}

export async function requestGeminiJson(options: {
  keys: string[]; rpm?: number; task: 'planner' | 'vision'; body: Record<string, unknown>;
  budget?: VisualApiBudget; timeoutMs?: number; pool?: GeminiKeyPool; models?: string[];
}): Promise<string> {
  const budget = options.budget ?? createVisualApiBudget(options.timeoutMs ?? 10000);
  const field = options.task === 'planner' ? 'plannerCalls' : 'visionCalls';
  if (budget[field] >= (field === 'plannerCalls' ? 1 : 3)) throw new Error(`Gemini ${options.task} call cap reached`);
  budget[field]++;
  const pool = options.pool ?? sharedPool;
  const started = Date.now();
  let localAttempts = 0; let outcome: 'ok' | 'error' = 'error';
  try {
    const models = options.models ?? visualGeminiModels();
    for (const model of models) {
      if (missingModels.has(model)) continue;
      remainingVisualMs(budget);
      const key = await pool.acquire(options.keys, options.rpm ?? 10, budget.deadline);
      if (budget.chargedAttempts >= 4) throw new Error('Gemini per-clip charged attempt cap (4) reached');
      budget.chargedAttempts++; budget.attempts++; localAttempts++;
      const config = { ...options.body.generationConfig as Record<string, unknown> };
      if (/^gemini-3/.test(model)) config.thinkingConfig = { thinkingLevel: 'low' };
      else if (/^gemini-2\.5/.test(model)) config.thinkingConfig = { thinkingBudget: 0 };
      else delete config.thinkingConfig;
      // The cap is resolved once so the abort signal and the reported cause are
      // the same number. `remainingVisualMs` may throw (deadline) and that must
      // never be reported as a network failure.
      const capMs = remainingVisualMs(budget, options.timeoutMs ?? DEFAULT_VISUAL_CALL_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ ...options.body, generationConfig: config }), signal: AbortSignal.timeout(capMs),
        });
      } catch (error) {
        // A network failure/timeout is a routing failure: nothing was billed
        // upstream, so refund the charged attempt and give the next model a
        // chance while the shared wall deadline allows it. Previously one slow
        // model aborted the whole chain and every clip showed 0 resolved images.
        const detail = describeGeminiFetchFailure(error, capMs);
        budget.lastFailure = `Gemini network unavailable or request timed out (${detail}; ${model}); photo skipped`;
        budget.chargedAttempts--;
        const hasNextModel = models.slice(models.indexOf(model) + 1).some((next) => !missingModels.has(next));
        const delay = Math.round(150 + Math.random() * 200);
        if (!hasNextModel || Date.now() + delay >= budget.deadline) throw new Error(budget.lastFailure);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.ok) {
        const payload = await response.json() as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
        const answer = payload.candidates?.[0];
        if (answer?.finishReason && answer.finishReason !== 'STOP') throw new Error(`Gemini incomplete output: ${answer.finishReason}`);
        const text = answer?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? '').join('') ?? '';
        if (!text) throw new Error('Gemini returned no verdict/output');
        outcome = 'ok'; return text;
      }
      const status = response.status;
      const fallback = status === 404 || status === 429 || status >= 500;
      budget.lastFailure = `Gemini ${status === 404 ? 'model unavailable' : status === 429 ? 'quota/rate limit exhausted' : status >= 500 ? 'service unavailable' : 'key invalid or request rejected'} (HTTP ${status})`;
      await response.body?.cancel().catch(() => undefined);
      if (status === 404 && !missingModels.has(model)) { missingModels.add(model); log.warn(`Gemini model ${model} returned 404; disabled for this process`); }
      if (!fallback) throw new Error(budget.lastFailure);
      // Refund only routing failures. Physical attempts are still logged, RPM still applies,
      // model traversal is finite and the wall deadline is shared by all parallel batches.
      budget.chargedAttempts--;
      if (status !== 404) {
        const delay = Math.round(150 + Math.random() * 200);
        if (Date.now() + delay >= budget.deadline) throw new Error(budget.lastFailure);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(budget.lastFailure ?? 'No available Gemini model in the configured LLM chain; check models.list');
  } finally {
    const elapsedMs = Date.now() - started;
    budget.geminiMs += elapsedMs;
    budget.geminiCalls.push({ task: options.task, elapsedMs, attempts: localAttempts, outcome });
  }
}
