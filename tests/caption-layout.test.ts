import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinalCaptionChunks } from '../remotion/CaptionComposition';
import {
  fitCaptionFontSize,
  getCaptionChunkWordLimit,
  resolveCaptionLineStyle,
  splitCaptionWordsIntoLines,
} from '../lib/caption-layout';
import type { CaptionPreset, WordTimestamp } from '../lib/types';

const basePreset: CaptionPreset = {
  _id: 'caption-test',
  name: 'Test caption',
  fontFamily: 'Arial, sans-serif',
  fontSize: 48,
  fontWeight: 'bold',
  textColor: '#FFFFFF',
  highlightColor: '#FFE600',
  strokeColor: '#000000',
  strokeWidth: 3,
  positionY: 25,
  animationStyle: 'karaoke',
  uppercase: true,
};

function words(text: string): WordTimestamp[] {
  return text.split(/\s+/).map((word, index) => ({
    word,
    start: index * 0.3,
    end: index * 0.3 + 0.25,
  }));
}

test('legacy presets and empty rich styles resolve to the original four-word chunk and global style', () => {
  const input = words('one two three four five');
  assert.equal(getCaptionChunkWordLimit(basePreset), 4);
  assert.equal(getCaptionChunkWordLimit({ ...basePreset, lineStyles: [] }), 4);
  assert.deepEqual(splitCaptionWordsIntoLines(input.slice(0, 2), basePreset)[0].words, input.slice(0, 2));
  assert.equal(resolveCaptionLineStyle(basePreset, 0).fontSize, basePreset.fontSize);
});

test('rich chunks split words in order by maxWords and reuse the final line style on overflow', () => {
  const preset: CaptionPreset = {
    ...basePreset,
    lineStyles: [
      { maxWords: 2, fontSize: 60, textColor: '#FFFFFF', italic: true },
      { maxWords: 3, fontSize: 40, uppercase: false, animationStyle: 'fade-in' },
    ],
  };
  const input = words('one two three four five six seven eight');
  assert.equal(getCaptionChunkWordLimit(preset), 5);
  const lines = splitCaptionWordsIntoLines(input, preset);
  assert.deepEqual(lines.map((line) => line.words.map((word) => word.word)), [
    ['one', 'two'],
    ['three', 'four', 'five'],
    ['six', 'seven', 'eight'],
  ]);
  assert.equal(lines[0].style.fontSize, 60);
  assert.equal(lines[0].style.italic, true);
  assert.equal(lines[1].style.uppercase, false);
  assert.equal(lines[1].style.animationStyle, 'fade-in');
  assert.equal(lines[2].style.fontSize, 40);
  assert.deepEqual(lines.flatMap((line) => line.words), input);
});

test('Remotion final chunks use rich line capacity but keep the legacy four-word chunking', () => {
  const input = words('one two three four five six seven eight nine ten');
  const legacy = buildFinalCaptionChunks(input, 0, 0, getCaptionChunkWordLimit(basePreset));
  const richPreset: CaptionPreset = {
    ...basePreset,
    lineStyles: [{ maxWords: 2 }, { maxWords: 3 }],
  };
  const rich = buildFinalCaptionChunks(input, 0, 0, getCaptionChunkWordLimit(richPreset));
  assert.deepEqual(legacy.map((chunk) => chunk.words.length), [4, 4, 2]);
  assert.deepEqual(rich.map((chunk) => chunk.words.length), [5, 5]);
  assert.deepEqual(rich.flatMap((chunk) => chunk.words), input);
});

test('layout bounds unsafe settings and shrinks very long rows without dropping words', () => {
  const preset: CaptionPreset = {
    ...basePreset,
    lineStyles: [{ maxWords: 999, fontSize: 400, strokeWidth: 50, lineHeight: 0.1, letterSpacing: 100 }],
  };
  const style = resolveCaptionLineStyle(preset, 0);
  assert.equal(style.maxWords, 8);
  assert.equal(style.fontSize, 160);
  assert.equal(style.strokeWidth, 20);
  assert.equal(style.lineHeight, 0.75);
  assert.equal(style.letterSpacing, 30);

  const longText = `${'extraordinarilylongword'.repeat(20)} ${'more'.repeat(20)}`;
  assert.ok(fitCaptionFontSize(longText, 64, 900, 2, true) < 64);
  const input = words('one two three four five six seven eight nine');
  const grouped = splitCaptionWordsIntoLines(input, preset);
  assert.deepEqual(grouped.flatMap((line) => line.words), input);
});
