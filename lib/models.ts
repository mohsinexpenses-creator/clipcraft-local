/**
 * Single source of truth for LLM model ids.
 *
 * Why this file exists: model ids used to be hard-coded inside lib/claude.ts and
 * lib/gemini.ts, and both of them rotted:
 *
 *   - `claude-3-haiku-20240307` was retired by Anthropic on 2026-04-19. Every call
 *     now fails outright (no automatic redirect to a newer model).
 *   - `gemini-1.5-flash` was shut down by Google on 2025-09-29 and returns 404.
 *
 * Keep the ids here so a future deprecation is a one-line change (or just an
 * .env.local change), and prefer the rolling aliases (`gemini-flash-latest`) for
 * personal use so the app keeps working between provider deprecations.
 */

/** Model ids that the provider has already switched off. Used for a loud warning. */
const RETIRED_CLAUDE_MODELS = new Set([
  'claude-3-haiku-20240307',
  'claude-3-haiku-20240307-v1',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-2.1',
  'claude-2.0',
]);

const RETIRED_GEMINI_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-pro',
  'gemini-1.5-pro-001',
  'gemini-1.5-pro-002',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-pro',
]);

/**
 * Claude Haiku 4.5 - Anthropic's documented successor to Claude 3 Haiku.
 * Cheap enough for transcript analysis + short overlay copy, which is all we use it for.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * `gemini-flash-latest` always points at the newest Flash model, so it survives
 * Google's frequent version churn. Pin an explicit version if you want reproducible output.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

function warnOnce(key: string, message: string): void {
  // Widen through `unknown` first: globalThis does not structurally overlap
  // Record<string, Set<string>>, so a direct cast is rejected by tsc.
  const host = globalThis as unknown as Record<string, Set<string> | undefined>;
  const cache = host.__clipcraftModelWarnings ?? (host.__clipcraftModelWarnings = new Set<string>());

  if (cache.has(key)) return;
  cache.add(key);
  console.warn(message);
}

export function getClaudeModel(): string {
  const model = readEnv('ANTHROPIC_MODEL') || DEFAULT_CLAUDE_MODEL;

  if (RETIRED_CLAUDE_MODELS.has(model)) {
    warnOnce(
      `claude:${model}`,
      `[Models] ANTHROPIC_MODEL="${model}" has been retired by Anthropic and every request will fail. ` +
      `Set ANTHROPIC_MODEL=${DEFAULT_CLAUDE_MODEL} (or newer) in .env.local.`
    );
  }

  return model;
}

export function getGeminiModelName(): string {
  const model = readEnv('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;

  if (RETIRED_GEMINI_MODELS.has(model)) {
    warnOnce(
      `gemini:${model}`,
      `[Models] GEMINI_MODEL="${model}" has been shut down by Google and returns 404. ` +
      `Set GEMINI_MODEL=${DEFAULT_GEMINI_MODEL} (or a current pinned version) in .env.local.`
    );
  }

  return model;
}
