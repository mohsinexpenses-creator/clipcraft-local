/**
 * The shared stacking geometry: hook / CTA cards land DIRECTLY ABOVE the
 * caption block, clamped to the canvas, identical for both caption engines.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OVERLAY_STACK_GAP,
  OVERLAY_TOP_MARGIN,
  captionReservedBand,
  stackCardAboveCaptions,
  stackPositionPercent,
} from '../lib/overlay-stack';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import type { CaptionPreset } from '../lib/types';

const hookStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'hook')!;
const ctaStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'cta')!;

test('caption bands sit at the preset position and cover the reserved height', () => {
  for (const preset of DEFAULT_CAPTION_PRESETS.slice(0, 6)) {
    for (const engine of ['native', 'remotion'] as const) {
      const band = captionReservedBand(engine, preset);
      const bottomEdge = 1920 * (1 - preset.positionY / 100);
      assert.ok(band.top < band.bottom, `${preset._id}/${engine}: sane band`);
      if (engine === 'remotion') {
        // Remotion's box is bottom-anchored: it sits at/above the position line.
        assert.ok(band.bottom <= bottomEdge + 1, `${preset._id}/remotion: anchored to the position line`);
      } else {
        // Native ASS anchors the line's TOP; the reserved block hangs below it.
        assert.ok(band.top < bottomEdge, `${preset._id}/native: line top is above the position line`);
      }
      assert.ok(band.top >= bottomEdge - 400, `${preset._id}/${engine}: band near the position line`);
    }
  }
});

test('cards stack exactly one gap above the caption band, clamped to the top margin', () => {
  const preset: CaptionPreset = DEFAULT_CAPTION_PRESETS[0];
  const band = captionReservedBand('remotion', preset);
  const top = stackCardAboveCaptions(band, 150);
  assert.equal(top, Math.round(band.top - OVERLAY_STACK_GAP - 150));

  // A caption near the top pins the card to the margin instead of off-canvas.
  const high: CaptionPreset = { ...preset, positionY: 97 };
  const highBand = captionReservedBand('remotion', high);
  const clamped = stackCardAboveCaptions(highBand, 400);
  assert.equal(clamped, OVERLAY_TOP_MARGIN);
});

test('stackPositionPercent is % from the top, rounded to 0.1, inside 0..100', () => {
  assert.equal(stackPositionPercent(0), 0);
  assert.equal(stackPositionPercent(1920), 100);
  const p = stackPositionPercent(960);
  assert.equal(p, 50);
  assert.equal(stackPositionPercent(123), Math.round((123 / 1920) * 1000) / 10);
});

test('the hook and CTA never need the caption lift: their home is above the caption band', () => {
  const band = captionReservedBand('native', DEFAULT_CAPTION_PRESETS[0]);
  const hookTop = stackCardAboveCaptions(band, 180);
  const ctaTop = stackCardAboveCaptions(band, 120);
  assert.ok(hookTop + 180 <= band.top - OVERLAY_STACK_GAP + 1, 'hook clears the captions');
  assert.ok(ctaTop + 120 <= band.top - OVERLAY_STACK_GAP + 1, 'CTA clears the captions');
  assert.ok(hookStyle && ctaStyle, 'style presets exist for the height estimates');
});
