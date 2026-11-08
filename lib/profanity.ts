/**
 * Render-time language safety for captions, overlays and audio.
 *
 * The persisted Deepgram transcript is deliberately immutable. This module only
 * decides what to paint or mute while a clip is rendered, so a policy update never
 * needs a re-transcription and the original evidence remains available for review.
 */

import { DEFAULT_PROFANITY_SETTINGS, type ViralClip } from './types';
import {
  SAFETY_ALLOWLIST,
  SAFETY_LEXICON,
  type SafetyLexiconCategory,
  type SafetyWordEntry,
} from './profanity-lexicon';
import { RenderCancelledError } from './errors';

export type ProfanityAudioMode = 'mute' | 'beep' | 'off';

export interface ProfanityMatch {
  /** Inclusive transcript-word indexes covered by this match. */
  startIndex: number;
  endIndex: number;
  category: SafetyLexiconCategory;
  term: string;
  source: 'static' | 'context';
}

export interface TranscriptSafetyWord {
  word: string;
  start: number;
  end: number;
}

/** Kept for compatibility with integrations that surfaced the old word list. */
export const PROFANITY_WORDS: readonly string[] = Object.values(SAFETY_LEXICON)
  .flatMap(({ words }) => words.flatMap((entry) => [entry.term, ...(entry.aliases ?? [])]));

const ASCII_WORD = /[a-z0-9]/i;
const TOKEN_CHARS = /[\p{L}\p{N}@$!|+*._'’-]+/gu;

/** Common leetspeak is normalized before transcript-window matching. */
const LEET_NORMALIZATION: Record<string, string> = {
  '@': 'a',
  '4': 'a',
  '8': 'b',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '0': 'o',
  '$': 's',
  '5': 's',
  '7': 't',
  '+': 't',
  '9': 'g',
};

/** Normalize one spoken/displayed token without making substrings eligible. */
export function normalizeSafetyToken(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map((character) => LEET_NORMALIZATION[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The viral response already performed a full safety pass. Convert its human
 * phrases to the same token representation as transcript matching, so the
 * render can use that validated data without repeating a second LLM review.
 */
export function normalizeViralSafetyPhrase(value: string): string {
  return (value.match(TOKEN_CHARS) ?? [])
    .map(normalizeSafetyToken)
    .filter(Boolean)
    .join(' ');
}

export interface ViralSafetyIndexes {
  /** Normalized, de-duplicated phrases carried by viral analysis. */
  phrases: string[];
  /** Every word index in a contiguous phrase match. */
  indexes: number[];
}

/** The small subset of a viral response that the render-time matcher needs. */
export interface ViralSafetySource {
  safety_analysis?: Pick<ViralClip['safety_analysis'], 'risky_words'>;
  viral_packaging?: Pick<ViralClip['viral_packaging'], 'words_to_change'>;
}

/**
 * Reuse `risky_words` and `words_to_change` from a validated viral response.
 * Matching is intentionally exact and contiguous after normalization: it never
 * censors a phrase merely because its words appear separately in the clip.
 */
export function findViralSafetyWordIndexes(
  words: readonly Pick<TranscriptSafetyWord, 'word'>[],
  analysis: ViralSafetySource | null | undefined,
): ViralSafetyIndexes {
  const values = [
    ...(analysis?.safety_analysis?.risky_words ?? []).map((entry) => entry.word_or_phrase),
    ...(analysis?.viral_packaging?.words_to_change ?? []),
  ];
  const phrases = [...new Set(values.map(normalizeViralSafetyPhrase).filter(Boolean))];
  if (phrases.length === 0 || words.length === 0) return { phrases, indexes: [] };

  const tokens = words.map((word) => normalizeSafetyToken(word.word));
  const indexes = new Set<number>();
  for (const phrase of phrases) {
    const phraseTokens = phrase.split(' ');
    for (let start = 0; start <= tokens.length - phraseTokens.length; start += 1) {
      if (tokens.slice(start, start + phraseTokens.length).join(' ') !== phrase) continue;
      for (let index = start; index < start + phraseTokens.length; index += 1) {
        indexes.add(index);
      }
    }
  }

  return { phrases, indexes: [...indexes].sort((a, b) => a - b) };
}

/** Explicit emergency override for auditing / policy changes. */
export function getForceLlmSafetyReview(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.FORCE_LLM_SAFETY_REVIEW?.trim() ?? '');
}

function phraseKey(words: readonly string[]): string {
  return words.map(normalizeSafetyToken).filter(Boolean).join(' ');
}

const ALLOWLIST_KEYS = SAFETY_ALLOWLIST.map(phraseKey).filter(Boolean);

interface CompiledWord {
  category: SafetyLexiconCategory;
  term: string;
  /** Exact normalized word alternatives, including suffix expansions. */
  forms: readonly string[];
  /** Text regexes retain source boundaries and catch separated/leet spellings. */
  textPatterns: readonly RegExp[];
}

interface CompiledPhrase {
  category: SafetyLexiconCategory;
  term: string;
  forms: readonly string[];
  textPatterns: readonly RegExp[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function wordForms(entry: SafetyWordEntry): string[] {
  const bases = [entry.term, ...(entry.aliases ?? [])]
    .map(normalizeSafetyToken)
    .filter(Boolean);
  return unique(
    bases.flatMap((base) => [
      base,
      ...(entry.suffixes ?? []).map((suffix) => `${base}${normalizeSafetyToken(suffix)}`),
    ]),
  );
}

/** A character-level expression catches f.u.c.k / sh1t without substring matching. */
function letterExpression(character: string): string {
  const escaped = character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  switch (character) {
    case 'a': return '[a@4]';
    case 'b': return '[b8]';
    case 'e': return '[e3]';
    case 'g': return '[g69]';
    case 'i': return '[i1!|]';
    case 'o': return '[o0]';
    case 's': return '[s$5]';
    case 't': return '[t7+]';
    default: return escaped;
  }
}

function textPatternForNormalizedWord(form: string): RegExp | null {
  if (!form || !/^[a-z0-9]+$/.test(form)) return null;
  // Do not permit whitespace here: multi-token terms live in the phrase matcher.
  // Punctuation/underscore separators catch f.u.c.k and sh!t but boundaries protect
  // class, assess, cocktail and Scunthorpe.
  const body = [...form].map(letterExpression).join('[._-]*');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'giu');
}

function compile(): { words: CompiledWord[]; phrases: CompiledPhrase[] } {
  const words: CompiledWord[] = [];
  const phrases: CompiledPhrase[] = [];

  for (const [category, values] of Object.entries(SAFETY_LEXICON) as Array<[
    SafetyLexiconCategory,
    (typeof SAFETY_LEXICON)[SafetyLexiconCategory],
  ]>) {
    for (const entry of values.words) {
      const forms = wordForms(entry);
      words.push({
        category,
        term: entry.term,
        forms,
        textPatterns: forms
          .map(textPatternForNormalizedWord)
          .filter((pattern): pattern is RegExp => pattern !== null),
      });
    }
    for (const entry of values.phrases) {
      const sequences = [entry.phrase, ...(entry.aliases ?? [])]
        .map((parts) => parts.map(normalizeSafetyToken).filter(Boolean));
      const forms = unique(sequences.map((parts) => parts.join(' ')).filter(Boolean));
      const textPatterns = forms.map((form) => {
        const parts = form.split(' ').map(textPatternForNormalizedWord);
        if (parts.some((part) => !part)) return null;
        // Rebuild from sources to permit natural punctuation/whitespace between phrase words.
        const body = form
          .split(' ')
          .map((word) => [...word].map(letterExpression).join('[._-]*'))
          .join('[\\s\\p{P}_]+');
        return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'giu');
      }).filter((pattern): pattern is RegExp => pattern !== null);
      phrases.push({ category, term: entry.phrase.join(' '), forms, textPatterns });
    }
  }

  // Long phrase/word first makes e.g. motherfucker win over fuck while range
  // de-duplication below handles ties deterministically.
  words.sort((a, b) => Math.max(...b.forms.map((value) => value.length)) - Math.max(...a.forms.map((value) => value.length)));
  phrases.sort((a, b) => Math.max(...b.forms.map((value) => value.length)) - Math.max(...a.forms.map((value) => value.length)));
  return { words, phrases };
}

const COMPILED = compile();

function rangeIsAllowlisted(tokens: readonly string[], start: number, end: number): boolean {
  for (const allowed of ALLOWLIST_KEYS) {
    const allowedTokens = allowed.split(' ');
    const from = Math.max(0, start - allowedTokens.length + 1);
    const to = Math.min(tokens.length - allowedTokens.length, end);
    for (let candidate = from; candidate <= to; candidate += 1) {
      if (tokens.slice(candidate, candidate + allowedTokens.length).join(' ') === allowed) return true;
    }
  }
  return false;
}

function matchStaticTranscriptWords(words: readonly Pick<TranscriptSafetyWord, 'word'>[]): ProfanityMatch[] {
  const tokens = words.map((word) => normalizeSafetyToken(word.word));
  const matches: ProfanityMatch[] = [];

  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if (!token) continue;
    for (const entry of COMPILED.words) {
      if (!entry.forms.includes(token)) continue;
      if (rangeIsAllowlisted(tokens, start, start)) continue;
      matches.push({ startIndex: start, endIndex: start, category: entry.category, term: entry.term, source: 'static' });
    }
    for (const entry of COMPILED.phrases) {
      for (const form of entry.forms) {
        const parts = form.split(' ');
        if (parts.length === 1) {
          if (parts[0] !== token) continue;
        } else if (tokens.slice(start, start + parts.length).join(' ') !== form) {
          continue;
        }
        const end = start + parts.length - 1;
        if (rangeIsAllowlisted(tokens, start, end)) continue;
        matches.push({ startIndex: start, endIndex: end, category: entry.category, term: entry.term, source: 'static' });
      }
    }
  }
  return normalizeMatches(matches);
}

function normalizeMatches(matches: ProfanityMatch[]): ProfanityMatch[] {
  const byRange = new Map<string, ProfanityMatch>();
  for (const match of matches) {
    const key = `${match.startIndex}:${match.endIndex}`;
    const current = byRange.get(key);
    // Phrase and context matches are more informative than a shorter word match.
    if (!current || match.endIndex - match.startIndex > current.endIndex - current.startIndex) {
      byRange.set(key, match);
    }
  }
  return [...byRange.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
}

/**
 * Static transcript matching with a sliding word window. Returned ranges map directly
 * to Deepgram timestamps, including every word in a multi-word policy phrase.
 */
export function findProfanityMatches(
  words: readonly Pick<TranscriptSafetyWord, 'word'>[],
  additionalWordIndexes: readonly number[] = [],
): ProfanityMatch[] {
  const staticMatches = matchStaticTranscriptWords(words);
  const contextMatches = unique(additionalWordIndexes)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < words.length)
    .map((index) => ({
      startIndex: index,
      endIndex: index,
      category: 'profanity' as SafetyLexiconCategory,
      term: 'context-policy',
      source: 'context' as const,
    }));
  return normalizeMatches([...staticMatches, ...contextMatches]);
}

interface TextRange {
  start: number;
  end: number;
}

function allowlistedTextRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const allowed of ALLOWLIST_KEYS) {
    const parts = allowed.split(' ').map((word) => [...word].map(letterExpression).join('[._-]*'));
    const matcher = new RegExp(`(?<![A-Za-z0-9])${parts.join('[\\s\\p{P}_]+')}(?![A-Za-z0-9])`, 'giu');
    for (const found of text.matchAll(matcher)) {
      if (found.index !== undefined) ranges.push({ start: found.index, end: found.index + found[0].length });
    }
  }
  return ranges;
}

function isInsideAny(range: TextRange, containers: readonly TextRange[]): boolean {
  return containers.some((container) => range.start >= container.start && range.end <= container.end);
}

function textSafetyRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const entry of [...COMPILED.phrases, ...COMPILED.words]) {
    for (const template of entry.textPatterns) {
      const matcher = new RegExp(template.source, template.flags);
      for (const found of text.matchAll(matcher)) {
        if (found.index !== undefined) ranges.push({ start: found.index, end: found.index + found[0].length });
      }
    }
  }
  const allowlisted = allowlistedTextRanges(text);
  return ranges
    .filter((range) => !isInsideAny(range, allowlisted))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
}

function maskToken(value: string): string {
  const characters = [...value];
  if (characters.length <= 2) return value;
  return characters[0] + '*'.repeat(characters.length - 2) + characters[characters.length - 1];
}

/** Mask all visible word-like pieces of a matching word or phrase. */
function maskRange(value: string): string {
  return value.replace(TOKEN_CHARS, (token) => {
    // Preserve hashtag punctuation but mask its actual term.
    const firstWord = [...token].findIndex((character) => ASCII_WORD.test(character));
    if (firstWord < 0) return token;
    const lastWord = [...token].map((character) => ASCII_WORD.test(character)).lastIndexOf(true);
    const prefix = token.slice(0, firstWord);
    const word = token.slice(firstWord, lastWord + 1);
    const suffix = token.slice(lastWord + 1);
    return `${prefix}${maskToken(word)}${suffix}`;
  });
}

/** Boundary-safe masking for captions, hooks, CTAs, titles and hashtags. */
export function maskProfanity(text: string): string {
  if (!text) return text;
  const ranges = textSafetyRanges(text);
  if (!ranges.length) return text;
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += text.slice(cursor, range.start);
    output += maskRange(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

export function containsProfanity(text: string): boolean {
  return Boolean(text && textSafetyRanges(text).length);
}

/**
 * Returns a fresh word array for Remotion without touching the stored transcript.
 * A phrase masks every covered word, not only the final explicit slur.
 */
/** Resolve static phrase ranges plus contextual decisions once for a render. */
export function resolveCensoredWordIndexes(
  words: readonly Pick<TranscriptSafetyWord, 'word'>[],
  additionalWordIndexes: readonly number[] = [],
): number[] {
  const unsafe = new Set<number>();
  for (const match of findProfanityMatches(words, additionalWordIndexes)) {
    for (let index = match.startIndex; index <= match.endIndex; index += 1) unsafe.add(index);
  }
  return [...unsafe].sort((a, b) => a - b);
}

/** Apply a previously resolved index set without ever mutating the transcript. */
export function maskTranscriptWordsFromIndexes<T extends { word: string }>(
  words: readonly T[],
  censoredWordIndexes: readonly number[],
): T[] {
  const unsafe = new Set(censoredWordIndexes);
  return words.map((word, index) => ({
    ...word,
    word: unsafe.has(index) ? maskRange(word.word) : maskProfanity(word.word),
  }));
}

export function maskTranscriptWords<T extends { word: string }>(
  words: readonly T[],
  additionalWordIndexes: readonly number[] = [],
): T[] {
  return maskTranscriptWordsFromIndexes(
    words,
    resolveCensoredWordIndexes(words, additionalWordIndexes),
  );
}

/**
 * Optional LLM second pass. It sees indexed words only and returns JSON
 * `{ "indexes": [1, 2] }`. Static matching always runs first; provider errors,
 * malformed JSON and missing keys deliberately return an empty list so rendering is
 * never blocked by this enhancement.
 */
export async function findContextCensorWordIndexes(
  words: readonly Pick<TranscriptSafetyWord, 'word'>[],
  options: { enabled: boolean; signal?: AbortSignal } = { enabled: false },
): Promise<number[]> {
  if (!options.enabled || words.length === 0) return [];
  if (options.signal?.aborted) throw new RenderCancelledError();
  try {
    const { completeWithFallback } = await import('./llm');
    const transcript = words
      .map((word, index) => `${index}:${word.word}`)
      .join(' ')
      .slice(0, 24_000);
    const result = await completeWithFallback({
      task: 'render safety context review',
      taskKind: 'safety-review',
      system: 'You are a strict child-safe video moderation pass. Return only JSON. Flag word indexes that form profanity, sexual content, slurs or hate, threats or graphic violence, self-harm, drug references, or other language major short-video platforms would not permit children to hear. Do not flag harmless context.',
      prompt: `Transcript words with indexes:\n${transcript}\n\nReturn exactly {"indexes":[non-negative integer indexes]}.`,
      json: true,
      temperature: 0,
      maxTokens: 250,
      signal: options.signal,
    });
    const parsed = JSON.parse(result.text) as { indexes?: unknown };
    if (!Array.isArray(parsed.indexes)) return [];
    return unique(parsed.indexes)
      .filter((index): index is number => Number.isInteger(index) && index >= 0 && index < words.length)
      .sort((a, b) => a - b);
  } catch (error) {
    if (options.signal?.aborted || error instanceof RenderCancelledError) throw new RenderCancelledError();
    console.warn(`[profanity] Context moderation unavailable; static safety filter remains active: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

let storedModeOverride: ProfanityAudioMode | null = null;
let storedContextPassOverride: boolean | null = null;

export function setProfanityAudioModeOverride(mode: ProfanityAudioMode | null): void {
  storedModeOverride = mode;
}

export function setProfanityContextPassOverride(enabled: boolean | null): void {
  storedContextPassOverride = enabled;
}

export function getProfanityAudioMode(): ProfanityAudioMode {
  return storedModeOverride ?? DEFAULT_PROFANITY_SETTINGS.audioMode;
}

export function getProfanityContextPassEnabled(): boolean {
  return storedContextPassOverride ?? DEFAULT_PROFANITY_SETTINGS.contextPassEnabled;
}

const PROFANITY_PADDING_SECONDS = 0.07;

/**
 * Final-timeline audio windows for static phrases, inflections and optional context
 * indexes. Every edge gets 70 ms of guard band so timestamp quantisation cannot leak
 * a consonant; touching windows are merged before FFmpeg sees them.
 */
export function buildProfanityWindowsFromIndexes(
  words: readonly TranscriptSafetyWord[],
  hookStart: number,
  hookDuration: number,
  baseDuration: number,
  censoredWordIndexes: readonly number[],
  paddingSeconds = PROFANITY_PADDING_SECONDS,
): [number, number][] {
  if (!words.length) return [];
  const hookDur = Math.max(0, hookDuration);
  const hookOffset = Math.max(0, hookStart);
  const finalDuration = Math.max(0, baseDuration) + hookDur;
  const padding = Math.max(0, Math.min(0.25, paddingSeconds));
  const windows: [number, number][] = [];
  const indexes = [...new Set(censoredWordIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < words.length)
    .sort((a, b) => a - b);

  // Merge adjacent phrase words into one source range before timeline padding.
  for (let offset = 0; offset < indexes.length;) {
    let endOffset = offset;
    while (endOffset + 1 < indexes.length && indexes[endOffset + 1] === indexes[endOffset] + 1) endOffset += 1;
    const covered = words.slice(indexes[offset], indexes[endOffset] + 1);
    const start = Math.max(0, Math.min(...covered.map((word) => word.start)));
    const end = Math.min(baseDuration, Math.max(...covered.map((word) => word.end)));
    if (end > start) {
      windows.push([start + hookDur, end + hookDur]);
      if (hookDur > 0 && end > hookOffset && start < hookOffset + hookDur) {
        const previewStart = Math.max(0, start - hookOffset);
        const previewEnd = Math.min(hookDur, end - hookOffset);
        if (previewEnd > previewStart) windows.push([previewStart, previewEnd]);
      }
    }
    offset = endOffset + 1;
  }

  const padded = windows
    .map(([start, end]) => [Math.max(0, start - padding), Math.min(finalDuration, end + padding)] as [number, number])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of padded) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 0.001) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function buildProfanityWindows(
  words: readonly TranscriptSafetyWord[],
  hookStart: number,
  hookDuration: number,
  baseDuration: number,
  additionalWordIndexes: readonly number[] = [],
  paddingSeconds = PROFANITY_PADDING_SECONDS,
): [number, number][] {
  return buildProfanityWindowsFromIndexes(
    words,
    hookStart,
    hookDuration,
    baseDuration,
    resolveCensoredWordIndexes(words, additionalWordIndexes),
    paddingSeconds,
  );
}

export interface ProfanityAudioFilter {
  extraArgs: string[];
  filters: string[];
  audioLabel: string;
}

export function buildProfanityAudioFilter(
  windows: [number, number][],
  mode: ProfanityAudioMode,
  totalDurationSeconds: number,
  toneInputIndex: number,
  baseAudioLabel = '0:a',
): ProfanityAudioFilter | null {
  if (mode === 'off' || windows.length === 0) return null;
  const f = (value: number) => value.toFixed(3);
  const muteIn = (window: [number, number]) =>
    `volume=enable='between(t,${f(window[0])},${f(window[1])})':volume=0`;
  const gateOut = (window: [number, number]) =>
    `volume=0.25,volume=enable='lt(t,${f(window[0])})+gt(t,${f(window[1])})':volume=0`;

  if (mode === 'mute') {
    return {
      extraArgs: [],
      filters: [`[${baseAudioLabel}]${windows.map(muteIn).join(',')}[pa]`],
      audioLabel: '[pa]',
    };
  }

  const count = windows.length;
  const filters: string[] = [`[${toneInputIndex}:a]asplit=${count}${Array.from({ length: count }, (_, index) => `[s${index}]`).join('')}`];
  for (let index = 0; index < count; index += 1) filters.push(`[s${index}]${gateOut(windows[index])}[g${index}]`);
  filters.push(`[${baseAudioLabel}]${windows.map(muteIn).join(',')}[base]`);
  filters.push(`[base]${Array.from({ length: count }, (_, index) => `[g${index}]`).join('')}amix=inputs=${count + 1}:normalize=0:dropout_transition=0[pa]`);
  return {
    extraArgs: ['-f', 'lavfi', '-t', f(Math.max(0.1, totalDurationSeconds)), '-i', 'sine=frequency=1000:sample_rate=44100'],
    filters,
    audioLabel: '[pa]',
  };
}
