/**
 * Put a B-roll card on the frame where its word is actually spoken.
 *
 * The failure this module exists to stop: the analysis returns a moment such as
 *
 *   { "visualKeywords": ["cash"], "start": 41.2, "end": 43.7 }
 *
 * and the image appears a second and a half after the speaker says "cash", or
 * over a completely different sentence when the model's arithmetic drifts. The
 * model is good at naming the thing and bad at counting seconds.
 *
 * So every moment is re-anchored to a TRANSCRIPT WORD:
 *
 *  1. `anchorText` (the words the model pointed at) is located in the clip's
 *     word timings, tolerant of plural and punctuation differences;
 *  2. a model-supplied `wordIndex` is accepted only when it is within
 *     `ANCHOR_TOLERANCE_WORDS` of a word the anchor text really matches;
 *  3. the start is that word's start, floored onto the output frame grid, so a
 *     card may begin at most ONE frame early and never late;
 *  4. a moment that cannot be anchored is dropped, never placed on the model's
 *     guessed seconds.
 *
 * `BROLL_EXACT_SYNC=0` restores the old behaviour (the model's seconds), for
 * rolling back a render that went wrong.
 */

import type { WordTimestamp } from "../types";

/** How far a model-supplied word index may be from the word its anchor text matches. */
export const ANCHOR_TOLERANCE_WORDS = 4;

/** Words that carry no picture and must never become an anchor by themselves. */
const STOPWORDS = new Set([
  "a", "about", "after", "again", "against", "all", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "did", "do", "does", "doing", "don",
  "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off",
  "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves",
  "out", "over", "own", "same", "she", "should", "so", "some", "such", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until",
  "up", "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
  "yourself", "yourselves", "s", "t", "re", "ve", "ll", "d", "m",
]);

/** Lower-case, punctuation-free words (apostrophes kept: "that's" -> "thats"). */
export function syncTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/'/g, "").trim())
    .filter(Boolean);
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Plural / possessive tolerant equality: "cars" == "car", "musk's" == "musk". */
export function syncTokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const strip = (word: string) => {
    if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    // Plurals: "cars" -> "car", "houses" -> "house". The first branch must not
    // swallow the "s" of a "-se" word, which is why it excludes "ses".
    if (word.endsWith("ses")) return word.slice(0, -1);
    if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
    if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
    return word;
  };
  // "gas" must not equal "ga": a plural is only stripped when the shorter word
  // is long enough to stand on its own.
  if (strip(a) === strip(b)) {
    return a === strip(a) || b === strip(b) || Math.min(a.length, b.length) > 3;
  }
  return false;
}

export interface AnchorMatch {
  /** Index of the ANCHOR word in the clip's word list (the first matched word). */
  wordIndex: number;
  /** How many consecutive anchor tokens matched from there. */
  matched: number;
  /** 0..1 - the share of the anchor's meaningful tokens that matched. */
  score: number;
  /** Where the match came from, for the log line. */
  via: "anchorText" | "wordIndex" | "anchorText+wordIndex";
}

function meaningful(tokens: readonly string[]): string[] {
  const kept = tokens.filter((token) => !isStopword(token));
  return kept.length > 0 ? kept : [...tokens];
}

/**
 * Score how well a moment's anchor text matches the transcript starting at
 * `wordIndex`. Consecutive tokens must line up; stopwords in the transcript are
 * skipped, never the anchor's own words.
 */
function matchAt(
  anchor: readonly string[],
  haystack: readonly string[],
  wordIndex: number,
): { matched: number; lastIndex: number } {
  // The anchor's FIRST word must be the word at `wordIndex` - otherwise every
  // "the ..." in the clip would be a candidate for a phrase that starts later.
  const first = syncTokens(haystack[wordIndex]);
  if (!first.some((word) => syncTokenMatches(word, anchor[0]))) {
    return { matched: 0, lastIndex: wordIndex };
  }
  let cursor = wordIndex + 1;
  let matched = 1;
  for (const token of anchor.slice(1)) {
    let probe = cursor;
    while (probe < haystack.length && syncTokens(haystack[probe]).every(isStopword)) {
      probe += 1;
    }
    if (probe >= haystack.length) break;
    const words = syncTokens(haystack[probe]);
    if (words.some((word) => syncTokenMatches(word, token))) {
      matched += 1;
      cursor = probe + 1;
    } else if (matched > 0) {
      break;
    } else {
      return { matched: 0, lastIndex: wordIndex };
    }
  }
  return { matched, lastIndex: Math.max(wordIndex, cursor - 1) };
}

export interface AnchorInput {
  /** The words the model says the picture belongs to. */
  anchorText?: string;
  /** The model's transcript index, if it supplied one. */
  wordIndex?: number;
  words: readonly WordTimestamp[];
  /** The moment's own window, used to break ties and as the legacy start. */
  start: number;
  end: number;
}

export interface AnchoredMoment {
  /** Transcript index of the anchor word. */
  wordIndex: number;
  /** Clip-relative seconds of that word's start. */
  wordStart: number;
  anchorText: string;
  via: AnchorMatch["via"];
  score: number;
}

const MIN_ANCHOR_SCORE = 0.5;

/**
 * Find the transcript word a moment belongs to, or null when it cannot be
 * anchored. Ties go to the occurrence closest to the moment's own start.
 */
export function anchorMoment(input: AnchorInput): AnchoredMoment | null {
  const { words } = input;
  if (words.length === 0) return null;
  const anchorTokens = meaningful(syncTokens(input.anchorText ?? ""));
  const haystack = words.map((word) => word.word);

  const candidates: Array<{ wordIndex: number; matched: number; last: number }> = [];

  if (anchorTokens.length > 0) {
    const minMatched = Math.max(1, Math.ceil(anchorTokens.length * MIN_ANCHOR_SCORE));
    for (let index = 0; index < words.length; index += 1) {
      const { matched, lastIndex } = matchAt(anchorTokens, haystack, index);
      if (matched >= minMatched) candidates.push({ wordIndex: index, matched, last: lastIndex });
    }
  }

  if (candidates.length > 0) {
    const ranked = [...candidates].sort((a, b) => {
      if (b.matched !== a.matched) return b.matched - a.matched;
      return (
        Math.abs(words[a.wordIndex].start - input.start) -
        Math.abs(words[b.wordIndex].start - input.start)
      );
    });
    const best = ranked[0];
    const score = best.matched / Math.max(1, anchorTokens.length);
    // A model-supplied index is trusted only when it agrees with the text.
    if (
      typeof input.wordIndex === "number" &&
      Number.isInteger(input.wordIndex) &&
      input.wordIndex >= 0 &&
      Math.abs(input.wordIndex - best.wordIndex) <= ANCHOR_TOLERANCE_WORDS
    ) {
      return {
        wordIndex: best.wordIndex,
        wordStart: words[best.wordIndex].start,
        anchorText: input.anchorText?.trim() || words[best.wordIndex].word,
        via: "anchorText+wordIndex",
        score,
      };
    }
    return {
      wordIndex: best.wordIndex,
      wordStart: words[best.wordIndex].start,
      anchorText: input.anchorText?.trim() || words[best.wordIndex].word,
      via: "anchorText",
      score,
    };
  }

  // No usable anchor text: fall back to an index ONLY when that word is a real
  // content word. A guessed index onto "the" is exactly the drift we are fixing.
  if (
    typeof input.wordIndex === "number" &&
    Number.isInteger(input.wordIndex) &&
    input.wordIndex >= 0 &&
    input.wordIndex < words.length &&
    !syncTokens(words[input.wordIndex].word).every(isStopword)
  ) {
    return {
      wordIndex: input.wordIndex,
      wordStart: words[input.wordIndex].start,
      anchorText: words[input.wordIndex].word,
      via: "wordIndex",
      score: 0.5,
    };
  }
  return null;
}

/** The first frame at or before `seconds`, in frame units (never late). */
export function floorToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.floor(seconds * fps + 1e-6);
}

/** How far into the future a word start sat, in ms, for the log line. */
export function frameDeltaMs(
  modelStart: number,
  finalStart: number,
): number {
  return Math.round((modelStart - finalStart) * 1000);
}

/**
 * Words that read as an action rather than a picture. The fallback path never
 * searches for these ("visited the Eiffel Tower" must not become a stock search
 * for "visited").
 */
const ACTION_WORDS = new Set([
  "visited", "visit", "went", "gone", "going", "said", "says", "told", "tell",
  "asked", "asking", "think", "thought", "thinking", "know", "knew", "knows",
  "want", "wanted", "wants", "need", "needed", "needs", "look", "looked",
  "looking", "get", "got", "getting", "make", "made", "making", "take", "took",
  "taken", "give", "gave", "given", "come", "came", "coming", "start", "started",
  "trying", "tried", "try", "work", "worked", "working", "call", "called",
  "talk", "talked", "talking", "mean", "meant", "feel", "felt", "feels",
  "believe", "believed", "happen", "happened", "happens", "doing", "done",
  "done", "actually", "literally", "basically", "really", "kinda", "gonna",
  "wanna", "gotta", "probably", "maybe", "pretty", "every", "much", "many",
]);

/** A token that can carry a picture on its own. */
function isPictureToken(token: string): boolean {
  return Boolean(token) && !isStopword(token) && !ACTION_WORDS.has(token) && token.length >= 3;
}

/**
 * Default keyword moments when the analysis is unavailable: proper nouns first,
 * then 1-3 word content phrases. At most one card every `minSpacingSeconds`,
 * lowest relevance, and never a sentence fragment.
 */
export function concreteFallbackKeywords(
  words: readonly WordTimestamp[],
  clipDuration: number,
  options: { maxMoments?: number; minSpacingSeconds?: number } = {},
): Array<{
  visualKeywords: string[];
  start: number;
  end: number;
  anchorText: string;
  wordIndex: number;
}> {
  const maxMoments = Math.max(0, options.maxMoments ?? 6);
  const minSpacing = Math.max(0, options.minSpacingSeconds ?? 10);
  const out: Array<{
    visualKeywords: string[];
    start: number;
    end: number;
    anchorText: string;
    wordIndex: number;
  }> = [];
  if (maxMoments === 0 || words.length === 0) return out;

  const clean = (value: string) => value.replace(/[^A-Za-z0-9'-]/g, "");
  const seen = new Set<string>();
  const taken = new Set<number>();
  let lastStart = Number.NEGATIVE_INFINITY;

  const place = (index: number, keyword: string): void => {
    const start = Math.max(0, Math.min(clipDuration, words[index].start));
    if (start >= clipDuration) return;
    if (start - lastStart < minSpacing) return;
    lastStart = start;
    taken.add(index);
    out.push({
      visualKeywords: [keyword],
      start,
      end: Math.min(clipDuration, start + 1.5),
      anchorText: clean(words[index].word),
      wordIndex: index,
    });
  };

  const isProperNoun = (index: number): boolean => {
    const raw = words[index].word.replace(/^[^A-Za-z]+/, "");
    if (!/^[A-Z]/.test(raw)) return false;
    const tokens = syncTokens(words[index].word);
    if (tokens.length !== 1 || !isPictureToken(tokens[0])) return false;
    // A capitalised word at a sentence start is not evidence of a proper noun.
    const previous = words[index - 1];
    return Boolean(previous) && !/[.!?]$/.test(previous.word.trim());
  };

  // Pass 1: proper nouns, kept as the phrase they appear in ("Eiffel Tower").
  for (let index = 0; index < words.length && out.length < maxMoments; index += 1) {
    if (!isProperNoun(index)) continue;
    const tokens = syncTokens(words[index].word);
    if (seen.has(tokens[0])) continue;
    const next = words[index + 1];
    const nextTokens = next ? syncTokens(next.word) : [];
    const paired =
      nextTokens.length === 1 &&
      isPictureToken(nextTokens[0]) &&
      /^[A-Z]/.test(next.word.replace(/^[^A-Za-z]+/, ""));
    const phrase = paired
      ? `${clean(words[index].word)} ${clean(next.word)}`
      : clean(words[index].word);
    seen.add(tokens[0]);
    place(index, phrase);
  }

  // Pass 2: content words, in a 1-2 word phrase, for the rest of the clip.
  for (let index = 0; index < words.length && out.length < maxMoments; index += 1) {
    if (taken.has(index)) continue;
    const tokens = syncTokens(words[index].word);
    if (tokens.length !== 1 || !isPictureToken(tokens[0]) || seen.has(tokens[0])) continue;
    const phrase = [clean(words[index].word)];
    const next = words[index + 1];
    const nextTokens = next ? syncTokens(next.word) : [];
    if (nextTokens.length === 1 && isPictureToken(nextTokens[0])) {
      phrase.push(clean(next.word));
    }
    const keyword = phrase.join(" ").trim();
    if (!isPlausibleFallbackKeyword(keyword)) continue;
    seen.add(tokens[0]);
    place(index, keyword);
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * A generous, photographable-phrase filter for the fallback path: 1-3 words,
 * at least one non-stopword, never a whole sentence.
 */
export function isPlausibleFallbackKeyword(phrase: string): boolean {
  const tokens = syncTokens(phrase);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.some((token) => !isStopword(token));
}
