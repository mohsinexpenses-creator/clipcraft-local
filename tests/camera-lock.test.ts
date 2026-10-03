/**
 * Locked-camera tests: a split pane must hold perfectly still while the person
 * stays inside it, and glide (once, eased) only when their head really leaves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CameraParams,
  CameraSample,
  HEAD_DOWN,
  HEAD_HALF_WIDTH,
  HEAD_UP,
  buildLockedCamera,
  cameraPositionAt,
  glideSeconds,
  headInsideSafeZone,
  smoothstep,
  windowFor,
} from '../worker/camera-lock';
import { buildGlideExpression, cameraExpressions } from '../worker/layout';

const PARAMS: CameraParams = {
  srcW: 1920,
  srcH: 1080,
  cropW: 540,
  cropH: 480,
  anchorY: 0.5,
};

/** One detection every 1/fps s of a person whose centre follows `f(t)`. */
function trace(
  f: (t: number) => { cx: number; cy: number; w?: number },
  duration: number,
  fps = 8
): CameraSample[] {
  const out: CameraSample[] = [];
  for (let i = 0; i < Math.floor(duration * fps); i += 1) {
    const t = i / fps;
    const p = f(t);
    out.push({ t, cx: p.cx, cy: p.cy, w: p.w ?? 120 });
  }
  return out;
}

/** Deterministic pseudo-noise in [-1, 1]. */
function noise(i: number, salt = 1): number {
  return Math.sin(i * 12.9898 * salt + 78.233) * 0.999;
}

test('a person who sits still: ONE position, zero moves, whatever the detector jitter', () => {
  const samples = trace((t) => ({ cx: 900 + 6 * noise(t * 8), cy: 400 + 5 * noise(t * 8, 2) }), 30);
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.moves.length, 0);
  const expected = windowFor(900, 400, PARAMS);
  assert.ok(Math.abs(path.x0 - expected.x) < 8, `x0 ${path.x0} ~ ${expected.x}`);
  assert.ok(Math.abs(path.y0 - expected.y) < 8, `y0 ${path.y0} ~ ${expected.y}`);
});

test('nodding, swaying and gesturing inside the frame never move the camera', () => {
  // +-70px sway at 0.35Hz, +-30px nod at 0.8Hz, plus jitter: a lively talker.
  const samples = trace(
    (t) => ({
      cx: 900 + 70 * Math.sin(2 * Math.PI * 0.35 * t) + 5 * noise(t * 8),
      cy: 400 + 30 * Math.sin(2 * Math.PI * 0.8 * t) + 4 * noise(t * 8, 3),
    }),
    60
  );
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.moves.length, 0, 'the head never left the safe zone, so the frame never moved');
});

test('the lock is taken from the FIRST second, not from the whole clip', () => {
  // 500 for the first 3s, then a small move to 640 that still fits inside the window.
  const samples = trace((t) => ({ cx: t < 3 ? 500 : 640, cy: 400 }), 20);
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.moves.length, 0, '140px is still inside the window - no move');
  assert.ok(Math.abs(path.x0 - windowFor(500, 400, PARAMS).x) < 6, 'locked on where they were at the start');
});

test('the head leaving the frame triggers ONE eased glide that re-centres them, then it locks again', () => {
  // Sits at 900, leans/moves 420px to the right between t=10 and t=11.5, stays there.
  const samples = trace((t) => {
    const u = Math.min(1, Math.max(0, (t - 10) / 1.5));
    return { cx: 900 + 420 * smoothstep(u) + 4 * noise(t * 8), cy: 400 + 3 * noise(t * 8, 2) };
  }, 30);
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.moves.length, 1, 'exactly one re-centre');
  const move = path.moves[0];
  assert.ok(move.t > 9.9 && move.t < 12, `starts when the head reaches the edge (t=${move.t.toFixed(2)})`);
  assert.ok(move.duration >= 0.6 && move.duration <= 1.3, `eased glide, not a snap (${move.duration.toFixed(2)}s)`);

  const before = cameraPositionAt(path, 5);
  const after = cameraPositionAt(path, 25);
  assert.ok(Math.abs(before.x - windowFor(900, 400, PARAMS).x) < 8, 'still locked on the start position before');
  assert.ok(Math.abs(after.x - windowFor(1320, 400, PARAMS).x) < 20, `re-centred on the new spot (x=${after.x.toFixed(0)})`);
  assert.ok(Math.abs(after.y - before.y) < 15, 'nothing moved vertically - they only moved sideways');
});

test('while the camera glides, the head is never cut off by the window', () => {
  const raw = trace((t) => {
    const u = Math.min(1, Math.max(0, (t - 10) / 1.5));
    return { cx: 900 + 420 * smoothstep(u), cy: 400 };
  }, 30);
  const path = buildLockedCamera(raw, PARAMS);
  for (const s of raw) {
    const win = cameraPositionAt(path, s.t);
    assert.ok(s.cx - HEAD_HALF_WIDTH * s.w >= win.x, `left edge at t=${s.t.toFixed(2)}`);
    assert.ok(s.cx + HEAD_HALF_WIDTH * s.w <= win.x + PARAMS.cropW, `right edge at t=${s.t.toFixed(2)}`);
    assert.ok(s.cy - HEAD_UP * s.w >= win.y, `top edge at t=${s.t.toFixed(2)}`);
    assert.ok(s.cy + HEAD_DOWN * s.w <= win.y + PARAMS.cropH, `bottom edge at t=${s.t.toFixed(2)}`);
  }
});

test('standing up (vertical leave) moves the frame up; coming back down moves it back', () => {
  const samples = trace((t) => {
    const up = smoothstep((t - 8) / 0.9) - smoothstep((t - 14) / 0.9);
    return { cx: 900, cy: 500 - 170 * up };
  }, 25);
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.moves.length, 2, 'one glide up, one glide back');
  const lo = cameraPositionAt(path, 12);
  const start = cameraPositionAt(path, 2);
  const end = cameraPositionAt(path, 24);
  assert.ok(lo.y < start.y - 60, `window moved up (${start.y.toFixed(0)} -> ${lo.y.toFixed(0)})`);
  assert.ok(Math.abs(end.y - start.y) < 30, 'and returned');
  assert.ok(Math.abs(lo.x - start.x) < 15, 'no sideways drift');
});

test('a short burst of bad detections is NOT a reason to move', () => {
  // The detector locks onto something 500px away for two samples.
  const samples = trace((t) => ({ cx: t >= 5 && t < 5.25 ? 1400 : 900, cy: 400 }), 15);
  assert.equal(buildLockedCamera(samples, PARAMS).moves.length, 0);
});

test('a head that pops outside the safe zone and comes back within 0.2s does not move the camera', () => {
  // Sample every 1/8s: 1.5 samples ~ 0.19s outside.
  const samples = trace((t) => ({ cx: t >= 5 && t < 5.2 ? 1100 : 900, cy: 400 }), 15);
  assert.equal(buildLockedCamera(samples, PARAMS).moves.length, 0);
});

test('a person at the very edge of the frame: the window is clamped and does not keep trying to move', () => {
  const samples = trace((t) => ({ cx: 70 + 3 * noise(t * 8), cy: 300 }), 20);
  const path = buildLockedCamera(samples, PARAMS);
  assert.equal(path.x0, 0, 'window pinned to the left edge');
  assert.equal(path.moves.length, 0, 'nothing more the camera could do');
});

test('someone pacing back and forth cannot make the camera restless: moves are capped', () => {
  const samples = trace((t) => ({ cx: Math.floor(t / 4) % 2 === 0 ? 700 : 1250, cy: 400 }), 120);
  const path = buildLockedCamera(samples, { ...PARAMS, maxMoves: 6 });
  assert.equal(path.moves.length, 6);
  assert.equal(path.truncated, true);
  for (let i = 1; i < path.moves.length; i += 1) {
    const prev = path.moves[i - 1];
    assert.ok(path.moves[i].t >= prev.t + prev.duration - 1e-9, 'glides never overlap');
  }
});

test('no detections at all: a centred static window (never a crash)', () => {
  const path = buildLockedCamera([], PARAMS);
  assert.equal(path.moves.length, 0);
  assert.ok(path.x0 > 0 && path.y0 > 0);
});

test('a person who appears late: the window is already on them from the first frame', () => {
  const samples = trace(() => ({ cx: 1300, cy: 420 }), 20).filter((s) => s.t >= 8);
  const path = buildLockedCamera(samples, PARAMS);
  assert.ok(Math.abs(path.x0 - windowFor(1300, 420, PARAMS).x) < 6);
  assert.equal(cameraPositionAt(path, 0).x, path.x0, 'static from t=0');
});

test('headInsideSafeZone: margin, hair allowance and oversized heads', () => {
  const win = windowFor(900, 400, PARAMS);
  assert.equal(headInsideSafeZone({ t: 0, cx: 900, cy: 400, w: 120 }, win, PARAMS), true);
  // Head tilted back so its top edge reaches the top margin.
  assert.equal(headInsideSafeZone({ t: 0, cx: 900, cy: 400 - 100, w: 120 }, win, PARAMS), false);
  // Right side: head edge past the margin.
  assert.equal(headInsideSafeZone({ t: 0, cx: 900 + 215, cy: 400, w: 120 }, win, PARAMS), false);
  // A head bigger than the window can only be judged by its centre - centred is fine.
  assert.equal(headInsideSafeZone({ t: 0, cx: 900, cy: 400, w: 600 }, win, PARAMS), true);
});

test('glideSeconds: quick for a hop, longer (but bounded) for a big move', () => {
  assert.ok(glideSeconds(0) >= 0.6);
  assert.ok(glideSeconds(100) < glideSeconds(500));
  assert.ok(glideSeconds(5000) <= 1.3);
});

test('smoothstep eases in and out (zero slope at both ends, 0.5 in the middle)', () => {
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(0.5), 0.5);
  assert.ok(smoothstep(0.05) < 0.01, 'slow start');
  assert.ok(smoothstep(0.95) > 0.99, 'slow finish');
  assert.equal(smoothstep(-3), 0);
  assert.equal(smoothstep(7), 1);
});

/** Evaluate one of our FFmpeg expressions in JS (same functions, same operators). */
function evalFfmpegExpr(expr: string, t: number): number {
  const js = expr
    .replace(/\bclip\(/g, '__clip(')
    .replace(/\bpow\(/g, '__pow(')
    .replace(/\bmin\(/g, '__min(')
    .replace(/\bmax\(/g, '__max(');
  const fn = new Function(
    't',
    '__clip',
    '__pow',
    '__min',
    '__max',
    `return ${js};`
  ) as (t: number, ...f: unknown[]) => number;
  return fn(
    t,
    (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)),
    Math.pow,
    Math.min,
    Math.max
  );
}

test('a time shift that makes a glide start BEFORE t=0 never produces a double minus', () => {
  const path = { x0: 300, y0: 200, moves: [{ t: 2, duration: 0.8, x: 100, y: 200 }], truncated: false };
  const shifted = cameraExpressions(path, 1920, 1080, 540, 480, 13.5); // hook replays from clip time 13.5
  assert.ok(!shifted.x.includes('--'), shifted.x);
  assert.ok(shifted.x.includes('t+11.500'), shifted.x);
  // The glide is long over by the time the hook starts: the window sits at its END position for the whole hook.
  for (const t of [0, 1, 2.9]) assert.ok(Math.abs(evalFfmpegExpr(shifted.x, t) - 100) < 0.1, `x at ${t}`);
});

test('hook branch: only the glides that touch the hook window are kept (the rest fold into the start / drop out)', () => {
  const path = {
    x0: 300,
    y0: 200,
    moves: [
      { t: 2, duration: 0.8, x: 100, y: 200 }, //   finished long before the hook window
      { t: 8, duration: 1, x: 400, y: 260 }, //     finished just before it (ends at 9)
      { t: 20, duration: 1, x: 700, y: 260 }, //    starts after it closes
    ],
    truncated: false,
  };
  const windowed = cameraExpressions(path, 1920, 1080, 540, 480, 10, 3); // hook replays clip time 10..13
  assert.equal(windowed.x, '400.0', 'plain constant: both earlier glides folded in, the later one dropped');
  assert.equal(windowed.y, '260.0');

  // A glide in progress when the window opens must be kept, and the camera must match the full path.
  const mid = { ...path, moves: [...path.moves.slice(0, 2), { t: 9.6, duration: 1.2, x: 650, y: 300 }] };
  const part = cameraExpressions(mid, 1920, 1080, 540, 480, 10, 3);
  assert.ok(part.x.includes('clip('), 'the in-progress glide is still in the expression');
  for (let t = 0; t <= 3; t += 0.1) {
    const want = cameraPositionAt(mid, 10 + t);
    assert.ok(Math.abs(evalFfmpegExpr(part.x, t) - want.x) < 0.2, `x at hook t=${t.toFixed(1)}`);
    assert.ok(Math.abs(evalFfmpegExpr(part.y, t) - want.y) < 0.2, `y at hook t=${t.toFixed(1)}`);
  }
});

test('buildGlideExpression: a window that never moves is a plain constant', () => {
  assert.equal(buildGlideExpression(412.34, [], 1380), '412.3');
  assert.equal(buildGlideExpression(50, [], 0), '0', 'a window as big as the frame has nothing to pan');
});

test('the FFmpeg expression reproduces the planned camera exactly (sampled over time)', () => {
  const samples = trace((t) => {
    const a = smoothstep((t - 10) / 1.5);
    const b = smoothstep((t - 26) / 1.5);
    return { cx: 900 + 420 * (a - b), cy: 400 - 170 * (smoothstep((t - 18) / 0.9) - smoothstep((t - 21) / 0.9)) };
  }, 40);
  const path = buildLockedCamera(samples, PARAMS);
  assert.ok(path.moves.length >= 3, `scenario needs several moves (got ${path.moves.length})`);

  const expr = cameraExpressions(path, PARAMS.srcW, PARAMS.srcH, PARAMS.cropW, PARAMS.cropH);
  for (let t = 0; t <= 40; t += 0.05) {
    const want = cameraPositionAt(path, t);
    const gotX = evalFfmpegExpr(expr.x, t);
    const gotY = evalFfmpegExpr(expr.y, t);
    // toFixed(2/3) rounding in the expression text.
    assert.ok(Math.abs(gotX - want.x) < 0.2, `x at t=${t.toFixed(2)}: ${gotX} vs ${want.x}`);
    assert.ok(Math.abs(gotY - want.y) < 0.2, `y at t=${t.toFixed(2)}: ${gotY} vs ${want.y}`);
  }
});

test('even ten glides keep the crop expression tiny (Windows command-line safe)', () => {
  const samples = trace((t) => ({ cx: Math.floor(t / 6) % 2 === 0 ? 700 : 1250, cy: 400 }), 120);
  const path = buildLockedCamera(samples, PARAMS);
  assert.ok(path.moves.length >= 9);
  const expr = cameraExpressions(path, PARAMS.srcW, PARAMS.srcH, PARAMS.cropW, PARAMS.cropH);
  assert.ok(expr.x.length < 1800, `x expression is ${expr.x.length} chars`);
  assert.ok(expr.y.length < 100, `y expression stays a constant (${expr.y.length} chars)`);
  assert.ok(!expr.x.includes('if('), 'no nested if() chain');
});
