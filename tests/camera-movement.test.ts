/**
 * Camera movement quality: the events a viewer actually notices.
 *
 *   - a move has to be a move (0.3-0.7 s, eased) and never a long pan;
 *   - two decisions inside one transition RETARGET the same move instead of
 *     stacking two glides that fight each other;
 *   - a target that would not visibly change the framing is not a camera event;
 *   - the complete HEAD is what must stay inside the crop, measured against the
 *     real face box, and a head the source frame itself cuts is not a defect;
 *   - every move says why it happened.
 *
 * Pure planner logic (no FFmpeg, no model), so every expectation is exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSinglePlan,
  formatCameraMoveLog,
  getSpeakerCameraSettings,
} from '../worker/layout';
import { measureCameraPlanQa, positionAtPath } from '../worker/camera-plan';
import { AsdResult } from '../worker/asd/index';
import { Track } from '../worker/asd/tracker';

const SRC = { w: 1920, h: 1080 };
const ANCHOR_Y = 0.32;

/** A track with a detection every 0.25 s, `h` = the real face-box height. */
function track(
  id: number,
  seconds: number,
  f: (t: number) => { cx: number; cy: number; w?: number; h?: number },
): Track {
  const points = [];
  for (let i = 0; i < Math.floor(seconds * 4); i += 1) {
    const t = i / 4;
    const p = f(t);
    points.push({
      t,
      cx: p.cx,
      cy: p.cy,
      w: p.w ?? 200,
      ...(p.h !== undefined ? { h: p.h } : {}),
      mouthOpen: null,
      // A live face: the framing tests are about geometry, not liveness.
      motion: 0.2,
    });
  }
  const cx = points.reduce((sum, point) => sum + point.cx, 0) / Math.max(1, points.length);
  const cy = points.reduce((sum, point) => sum + point.cy, 0) / Math.max(1, points.length);
  return {
    id,
    points,
    visibleTime: seconds,
    avgW: 200,
    maxW: 200,
    cx,
    cy,
    vx: 0,
    vy: 0,
    lastT: seconds,
    missed: 0,
  };
}

function asd(tracks: Track[], segments: Array<{ trackId: number | null; t0: number; t1: number }>): AsdResult {
  return {
    tracks,
    speakerSegments: segments,
    speakerCount: new Set(segments.map((segment) => segment.trackId)).size,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: tracks.length,
    framesUsed: 100,
    framesTotal: 100,
    sampleFps: 4,
    voicedRatio: 0.8,
  };
}

function plan(asdResult: AsdResult, options: Record<string, unknown> = {}, anchorY = ANCHOR_Y) {
  const single = buildSinglePlan(asdResult, SRC.w, SRC.h, anchorY, options);
  assert.ok(single.camera, 'locked mode always produces a camera path');
  return single;
}

// ---------------------------------------------------------------------------
// Transition behaviour
// ---------------------------------------------------------------------------

test('a speaker change is a deliberate move: eased, in the 0.3-0.7 s band', () => {
  const a = track(1, 10, () => ({ cx: 400, cy: 420 }));
  const b = track(2, 10, () => ({ cx: 1500, cy: 420 }));
  const single = plan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    {},
  );
  const move = single.camera!.moves[0];
  assert.ok(move, JSON.stringify(single.camera!.moves));
  assert.ok(move.duration >= 0.3, `not a snap (${move.duration}s)`);
  assert.ok(move.duration <= 0.7, `not a crawl (${move.duration}s)`);
  // smoothstep easing: the move has zero velocity at both ends, so halfway
  // through it has covered exactly half the distance.
  const halfway = positionAtPath(single.camera!, move.t + move.duration / 2);
  const start = positionAtPath(single.camera!, move.t - 0.01);
  const expected = (start.x + move.x) / 2;
  assert.ok(Math.abs(halfway.x - expected) <= 2, `eased midpoint ${halfway.x} ~ ${expected}`);
});

test('a long travel earns a little more time, but never becomes a pan', () => {
  const a = track(1, 10, () => ({ cx: 200, cy: 420 }));
  const b = track(2, 10, () => ({ cx: 1800, cy: 420 }));
  const single = plan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    {},
  );
  const move = single.camera!.moves[0];
  assert.ok(move.duration > 0.35, `a full-width travel takes longer (${move.duration}s)`);
  assert.ok(move.duration <= 0.75, `and still not a pan (${move.duration}s)`);
});

test('a second decision inside a transition retargets it instead of stacking glides', () => {
  // Two turns close together: the first move has not finished when the second
  // begins. The plan must never contain two overlapping glides.
  const a = track(1, 10, () => ({ cx: 400, cy: 420 }));
  const b = track(2, 10, () => ({ cx: 1100, cy: 420 }));
  const c = track(3, 10, () => ({ cx: 1750, cy: 420 }));
  const single = plan(
    asd([a, b, c], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 5.4 },
      { trackId: 3, t0: 5.4, t1: 10 },
    ]),
    {},
  );
  const moves = single.camera!.moves;
  assert.ok(moves.length >= 1, JSON.stringify(moves));
  for (let i = 1; i < moves.length; i += 1) {
    const previous = moves[i - 1];
    assert.ok(
      moves[i].t >= previous.t + previous.duration - 1e-6,
      `move ${i} (${moves[i].t}s) starts before move ${i - 1} ends (${previous.t + previous.duration}s)`,
    );
  }
  // And the last one really does reach the third speaker.
  const end = positionAtPath(single.camera!, 10);
  assert.ok(end.x + single.cropW / 2 > 1400, `ends on person 3 (centre ${end.x + single.cropW / 2})`);
});

test('a target too close to the current framing is not a camera event', () => {
  // The face drifts 40 px - well inside the dead zone - then a new speaker run
  // starts whose anchor is only a few pixels away. Nothing should move.
  const a = track(1, 20, (t) => ({ cx: 900 + 30 * Math.sin(t), cy: 420 }));
  const single = plan(
    asd([a], [
      { trackId: 1, t0: 0, t1: 10 },
      { trackId: 1, t0: 10, t1: 20 },
    ]),
    {},
  );
  assert.equal(single.camera!.moves.length, 0, JSON.stringify(single.camera!.moves));
});

test('the minimum-move threshold is configurable and resolution aware', () => {
  const defaults = getSpeakerCameraSettings({}, SRC.w, SRC.h);
  assert.equal(defaults.minMovePct, 0.035, '3.5% of the crop by default');
  const wide = getSpeakerCameraSettings({ CAMERA_MIN_MOVE_PCT: '10' }, SRC.w, SRC.h);
  assert.equal(wide.minMovePct, 0.10, 'the flag is a PERCENTAGE (10 = 10% of the crop)');
  const off = getSpeakerCameraSettings({ CAMERA_MIN_MOVE_PCT: '0' }, SRC.w, SRC.h);
  assert.equal(off.minMovePct, 0);
});

test('a slow continuous drift needs real confirmation before the frame moves', () => {
  const drifting = track(1, 40, (t) => ({ cx: 500 + t * 12, cy: 420 }));
  const single = plan(asd([drifting], [{ trackId: 1, t0: 0, t1: 40 }]), {});
  const settings = getSpeakerCameraSettings({}, SRC.w, SRC.h);
  assert.equal(settings.confirmSeconds, 0.9);
  // A drift that never stops cannot re-frame on every sample; a handful of moves
  // over 40 s is the tripod behaviour, dozens of them is hunting.
  assert.ok(single.camera!.moves.length <= 8, `moves=${single.camera!.moves.length}`);
});

// ---------------------------------------------------------------------------
// Head framing
// ---------------------------------------------------------------------------

test('the whole head is inside the crop, measured on the head not the centre', () => {
  const speaker = track(1, 20, () => ({ cx: 980, cy: 420 }));
  const single = plan(asd([speaker], [{ trackId: 1, t0: 0, t1: 20 }]), {});
  const qa = measureCameraPlanQa(single.cameraPlan!, [speaker], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 20,
  });
  assert.equal(qa.pctFramesHeadInsideCrop, 100, 'the head is whole in every frame');
  assert.equal(qa.framesWithHeadOutsideCrop, 0);
  assert.equal(qa.pctFramesHeadSafelyFramed, 100, 'and clears the safety margin');
  assert.equal(qa.maxPathDriftPx, 0, 'the plan and its expression agree');
});

test('the head estimate uses the detected box height when the detector reports it', () => {
  // A box that is TALLER than a standard YuNet box (a tilted head, or a different
  // detector): the head above it must be estimated from the height, so framing is
  // not silently based on the wrong head size.
  const tall = track(1, 20, () => ({ cx: 960, cy: 420, w: 200, h: 320 }));
  const single = plan(asd([tall], [{ trackId: 1, t0: 0, t1: 20 }]), {});
  const qa = measureCameraPlanQa(single.cameraPlan!, [tall], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 20,
  });
  // A 200x320 box is outside the standard ratio; the window must still be placed
  // so the head is whole (this is exactly the case that used to clip the chin).
  assert.equal(qa.framesWithHeadOutsideCrop, 0, `head outside in ${qa.framesWithHeadOutsideCrop} frames`);
  assert.equal(qa.pctFramesHeadInsideCrop, 100);
});

test('a person at the edge of the source is reported as unfittable, not as a framing failure', () => {
  // The head itself runs off the SOURCE frame: no crop can frame it. Counting it
  // as a camera defect is what made the old numbers contradictory.
  const edge = track(1, 20, () => ({ cx: 1880, cy: 420 }));
  const single = plan(asd([edge], [{ trackId: 1, t0: 0, t1: 20 }]), {});
  const qa = measureCameraPlanQa(single.cameraPlan!, [edge], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 20,
  });
  assert.ok(qa.framesWithHeadUnfittable > 0, 'reported honestly');
  assert.equal(qa.framesWithHeadOutsideCrop, 0, 'and not blamed on the camera');
  assert.equal(qa.pctFramesHeadInsideCrop, 100);
  assert.ok(qa.edgeLimitedFrames > 0, 'the edge limit is visible too');
});

test('the window keeps the whole head when the face alone would fit but the head would not', () => {
  // A 9:16 window out of a 16:9 source is FULL height, so the only framing choice
  // left is horizontal - and that is exactly where a face-centred window clips the
  // side of a head. Person just right of centre: a window centred on the FACE
  // fits, but a window at the configured anchor would push the head out.
  const speaker = track(1, 10, () => ({ cx: 1180, cy: 420 }));
  const single = plan(asd([speaker], [{ trackId: 1, t0: 0, t1: 10 }]), {}, ANCHOR_Y);
  const win = positionAtPath(single.camera!, 0);
  const halfHead = 0.62 * 200;
  assert.ok(1180 - halfHead >= win.x, `left side of the head inside (${1180 - halfHead} >= ${win.x})`);
  assert.ok(
    1180 + halfHead <= win.x + single.cropW,
    `right side of the head inside (${1180 + halfHead} <= ${win.x + single.cropW})`,
  );
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test('[CAMERA-MOVE] names every event and why it happened', () => {
  const a = track(1, 10, () => ({ cx: 400, cy: 420 }));
  const b = track(2, 10, () => ({ cx: 1500, cy: 420 }));
  const single = plan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    {},
  );
  const line = formatCameraMoveLog(single.cameraPlan!);
  assert.match(line, /^\[CAMERA-MOVE\] events=\d+/);
  assert.match(line, /5\.00s=speaker-change->person#2 glide/);
  assert.match(line, /to=\d+,\d+/);
});

test('a source cut is a hard switch, reported as one', () => {
  const speaker = track(1, 10, () => ({ cx: 400, cy: 420 }));
  const single = plan(asd([speaker], [{ trackId: 1, t0: 0, t1: 10 }]), { cuts: [5] });
  // A cut with no speaker change still re-frames the subject on the exact cut
  // frame (a new camera angle means new coordinates) - reported as a cut, never as
  // a glide that would travel across two different pictures.
  const cut = single.camera!.cuts?.[0];
  assert.ok(cut, `a hard switch at the cut: ${JSON.stringify(single.camera)}`);
  assert.ok(Math.abs(cut!.t - 5) < 0.02, `on the cut frame (t=${cut!.t})`);
  assert.deepEqual(positionAtPath(single.camera!, 5), { x: cut!.x, y: cut!.y });
});

test('switch entries record the target they moved to', () => {
  const a = track(1, 10, () => ({ cx: 400, cy: 420 }));
  const b = track(2, 10, () => ({ cx: 1500, cy: 420 }));
  const single = plan(
    asd([a, b], [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 10 },
    ]),
    {},
  );
  const swap = single.cameraPlan!.switches[0];
  assert.ok(swap, JSON.stringify(single.cameraPlan!.switches));
  assert.equal(swap.trackId, 2);
  assert.equal(swap.reason, 'speaker-change');
  assert.ok(swap.to.x > 1000, `moved towards person 2 (x=${swap.to.x})`);
  assert.ok(swap.duration >= 0.3, `a glide, not a jump (${swap.duration}s)`);
});
