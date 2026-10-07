import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAssFile } from '../worker/captions-ass';
import type { CaptionAnimationStyle, CaptionPreset, WordTimestamp } from '../lib/types';

const basePreset: CaptionPreset = {
  _id: 'ass-rich-test',
  name: 'ASS test',
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

const transcript: WordTimestamp[] = ['this', 'is', 'a', 'styled', 'caption', 'with', 'more', 'words'].map(
  (word, index) => ({ word, start: index * 0.35, end: index * 0.35 + 0.28 })
);

function render(preset: CaptionPreset, words = transcript): string {
  return generateAssFile({
    words,
    preset,
    totalDurationSeconds: 6,
    hookDuration: 0,
    hookStart: 0,
    ctaDuration: 0,
  });
}

test('simple presets and empty lineStyles keep the legacy ASS style and four-word chunks', () => {
  const legacy = render(basePreset);
  const emptyStyles = render({ ...basePreset, lineStyles: [] });
  assert.match(legacy, /Style: Cap,/);
  assert.equal((legacy.match(/^Dialogue:/gm) ?? []).length, 2);
  assert.equal((emptyStyles.match(/^Dialogue:/gm) ?? []).length, 2);
  assert.ok(['THIS', 'IS', 'A', 'STYLED'].every((word) => legacy.includes(word)));
});

test('rich ASS emits a separate styled row per dynamic line, with timing and casing intact', () => {
  const rich = render({
    ...basePreset,
    lineStyles: [
      { maxWords: 2, fontSize: 60, fontWeight: 'black', textColor: '#FFFFFF', highlightColor: '#FFE600' },
      { maxWords: 2, fontSize: 42, uppercase: false, italic: true, letterSpacing: 1.5, strokeWidth: 5 },
    ],
    lineGap: 8,
  }, transcript.slice(0, 4));
  const dialogue = rich.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogue.length, 2);
  assert.ok(dialogue[0].includes('\\fs72'));
  assert.ok(dialogue[0].includes('\\b1'));
  assert.ok(dialogue[0].includes('THIS') && dialogue[0].includes('IS'));
  assert.ok(dialogue[1].includes('\\i1'));
  assert.ok(dialogue[1].includes('\\fsp1.50'));
  assert.ok(dialogue[1].includes('a') && dialogue[1].includes('styled'));
  assert.ok(dialogue.every((line) => line.includes('\\pos(')));
  assert.equal(dialogue[0].split(',')[1], dialogue[1].split(',')[1]);
});

test('native rich captions approximate all four animation modes without changing the selected mode', () => {
  const animationStyles: CaptionAnimationStyle[] = ['karaoke', 'word-pop', 'fade-in', 'static'];
  for (const animationStyle of animationStyles) {
    const ass = render({
      ...basePreset,
      lineStyles: [{ maxWords: 4, animationStyle, uppercase: false, italic: true }],
    }, transcript.slice(0, 4));
    const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:'));
    assert.ok(dialogue, `missing ASS dialogue for ${animationStyle}`);
    assert.ok(dialogue?.includes('\\i1'));
    if (animationStyle === 'karaoke') {
      assert.match(dialogue ?? '', /\\k\d+/);
      assert.match(dialogue ?? '', /\\fscx/);
    } else if (animationStyle === 'word-pop') {
      assert.doesNotMatch(dialogue ?? '', /\\k\d+/);
      assert.match(dialogue ?? '', /\\t\(0,90,\\fscx124/);
      assert.match(dialogue ?? '', /\\1c&H[0-9A-F]+&/);
    } else if (animationStyle === 'fade-in') {
      assert.match(dialogue ?? '', /\\fad\(/);
      assert.doesNotMatch(dialogue ?? '', /\\k\d+/);
    } else {
      assert.doesNotMatch(dialogue ?? '', /\\fad\(|\\fscx/);
      assert.doesNotMatch(dialogue ?? '', /\\k\d+/);
    }
    assert.ok(dialogue?.includes('this') && dialogue.includes('is') && dialogue.includes('styled'));
  }
});

test('extremely long native words are hard-wrapped while all transcript text remains present', () => {
  const longWord = 'extraordinarilylongword'.repeat(40);
  const ass = render({
    ...basePreset,
    lineStyles: [{ maxWords: 1, fontSize: 18, uppercase: false, animationStyle: 'static' }],
  }, [{ word: longWord, start: 0.1, end: 2.5 }]);
  const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:'));
  assert.ok(dialogue?.includes('\\N'));
  assert.ok(dialogue?.replace(/\\N/g, '').includes(longWord));
  assert.match(dialogue ?? '', /\\bord3/);
  assert.match(dialogue ?? '', /\\fnArial/);
});
