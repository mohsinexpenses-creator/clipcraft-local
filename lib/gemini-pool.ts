import { createHash } from 'node:crypto';

export interface VisualApiBudget {
  deadline: number;
  plannerCalls: number;
  visionCalls: number;
  attempts: number;
  geminiMs: number;
  cacheHits: number;
  lastFailure?: string;
}
export function createVisualApiBudget(timeoutMs = 25000): VisualApiBudget {
  return { deadline: Date.now() + timeoutMs, plannerCalls: 0, visionCalls: 0, attempts: 0, geminiMs: 0, cacheHits: 0 };
}
export function remainingVisualMs(budget?: VisualApiBudget, cap = 7000): number {
  const remaining = budget ? budget.deadline - Date.now() : cap;
  if (remaining <= 0) throw new Error('Visual prefetch deadline exceeded; unresolved beats skipped');
  return Math.max(1, Math.min(cap, remaining));
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

export async function requestGeminiJson(options: {
  keys: string[]; rpm?: number; task: 'planner' | 'vision'; body: Record<string, unknown>;
  budget?: VisualApiBudget; timeoutMs?: number; pool?: GeminiKeyPool;
}): Promise<string> {
  const budget = options.budget ?? createVisualApiBudget(options.timeoutMs ?? 10000);
  const field = options.task === 'planner' ? 'plannerCalls' : 'visionCalls';
  if (budget[field] >= (field === 'plannerCalls' ? 1 : 3)) throw new Error(`Gemini ${options.task} call cap reached`);
  budget[field]++;
  const pool = options.pool ?? sharedPool;
  const started = Date.now();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      remainingVisualMs(budget);
      if (budget.attempts >= 4) throw new Error(`Gemini per-clip HTTP attempt cap (4) reached; includes retries. ${budget.lastFailure ?? ''}`);
      const key = await pool.acquire(options.keys, options.rpm ?? 10, budget.deadline);
      // Recheck after any asynchronous limiter wait; parallel batches share the cap.
      if (budget.attempts >= 4) throw new Error(`Gemini per-clip HTTP attempt cap (4) reached; includes retries. ${budget.lastFailure ?? ''}`);
      budget.attempts++;
      let response: Response;
      try {
        response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(options.body), signal: AbortSignal.timeout(remainingVisualMs(budget, options.timeoutMs ?? 7000)),
        });
      } catch { throw new Error('Gemini network unavailable or request timed out; photo skipped'); }
      if (response.ok) {
        const payload = await response.json() as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
        const answer = payload.candidates?.[0];
        if (answer?.finishReason && answer.finishReason !== 'STOP') throw new Error(`Gemini incomplete output: ${answer.finishReason}`);
        const text = answer?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? '').join('') ?? '';
        if (!text) throw new Error('Gemini returned no verdict/output');
        return text;
      }
      // Never log provider bodies/URLs: error messages can contain credentials or input.
      budget.lastFailure = `Gemini ${response.status === 429 ? 'quota/rate limit exhausted' : response.status >= 500 ? 'service unavailable' : 'key invalid or request rejected'} (HTTP ${response.status})`;
      const transient = response.status === 429 || response.status >= 500;
      const invalid = response.status === 400 || response.status === 401 || response.status === 403;
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => undefined);
      if (invalid) pool.block(key, 60000);
      if (response.status === 429) pool.block(key, Math.max(1000, Math.min(60000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000)));
      if ((!transient && !invalid) || attempt === 2) throw new Error(`Gemini ${invalid ? 'key invalid/access denied' : transient ? 'quota exhausted/service unavailable' : 'request rejected'} (HTTP ${response.status})`);
      const delay = Math.round(350 * 2 ** attempt + Math.random() * 200);
      if (Date.now() + delay >= budget.deadline) throw new Error(`Gemini quota/network deadline (HTTP ${response.status})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error('Gemini retry budget exhausted');
  } finally { budget.geminiMs += Date.now() - started; }
}
