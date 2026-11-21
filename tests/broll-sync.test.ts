import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANCHOR_TOLERANCE_WORDS,
  anchorMoment,
  concreteFallbackKeywords,
  floorToFrame,
  isPlausibleFallbackKeyword,
  syncTokenMatches,
  syncTokens,
} from '../lib/broll/sync';
import { exactSyncEnabled, parseBrollAnalysis } from '../lib/broll/analysis';
import type { WordTimestamp } from '../lib/types';

/**
 * Phase 4a: a picture appears on the frame where its word is spoken.
 *
 * The bug this replaces: the analysis returned `start: 41.2` for a word the
 * speaker said at 39.8, so the card appeared 1.4 s late - over the next sentence.
 * Every test here is about the anchor being the truth and the model's seconds
 * being a hint that is never trusted.
 */

/** Words every 0.4 s starting at `offset`, from a space-separated script. */
function speech(script: string, offset = 0, step = 0.4): WordTimestamp[] {
  return script.split(/\s+/).filter(Boolean).map((word, index) => ({
    word,
    start: offset + index * step,
    end: offset + (index + 1) * step - 0.05,
  }));
}

const SCRIPT =
  'so he sold everything and bought a Ferrari with the cash he had left over from his job';
const WORDS = speech(SCRIPT);

test('a word index and its text agree: the anchor is that exact word', () => {
  const anchor = anchorMoment({ anchorText: 'Ferrari', words: WORDS, start: 99, end: 100 });
  assert.ok(anchor);
  assert.equal(anchor.wordIndex, 7);
  assert.equal(anchor.wordStart, WORDS[7].start);
  assert.equal(anchor.via, 'anchorText');
  assert.equal(anchor.score, 1);
});

test("the model's seconds never win: a far-off start still anchors to the word", () => {
  // The model claims the cash moment is at 20 s; it is really at index 9.
  const anchor = anchorMoment({ anchorText: 'cash', words: WORDS, start: 20, end: 22 });
  assert.ok(anchor);
  assert.equal(anchor.wordIndex, 10);
  assert.ok(anchor.wordStart < 5, `anchored at ${anchor.wordStart}s, not the claimed 20s`);
});

test('a plausible word index is trusted and marked, a wild one is not', () => {
  const good = anchorMoment({ anchorText: 'Ferrari', wordIndex: 8, words: WORDS, start: 0, end: 0 });
  assert.ok(good);
  assert.equal(good.wordIndex, 7, 'the text decides, the index confirms');
  assert.equal(good.via, 'anchorText+wordIndex');

  const wild = anchorMoment({
    anchorText: 'Ferrari',
    wordIndex: 7 + ANCHOR_TOLERANCE_WORDS + 3,
    words: WORDS,
    start: 0,
    end: 0,
  });
  assert.ok(wild);
  assert.equal(wild.via, 'anchorText', 'an index outside the tolerance is ignored');
});

test('plural, possessive and punctuation differences still anchor', () => {
  const words = speech("the developer's cars are here and the developers car is gone");
  const a = anchorMoment({ anchorText: 'developers cars', words, start: 0, end: 0 });
  assert.ok(a, 'apostrophe and plural forms match');
  assert.equal(a.wordIndex, 1);
  assert.equal(syncTokenMatches('cars', 'car'), true);
  assert.equal(syncTokenMatches('cities', 'city'), true);
  assert.equal(syncTokenMatches('houses', 'house'), true);
  assert.equal(syncTokenMatches('gas', 'ga'), false);
});

test('two-word anchors skip function words in the transcript but not in the anchor', () => {
  const words = speech('they went to the Eiffel Tower at night');
  const anchor = anchorMoment({ anchorText: 'Eiffel Tower', words, start: 0, end: 0 });
  assert.ok(anchor);
  assert.equal(anchor.wordIndex, 4);
  assert.equal(anchor.score, 1);
});

test('an index onto a function word without matching text is refused', () => {
  assert.equal(anchorMoment({ wordIndex: 6, words: WORDS, start: 0, end: 0 }), null);
  // ...but a content word is an acceptable last resort.
  const content = anchorMoment({ wordIndex: 7, words: WORDS, start: 0, end: 0 });
  assert.ok(content);
  assert.equal(content.via, 'wordIndex');
  assert.equal(anchorMoment({ anchorText: 'nonexistent phrases here', words: WORDS, start: 0, end: 0 }), null);
});

test('a start is floored to the frame grid, at most one frame early and never late', () => {
  assert.equal(floorToFrame(1.03, 30), 30, '1.03 s on a 30 fps grid');
  assert.equal(floorToFrame(1.03, 30) / 30, 1, 'exactly one frame early');
  assert.equal(floorToFrame(1.0, 30), 30, 'an exact frame stays');
  assert.equal(floorToFrame(0, 30), 0);
  for (const seconds of [0.001, 0.0333, 12.349, 59.98]) {
    const frame = floorToFrame(seconds, 30);
    assert.ok(frame / 30 <= seconds + 1e-9, 'never late');
    assert.ok(seconds - frame / 30 < 1 / 30 + 1e-9, 'never more than one frame early');
  }
});

test('the parser drops a moment it cannot anchor instead of using model seconds', () => {
  const response = JSON.stringify({
    entities: [],
    broll: [
      { visualKeywords: ['ferrari'], anchorText: 'Ferrari', relevance: 5 },
      { visualKeywords: ['spaceship'], anchorText: 'spaceship', relevance: 4 },
      { visualKeywords: ['cash'], start: 3.1, end: 5.2, relevance: 3 },
    ],
  });
  const analysis = parseBrollAnalysis(response, 20, WORDS, { fps: 30, exactSync: true });
  assert.equal(analysis.broll.length, 2, 'the un-anchorable moment is dropped');
  assert.equal(analysis.broll[0].wordIndex, 7);
  assert.ok(
    Math.abs(analysis.broll[0].start - WORDS[7].start) < 1e-9,
    `"Ferrari" is spoken at 2.8 s, card at ${analysis.broll[0].start}`,
  );
  assert.equal(analysis.broll[1].start, WORDS[10].start, 'keyword text used as the anchor');
  assert.equal(analysis.broll[0].relevance, 5);
  assert.equal(analysis.broll[1].relevance, 3, 'a missing relevance defaults to 3, never 5');
});

test('BROLL_EXACT_SYNC=0 restores the model seconds (the rollback path)', () => {
  const response = JSON.stringify({
    entities: [],
    broll: [{ visualKeywords: ['ferrari'], start: 3.1, end: 5.2 }],
  });
  const legacy = parseBrollAnalysis(response, 20, WORDS, { exactSync: false });
  assert.equal(legacy.broll[0].start, 3.1, 'the old behaviour is exactly the model start');

  const previous = process.env.BROLL_EXACT_SYNC;
  process.env.BROLL_EXACT_SYNC = '0';
  try {
    assert.equal(exactSyncEnabled(), false);
    const viaEnv = parseBrollAnalysis(response, 20, WORDS);
    assert.equal(viaEnv.broll[0].start, 3.1);
  } finally {
    if (previous === undefined) delete process.env.BROLL_EXACT_SYNC;
    else process.env.BROLL_EXACT_SYNC = previous;
  }
  assert.equal(exactSyncEnabled(), true, 'default is exact sync');
});

test('fallback keywords are proper nouns and content phrases, never sentence fragments', () => {
  const words = speech(
    'so i was like telling you that is wild when we visited the Eiffel Tower in Paris and ate baguettes',
  );
  const moments = concreteFallbackKeywords(words, 20, { maxMoments: 6, minSpacingSeconds: 3 });
  assert.ok(moments.length > 0);
  for (const moment of moments) {
    const keyword = moment.visualKeywords[0];
    assert.ok(keyword.split(/\s+/).length <= 3, `"${keyword}" is a fragment`);
    assert.doesNotMatch(keyword, /\b(was|like|that|is|the|and|we)\b/i, `"${keyword}" is filler`);
    assert.equal(isPlausibleFallbackKeyword(keyword), true);
    assert.ok(moment.anchorText.length > 0, 'every fallback card still has an anchor');
  }
  const keywords = moments.map((moment) => moment.visualKeywords[0]);
  assert.ok(keywords.includes('Paris') || keywords.includes('Eiffel Tower') || keywords.includes('baguettes'), keywords.join(' | '));
});

test('fallback cards are at most one per 10 s by default', () => {
  const words = speech('cash money ferrari mansion jet yacht island castle watches suits', 0, 0.5);
  const moments = concreteFallbackKeywords(words, 10, { maxMoments: 10 });
  for (let index = 1; index < moments.length; index += 1) {
    assert.ok(
      moments[index].start - moments[index - 1].start >= 10 - 1e-6,
      `cards at ${moments[index - 1].start} and ${moments[index].start} are closer than 10 s`,
    );
  }
});

test('token normalisation is stable for the anchor and the transcript side', () => {
  assert.deepEqual(syncTokens("That's  a  CAR, isn't it?!"), ['thats', 'a', 'car', 'isnt', 'it']);
  assert.deepEqual(syncTokens('well-known'), ['well', 'known']);
});
