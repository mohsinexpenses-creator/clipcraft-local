import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProfanityAudioFilter,
  buildProfanityWindowsFromIndexes,
  containsProfanity,
  findProfanityMatches,
  findViralSafetyWordIndexes,
  maskProfanity,
  maskTranscriptWordsFromIndexes,
  resolveCensoredWordIndexes,
} from '../lib/profanity';

const words = [
  { word: 'This', start: 0, end: 0.2 },
  { word: 'is', start: 0.2, end: 0.35 },
  { word: 'a', start: 0.35, end: 0.45 },
  { word: 'piece', start: 1, end: 1.2 },
  { word: 'of', start: 1.2, end: 1.3 },
  { word: 'shit', start: 1.3, end: 1.55 },
  { word: 'then', start: 2, end: 2.2 },
  { word: 'safe', start: 2.2, end: 2.5 },
] as const;

test('safety masking catches punctuation/leet variants while respecting word boundaries', () => {
  assert.equal(maskProfanity('That is f.u.c.k!'), 'That is f*****k!');
  assert.equal(maskProfanity('Sh1t happens.'), 'S**t happens.');
  assert.equal(containsProfanity('a piece of shit'), true);
  assert.equal(containsProfanity('class assessment cocktail'), false, 'never censor harmless substrings');
  assert.equal(maskProfanity('class assessment cocktail'), 'class assessment cocktail');
});

test('phrase ranges and contextual policy decisions resolve once for captions and audio', () => {
  const matches = findProfanityMatches(words);
  const phrase = matches.find((match) => match.term === 'piece of shit');
  assert.deepEqual(
    phrase && [phrase.startIndex, phrase.endIndex],
    [3, 5],
    'all words of a multi-word phrase are covered',
  );

  const indexes = resolveCensoredWordIndexes(words, [7]);
  assert.deepEqual(indexes, [3, 4, 5, 7]);
  const masked = maskTranscriptWordsFromIndexes(words, indexes);
  assert.deepEqual(masked.slice(3, 6).map((word) => word.word), ['p***e', 'of', 's**t']);
  assert.equal(masked[7].word, 's**e', 'the optional contextual pass uses the same index set');

  // The hook replays source 1.0-2.0 at final time 0-1.0, then the full clip
  // follows at +1.0. Its unsafe phrase therefore has both preview and main audio windows.
  const windows = buildProfanityWindowsFromIndexes(words, 1, 1, 3, indexes, 0);
  assert.deepEqual(windows, [[0, 0.55], [2, 2.55], [3.2, 3.5]]);
});

test('viral safety phrases are normalized and matched as contiguous transcript ranges', () => {
  const viral = findViralSafetyWordIndexes(words, {
    safety_analysis: {
      risky_words: [
        { word_or_phrase: 'Piece of sh!t', action: 'censor', safer_replacement: '' },
        { word_or_phrase: 'PIECE OF SHIT', action: 'mute', safer_replacement: '' },
      ],
    },
    viral_packaging: {
      words_to_change: ['safe', 'unmatched phrase'],
    },
  });

  assert.deepEqual(viral.phrases, ['piece of shit', 'safe', 'unmatched phrase']);
  assert.deepEqual(viral.indexes, [3, 4, 5, 7]);
});

test('mute and beep audio plans use the same already-resolved windows', () => {
  const windows: [number, number][] = [[1.1, 1.4]];
  const mute = buildProfanityAudioFilter(windows, 'mute', 4, 6, 'a');
  assert.deepEqual(mute?.extraArgs, []);
  assert.match(mute?.filters[0] ?? '', /between\(t,1\.100,1\.400\)/);

  const beep = buildProfanityAudioFilter(windows, 'beep', 4, 6, 'a');
  assert.ok(beep?.extraArgs.includes('sine=frequency=1000:sample_rate=44100'));
  assert.match(beep?.filters.join(';') ?? '', /amix=inputs=2/);
  assert.equal(buildProfanityAudioFilter(windows, 'off', 4, 6, 'a'), null);
});
