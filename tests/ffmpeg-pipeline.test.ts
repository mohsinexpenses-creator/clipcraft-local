/**
 * Animated crop filter-builder tests - the expressions the 9:16 window glides
 * with. All coordinates are in MIRRORED space (hflip runs first).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFocusCropFilter,
  buildPiecewiseExpression,
  buildSplitFilterComplex,
} from '../worker/ffmpeg-pipeline';
import { FocusTimeline, SplitTimeline } from '../worker/speaker-tracker';

test('buildPiecewiseExpression: single keyframe is a constant', () => {
  assert.equal(buildPiecewiseExpression([{ t: 0, v: 100 }], 1920), 'max(0,min(1920,100.00))');
});

test('buildPiecewiseExpression: two keyframes interpolate with a slope', () => {
  const expr = buildPiecewiseExpression([
    { t: 0, v: 100 },
    { t: 2, v: 300 },
  ], 1920);
  // 100 + 100/s * (t-0) until t=2, then hold 300.
  assert.equal(expr, 'max(0,min(1920,if(lt(t,2.000),100.00+100.00*(t-0.000),300.00)))');
});

test('buildPiecewiseExpression: near-identical keyframes collapse without dividing by zero', () => {
  const expr = buildPiecewiseExpression([
    { t: 1, v: 10 },
    { t: 1.01, v: 50 },
    { t: 2, v: 90 },
  ], 1920);
  // 1.01-1.00 < 0.02 AND values differ by >10: a step - hold the old value 20ms
  // instead of collapsing into a divide-by-zero.
  assert.ok(!expr.includes('Infinity'), `no infinite slopes: ${expr}`);
  assert.ok(!expr.includes('NaN'), `no NaN slopes: ${expr}`);
  assert.ok(expr.startsWith('max(0,min(1920,'), expr);
});

test('buildPiecewiseExpression: same spot keyframes merge to the later value', () => {
  const expr = buildPiecewiseExpression([
    { t: 1, v: 100 },
    { t: 1.01, v: 102 },
    { t: 2, v: 200 },
  ], 1920);
  // merged: (1.01, 102) -> (2, 200), slope 98.99
  assert.equal(expr, 'max(0,min(1920,if(lt(t,2.000),102.00+98.99*(t-1.010),200.00)))');
});

test('buildPiecewiseExpression: values are clamped into [0, clampMax]', () => {
  const expr = buildPiecewiseExpression([
    { t: 0, v: -50 },
    { t: 1, v: 5000 },
  ], 1920);
  assert.ok(expr.startsWith('max(0,min(1920,'), expr);
});

test('buildFocusCropFilter: landscape source slides along x', () => {
  const focus: FocusTimeline = {
    cropW: 606,
    cropH: 1080,
    axis: 'x',
    keyframes: [
      { t: 0, v: 0 },
      { t: 0.45, v: 1196 },
    ],
  };
  const filter = buildFocusCropFilter(focus, 1920, 1080);
  assert.equal(filter, "crop=606:1080:x='max(0,min(1314,if(lt(t,0.450),0.00+2657.78*(t-0.000),1196.00)))':y=0");
});

test('buildFocusCropFilter: portrait source slides along y', () => {
  const focus: FocusTimeline = {
    cropW: 1080,
    cropH: 606,
    axis: 'y',
    keyframes: [
      { t: 0, v: 100 },
      { t: 1, v: 400 },
    ],
  };
  const filter = buildFocusCropFilter(focus, 1080, 1920);
  assert.equal(filter, "crop=1080:606:x=0:y='max(0,min(1314,if(lt(t,1.000),100.00+300.00*(t-0.000),400.00)))'");
});

test('buildSplitFilterComplex: mirrored split, active pane on top, vstack output', () => {
  const split: SplitTimeline = {
    cropW: 586,
    cropH: 520,
    top: [
      { t: 0, x: 0, y: 100 },
      { t: 1, x: 1207, y: 100 },
    ],
    bottom: [
      { t: 0, x: 1207, y: 100 },
      { t: 1, x: 0, y: 100 },
    ],
  };
  const filter = buildSplitFilterComplex(split, 1920, 1080, 'format=yuv420p');

  assert.ok(filter.startsWith('[0:v]hflip,split=2[sa][sb];'), filter.slice(0, 60));
  assert.ok(filter.includes('[sa]crop=586:520:x='), 'top crop present');
  assert.ok(filter.includes("scale=1080:960:flags=lanczos[spTop];"), 'top scaled');
  assert.ok(filter.includes('[sb]'), 'bottom branch present');
  assert.ok(filter.includes("scale=1080:960:flags=lanczos[spBottom];"), 'bottom scaled');
  assert.ok(filter.includes('[spTop][spBottom]vstack=inputs=2,format=yuv420p[vout]'), filter.slice(-80));

  // Both x expressions must interpolate (pane positions glide over 1s here).
  const xExprs = filter.match(/x='([^']+)'/g) ?? [];
  assert.equal(xExprs.length, 2, 'both pane x positions are animated');
  for (const expr of xExprs) {
    assert.ok(expr.includes('if(lt(t,'), expr);
  }

  // y expressions are animated too (y='...' ), x/y never raw-commas.
  const yExprs = filter.match(/y='([^']+)'/g) ?? [];
  assert.equal(yExprs.length, 2);
  assert.ok(!filter.includes('\\,'), 'no escaped commas needed inside quotes');
});

test('buildSplitFilterComplex: single face uses a literal center crop for the echo pane', () => {
  const split: SplitTimeline = {
    cropW: 586,
    cropH: 520,
    top: [{ t: 0, x: 656, y: 200 }],
    bottom: [{ t: 0, x: 656, y: 200 }],
  };
  const filter = buildSplitFilterComplex(split, 1920, 1080, 'format=yuv420p');
  // One-keyframe timelines become literal clamped numbers (no if-chain).
  assert.ok(
    filter.includes("crop=586:520:x='max(0,min(1334,656.00))':y='max(0,min(560,200.00))'"),
    filter
  );
});
