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
  DEFAULT_PATH_SETTINGS,
  DEFAULT_PIPELINE_OPTIONS,
  DEFAULT_PROFANITY_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  DEFAULT_WORKER_SETTINGS,
  PathSettings,
  PipelineOptions,
  EnvHint,
  ProfanitySettings,
  RenderDefaults,
  SettingsLimits,
  SettingsSources,
  VISUAL_OVERLAY_ANIMATIONS,
  VISUAL_PROVIDERS,
  VisualOverlayAnimation,
  VisualProviderName,
  VisualProviderToggles,
  WorkerSettings,
} from './types';
import { OPTION_LIMITS, sanitizePipelineOptions } from './pipeline-defaults';
import { DEFAULT_FILTER_PRESETS } from './presets';
import { AppError } from './errors';
import { readAppSettingsSections, saveAppSettingsSection } from './db';

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
const LAYOUTS = new Set(['speaker-focus', 'split-screen']);
const PROVIDER_CHOICES = new Set(['auto', 'deepgram', 'whisper']);
const AUDIO_MODES = new Set(['mute', 'beep', 'off']);
const VISUAL_ANIMATIONS = new Set<string>(VISUAL_OVERLAY_ANIMATIONS);
const VISUAL_PROVIDER_SET = new Set<string>(VISUAL_PROVIDERS);

/** A key long enough to be real; the `.env.example` placeholder is explicitly rejected. */
const MIN_SECRET_LENGTH = 20;
const MAX_KEY_POOL = 8;

export type SecretKind = 'gemini' | 'deepgram' | 'pexels' | 'openverse';

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
 * An `ai` section as it may leave the server: the keys replaced by their mask.
 *
 * `saveSettingsSection` hands back the merged section it just wrote, and for `ai` that
 * object contains the real keys, so every route that echoes it has to pass it through
 * here. Masking is a function rather than a per-route habit because a route that forgets
 * one field is a secret in a JSON response, not a bug anyone notices.
 */
export function maskAiSecrets(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  if (Array.isArray(out.geminiApiKeys)) {
    out.geminiApiKeys = (out.geminiApiKeys as unknown[]).map((key) => maskSecret(String(key)));
  }
  if (typeof out.deepgramApiKey === 'string') out.deepgramApiKey = maskSecret(out.deepgramApiKey);
  if (typeof out.pexelsApiKey === 'string') out.pexelsApiKey = maskSecret(out.pexelsApiKey);
  if (typeof out.pixabayApiKey === 'string') out.pixabayApiKey = maskSecret(out.pixabayApiKey);
  if (typeof out.unsplashAccessKey === 'string') out.unsplashAccessKey = maskSecret(out.unsplashAccessKey);
  if (typeof out.openverseClientId === 'string') out.openverseClientId = maskSecret(out.openverseClientId);
  if (typeof out.openverseClientSecret === 'string') out.openverseClientSecret = maskSecret(out.openverseClientSecret);
  return out;
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
    'PEXELS_API_KEY',
    'OPENVERSE_CLIENT_ID',
    'OPENVERSE_CLIENT_SECRET',
    'WIKIMEDIA_USER_AGENT',
    'WORKER_CONCURRENCY',
    'VIRAL_CONCURRENCY',
    'REMOTION_CONCURRENCY',
    'PROFANITY_AUDIO_MODE',
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
  { min, max, label, precision = 0 }: { min: number; max: number; label: string; precision?: 0 | 1 | 2 }
): number {
  // `Number('')` is 0, so an empty field has to be rejected here rather than silently
  // turning into "zero renders at a time".
  const text = typeof value === 'number' ? null : String(value ?? '').trim();
  if (text === '') throw badRequest(`${label} must be a number.`, 'Empty is only allowed where the field says so.');
  const numeric = typeof value === 'number' ? value : Number(text);
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw badRequest(`${label} must be a number.`);
  }
  const factor = precision === 2 ? 100 : precision === 1 ? 10 : 1;
  const step = Math.round(numeric * factor) / factor;
  if (step < min || step > max) {
    throw badRequest(`${label} must be between ${min} and ${max}.`, `Use a value from ${min} to ${max}.`);
  }
  return step;
}

function boolOf(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${label} must be true or false.`);
}

function sanitizeVisualProviders(value: unknown): VisualProviderToggles {
  const input = record(value, 'Visual providers');
  return {
    pexels: input.pexels === undefined ? DEFAULT_RENDER_SETTINGS.visualProviders.pexels : boolOf(input.pexels, 'Pexels toggle'),
    pixabay:
      input.pixabay === undefined
        ? (DEFAULT_RENDER_SETTINGS.visualProviders.pixabay ?? true)
        : boolOf(input.pixabay, 'Pixabay toggle'),
    unsplash:
      input.unsplash === undefined
        ? (DEFAULT_RENDER_SETTINGS.visualProviders.unsplash ?? true)
        : boolOf(input.unsplash, 'Unsplash toggle'),
    openverse:
      input.openverse === undefined
        ? DEFAULT_RENDER_SETTINGS.visualProviders.openverse
        : boolOf(input.openverse, 'Openverse toggle'),
    wikimedia:
      input.wikimedia === undefined
        ? DEFAULT_RENDER_SETTINGS.visualProviders.wikimedia
        : boolOf(input.wikimedia, 'Wikimedia toggle'),
  };
}

function sanitizeVisualProviderPriority(value: unknown): VisualProviderName[] {
  if (!Array.isArray(value)) {
    throw badRequest('Visual provider priority must be a list.');
  }
  const seen = new Set<VisualProviderName>();
  const ordered: VisualProviderName[] = [];
  for (const item of value) {
    const provider = enumOf<VisualProviderName>(item, VISUAL_PROVIDER_SET, 'Visual provider');
    if (!seen.has(provider)) {
      seen.add(provider);
      ordered.push(provider);
    }
  }
  for (const fallback of VISUAL_PROVIDERS) {
    if (!seen.has(fallback)) ordered.push(fallback);
  }
  return ordered;
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
      if (input.autoVisuals !== undefined) {
        out.autoVisuals = boolOf(input.autoVisuals, 'Auto contextual visuals');
      }
      if (input.maxVisualMoments !== undefined) {
        out.maxVisualMoments = numberIn(input.maxVisualMoments, {
          ...OPTION_LIMITS.maxVisualMoments,
          precision: 0,
          label: 'Max visual moments',
        });
      }
      if (input.visualConfidenceThreshold !== undefined) {
        out.visualConfidenceThreshold = numberIn(input.visualConfidenceThreshold, {
          ...OPTION_LIMITS.visualConfidence,
          precision: 2,
          label: 'Visual confidence threshold',
        });
      }
      if (input.visualMinDuration !== undefined) {
        out.visualMinDuration = numberIn(input.visualMinDuration, {
          ...OPTION_LIMITS.visualDuration,
          precision: 1,
          label: 'Minimum visual duration',
        });
      }
      if (input.visualDefaultDuration !== undefined) {
        out.visualDefaultDuration = numberIn(input.visualDefaultDuration, {
          ...OPTION_LIMITS.visualDuration,
          precision: 1,
          label: 'Default visual duration',
        });
      }
      if (input.visualAnimation !== undefined) {
        out.visualAnimation = enumOf<VisualOverlayAnimation>(
          input.visualAnimation,
          VISUAL_ANIMATIONS,
          'Visual animation'
        );
      }
      if (input.visualProviders !== undefined) {
        out.visualProviders = sanitizeVisualProviders(input.visualProviders);
      }
      if (input.visualProviderPriority !== undefined) {
        out.visualProviderPriority = sanitizeVisualProviderPriority(input.visualProviderPriority);
      }
      if (input.visualShowOnVideoCredit !== undefined) {
        out.visualShowOnVideoCredit = boolOf(input.visualShowOnVideoCredit, 'On-video visual credit');
      }
      if (input.visualCardAspect !== undefined) {
        const aspect = stringValue(input.visualCardAspect);
        if (aspect !== 'portrait' && aspect !== 'square') {
          throw badRequest('Invalid visual card aspect ratio.', 'Choose portrait (4:5) or square (1:1).');
        }
        out.visualCardAspect = aspect;
      }
      if (input.visualCardBorder !== undefined) {
        out.visualCardBorder = boolOf(input.visualCardBorder, 'Visual card border');
      }
      if (input.visualVisionScoreThreshold !== undefined) {
        out.visualVisionScoreThreshold = numberIn(input.visualVisionScoreThreshold, { min: 0, max: 10, precision: 0, label: "Vision relevance threshold" });
      }
      if (input.visualRelevanceStrictness !== undefined) {
        if (input.visualRelevanceStrictness !== 'strict' && input.visualRelevanceStrictness !== 'lenient') throw new Error('Invalid relevance strictness');
        out.visualRelevanceStrictness = input.visualRelevanceStrictness;
      }
      if (input.visualizableScoreThreshold !== undefined) {
        out.visualizableScoreThreshold = numberIn(input.visualizableScoreThreshold, { min: 0, max: 10, precision: 0, label: "Visualizable score threshold" });
      }
      if (input.visualVisionVerify !== undefined) {
        out.visualVisionVerify = boolOf(input.visualVisionVerify, 'Gemini vision relevance check');
      }
      if (input.sfxEnabled !== undefined) {
        out.sfxEnabled = boolOf(input.sfxEnabled, 'Sound effects enabled');
      }
      if (input.sfxVolume !== undefined) {
        out.sfxVolume = numberIn(input.sfxVolume, {
          ...OPTION_LIMITS.sfxVolume,
          precision: 1,
          label: 'SFX volume (dB)',
        });
      }
      return out;
    }

    case 'ai': {
      const input = record(value, 'AI provider settings');
      const out: Record<string, unknown> = {};
      if (input.geminiRequestsPerMinute !== undefined) {
        out.geminiRequestsPerMinute = numberIn(input.geminiRequestsPerMinute, { min: 1, max: 1000, precision: 0, label: 'Gemini requests per minute per key' });
      }
      if ('geminiApiKeys' in input) {
        out.geminiApiKeys = mergeKeyPool(input.geminiApiKeys, context.storedAi?.geminiApiKeys ?? []);
      }
      if ('deepgramApiKey' in input) {
        const carried = context.storedAi?.deepgramApiKey ?? '';
        const raw = isMaskedPlaceholder(input.deepgramApiKey) ? carried : textOf(input.deepgramApiKey, 300, 'Deepgram API key');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest('That does not look like a Deepgram API key.', `Keys are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove the stored key.`);
        }
        out.deepgramApiKey = raw;
      }
      if ('deepgramModel' in input) out.deepgramModel = textOf(input.deepgramModel, 64, 'Deepgram model');
      if (input.transcriptionProvider !== undefined) {
        out.transcriptionProvider = enumOf(input.transcriptionProvider, PROVIDER_CHOICES, 'Transcription provider');
      }
      if ('pexelsApiKey' in input) {
        const carried = context.storedAi?.pexelsApiKey ?? '';
        const raw = isMaskedPlaceholder(input.pexelsApiKey) ? carried : textOf(input.pexelsApiKey, 300, 'Pexels API key');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest(
            'That does not look like a Pexels API key.',
            `Keys are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove the stored key.`
          );
        }
        out.pexelsApiKey = raw;
      }
      if ('pixabayApiKey' in input) {
        const carried = context.storedAi?.pixabayApiKey ?? '';
        const raw = isMaskedPlaceholder(input.pixabayApiKey) ? carried : textOf(input.pixabayApiKey, 300, 'Pixabay API key');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest(
            'That does not look like a Pixabay API key.',
            `Keys are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove the stored key.`
          );
        }
        out.pixabayApiKey = raw;
      }
      if ('unsplashAccessKey' in input) {
        const carried = context.storedAi?.unsplashAccessKey ?? '';
        const raw = isMaskedPlaceholder(input.unsplashAccessKey)
          ? carried
          : textOf(input.unsplashAccessKey, 300, 'Unsplash Access Key');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest(
            'That does not look like an Unsplash Access Key.',
            `Keys are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove the stored key.`
          );
        }
        out.unsplashAccessKey = raw;
      }
      if ('openverseClientId' in input) {
        const carried = context.storedAi?.openverseClientId ?? '';
        const raw = isMaskedPlaceholder(input.openverseClientId)
          ? carried
          : textOf(input.openverseClientId, 300, 'Openverse client id');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest(
            'That does not look like an Openverse client id.',
            `Credentials are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove.`
          );
        }
        out.openverseClientId = raw;
      }
      if ('openverseClientSecret' in input) {
        const carried = context.storedAi?.openverseClientSecret ?? '';
        const raw = isMaskedPlaceholder(input.openverseClientSecret)
          ? carried
          : textOf(input.openverseClientSecret, 300, 'Openverse client secret');
        if (raw && !isUsableSecret(raw)) {
          throw badRequest(
            'That does not look like an Openverse client secret.',
            `Credentials are at least ${MIN_SECRET_LENGTH} characters with no spaces. Submit an empty value to remove.`
          );
        }
        out.openverseClientSecret = raw;
      }
      if ('wikimediaUserAgent' in input) {
        const raw = textOf(input.wikimediaUserAgent, 250, 'Wikimedia User-Agent');
        if (/[\u0000-\u001f]/.test(raw)) {
          throw badRequest('Wikimedia User-Agent contains control characters.');
        }
        out.wikimediaUserAgent = raw;
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
      if (input.strictVideoOrder !== undefined) {
        out.strictVideoOrder = boolOf(input.strictVideoOrder, 'Strict video order');
      }
      return out;
    }

    case 'profanity': {
      const input = record(value, 'Profanity settings');
      const out: Record<string, unknown> = {};
      if (input.audioMode !== undefined) out.audioMode = enumOf(input.audioMode, AUDIO_MODES, 'Profanity audio mode');
      return out;
    }

    case 'paths': {
      const input = record(value, 'Paths & binaries');
      const out: Record<string, unknown> = {};
      for (const field of ['uploadDir', 'clipsDir', 'ffmpegPath', 'whisperCliPath'] as const) {
        if (!(field in input)) continue;
        out[field] = pathString(input[field], PATH_FIELD_LABELS[field]);
      }
      return out;
    }

    default:
      throw badRequest(`Section "${section}" has no editable fields.`);
  }
}

const PATH_FIELD_LABELS: Record<keyof PathSettings, string> = {
  uploadDir: 'Upload directory',
  clipsDir: 'Generated clips directory',
  ffmpegPath: 'FFmpeg path',
  whisperCliPath: 'Whisper CLI path',
};

/**
 * A filesystem path entered on the Settings page. Empty means "back to the
 * automatic value"; anything else is used as-is (Windows drive letters and
 * backslashes are legal content, so no character allow-list - only control
 * characters and absurd lengths are rejected).
 */
function pathString(value: unknown, label: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw badRequest(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 500) throw badRequest(`${label} is longer than 500 characters.`);
  if (/[\u0000-\u001f]/.test(trimmed)) throw badRequest(`${label} contains control characters.`);
  return trimmed;
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
  paths?: Partial<Record<keyof PathSettings, unknown>>;
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

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function clampFloatInRange(value: unknown, min: number, max: number, fallback: number, precision: 1 | 2): number {
  const numeric = numberValue(value);
  if (numeric === undefined) return fallback;
  const factor = precision === 2 ? 100 : 10;
  return Math.max(min, Math.min(max, Math.round(numeric * factor) / factor));
}

function resolveVisualProvidersStored(value: unknown): VisualProviderToggles {
  const raw = asRecord(value);
  return {
    pexels: boolValue(raw.pexels) ?? DEFAULT_RENDER_SETTINGS.visualProviders.pexels,
    pixabay: boolValue(raw.pixabay) ?? (DEFAULT_RENDER_SETTINGS.visualProviders.pixabay ?? true),
    unsplash: boolValue(raw.unsplash) ?? (DEFAULT_RENDER_SETTINGS.visualProviders.unsplash ?? true),
    openverse: boolValue(raw.openverse) ?? DEFAULT_RENDER_SETTINGS.visualProviders.openverse,
    wikimedia: boolValue(raw.wikimedia) ?? DEFAULT_RENDER_SETTINGS.visualProviders.wikimedia,
  };
}

function resolveVisualProviderPriorityStored(value: unknown): VisualProviderName[] {
  if (!Array.isArray(value)) return [...DEFAULT_RENDER_SETTINGS.visualProviderPriority];
  const seen = new Set<VisualProviderName>();
  const ordered: VisualProviderName[] = [];
  for (const item of value) {
    const str = stringValue(item);
    if (str && VISUAL_PROVIDER_SET.has(str)) {
      const provider = str as VisualProviderName;
      if (!seen.has(provider)) {
        seen.add(provider);
        ordered.push(provider);
      }
    }
  }
  for (const fallback of VISUAL_PROVIDERS) {
    if (!seen.has(fallback)) ordered.push(fallback);
  }
  return ordered;
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
  const layout = LAYOUTS.has(stringValue(renderStored.layout) ?? '')
    ? (stringValue(renderStored.layout) as RenderDefaults['layout'])
    : DEFAULT_RENDER_SETTINGS.layout;
  const filterPreset = FILTER_IDS.has(stringValue(renderStored.filterPreset) ?? '')
    ? (stringValue(renderStored.filterPreset) as RenderDefaults['filterPreset'])
    : DEFAULT_RENDER_SETTINGS.filterPreset;
  const visualAnimation = VISUAL_ANIMATIONS.has(stringValue(renderStored.visualAnimation) ?? '')
    ? (stringValue(renderStored.visualAnimation) as VisualOverlayAnimation)
    : DEFAULT_RENDER_SETTINGS.visualAnimation;

  sources.render = {
    layout: stringValue(renderStored.layout) ? 'app' : 'default',
    filterPreset: stringValue(renderStored.filterPreset) ? 'app' : 'default',
    captionPresetId: renderStored.captionPresetId !== undefined ? 'app' : 'default',
    hookStylePresetId: renderStored.hookStylePresetId !== undefined ? 'app' : 'default',
    ctaStylePresetId: renderStored.ctaStylePresetId !== undefined ? 'app' : 'default',
    hookDuration: numberValue(renderStored.hookDuration) !== undefined ? 'app' : 'default',
    ctaDuration: numberValue(renderStored.ctaDuration) !== undefined ? 'app' : 'default',
    autoVisuals: boolValue(renderStored.autoVisuals) !== undefined ? 'app' : 'default',
    maxVisualMoments: numberValue(renderStored.maxVisualMoments) !== undefined ? 'app' : 'default',
    visualConfidenceThreshold: numberValue(renderStored.visualConfidenceThreshold) !== undefined ? 'app' : 'default',
    visualMinDuration: numberValue(renderStored.visualMinDuration) !== undefined ? 'app' : 'default',
    visualDefaultDuration: numberValue(renderStored.visualDefaultDuration) !== undefined ? 'app' : 'default',
    visualAnimation: stringValue(renderStored.visualAnimation) ? 'app' : 'default',
    visualProviders: renderStored.visualProviders !== undefined ? 'app' : 'default',
    visualProviderPriority: Array.isArray(renderStored.visualProviderPriority) ? 'app' : 'default',
    visualShowOnVideoCredit: boolValue(renderStored.visualShowOnVideoCredit) !== undefined ? 'app' : 'default',
  };

  const render: RenderDefaults = {
    layout,
    filterPreset,
    captionPresetId: idValue(renderStored.captionPresetId) ?? null,
    hookStylePresetId: idValue(renderStored.hookStylePresetId) ?? null,
    ctaStylePresetId: idValue(renderStored.ctaStylePresetId) ?? null,
    hookDuration: clampDuration(renderStored.hookDuration, DEFAULT_RENDER_SETTINGS.hookDuration),
    ctaDuration: clampDuration(renderStored.ctaDuration, DEFAULT_RENDER_SETTINGS.ctaDuration),
    autoVisuals: boolValue(renderStored.autoVisuals) ?? DEFAULT_RENDER_SETTINGS.autoVisuals,
    maxVisualMoments: intInRange(
      renderStored.maxVisualMoments,
      OPTION_LIMITS.maxVisualMoments.min,
      OPTION_LIMITS.maxVisualMoments.max,
      DEFAULT_RENDER_SETTINGS.maxVisualMoments
    ),
    visualConfidenceThreshold: clampFloatInRange(
      renderStored.visualConfidenceThreshold,
      OPTION_LIMITS.visualConfidence.min,
      OPTION_LIMITS.visualConfidence.max,
      DEFAULT_RENDER_SETTINGS.visualConfidenceThreshold,
      2
    ),
    visualMinDuration: clampFloatInRange(
      renderStored.visualMinDuration,
      OPTION_LIMITS.visualDuration.min,
      OPTION_LIMITS.visualDuration.max,
      DEFAULT_RENDER_SETTINGS.visualMinDuration,
      1
    ),
    visualDefaultDuration: clampFloatInRange(
      renderStored.visualDefaultDuration,
      OPTION_LIMITS.visualDuration.min,
      OPTION_LIMITS.visualDuration.max,
      DEFAULT_RENDER_SETTINGS.visualDefaultDuration,
      1
    ),
    visualAnimation,
    visualProviders: resolveVisualProvidersStored(renderStored.visualProviders),
    visualProviderPriority: resolveVisualProviderPriorityStored(renderStored.visualProviderPriority),
    visualShowOnVideoCredit:
      boolValue(renderStored.visualShowOnVideoCredit) ?? DEFAULT_RENDER_SETTINGS.visualShowOnVideoCredit,
    visualCardAspect:
      renderStored.visualCardAspect === 'square' || renderStored.visualCardAspect === 'portrait'
        ? renderStored.visualCardAspect
        : (DEFAULT_RENDER_SETTINGS.visualCardAspect ?? 'portrait'),
    visualCardBorder:
      boolValue(renderStored.visualCardBorder) ?? (DEFAULT_RENDER_SETTINGS.visualCardBorder ?? true),
    visualVisionScoreThreshold: intInRange(renderStored.visualVisionScoreThreshold, 0, 10, 7),
    visualRelevanceStrictness: renderStored.visualRelevanceStrictness === "lenient" ? "lenient" : "strict",
    visualizableScoreThreshold: intInRange(renderStored.visualizableScoreThreshold, 0, 10, 6),
    visualVisionVerify:
      boolValue(renderStored.visualVisionVerify) ?? (DEFAULT_RENDER_SETTINGS.visualVisionVerify ?? true),
    sfxEnabled: boolValue(renderStored.sfxEnabled) ?? (DEFAULT_RENDER_SETTINGS.sfxEnabled ?? true),
    sfxVolume: clampFloatInRange(
      renderStored.sfxVolume,
      OPTION_LIMITS.sfxVolume.min,
      OPTION_LIMITS.sfxVolume.max,
      DEFAULT_RENDER_SETTINGS.sfxVolume ?? -14,
      1
    ),
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
  const pexelsRaw = stringValue(aiStored.pexelsApiKey) ?? '';
  const pexelsApiKey = isUsableSecret(pexelsRaw) ? pexelsRaw : '';
  const pixabayRaw = stringValue(aiStored.pixabayApiKey) ?? '';
  const pixabayApiKey = isUsableSecret(pixabayRaw) ? pixabayRaw : '';
  const unsplashRaw = stringValue(aiStored.unsplashAccessKey) ?? '';
  const unsplashAccessKey = isUsableSecret(unsplashRaw) ? unsplashRaw : '';
  const openverseClientIdRaw = stringValue(aiStored.openverseClientId) ?? '';
  const openverseClientId = isUsableSecret(openverseClientIdRaw) ? openverseClientIdRaw : '';
  const openverseClientSecretRaw = stringValue(aiStored.openverseClientSecret) ?? '';
  const openverseClientSecret = isUsableSecret(openverseClientSecretRaw) ? openverseClientSecretRaw : '';
  const wikimediaUserAgentStored = stringValue(aiStored.wikimediaUserAgent) ?? '';

  sources.ai = {
    geminiApiKeys: geminiApiKeys.length ? 'app' : 'default',
    deepgramApiKey: deepgramApiKey ? 'app' : 'default',
    deepgramModel: deepgramModel ? 'app' : 'default',
    transcriptionProvider: stringValue(aiStored.transcriptionProvider) ? 'app' : 'default',
    ...(pexelsApiKey ? { pexelsApiKey: 'app' as const } : {}),
    ...(pixabayApiKey ? { pixabayApiKey: 'app' as const } : {}),
    ...(unsplashAccessKey ? { unsplashAccessKey: 'app' as const } : {}),
    ...(openverseClientId ? { openverseClientId: 'app' as const } : {}),
    ...(openverseClientSecret ? { openverseClientSecret: 'app' as const } : {}),
    ...(wikimediaUserAgentStored ? { wikimediaUserAgent: 'app' as const } : {}),
  };

  const ai: AiProviderSettings = {
    geminiApiKeys,
    geminiRequestsPerMinute: intInRange(aiStored.geminiRequestsPerMinute, 1, 1000, 10),
    deepgramApiKey,
    deepgramModel: deepgramModel || 'nova-2',
    transcriptionProvider,
    pexelsApiKey,
    pixabayApiKey,
    unsplashAccessKey,
    openverseClientId,
    openverseClientSecret,
    wikimediaUserAgent: wikimediaUserAgentStored || DEFAULT_AI_SETTINGS.wikimediaUserAgent,
  };

  /* worker */
  const workerStored = stored.worker ?? {};
  sources.worker = {
    clipConcurrency: numberValue(workerStored.clipConcurrency) !== undefined ? 'app' : 'default',
    viralConcurrency: numberValue(workerStored.viralConcurrency) !== undefined ? 'app' : 'default',
    // An explicit `null` is a choice ("let the renderer decide"), so it counts as stored.
    remotionConcurrency: workerStored.remotionConcurrency !== undefined ? 'app' : 'default',
    ...(boolValue(workerStored.strictVideoOrder) !== undefined ? { strictVideoOrder: 'app' as const } : {}),
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
    strictVideoOrder: boolValue(workerStored.strictVideoOrder) ?? DEFAULT_WORKER_SETTINGS.strictVideoOrder ?? true,
  };

  /* profanity */
  const profanityStored = stored.profanity ?? {};
  const storedMode = stringValue(profanityStored.audioMode)?.toLowerCase() ?? '';
  const audioMode = AUDIO_MODES.has(storedMode)
    ? (storedMode as ProfanitySettings['audioMode'])
    : DEFAULT_PROFANITY_SETTINGS.audioMode;
  sources.profanity = { audioMode: AUDIO_MODES.has(storedMode) ? 'app' : 'default' };

  /* paths - an empty string is the built-in "automatic" value, not a path */
  const pathsStored = stored.paths ?? {};
  const paths: PathSettings = {
    uploadDir: stringValue(pathsStored.uploadDir) ?? DEFAULT_PATH_SETTINGS.uploadDir,
    clipsDir: stringValue(pathsStored.clipsDir) ?? DEFAULT_PATH_SETTINGS.clipsDir,
    ffmpegPath: stringValue(pathsStored.ffmpegPath) ?? DEFAULT_PATH_SETTINGS.ffmpegPath,
    whisperCliPath: stringValue(pathsStored.whisperCliPath) ?? DEFAULT_PATH_SETTINGS.whisperCliPath,
  };
  sources.paths = {
    uploadDir: paths.uploadDir ? 'app' : 'default',
    clipsDir: paths.clipsDir ? 'app' : 'default',
    ffmpegPath: paths.ffmpegPath ? 'app' : 'default',
    whisperCliPath: paths.whisperCliPath ? 'app' : 'default',
  };

  const effective: AppSettings = {
    pipeline: {
      ...pipeline,
      viral: { ...DEFAULT_PIPELINE_OPTIONS.viral, ...(pipeline.viral ?? {}) },
    },
    render,
    ai,
    worker,
    profanity: { audioMode },
    paths,
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

/**
 * The saved `paths` section, read synchronously. `getFfmpegPath()` and friends
 * are sync and run on every spawn, so they cannot await the async store; the
 * SQLite read behind this is a single indexed query and cached by the OS.
 * Never throws: a settings hiccup must fall back to the automatic chain, not
 * break a render.
 */
export function getStoredPathSettings(): PathSettings {
  try {
    const store = storeOverride ?? syncDbStore();
    const stored = readStoredSectionsFrom(store).paths ?? {};
    return {
      uploadDir: stringValue(stored.uploadDir) ?? '',
      clipsDir: stringValue(stored.clipsDir) ?? '',
      ffmpegPath: stringValue(stored.ffmpegPath) ?? '',
      whisperCliPath: stringValue(stored.whisperCliPath) ?? '',
    };
  } catch {
    return { ...DEFAULT_PATH_SETTINGS };
  }
}

let cachedSyncStore: SettingsStore | null = null;

function syncDbStore(): SettingsStore {
  if (!cachedSyncStore) {
    cachedSyncStore = {
      // `lib/db.ts` is server-only and never imports this module, so the static
      // import cannot cycle; better-sqlite3 reads are synchronous by nature.
      read: () => readAppSettingsSections().map((row) => ({ key: row.key, value: row.value })),
      write: (section, value) => saveAppSettingsSection(section, value),
    };
  }
  return cachedSyncStore;
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
  return readStoredSectionsFrom(store);
}

function readStoredSectionsFrom(store: SettingsStore): StoredSettingsRows {
  const stored: StoredSettingsRows = {};
  for (const row of store.read()) {
    if (row.key === 'pipeline') stored.pipeline = sanitizePipelineOptions(row.value);
    else if (row.key === 'render') stored.render = asRecord(row.value);
    else if (row.key === 'ai') stored.ai = (row.value as Partial<AiProviderSettings>) ?? {};
    else if (row.key === 'worker') stored.worker = asRecord(row.value);
    else if (row.key === 'profanity') stored.profanity = asRecord(row.value);
    else if (row.key === 'paths') stored.paths = asRecord(row.value);
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
  if (stored.paths) storedOut.paths = stored.paths;
  if (stored.ai) {
    storedOut.ai = {
      ...stored.ai,
      geminiApiKeys: (stored.ai.geminiApiKeys ?? []).map(maskSecret),
      deepgramApiKey: maskSecret(stored.ai.deepgramApiKey ?? ''),
      pexelsApiKey: maskSecret(stored.ai.pexelsApiKey ?? ''),
      openverseClientId: maskSecret(stored.ai.openverseClientId ?? ''),
      openverseClientSecret: maskSecret(stored.ai.openverseClientSecret ?? ''),
    };
  }

  return {
    stored: storedOut,
    // Masked, like `stored`. `resolveSettings` keeps the raw keys because the worker and
    // the provider calls read that object; this one goes to a browser, where a key is
    // only ever needed as "present" plus a tail to recognise (and to send back as the
    // keep-this-one placeholder).
    effective: {
      ...effective,
      ai: {
        ...effective.ai,
        geminiApiKeys: effective.ai.geminiApiKeys.map(maskSecret),
        deepgramApiKey: maskSecret(effective.ai.deepgramApiKey),
        pexelsApiKey: maskSecret(effective.ai.pexelsApiKey),
        openverseClientId: maskSecret(effective.ai.openverseClientId),
        openverseClientSecret: maskSecret(effective.ai.openverseClientSecret),
      },
    },
    sources,
    configured: APP_SETTINGS_SECTIONS.filter((section) => Object.prototype.hasOwnProperty.call(stored, section)),
    // Only a *stored* override can be pending; a field that still holds its built-in
    // default was already read at worker start, so saying "restart" there would be noise.
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
  layouts: ['speaker-focus', 'split-screen'] as const,
  audioModes: ['mute', 'beep', 'off'] as const,
  transcriptionProviders: ['auto', 'deepgram', 'whisper'] as const,
  maxVisualMoments: OPTION_LIMITS.maxVisualMoments,
  visualConfidence: OPTION_LIMITS.visualConfidence,
  visualDuration: OPTION_LIMITS.visualDuration,
  visualAnimations: VISUAL_OVERLAY_ANIMATIONS,
  visualProviders: VISUAL_PROVIDERS,
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
  const pexelsRaw = envText('PEXELS_API_KEY');
  const pexelsApiKey = isUsableSecret(pexelsRaw) ? pexelsRaw : '';
  const openverseIdRaw = envText('OPENVERSE_CLIENT_ID');
  const openverseClientId = isUsableSecret(openverseIdRaw) ? openverseIdRaw : '';
  const openverseSecretRaw = envText('OPENVERSE_CLIENT_SECRET');
  const openverseClientSecret = isUsableSecret(openverseSecretRaw) ? openverseSecretRaw : '';
  const wikimediaUserAgent = envText('WIKIMEDIA_USER_AGENT');

  if (
    !geminiApiKeys.length &&
    !deepgramApiKey &&
    !deepgramModel &&
    !pexelsApiKey &&
    !openverseClientId &&
    !openverseClientSecret &&
    !wikimediaUserAgent
  ) {
    return null;
  }

  const value: Record<string, unknown> = {
    geminiApiKeys,
    deepgramApiKey,
    transcriptionProvider: DEFAULT_AI_SETTINGS.transcriptionProvider,
  };
  if (deepgramModel) value.deepgramModel = deepgramModel;
  if (pexelsApiKey) value.pexelsApiKey = pexelsApiKey;
  if (openverseClientId) value.openverseClientId = openverseClientId;
  if (openverseClientSecret) value.openverseClientSecret = openverseClientSecret;
  if (wikimediaUserAgent) value.wikimediaUserAgent = wikimediaUserAgent;
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
  // The row keeps the real keys; what is handed back is what a route puts in a response
  // body, and both callers today echo it straight to the browser.
  return { updatedAt, saved: section === 'ai' ? maskAiSecrets(merged) : merged };
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

export async function resolveVisualProviderSettings(): Promise<{
  render: RenderDefaults;
  geminiApiKeys: string[];
  geminiRequestsPerMinute?: number;
  pexelsApiKey: string;
  pixabayApiKey: string;
  unsplashAccessKey: string;
  openverseClientId: string;
  openverseClientSecret: string;
  wikimediaUserAgent: string;
}> {
  const settings = await loadEffectiveSettings();
  return {
    render: settings.render,
    geminiApiKeys: settings.ai.geminiApiKeys,
    geminiRequestsPerMinute: settings.ai.geminiRequestsPerMinute ?? 10,
    pexelsApiKey: settings.ai.pexelsApiKey,
    pixabayApiKey: settings.ai.pixabayApiKey ?? '',
    unsplashAccessKey: settings.ai.unsplashAccessKey ?? '',
    openverseClientId: settings.ai.openverseClientId,
    openverseClientSecret: settings.ai.openverseClientSecret,
    wikimediaUserAgent: settings.ai.wikimediaUserAgent,
  };
}

export { DEFAULT_RENDER_SETTINGS, OPTION_LIMITS };
