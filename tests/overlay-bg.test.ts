/**
 * Card-background CSS parse/build round-trips for the visual picker
 * (solid + gradient + "custom CSS stays untouched").
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBackground, parseBackground, parseColor, rgbaCss } from '../lib/overlay-bg';

test('solid rgba parses and rebuilds', () => {
  const parsed = parseBackground('rgba(15, 23, 42, 0.92)');
  assert.equal(parsed.mode, 'solid');
  if (parsed.mode === 'solid') {
    assert.equal(parsed.color.hex, '#0f172a');
    assert.equal(parsed.color.alpha, 0.92);
    assert.equal(buildBackground(parsed), 'rgba(15, 23, 42, 0.92)');
  }
});

test('hex colors parse (with #rrggbbaa alpha) and rebuild as rgba', () => {
  const parsed = parseBackground('#FF000080');
  assert.equal(parsed.mode, 'solid');
  if (parsed.mode === 'solid') {
    assert.equal(parsed.color.hex, '#ff0000');
    assert.ok(Math.abs(parsed.color.alpha - 0.5) < 0.01);
  }
  assert.equal(rgbaCss({ hex: '#ffffff', alpha: 1 }), 'rgb(255, 255, 255)');
});

test('gradient parses angle + both stops and rebuilds identically', () => {
  const css = 'linear-gradient(135deg, rgba(255, 220, 0, 0.9), rgba(15, 23, 42, 0.2))';
  const parsed = parseBackground(css);
  assert.equal(parsed.mode, 'gradient');
  if (parsed.mode === 'gradient') {
    assert.equal(parsed.angle, 135);
    assert.equal(parsed.from.hex, '#ffdc00');
    assert.equal(parsed.to.alpha, 0.2);
    assert.equal(buildBackground(parsed), css);
  }
});

test('unparseable custom CSS is preserved as raw (not clobbered)', () => {
  const parsed = parseBackground('radial-gradient(circle, red, blue)');
  assert.equal(parsed.mode, 'raw');
  const empty = parseBackground('');
  assert.equal(empty.mode, 'raw');
  assert.ok(parseColor('not-a-color') === null);
});
