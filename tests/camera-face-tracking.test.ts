/**
 * Live face tracking, camera framing and speaker re-locking.
 *
 * The complaints this covers, from a real render:
 *   - the opening frames showed a microphone / an empty chair instead of the
 *     live speaker, because the window was placed on `runs[0].anchor` (where that
 *     face is somewhere LATER in the shot) regardless of whether the face was
 *     visible in frame one;
 *   - a speaker run whose settle window held no detection was silently DROPPED,
 *     so a clip could open with no anchor at all;
 *   - after a source camera-angle change the crop stayed on the previous angle,
 *     because the tracker kept one identity (and one position) across the cut;
 *   - when detections disappeared the window held a stale crop forever, and when
 *     a speaker was not visible the speaker timeline still labelled them, which
 *     gave the camera a person it could not see.
 *
 * Synthetic tracks only: no FFmpeg, no ONNX model, no video file. Every threshold
 * is a parameter, so the expectations are exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_PLAN_DEFAULTS,
  buildLockedSpeakerCamera,
  detectionGaps,
  measureCameraPlanQa,
  positionAtPath,
} from '../worker/camera-plan';
import { Tracker, type FrameDetection, type Track } from '../worker/asd/tracker';
import { buildSpeakerTimeline } from '../worker/asd/speaker';
import { buildSinglePlan, cameraExpressions, formatCameraFaceLog } from '../worker/layout';
import { faceBoxInsideWindow } from '../worker/camera-lock';
import type { AsdResult } from '../worker/asd/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SRC = { w: 1920, h: 1080 };
const ANCHOR_Y = 0.32;

interface Sight {
  t: number;
  cx: number;
  cy: number;
  w?: number;
}

/** A person detected at exactly `sights` (times are clip-relative seconds). */
function trackOf(id: number, sights: Sight[]): Track {
  const points = sights
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((s) => ({
      t: s.t,
      cx: s.cx,
      cy: s.cy,
      w: s.w ?? 120,
      mouthOpen: null,
      motion: 0.5,
    }));
  const widths = points.map((p) => p.w);
  return {
    id,
    points,
    visibleTime: Math.max(0, points[points.length - 1].t - points[0].t),
    avgW: widths.reduce((sum, w) => sum + w, 0) / Math.max(1, widths.length),
    maxW: Math.max(...widths),
    cx: points[points.length - 1].cx,
    cy: points[points.length - 1].cy,
    vx: 0,
    vy: 0,
    lastT: points[points.length - 1].t,
    missed: 0,
  };
}

/** A person seen every `step` seconds over `[from, to]`. */
function trackEvery(
  id: number,
  from: number,
  to: number,
  f: (t: number) => { cx: number; cy: number; w?: number },
  step = 0.25,
): Track {
  const sights: Sight[] = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    sights.push({ t: Math.round(t * 1000) / 1000, ...f(t) });
  }
  return trackOf(id, sights);
}

function asd(
  tracks: Track[],
  speakers: Array<{ trackId: number | null; t0: number; t1: number }>,
  shotCuts: number[] = [],
): AsdResult {
  return {
    tracks,
    speakerSegments: speakers,
    speakerCount: new Set(speakers.map((s) => s.trackId).filter((x): x is number => x !== null)).size,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: Math.max(1, tracks.length),
    framesUsed: 40,
    framesTotal: 40,
    sampleFps: 4,
    voicedRatio: 0.5,
    shotCuts,
  };
}

function build(tracks: Track[], speakers: Array<{ trackId: number | null; t0: number; t1: number }>, shotCuts: number[] = [], options: Record<string, unknown> = {}) {
  return buildLockedSpeakerCamera(tracks, speakers, {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: 608,
    cropH: 1080,
    anchorY: ANCHOR_Y,
    cuts: shotCuts,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// 1. The video opens on a microphone before the speaker's face appears
// ---------------------------------------------------------------------------

test('a clip that opens on a microphone starts framed on a real face, not on nothing', () => {
  // An establishing angle shows a microphone for the first 2 s; the speaker walks
  // in afterwards. At 2 s the source cuts to a close-up.
  const speaker = trackEvery(1, 3, 20, (t) => ({ cx: 1200 + 10 * Math.sin(t), cy: 430, w: 220 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 20 }], [2]);

  // The opening window must NOT be the speaker's later position (that would show
  // whatever sits there at t=0 - the microphone).
  const speakerWindow = { x: 1200 - 304, y: 430 - 1080 * ANCHOR_Y };
  const open = { x: plan.path.x0, y: plan.path.y0 };
  assert.ok(
    Math.abs(open.x - speakerWindow.x) > 200,
    `the first frame must not be pre-positioned on an invisible face (${JSON.stringify(open)})`,
  );

  // ...and it must move to the speaker on the cut frame, not glide across it.
  const cut = plan.path.cuts?.find((c) => Math.abs(c.t - 2) < 1e-6);
  assert.ok(cut, `a hard switch on the cut frame: ${JSON.stringify(plan.path.cuts)}`);
  assert.ok(Math.abs(cut.x - speakerWindow.x) < 340, `the new shot is framed on the speaker (${cut.x})`);
});

test('the opening frame is validated: the diagnostic says whether a face is really in it', () => {
  const speaker = trackEvery(1, 2.5, 10, () => ({ cx: 900, cy: 430 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 10 }]);
  assert.ok(plan.initial, 'the plan reports its initial framing');
  assert.equal(plan.initial!.trackId, 1);
  assert.equal(plan.initial!.firstFaceAt, 2.5);
  assert.equal(plan.initial!.faceVisibleFromStart, false);
  assert.equal(plan.initial!.leadSeconds, 2.5);

  // Once the face appears, ONE short glide takes the window there (never a cut:
  // nothing about the source changed).
  const openingMove = plan.path.moves.find((move) => move.t >= 2.5 - 1e-6);
  assert.ok(openingMove, JSON.stringify(plan.path.moves));
  assert.ok(openingMove!.duration <= 0.8, 'a controlled transition, not a jump');
  assert.ok(openingMove!.duration >= 0.3, `a move a viewer can follow (${openingMove!.duration}s)`);
  // One short glide, and the window is on the subject within half a second.
  const settledAt = positionAtPath(plan.path, openingMove!.t + openingMove!.duration + 0.01);
  assert.ok(Math.abs(settledAt.x - (900 - 304)) < 200, JSON.stringify(settledAt));
});

// ---------------------------------------------------------------------------
// 2. The first valid face appears after the beginning of the source video
// ---------------------------------------------------------------------------

test('a run whose settle window holds no detection still gets an anchor', () => {
  // The speaker timeline opens at 0, but the detector's first sighting inside this
  // shot is at 1.1 s - the old code medianed an EMPTY settle window and dropped
  // the run, leaving the clip with no anchor at all.
  const speaker = trackEvery(1, 1.1, 12, () => ({ cx: 700, cy: 420 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 12 }]);
  assert.equal(plan.runs.length, 1, 'the run survives');
  assert.equal(plan.runs[0].settleSamples > 0, true);
  assert.ok(plan.segments.length > 0, 'and it produces a camera segment');
  assert.ok(Math.abs(plan.runs[0].face.cx - 700) < 15);
});

// ---------------------------------------------------------------------------
// 3-4. The speaker moves horizontally / vertically
// ---------------------------------------------------------------------------

test('a speaker moving horizontally is followed with short glides and never lost', () => {
  const speaker = trackEvery(1, 0, 12, (t) => ({ cx: 400 + 90 * t, cy: 430, w: 150 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 12 }]);
  assert.ok(plan.path.moves.length >= 1, 'the drift is actually followed');
  assert.ok(
    plan.path.moves.every((move) => move.duration <= 0.5),
    `every move is a short glide: ${JSON.stringify(plan.path.moves.map((m) => m.duration))}`,
  );
  // No micro-adjustments: about one move per 1.5 s of continuous drift, not one
  // per detection (48 detections here).
  assert.ok(plan.path.moves.length <= 8, `${plan.path.moves.length} moves over 12 s`);
  assert.ok(plan.path.moves.length >= 1);
  const qa = measureCameraPlanQa(plan, [speaker], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: 608,
    cropH: 1080,
    anchorY: ANCHOR_Y,
    durationSeconds: 12,
  });
  // A head that never stops moving cannot sit permanently in the dead zone: the
  // point is that it is never LEFT BEHIND (every glide targets the recent median)
  // and that no move is longer than half a second.
  assert.ok(qa.glidesOverHalfSecond === 0);
  assert.ok(qa.maxOffsetPx < 608 / 2, `never more than half a crop off (${qa.maxOffsetPx}px)`);
});

test('a speaker moving vertically keeps the whole head inside the crop', () => {
  // The 9:16 window is FULL height out of 1080, so vertical framing is fixed by
  // the source - what must hold is that the head never gets clipped by it.
  const speaker = trackEvery(1, 0, 10, (t) => ({ cx: 900, cy: 380 + 18 * t, w: 160 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 10 }]);
  const qa = measureCameraPlanQa(plan, [speaker], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: 608,
    cropH: 1080,
    anchorY: ANCHOR_Y,
    durationSeconds: 10,
  });
  assert.equal(qa.framesWithHeadOutsideCrop, 0, 'the head is never cut off');

  // Every window stays inside the source frame on both axes.
  for (const move of plan.path.moves) {
    assert.ok(move.x >= 0 && move.x <= SRC.w - 608, `x in frame: ${move.x}`);
    assert.ok(move.y >= 0 && move.y <= SRC.h - 1080, `y in frame: ${move.y}`);
  }
  assert.ok(plan.path.y0 >= 0 && plan.path.y0 <= SRC.h - 1080);
});

// ---------------------------------------------------------------------------
// 5-6. A source camera-angle change
// ---------------------------------------------------------------------------

test('the same speaker at a completely different position after a cut is re-framed on the cut frame', () => {
  const speaker = trackOf(1, [
    ...Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, cx: 500, cy: 420, w: 110 })),
    ...Array.from({ length: 40 }, (_, i) => ({ t: 5 + i * 0.25, cx: 1500, cy: 460, w: 240 })),
  ]);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 15 }], [5]);
  assert.equal(plan.path.cuts?.length, 1);
  assert.equal(plan.path.cuts![0].t, 5);
  // Not left pointing at the old angle.
  assert.ok(plan.path.cuts![0].x > plan.path.x0 + 500, `${plan.path.x0} -> ${plan.path.cuts![0].x}`);
  assert.equal(plan.path.moves.length, 0, 'a cut is a hard switch, never a glide');
  assert.deepEqual(positionAtPath(plan.path, 4.9), { x: plan.path.x0, y: plan.path.y0 });
  assert.deepEqual(positionAtPath(plan.path, 5), { x: plan.path.cuts![0].x, y: plan.path.cuts![0].y });
});

test('a different speaker visible after the cut is locked immediately', () => {
  const a = trackEvery(1, 0, 5, () => ({ cx: 400, cy: 420 }));
  const b = trackEvery(2, 5, 12, () => ({ cx: 1500, cy: 440 }));
  const plan = build(
    [a, b],
    [
      { trackId: 1, t0: 0, t1: 5 },
      { trackId: 2, t0: 5, t1: 12 },
    ],
    [5],
  );
  const cut = plan.path.cuts?.find((c) => Math.abs(c.t - 5) < 1e-6);
  assert.ok(cut, 'the angle change is a cut');
  assert.ok(Math.abs(cut.x - (1500 - 304)) < 30, `framed on the NEW speaker (${cut.x})`);
  assert.equal(plan.path.moves.length, 0, 'no interpolation across two shots');
});

test('a new shot that opens before its face is recognisable still anchors on that face', () => {
  // Shot 2 opens on a wide angle; the speaker only becomes detectable at 6.2 s.
  const speaker = trackOf(1, [
    ...Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, cx: 500, cy: 420 })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: 6.2 + i * 0.25, cx: 1300, cy: 430, w: 200 })),
  ]);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 14 }], [5]);

  const cut = plan.path.cuts?.find((c) => Math.abs(c.t - 5) < 1e-6);
  assert.ok(cut, `the cut still switches: ${JSON.stringify(plan.path.cuts)}`);
  // Anchored on the face as seen on the NEW shot - not on the old angle, and not
  // on the fallback default.
  assert.ok(
    Math.abs(cut.x - (1300 - 304)) < 60,
    `the new shot is framed on the new angle's face (${cut.x})`,
  );
  assert.equal(plan.path.moves.length, 0, 'a cut is a hard switch, never a glide');
  assert.equal(plan.runs.length, 2, 'both shots have their own run');
  assert.equal(plan.runs[1].shot, 1);
});

test('a new shot with NO face at all jumps away from the old framing, then re-anchors', () => {
  // Shot 2 is an empty stage for 1.2 s; the speaker is only detected after that.
  const speaker = trackOf(1, [
    ...Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, cx: 500, cy: 420 })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: 7.2 + i * 0.25, cx: 1300, cy: 430, w: 200 })),
  ]);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 14 }], [5], {
    // Keep the anchor search short so the "no face on the new shot" path is used.
    settleSeconds: 0.4,
  });
  const cut = plan.path.cuts?.find((c) => Math.abs(c.t - 5) < 1e-6);
  assert.ok(cut, 'the cut switches');
  assert.ok(Math.abs(cut.x - plan.path.x0) > 100, 'it does not keep the old angle');
});

// ---------------------------------------------------------------------------
// 7-8. The face disappears
// ---------------------------------------------------------------------------

test('a brief missed detection holds the framing (no camera move at all)', () => {
  const sights = [];
  for (let t = 0; t <= 10; t += 0.25) {
    // ONE sample missing at 4.0 s: a 0.5 s silence, under the 0.6 s tolerance.
    if (Math.abs(t - 4) < 1e-6) continue;
    sights.push({ t, cx: 800 + 20 * Math.sin(t), cy: 420 });
  }
  const speaker = trackOf(1, sights);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 10 }]);

  assert.equal(plan.fallbackHoles.length, 0, 'a 0.5 s gap is not a disappearance');
  assert.equal(plan.path.moves.length, 0, 'and it must not move the camera');
  assert.deepEqual(plan.holes, [], 'a gap under the tolerance is not reported as a hole');
});

test('an extended disappearance falls back deterministically, then re-locks', () => {
  const speaker = trackOf(1, [
    ...Array.from({ length: 16 }, (_, i) => ({ t: i * 0.25, cx: 700, cy: 420 })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: 8 + i * 0.25, cx: 1500, cy: 440 })),
  ]);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 13 }]);
  const gap = plan.holes.find((hole) => hole.start > 3 && hole.end <= 8.2);
  assert.ok(gap, `the disappearance is reported: ${JSON.stringify(plan.holes)}`);
  assert.ok(gap!.end - gap!.start > 3, 'an extended gap');

  // Exactly one fallback move, after the grace period, and it is deterministic.
  assert.equal(plan.fallbackHoles.length, 1, JSON.stringify(plan.fallbackHoles));
  const fallback = plan.fallbackHoles[0];
  assert.equal(fallback.source, 'default', 'nobody else is on screen, so the clamped default');
  assert.ok(fallback.t >= gap!.start + 1.4, `held the grace period first (${fallback.t})`);

  // Re-lock on the face when it returns: a move at/after 8 s.
  assert.ok(
    plan.path.moves.some((move) => move.t >= 8 - 1e-6),
    JSON.stringify(plan.path.moves),
  );
});

test('a disappearance with another face on screen falls back to that visible face', () => {
  // The speaker leaves at 6 s. A second person is on screen the whole time but is
  // never labelled a speaker and their track is too short to be promoted to a lock
  // run - so no run covers [6, 15] and the camera has nobody it is allowed to
  // follow. It must still not keep the departed speaker's stale crop: it moves to
  // the face that IS there.
  // Person 2 is NOT promoted to a lock run (they never speak), so the span after
  // the speaker leaves is uncovered - the camera has nobody it is allowed to
  // follow, but a face is plainly on screen.
  const left = trackOf(1, Array.from({ length: 16 }, (_, i) => ({ t: i * 0.25, cx: 500, cy: 420 })));
  const seated = trackEvery(2, 0, 15, () => ({ cx: 1450, cy: 430, w: 140 }));
  const plan = build(
    [left, seated],
    [{ trackId: 1, t0: 0, t1: 3.75 }],
    [],
    { durationSeconds: 15 },
  );
  const fallback = plan.fallbackHoles.find((entry) => entry.source === 'visible-face');
  assert.ok(fallback, `the visible face is used: ${JSON.stringify(plan.fallbackHoles)}`);
  const move = plan.path.moves.find((m) => Math.abs(m.t - fallback!.t) < 1e-6);
  assert.ok(move, 'the fallback is an actual camera move');
  assert.ok(Math.abs(move!.x - (1450 - 304)) < 60, `framed on the visible face (${move!.x})`);
});

// ---------------------------------------------------------------------------
// 9. Multiple faces visible at the same time
// ---------------------------------------------------------------------------

test('with two faces on screen the ACTIVE SPEAKER keeps the frame', () => {
  const speaker = trackEvery(1, 0, 12, () => ({ cx: 500, cy: 420, w: 150 }));
  // The listener is bigger (closer to camera) - size must not win over the speaker.
  const listener = trackEvery(2, 0, 12, () => ({ cx: 1450, cy: 430, w: 260 }));
  const plan = build(
    [speaker, listener],
    [
      { trackId: 1, t0: 0, t1: 6 },
      { trackId: 2, t0: 6, t1: 12 },
    ],
  );
  const first = plan.segments.find((segment) => segment.kind === 'lock')!;
  assert.equal(first.trackId, 1, 'the speaker, not the biggest face');
  assert.ok(Math.abs(plan.path.x0 - (500 - 304)) < 40);
  const swap = plan.path.moves.find((move) => move.t >= 5.9);
  assert.ok(swap, 'the turn change moves the frame');
  assert.ok(Math.abs(swap!.x - (1450 - 304)) < 40);
  assert.equal(plan.switches.length, 1);
});

// ---------------------------------------------------------------------------
// 10. Audio detects a speaker whose face is temporarily unavailable
// ---------------------------------------------------------------------------

test('a speaker label with no visible face does not create an invalid lock', () => {
  // The timeline says person 1 is talking, but they are not detected at all here.
  const ghost = trackEvery(1, 0, 3, () => ({ cx: 500, cy: 420 }));
  const plan = build([ghost], [{ trackId: 1, t0: 0, t1: 10 }]);
  // The run exists (the label is honest), but the plan never pretends the face is
  // there past the grace period: that is what the hole + fallback describe.
  assert.ok(plan.holes.length >= 1, JSON.stringify(plan.holes));
  assert.equal(plan.fallbackHoles.length, 1);
  assert.equal(plan.fallbackHoles[0].source, 'default');
});

test('the speaker timeline never labels a person who is not on screen', () => {
  const fps = 8;
  const duration = 8;
  const gone = trackOf(1, Array.from({ length: 8 }, (_, i) => ({ t: i * 0.25, cx: 500, cy: 420 })));
  gone.points = gone.points.map((p) => ({ ...p, motion: 0.6 }));
  const voice = new Array(duration * fps).fill(0.8);
  const { segments } = buildSpeakerTimeline({
    duration,
    fps,
    voice,
    tracks: [gone],
    frameWidth: SRC.w,
  });
  // After their last sighting (2 s) the label must stop, not persist to 8 s.
  const labelled = segments.filter((segment) => segment.trackId !== null);
  assert.ok(labelled.length > 0);
  // The window that owns the last sighting also owns the step after it, so the
  // label may extend by at most one decision window past the final detection.
  const lastSighting = gone.points[gone.points.length - 1].t;
  assert.ok(
    labelled.every((segment) => segment.t1 <= lastSighting + 1.2),
    `labels stop when the face does (${lastSighting}s): ${JSON.stringify(segments)}`,
  );
  // And the tail of the clip is explicitly "nobody", not a stale label.
  assert.equal(segments[segments.length - 1].trackId, null);
});

// ---------------------------------------------------------------------------
// 11. The detector misses a sampled frame
// ---------------------------------------------------------------------------

test('one noisy detection cannot move the camera and one miss cannot move it back', () => {
  const sights = [];
  for (let t = 0; t <= 10; t += 0.25) {
    // A single wild outlier at 5 s (a false positive well off the person).
    const outlier = Math.abs(t - 5) < 1e-6;
    sights.push({ t, cx: outlier ? 1600 : 800, cy: 420 });
  }
  const plan = build([trackOf(1, sights)], [{ trackId: 1, t0: 0, t1: 10 }]);
  assert.equal(plan.path.moves.length, 0, `a median filter absorbs one outlier: ${JSON.stringify(plan.path.moves)}`);
});

// ---------------------------------------------------------------------------
// 12. No valid face anywhere in the segment
// ---------------------------------------------------------------------------

test('with no detection at all the crop is the deterministic default, never a guess', () => {
  const plan = build([], [{ trackId: 1, t0: 0, t1: 10 }]);
  assert.deepEqual(plan.runs, []);
  assert.deepEqual(plan.path.moves, []);
  assert.equal(plan.path.x0, (SRC.w - 608) / 2);
  assert.equal(plan.path.y0, Math.max(0, (SRC.h - 1080) / 2));
  assert.equal(plan.initial, null);
  assert.match(formatCameraFaceLog(plan), /initial=none/);
});

// ---------------------------------------------------------------------------
// 13-14. The generated crop
// ---------------------------------------------------------------------------

test('the first generated frame is framed on the opening subject', () => {
  const speaker = trackEvery(1, 0, 8, () => ({ cx: 1100, cy: 430, w: 200 }));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 8 }]);
  assert.equal(plan.initial?.faceVisibleFromStart, true, formatCameraFaceLog(plan));
  const open = positionAtPath(plan.path, 0);
  assert.ok(
    faceBoxInsideWindow(
      { t: 0, cx: 1100, cy: 430, w: 200 },
      open,
      { cropW: 608, cropH: 1080, marginFraction: 0 },
    ),
    `the face is inside the first frame (${JSON.stringify(open)})`,
  );
});

test('the generated crop never leaves the source frame, on any axis, at any time', () => {
  // A crowded, adversarial clip: two cuts, a wild mover, a listener and a gap.
  const a = trackEvery(1, 0, 6, (t) => ({ cx: 80 + 40 * Math.sin(t * 2), cy: 200, w: 320 }));
  const b = trackOf(2, [
    ...Array.from({ length: 12 }, (_, i) => ({ t: 6 + i * 0.25, cx: 1830, cy: 990, w: 300 })),
    ...Array.from({ length: 12 }, (_, i) => ({ t: 9 + i * 0.25, cx: 20, cy: 30, w: 300 })),
  ]);
  const plan = build(
    [a, b],
    [
      { trackId: 1, t0: 0, t1: 6 },
      { trackId: 2, t0: 6, t1: 12 },
    ],
    [6],
  );
  for (let t = 0; t <= 12; t += 0.05) {
    const pos = positionAtPath(plan.path, t);
    assert.ok(pos.x >= 0 && pos.x <= SRC.w - 608, `x=${pos.x} at ${t.toFixed(2)}`);
    assert.ok(pos.y >= 0 && pos.y <= SRC.h - 1080, `y=${pos.y} at ${t.toFixed(2)}`);
  }
  // And the FFmpeg expressions come out clean (no colon can reach crop's parser).
  const expr = cameraExpressions(plan.path, SRC.w, SRC.h, 608, 1080);
  assert.ok(!expr.x.includes(':'), expr.x);
  assert.ok(!expr.y.includes(':'), expr.y);
});

// ---------------------------------------------------------------------------
// Tracker: identities never span a shot cut
// ---------------------------------------------------------------------------

function det(t: number, cx: number, cy: number, w = 120): FrameDetection {
  return { cx, cy, w, mouthOpen: null, motion: 0.5 };
}

test('a shot cut closes every track so no identity spans two camera angles', () => {
  const tracker = new Tracker();
  // Person at the left of a wide shot...
  for (let i = 0; i < 6; i += 1) tracker.update(i * 0.25, [det(i * 0.25, 500, 400)]);
  const before = tracker.all()[0];
  assert.equal(before.points.length, 6);

  // ...cut to a close-up where the SAME person is far right.
  tracker.resetAtShotCut(1.5);
  for (let i = 6; i < 12; i += 1) tracker.update(i * 0.25, [det(i * 0.25, 1500, 430)]);

  const tracks = tracker.all();
  assert.equal(tracks.length, 2, 'the new shot starts a NEW identity');
  assert.ok(
    tracks.every((track) => track.points.every((p) => p.t < 1.5) || track.points.every((p) => p.t >= 1.5)),
    'no track holds sightings from both angles',
  );
  // One cut resets exactly once, even if the sampler reports it twice.
  const ids = tracker.all().length;
  tracker.resetAtShotCut(1.5);
  tracker.update(3, [det(3, 1500, 430)]);
  assert.equal(tracker.all().length, ids, 'the second report of the same cut is ignored');
});

test('without a cut the same person keeps one identity (no spurious splits)', () => {
  const tracker = new Tracker();
  for (let i = 0; i < 12; i += 1) tracker.update(i * 0.25, [det(i * 0.25, 900 + i * 4, 420)]);
  assert.equal(tracker.all().length, 1);
});

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

test('detection gaps distinguish a missed sample from a disappearance', () => {
  const points = [0, 0.25, 0.5, 0.75, 2.75, 3, 3.25].map((t) => ({
    t,
    cx: 500,
    cy: 420,
    w: 120,
    mouthOpen: null,
    motion: 0.5,
  }));
  // 0.4 s tolerance: the 0.25 s cadence has no gaps, but the 2 s absence does.
  assert.deepEqual(detectionGaps({ points }, 0, 3.25), [{ start: 0.75, end: 2.75 }]);
  // A tolerance smaller than the sampling cadence reports every interval (the
  // caller must pass the detector's own cadence as the tolerance).
  assert.ok(
    detectionGaps({ points }, 0, 3.25, 0.1).length > 1,
    'a tolerance below the sampling interval reports ordinary intervals as gaps',
  );
  // Leading and trailing absences are holes too.
  assert.deepEqual(detectionGaps({ points }, 0, 5), [
    { start: 0.75, end: 2.75 },
    { start: 3.25, end: 5 },
  ]);
});

// ---------------------------------------------------------------------------
// Logging: explain WHY, without a line per frame
// ---------------------------------------------------------------------------

test('[CAMERA-FACE] explains the opening, the gaps and the fallbacks in one line', () => {
  const speaker = trackOf(1, [
    ...Array.from({ length: 8 }, (_, i) => ({ t: i * 0.25, cx: 700, cy: 420 })),
    ...Array.from({ length: 16 }, (_, i) => ({ t: 6 + i * 0.25, cx: 1500, cy: 440 })),
  ]);
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 10 }]);
  const line = formatCameraFaceLog(plan);
  assert.match(line, /^\[CAMERA-FACE\] initial=visible track=1 first_face_at=0s/);
  assert.match(line, /gaps=1/);
  assert.match(line, /long_gaps=1/);
  assert.match(line, /fallbacks=1/);
  assert.equal(line.includes('\n'), false, 'one greppable line');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('the missing-face hold is a documented, bounded setting', () => {
  assert.equal(CAMERA_PLAN_DEFAULTS.faceLostHoldSeconds, 1.5);
  const plan = buildLockedSpeakerCamera([], [], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: 608,
    cropH: 1080,
    anchorY: ANCHOR_Y,
  });
  assert.equal(plan.options.faceLostHoldSeconds, 1.5);
  const off = buildLockedSpeakerCamera([], [], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: 608,
    cropH: 1080,
    anchorY: ANCHOR_Y,
    faceLostHoldSeconds: 0,
  });
  assert.equal(off.options.faceLostHoldSeconds, 0, '0 restores always-hold');
});

test('with holding disabled the framing is kept, never moved at random', () => {
  const speaker = trackOf(1, Array.from({ length: 8 }, (_, i) => ({ t: i * 0.25, cx: 700, cy: 420 })));
  const plan = build([speaker], [{ trackId: 1, t0: 0, t1: 10 }], [], { faceLostHoldSeconds: 0 });
  assert.deepEqual(plan.fallbackHoles, []);
  assert.deepEqual(plan.path.moves, []);
  assert.equal(plan.holes.length, 0, 'no hold policy means no hole reasoning');
});

// ---------------------------------------------------------------------------
// End-to-end through the layout entry point
// ---------------------------------------------------------------------------

test('buildSinglePlan: the opening frame of a mic-then-speaker clip is the speaker', () => {
  const speaker = trackEvery(1, 4, 14, () => ({ cx: 1300, cy: 420, w: 210 }));
  const single = buildSinglePlan(
    asd([speaker], [{ trackId: 1, t0: 0, t1: 14 }], [4]),
    SRC.w,
    SRC.h,
    ANCHOR_Y,
    {},
  );
  assert.ok(single.camera, 'a camera path is produced');
  const open = positionAtPath(single.camera!, 0);
  assert.ok(
    Math.abs(open.x - (1300 - 304)) > 200,
    't=0 is NOT pre-positioned on a face that is not there yet',
  );
  const expr = cameraExpressions(single.camera!, SRC.w, SRC.h, single.cropW, single.cropH);
  assert.ok(expr.x.length > 0);
  assert.match(formatCameraFaceLog(single.cameraPlan!), /reanchor_cuts=0|cuts=0/);
});
