import fs from 'fs';
import path from 'path';
import {
  APP_SETTINGS_SECTIONS,
  AiProviderSettings,
  AppSettings,
  AppSettingsSection,
  AppSettingsSnapshot,
  CONCURRENCY_LIMITS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_PIPELINE_OPTIONS,
  DEFAULT_PROFANITY_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  PipelineOptions,
  EnvHint,
  ProfanitySettings,
  RenderDefaults,
  SettingsLimits,
  SettingsSources,
  WorkerSettings,
} from './types';
import { OPTION_LIMITS, sanitizePipelineOptions } from './pipeline-defaults';
import { DEFAULT_FILTER_PRESETS } from './presets';
import { AppError } from './errors';

/**
 * The Settings page's backing store: read the stored overrides from SQLite, fall
 * back to `.env.local`, then to the built-in defaults. Nothing else in the app
 * reads `process.env` for a value that has a settings row - and nothing here
 * rewrites `.env.local`, so a hand-edited env file stays authoritative until an
 * override is saved.
 *
 * Secrets (Gemini / Deepgram keys) are stored here for the same reason they live in
 * `.env.local`: this is a single-user machine. The API never returns one in full -
 * `maskSecret` is the only view of it - which is why saving a section that contains
 * a masked placeholder means "keep the key that is already stored".
 *
 * `.env.local` is parsed for one display purpose: to tell the user "DEEPGRAM_API_KEY
 * is already set in your env file" without exposing its value (see `envHints`).
 */

/**
 * Values a *running* worker process only picks up again after it is restarted: the two
 * polling loops are sized once, at start (`startWorker` in `worker/index.ts`). The
 * Remotion tab count is deliberately NOT here - `worker/runtime-settings.ts` refreshes
 * it before every job, so a change lands on the next render.
 */
export const RESTART_REQUIRED_PATHS = ['worker.clipConcurrency', 'worker.viralConcurrency'] as const;

const FILTER_IDS = new Set(DEFAULT_FILTER_PRESETS.map((preset) => preset.id));
const CAPTION_ENGINES = new Set(['remotion', 'native']);
const LAYOUTS = new Set(['speaker-focus', 'split-screen']);
const PROVIDER_CHOICES = new Set(['auto', 'deepgram', 'whisper']);
const AUDIO_MODES = new Set(['mute', 'beep', 'off']);

/** A key long enough to be real; the `.env.example` placeholder is explicitly rejected. */
const MIN_SECRET_LENGTH = 20;
const MAX_KEY_POOL = 8;

export type SecretKind = 'gemini' | 'deepgram';

/* ------------------------------------------------------------------ *
 * Env access
 * ------------------------------------------------------------------ */

function envText(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function envNumber(name: string): number | null {
  const raw = envText(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * `GEMINI_API_KEY` may hold one key, and a comma/semicolon/newline separated list is
 * accepted too - people copy pools around as lists. Keys that look like the placeholder
 * in `.env.example` are dropped so a freshly copied env file does not fail every call.
 */
export function parseKeyList(raw: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const key = part.trim();
    if (!isUsableSecret(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function isUsableSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.toLowerCase().includes('your_api_key')) return false;
  if (/^x+$/.test(trimmed) || /^0+$/.test(trimmed)) return false;
  return true;
}

/** `AIzaSy…9f3` - enough to recognise a key, not enough to use it. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `••••${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function isMaskedPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && value.includes('…') && value.trim().length <= 24;
}

/**
 * Which `.env.local` keys are in play, without sending their values to the browser.
 * `file` says the name appears in the env file even when this process has not loaded it
 * (the worker loads it itself, and `next dev` only loads it for its own process).
 */
export function envHints(): Record<string, EnvHint> {
  const names = [
    'GEMINI_API_KEY',
    'DEEPGRAM_API_KEY',
    'DEEPGRAM_MODEL',
    'WORKER_CONCURRENCY',
    'VIRAL_CONCURRENCY',
    'REMOTION_CONCURRENCY',
    'PROFANITY_AUDIO_MODE',
    'AUTO_RENDER_CAPTION_ENGINE',
  ];

  const fileText = readEnvFileText();
  const out: Record<string, EnvHint> = {};
  for (const name of names) {
    const value = envText(name);
    out[name] = {
      name,
      present: Boolean(value),
      masked: isUsableSecret(value) ? maskSecret(value) : '',
      inEnvFile: new RegExp(`^\\s*${name}=`, 'm').test(fileText),
    };
  }
  return out;
}

let envFileCache: { path: string; text: string; mtimeMs: number } | null = null;

/** Best-effort peek at `.env.local` - a missing or unreadable file simply means "no hints". */
function readEnvFileText(): string {
  const file = path.resolve(process.cwd(), '.env.local');
  try {
    const stat = fs.statSync(file);
    if (envFileCache && envFileCache.path === file && envFileCache.mtimeMs === stat.mtimeMs) {
      return envFileCache.text;
    }
    // Never larger than a config file should be; a huge file is not worth reading.
    if (stat.size > 256 * 1024) return '';
    const text = fs.readFileSync(file, 'utf8');
    envFileCache = { path: file, text, mtimeMs: stat.mtimeMs };
    return text;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Sanitizing a PATCH from the Settings page
 * ------------------------------------------------------------------ */

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${label} must be an object of settings.`);
  }
  return value as Record<string, unknown>;
}

function badRequest(message: string, resolution?: string): AppError {
  return new AppError(message, { status: 400, ...(resolution ? { resolution } : {}) });
}

/**
 * `precision` is the field's granularity: 0 for "how many renders at once" (never a
 * fraction) and 1 for overlay durations, which are edited in half-second steps. It must
 * not be inferred from min/max - 0..30 is a duration range as much as a whole-number one.
 */
function numberIn(
  value: unknown,
  { min, max, label, precision = 0 }: { min: number; max: number; label: string; precision?: 0 | 1 }
): number {
  // `Number('')` is 0, so an empty field has to be rejected here rather than silently
  // turning into "zero renders at a time".
  const text = typeof value === 'number' ? null : String(value ?? '').trim();
  if (text === '') throw badRequest(`${label} must be a number.`, 'Empty is only allowed where the field says so.');
  const numeric = typeof value === 'number' ? value : Number(text);
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw badRequest(`${label} must be a number.`);
  }
  const factor = precision === 1 ? 10 : 1;
  const step = Math.round(numeric * factor) / factor;
  if (step < min || step > max) {
    throw badRequest(`${label} must be between ${min} and ${max}.`, `Use a value from ${min} to ${max}.`);
  }
  return step;
}

function textOf(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw badRequest(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${label} is longer than ${max} characters.`);
  return trimmed;
}

function idOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = textOf(value, 80, label);
  // "  " means the same thing as "": use whatever the preset table marks as default.
  if (!text) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw badRequest(`${label} contains unsupported characters.`);
  }
  return text;
}

function enumOf<T extends string>(value: unknown, allowed: Set<string>, label: string): T {
  const text = textOf(value, 40, label);
  if (!allowed.has(text)) {
    throw badRequest(`Unknown ${label} "${text}".`, `Choose one of: ${[...allowed].join(', ')}.`);
  }
  return text as T;
}

/**
 * Gemini keys arrive as a full replacement list. An entry that is still the masked form
 * the API handed out means "the key I already have" - the UI never saw the real value, so
 * it cannot send it back. Masked entries are resolved by comparing masks, which keeps the
 * mapping correct even when the pool has been reordered in the meantime.
 */
function mergeKeyPool(incoming: unknown, stored: string[]): string[] {
  if (!Array.isArray(incoming)) throw badRequest('Gemini API keys must be a list.', 'Send an array of keys (an empty list clears the pool).');
  if (incoming.length > MAX_KEY_POOL) {
    throw badRequest(`At most ${MAX_KEY_POOL} Gemini API keys can be stored.`, 'Remove a key before adding another.');
  }

  const byMask = new Map<string, string>();
  for (const key of stored) byMask.set(maskSecret(key), key);

  const merged: string[] = [];
  const seen = new Set<string>();

  for (const entry of incoming) {
    let key: string;
    if (isMaskedPlaceholder(entry)) {
      const carried = byMask.get(entry.trim());
      if (!carried) continue; // Refers to a key that is no longer stored - drop it.
      key = carried;
    } else {
      key = textOf(entry, 300, 'Gemini API key');
      if (!isUsableSecret(key)) {
        throw badRequest('That does not look like an API key.', `A Google AI Studio key is at least ${MIN_SECRET_LENGTH} characters with no spaces.`);
      }
    }
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }

  return merged;
}

export function sanitizeSettingsSection(
  section: AppSettingsSection,
  value: unknown,
  context: { storedAi?: Partial<AiProviderSettings> } = {}
): Record<string, unknown> {
  if (!APP_SETTINGS_SECTIONS.includes(section)) {
    throw badRequest(`Unknown settings section "${section}".`, `Use one of: ${APP_SETTINGS_SECTIONS.join(', ')}.`);
  }

  switch (section) {
    case 'pipeline': {
      // Deliberately routed through the same clamps the upload form uses, so the
      // two paths can never disagree about what a valid pipeline document is.
      const sanitized = sanitizePipelineOptions(value);
      return { ...sanitized };
    }

    case 'render': {
      const input = record(value, 'Render defaults');
      const out: Record<string, unknown> = {};
      if (input.captionEngine !== undefined) {
        out.captionEngine = enumOf(input.captionEngine, CAPTION_ENGINES, 'Caption engine');
      }
      if (input.layout !== undefined) out.layout = enumOf(input.layout, LAYOUTS, 'Layout');
      if (input.filterPreset !== undefined) {
        const filter = enumOf(input.filterPreset, FILTER_IDS, 'Filter preset');
        out.filterPreset = filter;
      }
      if ('captionPresetId' in input) out.captionPresetId = idOrNull(input.captionPresetId, 'Caption preset id');
      if ('hookStylePresetId' in input) out.hookStylePresetId = idOrNull(input.hookStylePresetId, 'Hook style preset id');
      if ('ctaStylePresetId' in input) out.ctaStylePresetId = idOrNull(input.ctaStylePresetId, 'CTA style preset id');
      if (input.hookDuration !== undefined) {
        out.hookDuration = numberIn(input.hookDuration, { min: 0, max: 30, precision: 1, label: 'Hook duration' });
      }
      if (input.ctaDuration !== undefined) {
        out.ctaDuration = numberIn(input.ctaDuration, { min: 0, max: 30, precision: 1, label: 'CTA duration' });
      }
      return out;
    }

    case 'ai': {
      const input = record(value, 'AI provider settings');
      const out: Record<string, unknown> = {};
      if ('geminiApiKeys' in input) {
        out.geminiApiKeys = mergeKeyPool(input.geminiApiKeys, context.storedAi?.geminiApiKeys ?? []);
      }
      if ('deepgramApiKey' in input) {
        const carried = context.storedAi?.deepgramApiKey ?? '';
        const raw = isMaskedPlaceholder(input.deepgramApiKey) ? carried : textOf(input.deepgramApiKey, 300, 'Deepgram API key');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest('That does not look like a Deepgram API key.', `Keys are at least ${MIN_SECRET_LENGTH} characters with no spaces. Leave it empty to use the env file.`);
        }
        out.deepgramApiKey = raw;
      }
      if ('deepgramModel' in input) out.deepgramModel = textOf(input.deepgramModel, 64, 'Deepgram model');
      if (input.transcriptionProvider !== undefined) {
        out.transcriptionProvider = enumOf(input.transcriptionProvider, PROVIDER_CHOICES, 'Transcription provider');
      }
      return out;
    }

    case 'worker': {
      const input = record(value, 'Worker settings');
      const out: Record<string, unknown> = {};
      if (input.clipConcurrency !== undefined) {
        out.clipConcurrency = numberIn(input.clipConcurrency, { ...CONCURRENCY_LIMITS.clip, label: 'Clip concurrency' });
      }
      if (input.viralConcurrency !== undefined) {
        out.viralConcurrency = numberIn(input.viralConcurrency, { ...CONCURRENCY_LIMITS.viral, label: 'Viral detection concurrency' });
      }
      if ('remotionConcurrency' in input) {
        out.remotionConcurrency =
          input.remotionConcurrency === null || input.remotionConcurrency === '' || input.remotionConcurrency === undefined
            ? null
            : numberIn(input.remotionConcurrency, { ...CONCURRENCY_LIMITS.remotion, label: 'Remotion concurrency' });
      }
      return out;
    }

    case 'profanity': {
      const input = record(value, 'Profanity settings');
      const out: Record<string, unknown> = {};
      if (input.audioMode !== undefined) out.audioMode = enumOf(input.audioMode, AUDIO_MODES, 'Profanity audio mode');
      return out;
    }

    default:
      throw badRequest(`Section "${section}" has no editable fields.`);
  }
}

/* ------------------------------------------------------------------ *
 * Resolution: stored -> env -> built-in default
 * ------------------------------------------------------------------ */

/**
 * Raw rows from `app_settings`. They come out of a JSON column, so nothing in here is
 * trusted to have the right type yet - every read below narrows first. A hand-edited or
 * half-written row degrades to the env/default value instead of breaking a render.
 */
export interface StoredSettingsRows {
  /** Already run through `sanitizePipelineOptions` on read, so it is a known shape. */
  pipeline?: PipelineOptions;
  render?: Partial<Record<keyof RenderDefaults, unknown>>;
  ai?: Partial<AiProviderSettings>;
  worker?: Partial<Record<keyof WorkerSettings, unknown>>;
  profanity?: Partial<Record<keyof ProfanitySettings, unknown>>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A preset id may legitimately be `null` ("use the table default"), so only `undefined` means unset. */
function idValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = stringValue(value);
  return text === undefined ? null : /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Absent means "not configured - use the default", which is NOT the same as 0. The
 * distinction matters: a hook duration of 0 disables the hook intro entirely, so an
 * unset field must never collapse into it.
 */
function clampDuration(value: unknown, fallback: number): number {
  const numeric = numberValue(value);
  if (numeric === undefined) return fallback;
  return Math.max(0, Math.min(30, Math.round(numeric * 10) / 10));
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = numberValue(value);
  if (numeric === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

/**
 * A stored `null` is the user's choice - "let the renderer decide" - so it must not fall
 * through to the env value. Anything else unset or unparseable does fall through.
 */
function resolveRemotion(stored: unknown, fromEnv: number | null): number | null {
  if (stored === null) return null;
  const value = numberValue(stored) ?? fromEnv;
  return value === null || value === undefined
    ? null
    : intInRange(value, CONCURRENCY_LIMITS.remotion.min, CONCURRENCY_LIMITS.remotion.max, 1);
}

/**
 * Pure resolution over already-read rows. Kept separate from SQLite so the priority
 * rules are unit-testable without a database (`tests/app-settings.test.ts`).
 */
export function resolveSettings(stored: StoredSettingsRows): { effective: AppSettings; sources: SettingsSources } {
  const sources: SettingsSources = {};

  /* pipeline */
  sources.pipeline = {};
  const pipeline = stored.pipeline ?? DEFAULT_PIPELINE_OPTIONS;
  for (const key of ['autoDetect', 'autoRender'] as const) {
    sources.pipeline[key] = stored.pipeline ? 'app' : 'default';
  }
  sources.pipeline.viral = stored.pipeline ? 'app' : 'default';

  /* render */
  const engineFromEnv = envText('AUTO_RENDER_CAPTION_ENGINE').toLowerCase();
  const renderStored = stored.render ?? {};
  const storedEngine = CAPTION_ENGINES.has(stringValue(renderStored.captionEngine) ?? '')
    ? stringValue(renderStored.captionEngine)
    : undefined;
  const storedLayout = LAYOUTS.has(stringValue(renderStored.layout) ?? '')
    ? stringValue(renderStored.layout)
    : undefined;
  const storedFilter = FILTER_IDS.has(stringValue(renderStored.filterPreset) ?? '')
    ? stringValue(renderStored.filterPreset)
    : undefined;
  const engine = storedEngine ?? (CAPTION_ENGINES.has(engineFromEnv) ? engineFromEnv : DEFAULT_RENDER_SETTINGS.captionEngine);

  sources.render = {
    captionEngine: storedEngine ? 'app' : CAPTION_ENGINES.has(engineFromEnv) ? 'env' : 'default',
    filterPreset: storedFilter ? 'app' : 'default',
    layout: storedLayout ? 'app' : 'default',
    captionPresetId: renderStored.captionPresetId !== undefined ? 'app' : 'default',
    hookStylePresetId: renderStored.hookStylePresetId !== undefined ? 'app' : 'default',
    ctaStylePresetId: renderStored.ctaStylePresetId !== undefined ? 'app' : 'default',
    hookDuration: numberValue(renderStored.hookDuration) !== undefined ? 'app' : 'default',
    ctaDuration: numberValue(renderStored.ctaDuration) !== undefined ? 'app' : 'default',
  };

  const render: RenderDefaults = {
    captionEngine: engine as RenderDefaults['captionEngine'],
    layout: (storedLayout ?? DEFAULT_RENDER_SETTINGS.layout) as RenderDefaults['layout'],
    filterPreset: storedFilter ?? DEFAULT_RENDER_SETTINGS.filterPreset,
    captionPresetId: idValue(renderStored.captionPresetId) ?? null,
    hookStylePresetId: idValue(renderStored.hookStylePresetId) ?? null,
    ctaStylePresetId: idValue(renderStored.ctaStylePresetId) ?? null,
    hookDuration: clampDuration(renderStored.hookDuration, DEFAULT_RENDER_SETTINGS.hookDuration),
    ctaDuration: clampDuration(renderStored.ctaDuration, DEFAULT_RENDER_SETTINGS.ctaDuration),
  };

  /* ai */
  const aiStored = stored.ai ?? {};
  const envGeminiKeys = parseKeyList(envText('GEMINI_API_KEY'));
  const storedKeys = Array.isArray(aiStored.geminiApiKeys)
    ? aiStored.geminiApiKeys.filter((key): key is string => typeof key === 'string' && isUsableSecret(key))
    : [];
  const geminiApiKeys = storedKeys.length ? storedKeys : envGeminiKeys;

  const envDeepgramKey = envText('DEEPGRAM_API_KEY');
  const storedDeepgramKey = stringValue(aiStored.deepgramApiKey) ?? '';
  const deepgramApiKey = isUsableSecret(storedDeepgramKey) ? storedDeepgramKey : isUsableSecret(envDeepgramKey) ? envDeepgramKey : '';

  const envDeepgramModel = envText('DEEPGRAM_MODEL');
  const storedDeepgramModel = stringValue(aiStored.deepgramModel) ?? '';
  const deepgramModel = storedDeepgramModel || envDeepgramModel || 'nova-2';

  const storedChoice = PROVIDER_CHOICES.has(stringValue(aiStored.transcriptionProvider) ?? '')
    ? (stringValue(aiStored.transcriptionProvider) as AiProviderSettings['transcriptionProvider'])
    : DEFAULT_AI_SETTINGS.transcriptionProvider;

  sources.ai = {
    geminiApiKeys: storedKeys.length ? 'app' : envGeminiKeys.length ? 'env' : 'default',
    deepgramApiKey: isUsableSecret(storedDeepgramKey) ? 'app' : isUsableSecret(envDeepgramKey) ? 'env' : 'default',
    deepgramModel: storedDeepgramModel ? 'app' : envDeepgramModel ? 'env' : 'default',
    transcriptionProvider: stringValue(aiStored.transcriptionProvider) ? 'app' : 'default',
  };

  const ai: AiProviderSettings = { geminiApiKeys, deepgramApiKey, deepgramModel, transcriptionProvider: storedChoice };

  /* worker */
  const workerStored = stored.worker ?? {};
  const envClip = envNumber('WORKER_CONCURRENCY');
  const envViral = envNumber('VIRAL_CONCURRENCY');
  const envRemotion = envNumber('REMOTION_CONCURRENCY');

  sources.worker = {
    clipConcurrency: numberValue(workerStored.clipConcurrency) !== undefined ? 'app' : envClip ? 'env' : 'default',
    viralConcurrency: numberValue(workerStored.viralConcurrency) !== undefined ? 'app' : envViral ? 'env' : 'default',
    // An explicit `null` is a choice ("let the renderer decide"), so it counts as stored.
    remotionConcurrency:
      workerStored.remotionConcurrency !== undefined ? 'app' : envRemotion ? 'env' : 'default',
  };

  // The limits apply to whatever the value came from - a hand-written
  // `VIRAL_CONCURRENCY=500` in .env.local must not spawn five hundred loops.
  const worker: WorkerSettings = {
    clipConcurrency: intInRange(
      numberValue(workerStored.clipConcurrency) ?? envClip ?? 1,
      CONCURRENCY_LIMITS.clip.min,
      CONCURRENCY_LIMITS.clip.max,
      1
    ),
    viralConcurrency: intInRange(
      numberValue(workerStored.viralConcurrency) ?? envViral ?? 1,
      CONCURRENCY_LIMITS.viral.min,
      CONCURRENCY_LIMITS.viral.max,
      1
    ),
    remotionConcurrency: resolveRemotion(workerStored.remotionConcurrency, envRemotion),
  };

  /* profanity */
  const profanityStored = stored.profanity ?? {};
  const storedMode = AUDIO_MODES.has(stringValue(profanityStored.audioMode)?.toLowerCase() ?? '')
    ? stringValue(profanityStored.audioMode)!.toLowerCase()
    : undefined;
  const envMode = envText('PROFANITY_AUDIO_MODE').toLowerCase();
  const audioMode = storedMode ?? (AUDIO_MODES.has(envMode) ? envMode : DEFAULT_PROFANITY_SETTINGS.audioMode);
  sources.profanity = { audioMode: storedMode ? 'app' : AUDIO_MODES.has(envMode) ? 'env' : 'default' };

  const effective: AppSettings = {
    pipeline: {
      ...pipeline,
      viral: { ...DEFAULT_PIPELINE_OPTIONS.viral, ...(pipeline.viral ?? {}) },
    },
    render,
    ai,
    worker,
    profanity: { audioMode: audioMode as ProfanitySettings['audioMode'] },
  };

  return { effective, sources };
}

/* ------------------------------------------------------------------ *
 * Reading / writing the stored rows
 * ------------------------------------------------------------------ */

interface SettingsStore {
  read(): Array<{ key: AppSettingsSection; value: unknown }>;
  write(section: AppSettingsSection, value: Record<string, unknown> | null): string;
}

let storeOverride: SettingsStore | null = null;

/** A row that is not an object behaves like an empty section. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Tests inject an in-memory store instead of opening SQLite. */
export function setSettingsStoreForTests(store: SettingsStore | null): void {
  storeOverride = store;
}

async function defaultStore(): Promise<SettingsStore> {
  const db = await import('./db');
  return {
    read: () => db.readAppSettingsSections().map((row) => ({ key: row.key, value: row.value })),
    write: (section, value) => db.saveAppSettingsSection(section, value),
  };
}

async function readStoredSections(): Promise<StoredSettingsRows> {
  const store = storeOverride ?? (await defaultStore());
  const stored: StoredSettingsRows = {};
  for (const row of store.read()) {
    if (row.key === 'pipeline') stored.pipeline = sanitizePipelineOptions(row.value);
    else if (row.key === 'render') stored.render = asRecord(row.value);
    else if (row.key === 'ai') stored.ai = (row.value as Partial<AiProviderSettings>) ?? {};
    else if (row.key === 'worker') stored.worker = asRecord(row.value);
    else if (row.key === 'profanity') stored.profanity = asRecord(row.value);
  }
  return stored;
}

/** Effective settings for server code (worker + routes). Cheap: one tiny query. */
export async function loadEffectiveSettings(): Promise<AppSettings> {
  return resolveSettings(await readStoredSections()).effective;
}

/** The full payload `GET /api/settings` returns (secrets masked). */
export async function buildAppSettingsSnapshot(): Promise<AppSettingsSnapshot> {
  const stored = await readStoredSections();
  const { effective, sources } = resolveSettings(stored);

  const storedOut: Partial<Record<AppSettingsSection, unknown>> = {};
  if (stored.pipeline) storedOut.pipeline = stored.pipeline;
  if (stored.render) storedOut.render = stored.render;
  if (stored.worker) storedOut.worker = stored.worker;
  if (stored.profanity) storedOut.profanity = stored.profanity;
  if (stored.ai) {
    storedOut.ai = {
      ...stored.ai,
      geminiApiKeys: (stored.ai.geminiApiKeys ?? []).map(maskSecret),
      deepgramApiKey: maskSecret(stored.ai.deepgramApiKey ?? ''),
    };
  }

  return {
    stored: storedOut,
    effective,
    sources,
    configured: APP_SETTINGS_SECTIONS.filter((section) => Object.prototype.hasOwnProperty.call(stored, section)),
    // Only a *stored* override can be pending; a value that still comes from env was
    // already read at worker start, so saying "restart" there would be noise.
    restartRequired: RESTART_REQUIRED_PATHS.filter((path) => {
      const [section, key] = path.split('.') as [AppSettingsSection, string];
      return sources[section]?.[key] === 'app';
    }),
    env: envHints(),
    limits: LIMITS,
  };
}

const LIMITS: SettingsLimits = {
  clipCount: OPTION_LIMITS.clipCount,
  minClipDuration: OPTION_LIMITS.minClipDuration,
  concurrency: CONCURRENCY_LIMITS,
  overlayDuration: { min: 0, max: 30 },
  maxKeyPool: MAX_KEY_POOL,
  filterPresets: DEFAULT_FILTER_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description })),
  engines: ['remotion', 'native'] as const,
  layouts: ['speaker-focus', 'split-screen'] as const,
  audioModes: ['mute', 'beep', 'off'] as const,
  transcriptionProviders: ['auto', 'deepgram', 'whisper'] as const,
};

/**
 * Save one section. A form that edits two of its five fields must not wipe the other
 * three, so the submitted fields are merged over the stored row; an explicit `null`
 * still clears a field (that is how "use the database default" is selected), and
 * `validate` runs on the merged result *before* anything is written.
 */
export async function saveSettingsSection(
  section: AppSettingsSection,
  value: unknown,
  options: { validate?: (merged: Record<string, unknown>) => Promise<void> | void } = {}
): Promise<{ updatedAt: string; saved: Record<string, unknown> }> {
  const store = storeOverride ?? (await defaultStore());
  const previous = await readStoredSections();
  // `storedAi` lets a masked placeholder in the submitted key pool mean "keep the key
  // I already have" - the UI never sees the real value, so it cannot send it back.
  const sanitized = sanitizeSettingsSection(section, value, {
    storedAi: previous.ai ? { ...DEFAULT_AI_SETTINGS, ...previous.ai } : undefined,
  });

  const previousRow = (previous as unknown as Record<string, unknown>)[section];
  const merged =
    previousRow && typeof previousRow === 'object' && !Array.isArray(previousRow)
      ? { ...(previousRow as Record<string, unknown>), ...sanitized }
      : sanitized;

  await options.validate?.(merged);

  const updatedAt = store.write(section, merged);
  return { updatedAt, saved: merged };
}

export async function clearSettingsSection(section: AppSettingsSection): Promise<string> {
  const store = storeOverride ?? (await defaultStore());
  return store.write(section, null);
}

/* ------------------------------------------------------------------ *
 * Accessors used by the rest of the server
 * ------------------------------------------------------------------ */

/**
 * Ordered Gemini keys: the stored pool when there is one, otherwise
 * `GEMINI_API_KEY`. `index` walks the pool when the caller wants to rotate on a 429.
 */
export async function resolveGeminiApiKeys(): Promise<string[]> {
  const settings = await loadEffectiveSettings();
  return settings.ai.geminiApiKeys;
}

/** The single key a chain entry should use - `null` means "not configured". */
export async function resolveLlmApiKey(envName: string): Promise<string | null> {
  if (envName.toUpperCase() !== 'GEMINI_API_KEY') {
    const value = envText(envName);
    return isUsableSecret(value) ? value : null;
  }
  const keys = await resolveGeminiApiKeys();
  return keys[0] ?? null;
}

export async function resolveDeepgram(): Promise<{ apiKey: string; model: string }> {
  const settings = await loadEffectiveSettings();
  return { apiKey: settings.ai.deepgramApiKey, model: settings.ai.deepgramModel || 'nova-2' };
}

export async function resolveTranscriptionProviderChoice(): Promise<'auto' | 'deepgram' | 'whisper'> {
  const settings = await loadEffectiveSettings();
  return settings.ai.transcriptionProvider;
}

export async function resolveProfanityAudioMode(): Promise<ProfanitySettings['audioMode']> {
  const settings = await loadEffectiveSettings();
  return settings.profanity.audioMode;
}

/** Sync, safe by default - used by the worker before each job so edits apply without a restart. */
export async function resolveWorkerSettings(): Promise<WorkerSettings> {
  const settings = await loadEffectiveSettings();
  return settings.worker;
}

export { DEFAULT_RENDER_SETTINGS, OPTION_LIMITS };
