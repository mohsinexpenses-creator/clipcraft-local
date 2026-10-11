import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTION_THEME_CATALOG,
  isCaptionThemeName,
  resolveCaptionThemeOverlayStyle,
} from '../lib/caption-theme-styles';
import { captionReservedBand } from '../lib/overlay-stack';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import { selectThemeCaptionData } from '../remotion/caption-themes/data';
import { themeRegistry } from '../remotion/caption-themes/vendor/registry';
import type { CaptionChunk } from '../remotion/AnimatedWord';
import { CAPTION_THEME_NAMES } from '../lib/types';

function chunk(id: string, start: number, text: string): CaptionChunk {
  return {
    id,
    start,
    end: start + 0.4,
    words: [{ word: text, start, end: start + 0.4 }],
  };
}

test('all 13 upstream themes are present in the typed catalog and vendor registry', () => {
  assert.deepEqual(CAPTION_THEME_CATALOG.map((theme) => theme.id), CAPTION_THEME_NAMES);
  assert.deepEqual(Object.keys(themeRegistry), CAPTION_THEME_NAMES);
  assert.equal(CAPTION_THEME_CATALOG.length, 13);
  assert.ok(isCaptionThemeName('kinetic-01'));
  assert.ok(!isCaptionThemeName('unknown-theme'));

  const themedGalleryPresets = DEFAULT_CAPTION_PRESETS.filter((preset) => preset.captionTheme);
  assert.equal(themedGalleryPresets.length, 13, 'each upstream theme has one gallery preset');
  assert.deepEqual(
    themedGalleryPresets.map((preset) => preset.captionTheme).sort(),
    [...CAPTION_THEME_NAMES].sort(),
  );
  assert.equal(new Set(themedGalleryPresets.map((preset) => preset.captionTheme)).size, 13);
  assert.equal(DEFAULT_CAPTION_PRESETS[0].captionTheme, 'kinetic-01');
  assert.equal(DEFAULT_CAPTION_PRESETS[0].name, 'Bold Punch');
});

test('ClipCraft caption words adapt to the theme data contract without changing masked text or timing', () => {
  const source = [
    chunk('a', 0.5, 'W***'),
    chunk('b', 1.2, 'next'),
  ];
  const selected = selectThemeCaptionData(source, 'pop', 0.6);
  assert.deepEqual(selected?.data, {
    lines: [{ words: [{ text: 'W***', start: 0.5, end: 0.9 }] }],
  });

  // The previous line is held briefly, then the next line appears and eventually clears.
  assert.equal(selectThemeCaptionData(source, 'pop', 1.24)?.activeChunk.id, 'a');
  assert.equal(selectThemeCaptionData(source, 'pop', 1.26)?.activeChunk.id, 'b');
  assert.equal(selectThemeCaptionData(source, 'pop', 2.0), null);
});

test('Podcast receives its matching two-line pair; other themes receive one active line', () => {
  const source = [
    chunk('a', 0.1, 'first'),
    chunk('b', 0.7, 'second'),
    chunk('c', 1.3, 'third'),
    chunk('d', 1.9, 'fourth'),
  ];
  const podcast = selectThemeCaptionData(source, 'podcast', 1.46);
  assert.deepEqual(podcast?.data.lines.map((line) => line.words[0].text), ['third', 'fourth']);

  const kinetic = selectThemeCaptionData(source, 'kinetic-01', 1.46);
  assert.deepEqual(kinetic?.data.lines.map((line) => line.words[0].text), ['third']);
});

test('theme Hook/CTA styling follows the caption accent and preserves saved overlay geometry', () => {
  const caption = {
    ...DEFAULT_CAPTION_PRESETS[0],
    captionTheme: 'gaming-stream' as const,
    matchOverlayTheme: true,
    highlightColor: '#00CC88',
  };
  const hook = DEFAULT_OVERLAY_STYLE_PRESETS.find((style) => style.kind === 'hook')!;
  const cta = DEFAULT_OVERLAY_STYLE_PRESETS.find((style) => style.kind === 'cta')!;
  const matchedHook = resolveCaptionThemeOverlayStyle(caption, hook);
  const matchedCta = resolveCaptionThemeOverlayStyle(caption, cta);

  assert.equal(matchedHook.fontFamily, 'Rajdhani, sans-serif');
  assert.equal(matchedHook.borderColor, '#00CC88');
  assert.equal(matchedHook.badgeBackgroundColor, '#00CC88');
  assert.equal(matchedCta.backgroundColor, '#00CC88');
  assert.equal(matchedHook.fontSize, hook.fontSize);
  assert.equal(matchedHook.positionY, hook.positionY);
  assert.equal(matchedHook.badgeText, hook.badgeText);

  const disabled = { ...caption, matchOverlayTheme: false };
  assert.equal(resolveCaptionThemeOverlayStyle(disabled, hook), hook);
});

test('caption themes reserve their own band; classic presets keep the classic band', () => {
  const classic = { ...DEFAULT_CAPTION_PRESETS[0], captionTheme: undefined };
  const classicBand = captionReservedBand(classic);

  for (const theme of CAPTION_THEME_NAMES) {
    const themed = { ...DEFAULT_CAPTION_PRESETS[0], captionTheme: theme, fontSize: 64 };
    const themedBand = captionReservedBand(themed);
    assert.ok(themedBand.bottom > themedBand.top, `${theme} has a visible reserved band`);
    assert.ok(themedBand.bottom - themedBand.top <= 480, `${theme} stays within the safe reserve`);
    assert.notDeepEqual(themedBand, classicBand, `${theme} uses theme-specific geometry`);
  }
});
