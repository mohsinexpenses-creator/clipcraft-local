import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CAPTION_PRESETS } from '../lib/presets';

test('six built-in rich caption presets extend the catalogue, and exactly one preset is the default', () => {
  const richPresets = DEFAULT_CAPTION_PRESETS.filter((preset) => Boolean(preset.lineStyles?.length));
  assert.equal(richPresets.length, 6);
  // One default, and it is the multi-line "Dual Beat Highlight" - the legacy
  // single-line presets stay in the catalogue, they are just no longer what a fresh
  // install starts with.
  assert.equal(DEFAULT_CAPTION_PRESETS.filter((preset) => preset.isDefault).length, 1);
  assert.equal(DEFAULT_CAPTION_PRESETS.find((preset) => preset.isDefault)?._id, 'preset-rich-dual-beat');
  assert.ok(DEFAULT_CAPTION_PRESETS.some((preset) => preset._id === 'caption-creator-green'));
  assert.ok(DEFAULT_CAPTION_PRESETS.some((preset) => preset._id === 'caption-clean-studio' && !preset.lineStyles));
  assert.ok(richPresets.every((preset) => preset.lineStyles!.length >= 2));
  assert.ok(richPresets.some((preset) => preset.lineStyles?.some((line) => line.italic)));
  assert.ok(richPresets.some((preset) => preset.lineStyles?.some((line) => (line.letterSpacing ?? 0) !== 0)));

  const animations = new Set(richPresets.flatMap((preset) => preset.lineStyles?.map((line) => line.animationStyle) ?? []));
  for (const animation of ['karaoke', 'word-pop', 'fade-in', 'static']) {
    assert.ok(animations.has(animation as 'karaoke' | 'word-pop' | 'fade-in' | 'static'));
  }
});
