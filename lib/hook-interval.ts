/**
 * Where the hook replay comes from.
 *
 * The video's hook is a sentence the transcript already contains, and the
 * transcript already knows exactly when each word was spoken. So the ONLY
 * reliable source for "replay that sentence as the cold open" is the word
 * timings of that sentence - not a timestamp pair the LLM guessed.
 *
 * A real run made this concrete: viral detection returned a 22.9 s hook
 * (1665.8-1688.7 s), which `reusableViralHookInterval` rejected as invalid
 * (longer than half the clip), so the fallback LLM call picked
 * 1742.6-1745.6 s - three seconds 77 s into the clip - while the overlay still
 * showed the original hook_line. The intro replayed the wrong moment.
 *
 * Resolution order (Phase 3a):
 *   1. locate hook_line in the transcript words (normalized fuzzy match,
 *      preferring matches inside the clip window) and use those word times,
 *      trimmed to the maximum hook length at a WORD boundary;
 *   2. the viral-provided interval, when it is valid;
 *   3. the LLM fallback - and even then only when the transcript text inside its
 *      interval overlaps hook_line by at least 50 %; otherwise it is discarded.
 *
 * Pure functions only: the caller does the LLM call and the logging.
 */

import type { WordTimestamp } from './types';
import { parseTimestamp } from './viral-response';

/** Where a resolved interval came from. */
export type HookIntervalSource = 'transcript-words' | 'viral-response' | 'picker' | 'none';

export interface HookInterval {
  /** Absolute source-video seconds. */
  start: number;
  end: number;
  source: HookIntervalSource;
  /** 0..1 confidence of the transcript match (1 for the other sources). */
  score: number;
  /** The transcript words the interval was built from, when it came from words. */
  words?: string[];
}

export interface TranscriptHookMatchOptions {
  /** Clip window in absolute seconds: matches inside it are preferred. */
  clipStart: number;
  clipEnd: number;
  /** Maximum hook length in seconds (the configured hook duration). */
  maxSeconds: number;
  /**
   * Minimum share of the hook line's tokens that must be found in order inside
   * the window. 0.6 tolerates a transcription hiccup ("you are the cutest kid"
   * vs "you're the cutest kid") without matching a different sentence.
   */
  minScore?: number;
  /** How far before the clip a match may start (context for the intro). */
  lookbackSeconds?: number;
}

/** Lowercase, strip punctuation/diacritics and collapse whitespace. */
export function normalizeHookText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(text: string): string[] {
  return compactTokens(text);
}

/** "that's" -> "thats": normalizeHookText drops the apostrophe without a space. */
function compactTokens(text: string): string[] {
  return normalizeHookText(text).split(' ').filter(Boolean);
}

/** Two tokens count as equal when they are the same word up to a plural/verb ending. */
export function hookTokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.replace(/'/g, '') === b.replace(/'/g, '')) return true;
  // "thats" vs "that": an apostrophe inside a contraction is not a real word.
  if (a.length > 3 && (a === `${b}s` || b === `${a}s`)) return true;
  const strip = (token: string): string =>
    token.replace(/(ing|ed|es|s)$/, '').replace(/([^aeiou])\1$/, '$1');
  const sa = strip(a);
  const sb = strip(b);
  return sa.length >= 3 && sa === sb;
}

/**
 * How many of `needle`'s tokens appear IN ORDER inside `haystack`, as a share of
 * the needle's length. This is a subsequence score, not an exact match, so a
 * dropped interjection ("and i was like oh i'm") still scores highly.
 */
export function hookTokenOverlap(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 0;
  let index = 0;
  let matched = 0;
  for (const token of haystack) {
    if (index >= needle.length) break;
    if (hookTokensMatch(token, needle[index])) {
      index += 1;
      matched += 1;
    }
  }
  return matched / needle.length;
}

/**
 * Words a speaker says while restarting a sentence. A short run of these may
 * sit between two matched words; anything else breaks the alignment.
 */
const DISFLUENCY_TOKENS = new Set([
  'uh', 'uhm', 'um', 'erm', 'er', 'ah', 'hmm', 'mm', 'like', 'so', 'and', 'but',
  'well', 'yeah', 'okay', 'ok', 'i', 'mean', 'you', 'know', 'just', 'then',
]);

interface WordMatch {
  startIndex: number;
  endIndex: number;
  score: number;
  /** Distance of the match from the clip window (0 = inside it). */
  distance: number;
  matched: number;
}

/** Bounds on the alignment repairs, so a "match" can never span sentences. */
const MAX_FILLER_RUN = 3;
const MAX_INSERTIONS = 2;
const MAX_DELETIONS = 2;

interface Alignment {
  endIndex: number;
  matched: number;
  consumed: number;
}

/**
 * Align `needle` against `haystack` from `startIndex` with three bounded
 * repairs - the same repairs a human makes when comparing a transcript to what
 * was said:
 *
 *  - INSERTION: the transcript has a word the hook line does not ("that has
 *    ever" for "that's ever"). Allowed when the very next word matches.
 *  - DELETION: the transcript swallowed a word the hook line has ("you are"
 *    for "you're"). Allowed when the current word matches a later token.
 *  - FILLER: a short run of disfluencies ("uh", "like", "i mean") sits between
 *    two matched words.
 *
 * Anything else ENDS the alignment, which is what keeps a match from crossing
 * into the next unrelated sentence.
 */
function alignFrom(
  needle: readonly string[],
  haystack: readonly string[],
  startIndex: number,
): Alignment {
  let i = 1;
  let j = startIndex + 1;
  let matched = 1;
  let insertions = 0;
  let deletions = 0;
  let endIndex = startIndex;

  while (i < needle.length && j < haystack.length) {
    if (hookTokensMatch(haystack[j], needle[i])) {
      endIndex = j;
      matched += 1;
      i += 1;
      j += 1;
      continue;
    }
    // Filler run between two matched words.
    let filler = j;
    while (filler < haystack.length && DISFLUENCY_TOKENS.has(haystack[filler]) && filler - j <= MAX_FILLER_RUN) {
      if (i < needle.length && hookTokensMatch(haystack[filler + 1] ?? '', needle[i])) break;
      filler += 1;
    }
    if (filler > j && filler < haystack.length && i < needle.length && hookTokensMatch(haystack[filler], needle[i])) {
      j = filler;
      continue;
    }
    // Insertion: skip the transcript's extra word when the next one matches.
    if (
      insertions < MAX_INSERTIONS &&
      j + 1 < haystack.length &&
      hookTokensMatch(haystack[j + 1], needle[i])
    ) {
      insertions += 1;
      j += 1;
      continue;
    }
    // Deletion: the transcript swallowed this hook token.
    if (
      deletions < MAX_DELETIONS &&
      i + 1 < needle.length &&
      hookTokensMatch(haystack[j], needle[i + 1])
    ) {
      deletions += 1;
      i += 1;
      continue;
    }
    break;
  }

  return { endIndex, matched, consumed: i };
}

/**
 * Find the run of transcript words that spells out `hookLine`.
 *
 * Every start position where the first hook token appears is aligned (see
 * `alignFrom`), scored by the share of hook tokens that matched, and the best
 * score wins - ties go to the match closest to the clip window. The result is
 * trimmed to `maxSeconds` at a WORD boundary so the intro never cuts mid-word.
 */
export function findHookWords(
  hookLine: string,
  words: readonly WordTimestamp[],
  options: TranscriptHookMatchOptions,
): HookInterval | null {
  const needle = tokensOf(hookLine);
  if (needle.length === 0 || words.length === 0) return null;
  const minScore = options.minScore ?? 0.6;
  const lookback = options.lookbackSeconds ?? 10;

  const haystack = words.map((word) => normalizeHookText(word.word));

  let best: WordMatch | null = null;
  for (let startIndex = 0; startIndex < words.length; startIndex += 1) {
    // Cheap prefilter: only start where the phrase plausibly begins.
    if (!hookTokensMatch(haystack[startIndex], needle[0])) continue;
    const alignment = alignFrom(needle, haystack, startIndex);
    const score = alignment.matched / needle.length;
    if (score < minScore) continue;

    // Prefer matches whose words actually fit inside the clip window; a match
    // that starts before it is acceptable only within the lookback.
    const matchStart = words[startIndex].start;
    const matchEnd = words[alignment.endIndex].end;
    if (matchStart < options.clipStart - lookback) continue;
    if (matchStart > options.clipEnd) continue;

    let distance = 0;
    if (matchStart < options.clipStart) distance = options.clipStart - matchStart;
    if (matchEnd > options.clipEnd) distance += matchEnd - options.clipEnd + 100;

    if (
      best === null ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && distance < best.distance)
    ) {
      best = { startIndex, endIndex: alignment.endIndex, score, distance, matched: alignment.matched };
    }
  }
  if (!best) return null;

  // Trim to the maximum hook length at a WORD boundary (never mid-word).
  const maxSeconds = Math.max(0.5, options.maxSeconds);
  const start = words[best.startIndex].start;
  let chosenEnd = words[best.endIndex].end;
  if (chosenEnd - start > maxSeconds) {
    chosenEnd = start;
    for (let index = best.startIndex; index <= best.endIndex; index += 1) {
      if (words[index].end - start > maxSeconds) break;
      chosenEnd = words[index].end;
    }
    if (chosenEnd - start <= 0) chosenEnd = Math.min(words[best.endIndex].end, start + maxSeconds);
  }
  if (!(chosenEnd > start)) return null;

  return {
    start,
    end: chosenEnd,
    source: 'transcript-words',
    score: best.score,
    words: words.slice(best.startIndex, best.endIndex + 1).map((word) => word.word),
  };
}

/** The transcript text spoken inside [start, end], in order. */
export function wordsInRange(
  words: readonly WordTimestamp[],
  start: number,
  end: number,
): string[] {
  return words
    .filter((word) => word.end > start && word.start < end)
    .map((word) => word.word);
}

/**
 * How much of `hookLine` is actually spoken inside the interval, 0..1.
 * Used to discard an LLM fallback interval that covers a different sentence.
 */
export function hookIntervalOverlap(
  hookLine: string,
  words: readonly WordTimestamp[],
  start: number,
  end: number,
): number {
  const needle = tokensOf(hookLine);
  if (needle.length === 0) return 0;
  const spoken = wordsInRange(words, start, end).flatMap((word) => tokensOf(word));
  if (spoken.length === 0) return 0;
  // A long hook line against a short window, and a short hook phrase inside a
  // longer window, are both "this window says it". The reverse comparison is
  // normalised by the SHORTER side so it cannot reward a window that merely
  // shares words in a different order ("... telling you that is wild ...").
  const longShare = longestSharedRun(needle, spoken) / needle.length;
  const phraseShare = hookTokenOverlap(spoken, needle);
  return Math.max(longShare, phraseShare);
}

/** Longest run of needle tokens that appear contiguously (modulo fillers) in the window. */
function longestSharedRun(needle: readonly string[], spoken: readonly string[]): number {
  let best = 0;
  for (let start = 0; start < spoken.length; start += 1) {
    if (!hookTokensMatch(spoken[start], needle[0])) continue;
    const translation = alignFrom(needle, spoken, start);
    best = Math.max(best, translation.matched);
  }
  return best;
}

/**
 * The viral response's own interval, honouring the same validity rules the
 * pipeline always applied (inside the clip, at least a second in, at most half
 * the clip long). Returns absolute seconds.
 */
export function viralHookInterval(
  timestamp: { start: string; end: string } | null | undefined,
  clipStart: number,
  clipEnd: number,
  minOffsetSeconds = 1,
): HookInterval | null {
  if (!timestamp) return null;
  const start = parseTimestamp(timestamp.start);
  const end = parseTimestamp(timestamp.end);
  const clipDuration = clipEnd - clipStart;
  if (start === null || end === null || end <= start) return null;
  if (start < clipStart + minOffsetSeconds) return null;
  if (end > clipEnd) return null;
  if (end - start > clipDuration / 2) return null;
  return { start, end, source: 'viral-response', score: 1 };
}

export interface ResolveHookIntervalInput {
  hookLine: string;
  words: readonly WordTimestamp[];
  clipStart: number;
  clipEnd: number;
  maxSeconds: number;
  /** The viral response's interval strings, if any. */
  viralTimestamp?: { start: string; end: string } | null;
  /** The LLM fallback's answer, already converted to absolute seconds. */
  picker?: { start: number; end: number } | null;
  /** Share of hook_line the picker's window must contain. Default 0.5. */
  pickerMinOverlap?: number;
}

/**
 * Phase 3a in one function: transcript words first, then the viral interval,
 * then the picker - with the picker's window validated against the transcript.
 */
export function resolveHookInterval(input: ResolveHookIntervalInput): HookInterval | null {
  const fromWords = findHookWords(input.hookLine, input.words, {
    clipStart: input.clipStart,
    clipEnd: input.clipEnd,
    maxSeconds: input.maxSeconds,
  });
  if (fromWords) return fromWords;

  const viral = viralHookInterval(input.viralTimestamp, input.clipStart, input.clipEnd);
  if (viral) return viral;

  if (input.picker && input.picker.end > input.picker.start) {
    const minOverlap = input.pickerMinOverlap ?? 0.5;
    const overlap = hookIntervalOverlap(
      input.hookLine,
      input.words,
      input.picker.start,
      input.picker.end,
    );
    if (overlap >= minOverlap) {
      return {
        start: input.picker.start,
        end: input.picker.end,
        source: 'picker',
        score: overlap,
      };
    }
  }
  return null;
}
