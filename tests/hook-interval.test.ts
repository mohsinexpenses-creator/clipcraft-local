/**
 * Phase 3a: the hook replay comes from the transcript's word timings for the
 * hook line, not from a guessed timestamp pair.
 *
 * The real failure: hook_line "you are the cutest kid that's ever..." with a
 * viral interval of 22.9 s (rejected as > half the clip) fell through to an LLM
 * picker that answered 3 s at 77 s into the clip, so the intro replayed a
 * different moment than the text on screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findHookWords,
  hookIntervalOverlap,
  hookTokenOverlap,
  hookTokensMatch,
  normalizeHookText,
  resolveHookInterval,
  viralHookInterval,
} from '../lib/hook-interval';
import type { WordTimestamp } from '../lib/types';

/**
 * Build word timings from a text, 0.4 s per word starting at `start`. The words
 * are the ONLY times the resolver is allowed to trust.
 */
function speech(text: string, start = 0, step = 0.4): WordTimestamp[] {
  return text.split(/\s+/).map((word, index) => ({
    word,
    start: start + index * step,
    end: start + (index + 1) * step,
  }));
}

const HOOK_LINE = "you are the cutest kid that's ever been on this show";
const TRANSCRIPT_TEXT =
  'and i was like oh i am telling you that is wild ' +
  'you are the cutest kid that has ever been on this show ' +
  'so anyway here we are talking about something else entirely';

const CLIP_START = 1665.8;
const CLIP_END = 1753.3;

/** The same words shifted to absolute source time, as a transcript stores them. */
function absoluteSpeech(text: string, start: number, step = 0.4): WordTimestamp[] {
  return speech(text, start, step);
}

test('normalization and token matching tolerate plurals and punctuation', () => {
  assert.equal(normalizeHookText("  You ARE the cutest, kid!  "), 'you are the cutest kid');
  assert.ok(hookTokensMatch('kids', 'kid'));
  assert.ok(hookTokensMatch('talking', 'talk'));
  assert.ok(!hookTokensMatch('cutest', 'wildest'));
  assert.equal(hookTokenOverlap(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), 1);
  assert.equal(hookTokenOverlap(['a', 'b'], ['x', 'y']), 0);
});

test('the hook line is located in the transcript words and trimmed at a word boundary', () => {
  // The sentence is 34 s into the clip, spoken over ~4 s.
  const words = absoluteSpeech(TRANSCRIPT_TEXT, CLIP_START, 0.4);
  const match = findHookWords(HOOK_LINE, words, {
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
  });
  assert.ok(match, 'the sentence is found');
  assert.equal(match.source, 'transcript-words');
  assert.ok(match.start > CLIP_START, 'it is inside the clip, not the opening');
  assert.ok(match.words && match.words.length >= 8, `matched words: ${match.words?.join(' ')}`);
  assert.ok(match.score >= 0.6, `score ${match.score}`);
  // Trimmed to the 6 s cap, and the end is exactly a word boundary.
  assert.ok(match.end - match.start <= 6 + 1e-6, `length ${match.end - match.start}`);
  assert.ok(
    words.some((word) => Math.abs(word.end - match.end) < 1e-6),
    'the end lands on a word end, never mid-word',
  );
});

test('a short max length still starts at the first word of the sentence', () => {
  const words = absoluteSpeech(TRANSCRIPT_TEXT, CLIP_START, 0.4);
  const short = findHookWords(HOOK_LINE, words, {
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 1.6,
  });
  assert.ok(short);
  assert.ok(short.end - short.start <= 1.6 + 1e-6);
  assert.ok(short.end - short.start > 0);
});

test('a match inside the clip beats an identical match before it', () => {
  // The same sentence spoken twice: once 200 s earlier, once inside the window.
  const before = absoluteSpeech(HOOK_LINE, 1400);
  const inside = absoluteSpeech(`filler words here ${HOOK_LINE}`, CLIP_START + 20);
  const match = resolveHookInterval({
    hookLine: HOOK_LINE,
    words: [...before, ...inside],
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
  });
  assert.ok(match);
  assert.equal(match.source, 'transcript-words');
  assert.ok(match.start >= CLIP_START, `picked the in-window match (${match.start})`);
});

test('the whole resolution order: viral interval, then words, then a validated picker', () => {
  const words = absoluteSpeech(TRANSCRIPT_TEXT, CLIP_START);

  // 1. The exact in-clip viral interval wins over a transcript match.
  const withWords = resolveHookInterval({
    hookLine: HOOK_LINE,
    words,
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
    viralTimestamp: { start: '1700.000s', end: '1706.000s' },
  });
  assert.equal(withWords?.source, 'viral-response');
  assert.equal(withWords?.start, 1700);
  assert.equal(withWords?.end, 1706);

  const transcriptFallback = resolveHookInterval({
    hookLine: HOOK_LINE,
    words,
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
  });
  assert.equal(transcriptFallback?.source, 'transcript-words');

  // 2. With no transcript match, the viral interval is used.
  const withViral = resolveHookInterval({
    hookLine: 'zzz qqq xxx yyy',
    words,
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
    viralTimestamp: { start: '1700.000s', end: '1706.000s' },
  });
  assert.equal(withViral?.source, 'viral-response');
  assert.equal(withViral?.start, 1700);

  // 3. A paraphrased hook line (the overlay wording differs from what was
  //    said) is not in the transcript, so the picker's window is the only
  //    candidate - and it is accepted because the words there match.
  const spokenHook = words.slice(15, 23);
  const matchingPicker = resolveHookInterval({
    hookLine: `zzz qqq ${spokenHook.map((word) => word.word).join(' ')}`,
    words,
    clipStart: CLIP_START,
    clipEnd: CLIP_END,
    maxSeconds: 6,
    picker: { start: spokenHook[0].start, end: spokenHook[spokenHook.length - 1].end },
  });
  assert.equal(matchingPicker?.source, 'picker', 'the picker window covers the spoken words');
  assert.ok((matchingPicker?.score ?? 0) >= 0.5);

  // 3b. The picker's window must contain the hook line: a window over the
  //     clip's opening words is discarded, not replayed.
  const pickerOverOtherWords = resolveHookInterval({
    hookLine: 'zzz qqq the cutest kid ever',
    words: words.filter((word) => word.start >= words[8].start),
    clipStart: words[8].start,
    clipEnd: CLIP_END,
    maxSeconds: 6,
    picker: { start: words[8].start, end: words[12].end },
  });
  assert.equal(pickerOverOtherWords, null, 'a window that does not say it is discarded');

  // 4. Nothing at all.
  assert.equal(
    resolveHookInterval({
      hookLine: 'zzz qqq xxx yyy',
      words,
      clipStart: CLIP_START,
      clipEnd: CLIP_END,
      maxSeconds: 6,
    }),
    null,
  );
});

test('viral interval is exact when inside the clip and rejected when outside', () => {
  const atClipStart = viralHookInterval(
    { start: '1665.800s', end: '1710.000s' },
    CLIP_START,
    CLIP_END,
  );
  assert.deepEqual(atClipStart, {
    start: CLIP_START,
    end: 1710,
    source: 'viral-response',
    score: 1,
  }, 'clip-edge and longer-than-half intervals are not rewritten');
  assert.equal(viralHookInterval({ start: '1740.000s', end: '1760.000s' }, CLIP_START, CLIP_END), null, 'ends past the clip');
  assert.equal(viralHookInterval({ start: '1660.000s', end: '1670.000s' }, CLIP_START, CLIP_END), null, 'starts before the clip');
  assert.equal(viralHookInterval({ start: '1700.000s', end: '1705.000s' }, CLIP_START, CLIP_END)?.start, 1700);
});

test('overlap measures what is actually spoken inside a window', () => {
  const words = absoluteSpeech(TRANSCRIPT_TEXT, CLIP_START);
  const found = findHookWords(HOOK_LINE, words, { clipStart: CLIP_START, clipEnd: CLIP_END, maxSeconds: 6 });
  assert.ok(found);
  assert.ok(hookIntervalOverlap(HOOK_LINE, words, found.start, found.end) > 0.5);
  assert.equal(hookIntervalOverlap(HOOK_LINE, words, words[0].start, words[1].end), 0);
});

/**
 * Phase 3b: a present safety_analysis (even with risky_words: []) is valid data.
 * The real run paid for a 7.3 s moderation call because an EMPTY list was read
 * as "no data".
 */
test('an empty risky_words list counts as safety data, a missing section does not', async () => {
  const { hasViralSafetyData } = await import('../lib/profanity');
  const empty = {
    safety_analysis: {
      risk_level: 'safe',
      monetization_risk: 'none',
      reused_content_risk: 'none',
      algorithm_suppression_risk: 'none',
      ineligible_for_fyf_risk: 'none',
      risky_words: [],
    },
  };
  assert.equal(hasViralSafetyData(empty), true, 'nothing risky IS an answer');
  assert.equal(hasViralSafetyData({ safety_analysis: { risky_words: [{ word_or_phrase: 'damn', reason: 'x', action: 'mute' }] } } as never), true);
  assert.equal(hasViralSafetyData(null), false);
  assert.equal(hasViralSafetyData({}), false, 'missing section');
  assert.equal(hasViralSafetyData({ safety_analysis: {} } as never), false, 'missing field');
  assert.equal(hasViralSafetyData({ safety_analysis: { risky_words: 'none' } } as never), false, 'malformed field');
  assert.equal(hasViralSafetyData({ safety_analysis: { risky_words: [1, 2] } } as never), false, 'malformed entries');
});

test('the safety matcher still censors exactly what it did before', async () => {
  const { findViralSafetyWordIndexes } = await import('../lib/profanity');
  const words = 'this is damn weird and you are an idiot'.split(' ').map((word) => ({ word }));
  const analysis = {
    safety_analysis: {
      risky_words: [
        { word_or_phrase: 'damn', reason: 'mild', action: 'mute' as const },
        { word_or_phrase: 'an idiot', reason: 'insult', action: 'mute' as const },
      ],
    },
  };
  const result = findViralSafetyWordIndexes(words, analysis as never);
  assert.deepEqual(result.phrases, ['damn', 'an idiot']);
  // 'this is damn weird and you are an idiot' -> damn=2, an=7, idiot=8
  assert.deepEqual(result.indexes, [2, 7, 8], 'exact contiguous matching only');
});
