/**
 * Normalization layer for the AI's viral-clip response.
 *
 * The viral_detection prompt asks the model for
 *
 *   { "clips": [ { rank, timestamp, why_this_will_go_viral, hook_line_analysis,
 *                  retention_analysis, psychological_trigger, safety_analysis,
 *                  viral_packaging, scores, ... } ] }
 *
 * and THIS file is the one place that knows that shape. Everything downstream
 * (clip records, SQLite, the dashboard, the renderer) only sees the app's own
 * types, so a future prompt/schema change is made here and nowhere else.
 *
 *   model text ──extractViralClips──▶ raw clip objects
 *              ──normalizeViralClips─▶ ViralSegment[]  (+ `issues` for skipped clips)
 *              ──clipFieldsFromSegment▶ the ClipRecord fields the detect route stores
 *
 * Rules:
 *  - Pure: no database, network or logger imports - trivially testable.
 *  - Tolerant per field, strict per clip. A malformed optional field is dropped
 *    (or defaulted) and never fails the run. Only a clip whose time window cannot
 *    be trusted is skipped, and it is reported in `issues` instead of throwing.
 *  - Nothing nested is thrown away: every valid leaf of the response is kept in
 *    `ClipAnalysis` (stored inside the clip's JSON record - no SQL columns).
 *  - The previous flat format ({ start, end, reason, hookText, ... }) is upgraded
 *    to the new shape first, so prompts saved before the schema change still work.
 */

import {
  PSYCHOLOGICAL_TRIGGERS,
  RETENTION_STRENGTHS,
  RISKY_WORD_ACTIONS,
  SAFETY_RISKS,
  type ClipAnalysis,
  type ClipDuration,
  type ClipRecord,
  type ClipScores,
  type HookLineAnalysis,
  type RetentionAnalysis,
  type RiskyWord,
  type SafetyAnalysis,
  type TimeRange,
  type TriggerAnalysis,
  type ViralPackaging,
  type ViralSegment,
} from './types';

/** Viral score used when the model gave no usable `viral_score` (unchanged legacy default). */
export const DEFAULT_VIRAL_SCORE = 8;

/** `safetyNotes` text for a clip with no risky words (the dashboard hides it). */
export const NO_RISKY_WORDING_NOTE = 'No risky wording detected.';

/** Key holding the clip list in the response object. Rename here if the schema changes. */
const CLIPS_KEY = 'clips';

/** A clip shorter than this after clamping to the video is not a clip. */
const MIN_USABLE_CLIP_SECONDS = 1;

/** How far before the clip start a start-only hook timestamp may sit and still be accepted. */
const HOOK_EDGE_TOLERANCE_SECONDS = 1;

/** Length caps (code points) so one runaway field cannot bloat the stored record. */
const LIMITS = {
  title: 160,
  hookText: 200,
  ctaText: 120,
  hookLine: 220,
  reason: 600,
  text: 800,
  safetyNotes: 400,
  shortText: 120,
  hashtag: 60,
  hashtags: 15,
  riskyWords: 25,
  wordsToChange: 25,
} as const;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A block the model may have omitted or mangled reads as an empty object. */
const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

/** Copy without the `undefined` leaves. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/* ------------------------------------------------------------------ */
/* Timestamps                                                          */
/* ------------------------------------------------------------------ */

const SECONDS_WITH_UNIT = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)$/;
const CLOCK = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d+))?$/;
const UNIT_PARTS =
  /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/;

/**
 * Seconds from any timestamp notation the model is likely to use, or null.
 *
 *   12.5  "12.5"  "12.5s"  "90 seconds"      plain seconds (the transcript's own "12.5s" style)
 *   "01:23"                                   mm:ss          = 83
 *   "00:01:23"  "1:02:03.5"                   hh:mm:ss(.fff) = 83 / 3723.5
 *   "1m23s"  "1h 2m 3s"                       unit form
 *
 * Negative, non-finite or unreadable values (and minutes/seconds >= 60 in the
 * three-part form, or seconds >= 60 in "mm:ss") return null rather than guessing.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;

  const text = value
    .trim()
    .replace(/^[[("'`]+|[\])"'`]+$/g, '')
    .trim()
    .toLowerCase();
  if (!text) return null;

  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  const withUnit = SECONDS_WITH_UNIT.exec(text);
  if (withUnit) return Number(withUnit[1]);

  const clock = CLOCK.exec(text);
  if (clock) {
    const [, first, second, third, fraction] = clock;
    const fractionalSeconds = fraction ? Number(`0.${fraction}`) : 0;
    if (third === undefined) {
      if (Number(second) >= 60) return null;
      return Number(first) * 60 + Number(second) + fractionalSeconds;
    }
    if (Number(second) >= 60 || Number(third) >= 60) return null;
    return Number(first) * 3600 + Number(second) * 60 + Number(third) + fractionalSeconds;
  }

  const units = UNIT_PARTS.exec(text);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }

  return null;
}

/** "01:23 - 02:30", "12.5s to 20s", "[1:23 – 2:30]" → ["01:23", "02:30"]. */
export function splitTimestampRange(value: unknown): [string, string] | null {
  if (typeof value !== 'string') return null;
  const parts = value
    .trim()
    .replace(/^[[(]+|[\])]+$/g, '')
    .split(/\s*(?:–|—|→|-|\bto\b)\s*/i);
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

/** Start/end raw values from `{ start, end }` or a single "start - end" string. */
function readRangeParts(value: unknown): { start: unknown; end: unknown } {
  if (isRecord(value)) return { start: value.start, end: value.end };
  const parts = splitTimestampRange(value);
  return parts ? { start: parts[0], end: parts[1] } : { start: value, end: undefined };
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/** Short, quoted rendering of an untrusted value for issue messages. */
function show(value: unknown): string {
  const rendered = value === undefined ? 'missing' : JSON.stringify(value);
  return rendered.length > 40 ? `${rendered.slice(0, 37)}...` : rendered;
}

/* ------------------------------------------------------------------ */
/* Field coercion (every helper is total: it never throws)             */
/* ------------------------------------------------------------------ */

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Code-point aware so an emoji is never cut in half.
  return Array.from(value).slice(0, max).join('');
}

/** Trimmed, single-spaced text (numbers are stringified); undefined when empty. */
function text(value: unknown, max: number = LIMITS.text): string | undefined {
  const raw =
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? truncate(cleaned, max) : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    if (cleaned === 'true' || cleaned === 'yes') return true;
    if (cleaned === 'false' || cleaned === 'no') return false;
  }
  return undefined;
}

/**
 * Exactly one of `allowed`, or undefined.
 *
 * The prompt schema writes enum fields as "Weak | Medium | Strong | Extreme",
 * and models sometimes echo that placeholder back. A value that names several
 * options is therefore treated as "no answer" instead of being stored as a
 * literal string; a value that decorates exactly one option ("Strong 💪",
 * "strong - because...") still resolves to it.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;

  const exact = allowed.find((option) => option.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;

  const mentioned = allowed.filter((option) => new RegExp(`\\b${option}\\b`, 'i').test(cleaned));
  return mentioned.length === 1 ? mentioned[0] : undefined;
}

/** A 0-10 score from a number or a string such as "8", "8.5" or "8/10"; clamped, else undefined. */
function toScore(value: unknown): number | undefined {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*(?:\/\s*10(?:\.0+)?)?\s*$/.exec(value);
    if (match) n = Number(match[1].replace(',', '.'));
  }
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.min(10, Math.max(0, n));
}

function toNonNegative(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A positive whole rank from 3, "3" or "Clip #3". */
function toRank(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(/\d+(?:\.\d+)?/.exec(value)?.[0]) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined;
}

/** Unique "#tags" (a missing "#" is added, inner spaces removed). Accepts an array or one string. */
function toHashtags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const bare = item.replace(/\s+/g, '');
    if (!bare || bare === '#') continue;
    const tag = truncate(bare.startsWith('#') ? bare : `#${bare}`, LIMITS.hashtag);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= LIMITS.hashtags) break;
  }
  return tags;
}

/** The first of `keys` that holds a readable string in `source`. */
function firstText(source: JsonRecord, keys: readonly string[], max: number): string | undefined {
  for (const key of keys) {
    const found = text(source[key], max);
    if (found) return found;
  }
  return undefined;
}

function toRiskyWords(value: unknown): RiskyWord[] {
  const items = Array.isArray(value) ? value : [];
  const words: RiskyWord[] = [];
  for (const item of items) {
    let entry: RiskyWord | undefined;
    if (typeof item === 'string') {
      const wordOrPhrase = text(item, LIMITS.shortText);
      if (wordOrPhrase) entry = { wordOrPhrase };
    } else if (isRecord(item)) {
      const wordOrPhrase = firstText(item, ['word_or_phrase', 'word', 'phrase'], LIMITS.shortText);
      if (wordOrPhrase) {
        entry = compact({
          wordOrPhrase,
          action: oneOf(item.action, RISKY_WORD_ACTIONS),
          saferReplacement: firstText(item, ['safer_replacement', 'replacement'], LIMITS.shortText),
        });
      }
    }
    if (entry) words.push(entry);
    if (words.length >= LIMITS.riskyWords) break;
  }
  return words;
}

/** `words_to_change` is unspecified in the schema: strings, or word/replacement objects. */
function toWordsToChange(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const words: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const word = text(item, LIMITS.shortText);
      if (word) words.push(word);
    } else if (isRecord(item)) {
      const word = firstText(item, ['word_or_phrase', 'word', 'phrase'], LIMITS.shortText);
      const replacement = firstText(item, ['safer_replacement', 'replacement'], LIMITS.shortText);
      if (word) words.push(replacement ? `${word} → ${replacement}` : word);
    }
    if (words.length >= LIMITS.wordsToChange) break;
  }
  return words;
}

function toDuration(value: unknown): ClipDuration | undefined {
  if (!isRecord(value)) return undefined;
  const minutes = toNonNegative(value.minutes);
  const seconds = toNonNegative(value.seconds);
  const totalSeconds =
    toNonNegative(value.total_seconds) ??
    (minutes !== undefined && seconds !== undefined ? minutes * 60 + seconds : undefined);
  const duration = compact({ minutes, seconds, totalSeconds });
  return Object.keys(duration).length ? duration : undefined;
}

/** One line per risky word, e.g. "damn -> darn (replace); sh*t (censor)". */
export function summarizeRiskyWords(words: readonly RiskyWord[]): string {
  if (!words.length) return NO_RISKY_WORDING_NOTE;
  return truncate(
    words
      .map((word) =>
        [word.wordOrPhrase, word.saferReplacement ? `-> ${word.saferReplacement}` : '', word.action ? `(${word.action})` : '']
          .filter(Boolean)
          .join(' ')
      )
      .join('; '),
    LIMITS.safetyNotes
  );
}

/* ------------------------------------------------------------------ */
/* Pulling the clip list out of the model's text                       */
/* ------------------------------------------------------------------ */

export interface ExtractedClips {
  clips: unknown[];
  /** True when the JSON was cut off and only the clips that finished were salvaged. */
  truncated: boolean;
}

function stripCodeFences(value: string): string {
  return value.replace(/```[a-zA-Z0-9_-]*/g, ' ');
}

/** Index of the bracket closing the one at `start`, or -1 when the text ends first. String-aware. */
function findClosingIndex(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Drops commas that directly precede a closing bracket (outside strings). */
function removeTrailingCommas(source: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',') {
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseLenientJson(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    // Not strict JSON - retry once without trailing commas.
  }
  try {
    return { ok: true, value: JSON.parse(removeTrailingCommas(source)) };
  } catch {
    return { ok: false };
  }
}

type Root = { index: number; kind: 'wrapped' | 'bare' | 'single' };

/** Where the clip JSON starts: `{ "clips": [`, else a bare `[ {`, else one `{`. */
function locateRoot(source: string): Root | null {
  const wrapped = new RegExp(`\\{\\s*"${CLIPS_KEY}"\\s*:\\s*\\[`).exec(source);
  if (wrapped) return { index: wrapped.index, kind: 'wrapped' };
  const bare = /\[\s*\{/.exec(source);
  if (bare) return { index: bare.index, kind: 'bare' };
  const single = source.indexOf('{');
  return single === -1 ? null : { index: single, kind: 'single' };
}

const LEGACY_CLIP_KEYS = ['start', 'end'] as const;
const NEW_SHAPE_KEYS = [
  'timestamp',
  'why_this_will_go_viral',
  'hook_line_analysis',
  'retention_analysis',
  'psychological_trigger',
  'safety_analysis',
  'viral_packaging',
] as const;

function looksLikeClip(value: JsonRecord): boolean {
  return NEW_SHAPE_KEYS.some((key) => key in value) || LEGACY_CLIP_KEYS.every((key) => key in value);
}

/**
 * The clip objects inside an already-parsed response:
 * `{ clips: [...] }`, a bare array (the old format), or a single clip object.
 */
export function listRawClips(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const list = value[CLIPS_KEY];
    if (Array.isArray(list)) return list;
    if (looksLikeClip(value)) return [value];
  }
  return null;
}

/**
 * Every clip object that is complete on its own, found by walking the brackets.
 * Used when the whole response does not parse: either the model hit its output
 * limit mid-clip, or one clip is malformed - the others are still good.
 */
function salvageClipObjects(source: string, root: Root): unknown[] {
  if (root.kind === 'single') return [];
  // Depth of a clip's own braces: { "clips": [ { → 3,  [ { → 2.
  const clipDepth = root.kind === 'wrapped' ? 3 : 2;
  const clips: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let i = root.index; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      if (ch === '{' && depth === clipDepth) objectStart = i;
    } else if (ch === '}' || ch === ']') {
      if (ch === '}' && depth === clipDepth && objectStart !== -1) {
        const parsed = parseLenientJson(source.slice(objectStart, i + 1));
        if (parsed.ok) clips.push(parsed.value);
        objectStart = -1;
      }
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return clips;
}

/**
 * The raw clip objects from the model's text, whatever surrounds them (prose,
 * ```json fences) and however it ends (trailing commas, output cut off).
 * Returns null when no clip JSON can be found at all.
 */
export function extractViralClips(response: string): ExtractedClips | null {
  const source = stripCodeFences(response);
  if (/^\s*\[\s*\]\s*$/.test(source)) return { clips: [], truncated: false };

  const root = locateRoot(source);
  if (!root) return null;

  const end = findClosingIndex(source, root.index);
  if (end !== -1) {
    const parsed = parseLenientJson(source.slice(root.index, end + 1));
    if (parsed.ok) {
      const clips = listRawClips(parsed.value);
      if (clips) return { clips, truncated: false };
    }
  }

  const salvaged = salvageClipObjects(source, root);
  return salvaged.length ? { clips: salvaged, truncated: end === -1 } : null;
}

/* ------------------------------------------------------------------ */
/* One clip: raw JSON → ViralSegment                                   */
/* ------------------------------------------------------------------ */

export interface NormalizeContext {
  /** Source video length in seconds: no clip may leave [0, videoDuration]. */
  videoDuration: number;
}

/** A clip that was skipped, and why (index = position in the model's list, 0-based). */
export interface ClipIssue {
  index: number;
  message: string;
}

export interface NormalizeResult {
  segments: ViralSegment[];
  issues: ClipIssue[];
}

/** Thrown inside normalizeClip for the one failure that cannot be defaulted: an untrustworthy time window. */
class ClipRejected extends Error {}

/** Values of the old flat format that have no slot of their own in the new schema. */
interface LegacyExtras {
  /** The old top-level `score` stays the headline viral score (it was separate from `scores.viral`). */
  score?: number;
  safetyNotes?: string;
}

/** Old flat format → new shape, so there is a single mapping to maintain. */
function upgradeLegacyClip(flat: JsonRecord): { clip: JsonRecord; extras: LegacyExtras } {
  const scores = asRecord(flat.scores);
  return {
    clip: {
      rank: flat.rank,
      timestamp: { start: flat.start, end: flat.end },
      why_this_will_go_viral: flat.reason,
      hook_line_analysis: {
        hook_line: flat.hookLine,
        hook_timestamp: { start: flat.hookLineStart, end: flat.hookLineEnd },
      },
      retention_analysis: { predicted_retention: flat.retentionStrength },
      psychological_trigger: { dominant_trigger: flat.psychologicalTrigger },
      safety_analysis: { risk_level: flat.safetyRisk },
      viral_packaging: {
        hook_text_on_video: flat.hookText,
        video_title: flat.title,
        cta_text: flat.ctaText,
        hashtags: flat.hashtags,
      },
      scores: {
        viral_score: scores.viral ?? flat.score,
        retention_score: scores.retention,
        controversy_score: scores.controversy,
        shareability_score: scores.shareability,
      },
    },
    extras: {
      score: toScore(flat.score),
      safetyNotes: text(flat.safetyNotes, LIMITS.safetyNotes),
    },
  };
}

/**
 * The clip's window in seconds, validated against the source video:
 * readable, start < end, inside [0, videoDuration] (an overshooting end is clamped).
 */
function resolveWindow(clip: JsonRecord, videoDuration: number): TimeRange {
  const range = readRangeParts(clip.timestamp);
  const startRaw = range.start ?? clip.start;
  const endRaw = range.end ?? clip.end;

  const start = parseTimestamp(startRaw);
  if (start === null) throw new ClipRejected(`its start time is missing or unreadable (${show(startRaw)})`);

  let end = parseTimestamp(endRaw);
  if (end === null) {
    // No usable end: fall back to the duration the model reported.
    const reported = toDuration(clip.duration)?.totalSeconds;
    if (!reported) throw new ClipRejected(`its end time is missing or unreadable (${show(endRaw)}) and no duration was given`);
    end = start + reported;
  }
  if (end <= start) {
    throw new ClipRejected(`it ends (${formatSeconds(end)}) at or before it starts (${formatSeconds(start)})`);
  }

  const limit = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Number.POSITIVE_INFINITY;
  if (start >= limit) {
    throw new ClipRejected(`it starts at ${formatSeconds(start)}, past the end of the ${formatSeconds(limit)} video`);
  }
  const clampedEnd = Math.min(end, limit);
  if (clampedEnd - start < MIN_USABLE_CLIP_SECONDS) {
    throw new ClipRejected(
      `only ${formatSeconds(clampedEnd - start)} of it lies inside the ${formatSeconds(limit)} video`
    );
  }
  return { start, end: clampedEnd };
}

/**
 * The hook line's moment, kept only when it can really be cut out of the clip
 * (the renderer duplicates it from inside the clip window): it must overlap the
 * clip, and is clamped to it. `end` is optional - a start-only hook still works.
 */
export function fitHookToWindow(
  hook: { start: number; end?: number } | undefined,
  window: TimeRange
): { start: number; end?: number } | undefined {
  if (!hook || hook.start >= window.end) return undefined;
  if (hook.end === undefined) {
    if (hook.start < window.start - HOOK_EDGE_TOLERANCE_SECONDS) return undefined;
    return { start: Math.max(hook.start, window.start) };
  }
  if (hook.end <= window.start) return undefined;
  const start = Math.max(hook.start, window.start);
  const end = Math.min(hook.end, window.end);
  return end > start ? { start, end } : { start };
}

function readHookMoment(value: unknown): { start: number; end?: number } | undefined {
  const parts = readRangeParts(value);
  const start = parseTimestamp(parts.start);
  if (start === null) return undefined;
  const end = parseTimestamp(parts.end);
  return end !== null && end > start ? { start, end } : { start };
}

function readHookLineAnalysis(
  value: unknown,
  window: TimeRange
): { analysis: HookLineAnalysis; moment: { start: number; end?: number } | undefined } {
  const block = asRecord(value);
  const moment = fitHookToWindow(readHookMoment(block.hook_timestamp), window);
  const analysis = compact({
    hookLine: text(block.hook_line, LIMITS.hookLine),
    hookTimestamp: moment?.end !== undefined ? { start: moment.start, end: moment.end } : undefined,
    whyItWorks: text(block.why_it_works),
    placeBeforeClip: toBoolean(block.place_before_clip),
  });
  return { analysis, moment };
}

function readRetentionAnalysis(value: unknown): RetentionAnalysis {
  const block = asRecord(value);
  return compact({
    curiosityFirst3Seconds: text(block.curiosity_first_3_seconds),
    payoffLocation: text(block.payoff_location),
    openLoop: toBoolean(block.open_loop),
    likelyToWatchTillEnd: toBoolean(block.likely_to_watch_till_end),
    predictedRetention: oneOf(block.predicted_retention, RETENTION_STRENGTHS),
  });
}

function readTriggerAnalysis(value: unknown): TriggerAnalysis {
  const block = asRecord(value);
  return compact({
    dominantTrigger: oneOf(block.dominant_trigger, PSYCHOLOGICAL_TRIGGERS),
    explanation: text(block.explanation),
  });
}

function readSafetyAnalysis(value: unknown): SafetyAnalysis {
  const block = asRecord(value);
  return {
    ...compact({
      riskLevel: oneOf(block.risk_level, SAFETY_RISKS),
      monetizationRisk: text(block.monetization_risk),
      reusedContentRisk: text(block.reused_content_risk),
      algorithmSuppressionRisk: text(block.algorithm_suppression_risk),
      ineligibleForFypRisk: text(block.ineligible_for_fyf_risk),
    }),
    riskyWords: toRiskyWords(block.risky_words),
  };
}

function readViralPackaging(value: unknown): ViralPackaging {
  const block = asRecord(value);
  return {
    ...compact({
      hookTextOnVideo: text(block.hook_text_on_video, LIMITS.hookText),
      videoTitle: text(block.video_title, LIMITS.title),
      ctaText: text(block.cta_text, LIMITS.ctaText),
      platformSafe: toBoolean(block.platform_safe),
      eligibilityOrReachConcerns: text(block.eligibility_or_reach_concerns),
    }),
    hashtags: toHashtags(block.hashtags),
    wordsToChange: toWordsToChange(block.words_to_change),
  };
}

function readScores(value: unknown): Partial<ClipScores> {
  const block = asRecord(value);
  return compact({
    viral: toScore(block.viral_score),
    retention: toScore(block.retention_score),
    controversy: toScore(block.controversy_score),
    shareability: toScore(block.shareability_score),
  });
}

function hasAllScores(scores: Partial<ClipScores>): scores is ClipScores {
  return (
    scores.viral !== undefined &&
    scores.retention !== undefined &&
    scores.controversy !== undefined &&
    scores.shareability !== undefined
  );
}

/** True when `value` uses the new nested schema (anything else is the old flat format). */
function usesNewShape(value: JsonRecord): boolean {
  return NEW_SHAPE_KEYS.some((key) => key in value);
}

function normalizeClip(raw: unknown, context: NormalizeContext): ViralSegment {
  if (!isRecord(raw)) throw new ClipRejected('it is not a JSON object');

  const legacy = usesNewShape(raw) ? undefined : upgradeLegacyClip(raw);
  const clip = legacy ? legacy.clip : raw;

  const window = resolveWindow(clip, context.videoDuration);

  const { analysis: hookLineAnalysis, moment: hookMoment } = readHookLineAnalysis(clip.hook_line_analysis, window);
  const retentionAnalysis = readRetentionAnalysis(clip.retention_analysis);
  const trigger = readTriggerAnalysis(clip.psychological_trigger);
  const safetyAnalysis = readSafetyAnalysis(clip.safety_analysis);
  const packaging = readViralPackaging(clip.viral_packaging);
  const scores = readScores(clip.scores);
  const whyThisWillGoViral = text(clip.why_this_will_go_viral, LIMITS.reason);
  const duration = toDuration(clip.duration);

  const analysis: ClipAnalysis = {
    schemaVersion: 1,
    ...compact({ whyThisWillGoViral, duration }),
    hookLineAnalysis,
    retentionAnalysis,
    psychologicalTrigger: trigger,
    safetyAnalysis,
    viralPackaging: packaging,
    scores,
  };

  return compact({
    start: window.start,
    end: window.end,
    rank: toRank(clip.rank),
    score: legacy?.extras.score ?? scores.viral ?? DEFAULT_VIRAL_SCORE,
    reason: whyThisWillGoViral ?? '',
    hookText: (packaging.hookTextOnVideo ?? '').toUpperCase(),
    title: packaging.videoTitle,
    ctaText: packaging.ctaText,
    hookLine: hookLineAnalysis.hookLine,
    hookLineStart: hookMoment?.start,
    hookLineEnd: hookMoment?.end,
    placeBeforeClip: hookLineAnalysis.placeBeforeClip,
    hashtags: packaging.hashtags.length ? packaging.hashtags : undefined,
    retentionStrength: retentionAnalysis.predictedRetention,
    psychologicalTrigger: trigger.dominantTrigger,
    safetyRisk: safetyAnalysis.riskLevel,
    safetyNotes: legacy?.extras.safetyNotes ?? summarizeRiskyWords(safetyAnalysis.riskyWords),
    scores: hasAllScores(scores) ? scores : undefined,
    analysis,
  });
}

/**
 * Normalizes every raw clip. A clip that cannot be trusted (unreadable or
 * out-of-range time window) is skipped and reported in `issues`; one bad clip
 * never fails the others.
 */
export function normalizeViralClips(rawClips: readonly unknown[], context: NormalizeContext): NormalizeResult {
  const segments: ViralSegment[] = [];
  const issues: ClipIssue[] = [];
  rawClips.forEach((raw, index) => {
    try {
      segments.push(normalizeClip(raw, context));
    } catch (error) {
      issues.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return { segments, issues };
}

export interface NormalizedViralResponse extends NormalizeResult {
  /** False when the response held no recognisable clip JSON at all. */
  found: boolean;
  /** True when the response was cut off and only complete clips were kept. */
  truncated: boolean;
}

/**
 * One call from "whatever the model sent" to app segments: accepts the raw text
 * or an already-parsed JSON value.
 */
export function normalizeViralResponse(response: unknown, context: NormalizeContext): NormalizedViralResponse {
  let extracted: ExtractedClips | null;
  if (typeof response === 'string') {
    extracted = extractViralClips(response);
  } else {
    const clips = listRawClips(response);
    extracted = clips ? { clips, truncated: false } : null;
  }
  if (!extracted) return { segments: [], issues: [], found: false, truncated: false };
  return { ...normalizeViralClips(extracted.clips, context), found: true, truncated: extracted.truncated };
}

/* ------------------------------------------------------------------ */
/* Segment → clip record                                               */
/* ------------------------------------------------------------------ */

export type SegmentClipFields = Pick<
  ClipRecord,
  | 'viralScore'
  | 'viralReason'
  | 'rank'
  | 'title'
  | 'hookLine'
  | 'hookLineStart'
  | 'hookLineEnd'
  | 'placeBeforeClip'
  | 'hashtags'
  | 'retentionStrength'
  | 'psychologicalTrigger'
  | 'safetyRisk'
  | 'safetyNotes'
  | 'scores'
  | 'analysis'
>;

/**
 * The AI-derived part of a ClipRecord. The detect route spreads this into the
 * record (and decides hookText / ctaText itself, because those obey the
 * includeHookText / includeCta options), so a new AI field is added here once.
 */
export function clipFieldsFromSegment(segment: ViralSegment): SegmentClipFields {
  return {
    viralScore: segment.score,
    viralReason: segment.reason || undefined,
    rank: segment.rank,
    title: segment.title,
    hookLine: segment.hookLine,
    hookLineStart: segment.hookLineStart,
    hookLineEnd: segment.hookLineEnd,
    placeBeforeClip: segment.placeBeforeClip,
    hashtags: segment.hashtags,
    retentionStrength: segment.retentionStrength,
    psychologicalTrigger: segment.psychologicalTrigger,
    safetyRisk: segment.safetyRisk,
    safetyNotes: segment.safetyNotes,
    scores: segment.scores,
    analysis: segment.analysis,
  };
}
