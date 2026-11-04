import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROLL_ANIMATION,
  brollFramePhases,
  brollFrameStyle,
  brollSequenceFrames,
  easeOutCubic,
} from '../lib/broll/animation';

/**
 * Motion timings: the item must be fully invisible at both ends of its own
 * sequence (so a hard cut never shows) and must not overshoot its 4 s budget.
 */

test('a full-screen item bounces in from 0.75, overshoots, and settles at 1', () => {
  const start = brollFrameStyle('fullscreen', 0, 3);
  assert.equal(start.scale, 0.75);
  assert.equal(start.opacity, 1);

  const peak = brollFrameStyle('fullscreen', BROLL_ANIMATION.fullscreen.enterSeconds * 0.72, 3);
  assert.ok(peak.scale > 1.04 && peak.scale <= 1.05);

  const settled = brollFrameStyle('fullscreen', BROLL_ANIMATION.fullscreen.enterSeconds, 3);
  assert.equal(settled.opacity, 1);
  assert.equal(settled.scale, 1);
  assert.equal(settled.mediaScale, 1);

  const holdEnd = brollFrameStyle('fullscreen', 2.8, 3);
  assert.equal(holdEnd.mediaScale, 1.06);
  const end = brollFrameStyle('fullscreen', 3, 3);
  assert.equal(end.opacity, 0);
  assert.equal(end.scale, 0.75);
});

test('the Ken Burns push is monotonic and small', () => {
  const a = brollFrameStyle('fullscreen', 1, 4);
  const b = brollFrameStyle('fullscreen', 3, 4);
  assert.ok(b.mediaScale > a.mediaScale);
  assert.ok(b.mediaScale <= 1.06 + 1e-6);
  assert.ok(Math.abs(b.mediaX) <= 8 + 1e-6);
});

test('a landscape card slides up into place and fades out at the end', () => {
  const start = brollFrameStyle('landscape', 0, 3);
  assert.equal(start.opacity, 0);
  assert.ok(start.translateY > 20);
  assert.ok(start.scale < 1);

  const hold = brollFrameStyle('landscape', 1.5, 3);
  assert.equal(hold.opacity, 1);
  assert.equal(hold.scale, 1);
  assert.equal(hold.translateY, 0);

  const end = brollFrameStyle('landscape', 3, 3);
  assert.equal(end.opacity, 0);
});

test('extremely short items still enter and exit within half their length', () => {
  const style = brollFrameStyle('fullscreen', 0.4, 0.8);
  assert.ok(style.opacity >= 0 && style.opacity <= 1);
  const end = brollFrameStyle('fullscreen', 0.8, 0.8);
  assert.equal(end.opacity, 0);
});

test('easeOutCubic stays within 0..1 and clamps its input', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-3), 0);
  assert.equal(easeOutCubic(9), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('sequence frames are per item, not per clip', () => {
  assert.equal(brollSequenceFrames(3, 30), 90);
  assert.equal(brollSequenceFrames(2.5, 24), 60);
  assert.equal(brollSequenceFrames(0, 30), 1);
  assert.equal(brollSequenceFrames(3, 0), 90, 'a bogus fps falls back to 30');
});

test('fullscreen frame phases use PNG edges and JPEG hold without gaps', () => {
  const phases = brollFramePhases(90, 23.976);
  assert.deepEqual(
    phases.map(({ name, format, startFrame, endFrame }) => [name, format, startFrame, endFrame]),
    [
      ['enter', 'png', 0, 4],
      ['hold', 'jpeg', 5, 84],
      ['exit', 'png', 85, 89],
    ]
  );
  assert.equal(
    phases.reduce((count, phase) => count + phase.endFrame - phase.startFrame + 1, 0),
    90
  );
});

test('short fullscreen items keep distinct PNG enter and exit frames', () => {
  assert.deepEqual(brollFramePhases(2, 24), [
    { name: 'enter', format: 'png', startFrame: 0, endFrame: 0 },
    { name: 'exit', format: 'png', startFrame: 1, endFrame: 1 },
  ]);
});
