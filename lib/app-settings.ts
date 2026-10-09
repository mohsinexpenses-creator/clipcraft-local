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
  DEFAULT_WORKER_SETTINGS,
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
 * The Settings page's backing store, and the only place these five sections are read.
 *
 * Precedence is deliberately short: **a value saved on /settings, otherwise the
 * built-in default**. `.env.local` is NOT a fallback for a settings value - a key or a
 * knob that only exists in the env file is simply not configured as far as the app is
 * concerned, so what the page shows is exactly what the app does. Everything else in
 * `.env.local` (paths, model files, CRF, upload limits, timeouts) is untouched and
 * still read where it always was.
 *
 * `.env.local` is still *parsed*, for two narrow purposes: the page lists what the env
 * file holds so nothing looks lost (`envHints`), and `envAiKeysForImport` lets the user
 * copy an already-working key setup into Settings once, with their consent. Neither
 * reads env at the moment a value is used.
 *
 * Secrets (Gemini / Deepgram keys) live here for the same reason they lived in
 * `.env.local`: this is a single-user machine, and the SQLite file is git-ignored like
 * the env file is. The API never returns one in full - `maskSecret` is the only view of
 * it - which is why saving a section that contains a masked placeholder means "keep the
 * key that is already stored".
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
 * Which `.env.local` names still hold a value that Settings now owns. This is a
 * migration courtesy and nothing else: the values are shown masked so the user can
 * recognise which key is sitting unused, and the page tells them it is NOT read.
 * `inEnvFile` is true when the name appears in the file even if this process has not
 * loaded it (the worker loads it itself, `next dev` only loads it for its own process).
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
 * A stored `null` is the user's own decision - "let the renderer decide, based on the
 * CPU" - so it must not fall through to anything else. A value that is set is clamped to
 * the same limits the UI offers, because a row can also be written by hand.
 */
function resolveRemotion(stored: unknown): number | null {
  if (stored === null) return null;
  const value = numberValue(stored);
  return value === undefined
    ? null
    : intInRange(value, CONCURRENCY_LIMITS.remotion.min, CONCURRENCY_LIMITS.remotion.max, 1);
}

/**
 * Pure resolution over already-read rows: stored value, else built-in default.
 *
 * There is no env tier here on purpose. `.env.local` is where the *other* knobs live
 * (binaries, models, CRF, upload limits) and a user who moves a value into Settings must
 * then see one answer, not two - the page is the contract. Keeping this function free of
 * `process.env` (and of SQLite) is also what makes the precedence rules unit-testable.
 */
export function resolveSettings(stored: StoredSettingsRows): { effective: AppSettings; sources: SettingsSources } {
  const sources: SettingsSources = {};

  /* pipeline - `stored.pipeline` is already a sanitized `PipelineOptions` */
  const pipeline = stored.pipeline ?? DEFAULT_PIPELINE_OPTIONS;
  sources.pipeline = {
    autoDetect: stored.pipeline?.autoDetect !== undefined ? 'app' : 'default',
    autoRender: stored.pipeline?.autoRender !== undefined ? 'app' : 'default',
    viral: stored.pipeline?.viral ? 'app' : 'default',
  };

  /* render */
  const renderStored = stored.render ?? {};
  const engine = CAPTION_ENGINES.has(stringValue(renderStored.captionEngine) ?? '')
    ? (stringValue(renderStored.captionEngine) as RenderDefaults['captionEngine'])
    : DEFAULT_RENDER_SETTINGS.captionEngine;
  const layout = LAYOUTS.has(stringValue(renderStored.layout) ?? '')
    ? (stringValue(renderStored.layout) as RenderDefaults['layout'])
    : DEFAULT_RENDER_SETTINGS.layout;
  const filterPreset = FILTER_IDS.has(stringValue(renderStored.filterPreset) ?? '')
    ? (stringValue(renderStored.filterPreset) as RenderDefaults['filterPreset'])
    : DEFAULT_RENDER_SETTINGS.filterPreset;

  sources.render = {
    captionEngine: engine !== DEFAULT_RENDER_SETTINGS.captionEngine || stringValue(renderStored.captionEngine) ? 'app' : 'default',
    layout: stringValue(renderStored.layout) ? 'app' : 'default',
    filterPreset: stringValue(renderStored.filterPreset) ? 'app' : 'default',
    captionPresetId: renderStored.captionPresetId !== undefined ? 'app' : 'default',
    hookStylePresetId: renderStored.hookStylePresetId !== undefined ? 'app' : 'default',
    ctaStylePresetId: renderStored.ctaStylePresetId !== undefined ? 'app' : 'default',
    hookDuration: numberValue(renderStored.hookDuration) !== undefined ? 'app' : 'default',
    ctaDuration: numberValue(renderStored.ctaDuration) !== undefined ? 'app' : 'default',
  };

  const render: RenderDefaults = {
    captionEngine: engine,
    layout,
    filterPreset,
    captionPresetId: idValue(renderStored.captionPresetId) ?? null,
    hookStylePresetId: idValue(renderStored.hookStylePresetId) ?? null,
    ctaStylePresetId: idValue(renderStored.ctaStylePresetId) ?? null,
    hookDuration: clampDuration(renderStored.hookDuration, DEFAULT_RENDER_SETTINGS.hookDuration),
    ctaDuration: clampDuration(renderStored.ctaDuration, DEFAULT_RENDER_SETTINGS.ctaDuration),
  };

  /* ai - keys exist only if they were put here, never inherited from the env file */
  const aiStored = stored.ai ?? {};
  const geminiApiKeys = Array.isArray(aiStored.geminiApiKeys)
    ? aiStored.geminiApiKeys.filter((key): key is string => typeof key === 'string' && isUsableSecret(key))
    : [];
  const deepgramKey = stringValue(aiStored.deepgramApiKey) ?? '';
  const deepgramApiKey = isUsableSecret(deepgramKey) ? deepgramKey : '';
  const deepgramModel = stringValue(aiStored.deepgramModel) ?? '';
  const transcriptionProvider = PROVIDER_CHOICES.has(stringValue(aiStored.transcriptionProvider) ?? '')
    ? (stringValue(aiStored.transcriptionProvider) as AiProviderSettings['transcriptionProvider'])
    : DEFAULT_AI_SETTINGS.transcriptionProvider;

  sources.ai = {
    geminiApiKeys: geminiApiKeys.length ? 'app' : 'default',
    deepgramApiKey: deepgramApiKey ? 'app' : 'default',
    deepgramModel: deepgramModel ? 'app' : 'default',
    transcriptionProvider: stringValue(aiStored.transcriptionProvider) ? 'app' : 'default',
  };

  const ai: AiProviderSettings = {
    geminiApiKeys,
    deepgramApiKey,
    deepgramModel: deepgramModel || 'nova-2',
    transcriptionProvider,
  };

  /* worker */
  const workerStored = stored.worker ?? {};
  sources.worker = {
    clipConcurrency: numberValue(workerStored.clipConcurrency) !== undefined ? 'app' : 'default',
    viralConcurrency: numberValue(workerStored.viralConcurrency) !== undefined ? 'app' : 'default',
    // An explicit `null` is a choice ("let the renderer decide"), so it counts as stored.
    remotionConcurrency: workerStored.remotionConcurrency !== undefined ? 'app' : 'default',
  };

  const worker: WorkerSettings = {
    clipConcurrency: intInRange(
      numberValue(workerStored.clipConcurrency) ?? DEFAULT_WORKER_SETTINGS.clipConcurrency,
      CONCURRENCY_LIMITS.clip.min,
      CONCURRENCY_LIMITS.clip.max,
      1
    ),
    viralConcurrency: intInRange(
      numberValue(workerStored.viralConcurrency) ?? DEFAULT_WORKER_SETTINGS.viralConcurrency,
      CONCURRENCY_LIMITS.viral.min,
      CONCURRENCY_LIMITS.viral.max,
      1
    ),
    remotionConcurrency: resolveRemotion(workerStored.remotionConcurrency),
  };

  /* profanity */
  const profanityStored = stored.profanity ?? {};
  const storedMode = stringValue(profanityStored.audioMode)?.toLowerCase() ?? '';
  const audioMode = AUDIO_MODES.has(storedMode)
    ? (storedMode as ProfanitySettings['audioMode'])
    : DEFAULT_PROFANITY_SETTINGS.audioMode;
  sources.profanity = { audioMode: AUDIO_MODES.has(storedMode) ? 'app' : 'default' };

  const effective: AppSettings = {
    pipeline: {
      ...pipeline,
      viral: { ...DEFAULT_PIPELINE_OPTIONS.viral, ...(pipeline.viral ?? {}) },
    },
    render,
    ai,
    worker,
    profanity: { audioMode },
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
 * The keys `.env.local` holds, formatted as a stored `ai` section - for the ONE case
 * where env is read on purpose: the user clicking "Copy from .env.local" on the Settings
 * page. It is not a fallback; nothing calls it while resolving a value, and it never
 * returns a key to the browser (the result goes straight into the table).
 *
 * `null` means there is nothing to copy, which is what hides the button.
 */
export async function envAiSectionForImport(): Promise<Record<string, unknown> | null> {
  const geminiApiKeys = parseKeyList(envText('GEMINI_API_KEY'));
  const deepgramRaw = envText('DEEPGRAM_API_KEY');
  const deepgramApiKey = isUsableSecret(deepgramRaw) ? deepgramRaw : '';
  const deepgramModel = envText('DEEPGRAM_MODEL');

  if (!geminiApiKeys.length && !deepgramApiKey && !deepgramModel) return null;

  const value: Record<string, unknown> = {
    geminiApiKeys,
    deepgramApiKey,
    transcriptionProvider: DEFAULT_AI_SETTINGS.transcriptionProvider,
  };
  if (deepgramModel) value.deepgramModel = deepgramModel;
  return value;
}

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
 * The ordered Gemini key pool, exactly as saved on /settings. `index` lets a caller
 * rotate to the next key on a 429 without re-reading the table.
 */
export async function resolveGeminiApiKeys(): Promise<string[]> {
  const settings = await loadEffectiveSettings();
  return settings.ai.geminiApiKeys;
}

/**
 * The key a chain entry should start with - `null` means "not configured, do not try".
 * Every slot is a Google AI Studio model reading the same Settings-managed pool, so the
 * env name on the entry no longer selects anything; the argument stays because callers
 * log it when the pool is empty.
 */
export async function resolveLlmApiKey(envName?: string): Promise<string | null> {
  void envName;
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

/** Used by the worker before each job so a per-job value applies without a restart. */
export async function resolveWorkerSettings(): Promise<WorkerSettings> {
  const settings = await loadEffectiveSettings();
  return settings.worker;
}

export { DEFAULT_RENDER_SETTINGS, OPTION_LIMITS };
