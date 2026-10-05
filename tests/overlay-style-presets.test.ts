/**
 * Hook / CTA overlay STYLE preset invariants (defaults seeded into SQLite).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';

test('default overlay style presets cover hook + cta with unique ids', () => {
  const ids = DEFAULT_OVERLAY_STYLE_PRESETS.map((p) => p._id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');

  const hooks = DEFAULT_OVERLAY_STYLE_PRESETS.filter((p) => p.kind === 'hook');
  const ctas = DEFAULT_OVERLAY_STYLE_PRESETS.filter((p) => p.kind === 'cta');
  assert.ok(hooks.length >= 2, 'at least two hook styles');
  assert.ok(ctas.length >= 2, 'at least two cta styles');
});

test('style presets keep hook/CTA text generation intact (styling only)', () => {
  // Styles never carry copy - hook/CTA TEXT still comes from the AI prompts.
  // The only copy-ish field is the decorative badge chip label.
  for (const preset of DEFAULT_OVERLAY_STYLE_PRESETS) {
    assert.equal(typeof preset.fontFamily, 'string');
    assert.ok(preset.fontSize >= 20 && preset.fontSize <= 64);
    assert.ok(preset.positionY > 0 && preset.positionY < 100, `${preset._id} positionY ${preset.positionY}`);
  }
});

test('the faithful-default styles reproduce the previous hardcoded looks', () => {
  const hook = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p._id === 'hook-bold-yellow')!;
  assert.ok(hook, 'hook-bold-yellow present');
  assert.equal(hook.animationStyle, 'pop');
  assert.equal(hook.badgeText, 'Hook Intro');
  assert.equal(hook.positionY, 12);

  const cta = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p._id === 'cta-gradient-green')!;
  assert.ok(cta, 'cta-gradient-green present');
  assert.equal(cta.animationStyle, 'pop');
  assert.equal(cta.positionY, 64);
  assert.ok(cta.backgroundColor.includes('linear-gradient'), cta.backgroundColor);
});

test('all animation styles are ones the overlays actually render', () => {
  for (const preset of DEFAULT_OVERLAY_STYLE_PRESETS) {
    assert.ok(['pop', 'fade', 'slide-up', 'none'].includes(preset.animationStyle), preset.animationStyle);
  }
});
