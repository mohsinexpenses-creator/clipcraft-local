/**
 * Locked speaker camera (`CAMERA_MODE=locked`, the default) and its rollback.
 *
 * The complaints this covers, from a real render's log:
 *   - 31 keyframes and glides of 13.6 s / 8.75 s / 1.9 s on a 90 s window (the
 *     whole track was decimated to 24 points BEFORE it was cut into segments);
 *   - the window crept towards each segment's median face position even while the
 *     speaker stood still;
 *   - the hook window moved about once a second;
 *   - the crop interpolated right across source shot cuts.
 *
 * Synthetic tracks only: every threshold is a parameter, so the expectations here
 * are exact (no FFmpeg, no model, no video file).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSingleFilterParts,
  buildSinglePlan,
  cameraExpressions,
  formatCameraPlanLog,
  formatCameraQaLog,
  getFilterGraphScriptThreshold,
  getSpeakerCameraSettings,
  needsFilterScript,
  sliceCameraPath,
  FILTER_GRAPH_SCRIPT_THRESHOLD,
} from '../worker/layout';
import {
  buildSpeakerRuns,
  isTransition,
  measureCameraPlanQa,
  measureCameraQa,
  onScreenShare,
  positionAtPath,
} from '../worker/camera-plan';
import { AsdResult } from '../worker/asd/index';
import { Track } from '../worker/asd/tracker';
import {
  collateSceneCuts,
  cutBetween,
  parseSceneMetadata,
  splitTimesAtCuts,
} from '../worker/asd/shot-cuts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SRC = { w: 1920, h: 1080 };
const ANCHOR_Y = 0.32;

/** A person whose face centre follows `f(t)`, one sighting every 0.25 s. */
function track(id: number, duration: number, f: (t: number) => { cx: number; cy: number; w?: number }): Track {
  const points = [];
  for (let i = 0; i * 0.25 < duration; i += 1) {
    const t = Math.round(i * 0.25 * 1000) / 1000;
    const p = f(t);
    points.push({ t, cx: p.cx, cy: p.cy, w: p.w ?? 120, mouthOpen: null, motion: 0.5 });
  }
  const widths = points.map((p) => p.w);
  return {
    id,
    points,
    visibleTime: duration,
    avgW: widths.reduce((sum, w) => sum + w, 0) / Math.max(1, widths.length),
    maxW: Math.max(...widths),
    cx: points[points.length - 1].cx,
    cy: points[points.length - 1].cy,
    vx: 0,
    vy: 0,
    lastT: duration,
    missed: 0,
  };
}

function asd(
  tracks: Track[],
  speakers: Array<{ trackId: number | null; t0: number; t1: number }>,
  shotCuts: number[] = []
): AsdResult {
  return {
    tracks,
    speakerSegments: speakers,
    speakerCount: new Set(speakers.map((s) => s.trackId).filter((x): x is number => x !== null)).size,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: tracks.length,
    framesUsed: 40,
    framesTotal: 40,
    sampleFps: 4,
    voicedRatio: 0.5,
    shotCuts,
  };
}

function plan(asdResult: AsdResult, options: Record<string, unknown> = {}) {
  const single = buildSinglePlan(asdResult, SRC.w, SRC.h, ANCHOR_Y, options);
  assert.ok(single.camera, 'locked mode always produces a camera path');
  return single;
}

// ---------------------------------------------------------------------------
// Task 1: a talking head that sways +/-40px never moves the camera
// ---------------------------------------------------------------------------

test('a talking head swaying +/-40px produces ZERO camera motion', () => {
  const head = track(1, 60, (t) => ({
    cx: 900 + 40 * Math.sin(2 * Math.PI * 0.35 * t),
    cy: 420 + 20 * Math.sin(2 * Math.PI * 0.8 * t),
  }));
  const single = plan(asd([head], [{ trackId: 1, t0: 0, t1: 60 }]));

  assert.equal(single.camera!.moves.length, 0, 'the frame never moves');
  assert.equal(single.camera!.cuts?.length ?? 0, 0, 'and never switches');
  // One position for the whole clip: the median of the first second.
  const position = positionAtPath(single.camera!, 0);
  for (let t = 0; t <= 60; t += 0.5) {
    assert.deepEqual(positionAtPath(single.camera!, t), position, `still at t=${t}`);
  }
  // The face stays well inside the crop the whole time.
  const qa = measureCameraQa({
    path: single.camera!,
    samples: head.points.map((p) => ({ t: p.t, cx: p.cx, cy: p.cy, w: p.w })),
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 60,
  });
  assert.equal(qa.edgeLimitedFrames, 0, 'no frame was pinned by the crop edge');
  // The sway does poke out of the 10%x8% dead zone on its extremes; what matters is
  // that the CAMERA never moved for it. The peak excursion is bounded by the sway.
  // (A 60 s sway at 0.35 Hz puts the third harmonic in the median's rear window,
  // so the measured peak can exceed the sway itself - the camera still holds.)
  assert.ok(qa.maxOffsetPx < 80, `max offset stays small (${qa.maxOffsetPx}px)`);
  assert.ok(
    qa.pctFramesInDeadzone > 50,
    `the spot the camera chose is the face's typical place (${qa.pctFramesInDeadzone}%)`
  );
});

test('the dead zone is 10% of the crop width and 8% of its height (flags change it)', () => {
  const settings = getSpeakerCameraSettings({}, SRC.w, SRC.h);
  assert.equal(settings.mode, 'locked', 'locked is the default');
  assert.equal(settings.deadZoneXPct, 0.1);
  assert.equal(settings.deadZoneYPct, 0.08);
  assert.equal(settings.confirmSeconds, 0.4);
  assert.equal(settings.recentreSeconds, 0.35);
  assert.equal(settings.speakerGlideSeconds, 0.1);
  assert.equal(settings.switchMode, 'glide');
  assert.equal(settings.cutaways, false, 'SPEAKER_CUTAWAYS is off by default');
  assert.equal(settings.speakerHoldSeconds, 6);
  assert.equal(settings.cutawaySeconds, 2);
  assert.equal(settings.cutawayPick, 'random');
  assert.equal(settings.maxMoves, 400, 'the keyframe safety cap');

  const wide = getSpeakerCameraSettings(
    { CAMERA_HOLD_DEADZONE_PCT: '20', CAMERA_HOLD_DEADZONE_Y_PCT: '12' },
    SRC.w,
    SRC.h
  );
  assert.equal(wide.deadZoneXPct, 0.2);
  assert.equal(wide.deadZoneYPct, 0.12);

  // A sway that leaves the default zone no longer moves a 20%-wide zone.
  const head = track(1, 20, (t) => ({ cx: 900 + 40 * Math.sin(2 * Math.PI * 0.1 * t), cy: 420 }));
  assert.equal(plan(asd([head], [{ trackId: 1, t0: 0, t1: 20 }])).camera!.moves.length, 0);
  // A 2%-wide dead zone makes the same 40px sway a real departure.
  assert.equal(
    plan(asd([head], [{ trackId: 1, t0: 0, t1: 20 }]), { deadZoneXPct: 0.02 }).camera!.moves.length > 0,
    true,
    'a narrower dead zone does react to the same sway'
  );
});

// ---------------------------------------------------------------------------
// Task 1: a slow drift past the dead zone = exactly ONE re-centre
// ---------------------------------------------------------------------------

test('a slow drift beyond the dead zone is exactly ONE 0.35s recentre, never a follow', () => {
  // 90 px over 6 s, then still (a talker sliding back into the chair arm).
  const drifting = track(1, 30, (t) => ({ cx: 400 + Math.min(90, t * 15), cy: 420 }));
  const single = plan(asd([drifting], [{ trackId: 1, t0: 0, t1: 30 }]));
  const moves = single.camera!.moves;
  assert.equal(moves.length, 1, `one re-centre (got ${moves.length})`);
  assert.equal(moves[0].duration, 0.35, 'one fixed short glide');
  assert.ok(moves[0].t > 2, `only after the 0.4s confirmation (t=${moves[0].t})`);
  assert.ok(
    moves[0].x > single.camera!.x0,
    'and it moves in the direction the face went'
  );
  // After the re-centre the camera is locked again for the rest of the clip.
  const settled = positionAtPath(single.camera!, moves[0].t + 1);
  for (let t = moves[0].t + 1; t < 30; t += 1) {
    assert.deepEqual(positionAtPath(single.camera!, t), settled, `locked again at t=${t}`);
  }
});

test('no glide longer than 0.5 s, whatever the speaker does', () => {
  const talker = track(1, 90, (t) => ({
    cx: 700 + 250 * Math.sin(2 * Math.PI * 0.05 * t),
    cy: 400,
  }));
  const single = plan(asd([talker], [{ trackId: 1, t0: 0, t1: 90 }]));
  for (const move of single.camera!.moves) {
    assert.ok(move.duration <= 0.5, `glide at t=${move.t} lasts ${move.duration}s`);
  }
  const qa = measureCameraQa({
    path: single.camera!,
    samples: talker.points.map((p) => ({ t: p.t, cx: p.cx, cy: p.cy, w: p.w })),
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 90,
  });
  assert.equal(qa.glidesOverHalfSecond, 0);
  assert.ok(qa.motionEventsPerMinute < 30, `events/min ${qa.motionEventsPerMinute}`);
});

// ---------------------------------------------------------------------------
// Task 1: alternating speakers
// ---------------------------------------------------------------------------

test('alternating speakers: one 0.1s glide per turn, instant in cut mode', () => {
  const a = track(1, 20, () => ({ cx: 400, cy: 420 }));
  const b = track(2, 20, () => ({ cx: 1500, cy: 420 }));
  const turns = [
    { trackId: 1, t0: 0, t1: 3 },
    { trackId: 2, t0: 3, t1: 6 },
    { trackId: 1, t0: 6, t1: 9 },
    { trackId: 2, t0: 9, t1: 12 },
    { trackId: 1, t0: 12, t1: 15 },
  ];
  const gliding = plan(asd([a, b], turns));
  assert.equal(gliding.camera!.moves.length, 4, 'one switch per turn change');
  for (const move of gliding.camera!.moves) assert.equal(move.duration, 0.1);
  assert.equal(gliding.camera!.cuts?.length ?? 0, 0, 'no hard switches in glide mode');

  const cutting = plan(asd([a, b], turns), { switchMode: 'cut' });
  assert.equal(cutting.camera!.moves.length, 0, 'nothing glides');
  assert.equal(cutting.camera!.cuts?.length, 4, 'four instant switches');
  for (const cut of cutting.camera!.cuts!) {
    // At the cut frame the window is ALREADY on the new speaker.
    assert.deepEqual(positionAtPath(cutting.camera!, cut.t), { x: cut.x, y: cut.y });
  }
});

// ---------------------------------------------------------------------------
// Task 3: source shot cuts
// ---------------------------------------------------------------------------

test('a source cut switches the crop on the exact cut frame, anchored after the cut', () => {
  // One continuous person, but the source cuts wide -> close at t=10.
  const person = track(1, 20, (t) => (t < 10 ? { cx: 700, cy: 400, w: 90 } : { cx: 1400, cy: 430, w: 260 }));
  const single = plan(asd([person], [{ trackId: 1, t0: 0, t1: 20 }], [10]));
  const camera = single.camera!;

  assert.equal(camera.cuts?.length, 1, 'exactly one hard switch');
  assert.equal(camera.cuts![0].t, 10);
  const after = camera.cuts![0];
  assert.ok(after.x > camera.x0 + 300, `the new shot is framed on the new face (${camera.x0} -> ${after.x})`);
  assert.equal(camera.moves.length, 0, 'no glide at all - the cut does the work');

  // The FFmpeg expression switches on the cut frame too.
  const expr = cameraExpressions(camera, SRC.w, SRC.h, single.cropW, single.cropH);
  assert.ok(expr.x.includes('gte(t,10.000)*'), expr.x);
  assert.ok(!expr.x.includes(':'), `no colon may reach crop's option parser: ${expr.x}`);

  // And nothing interpolates ACROSS the cut: the position is constant either side.
  assert.deepEqual(positionAtPath(camera, 9.9), { x: camera.x0, y: camera.y0 });
  assert.deepEqual(positionAtPath(camera, 10), { x: after.x, y: after.y });
});

test('a speaker run that spans a cut becomes two runs (a new anchor per shot)', () => {
  const runs = buildSpeakerRuns([{ trackId: 1, t0: 0, t1: 10 }], [4, 7]);
  assert.deepEqual(
    runs.map((run) => [run.t0, run.t1, run.shot]),
    [
      [0, 4, 0],
      [4, 7, 1],
      [7, 10, 2],
    ]
  );
  assert.deepEqual(
    runs.map((run) => run.startsAtCut),
    [false, true, true]
  );
});

test('shot-cut detection parses ffmpeg scene metadata and merges duplicate hits', () => {
  const stderr = [
    'frame:12 pts:480 pts_time:0.48',
    'lavfi.scene_score=0.512',
    'frame:13 pts:520 pts_time:0.52',
    'lavfi.scene_score=0.404',
    'frame:150 pts:6000 pts_time:6.0',
    'lavfi.scene_score=0.801',
    'ffmpeg version n9',
  ].join('\n');
  const hits = parseSceneMetadata(stderr);
  assert.deepEqual(hits, [
    { t: 0.48, score: 0.512 },
    { t: 0.52, score: 0.404 },
    { t: 6, score: 0.801 },
  ]);
  // Two hits 0.04 s apart are one cut; the window edge is not a cut.
  assert.deepEqual(collateSceneCuts(hits, 10), [0.48, 6]);
  assert.deepEqual(collateSceneCuts([{ t: 0.05, score: 0.9 }], 10), [], 'edge hit dropped');
});

test('cut ranges: no consumer may interpolate across a cut', () => {
  assert.deepEqual(
    splitTimesAtCuts([{ t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }], [2]),
    [[{ t: 0 }, { t: 1 }], [{ t: 2 }, { t: 3 }]]
  );
  assert.equal(cutBetween(1, 3, [2]), 2);
  assert.equal(cutBetween(3, 5, [2]), null);
});

// ---------------------------------------------------------------------------
// Task 2: keyframes stay a handful - and even 10 cutaways keep them all
// ---------------------------------------------------------------------------

test('a 90 s two-person conversation stays a handful of keyframes', () => {
  const a = track(1, 90, (t) => ({ cx: 420 + 15 * Math.sin(t), cy: 420 }));
  const b = track(2, 90, (t) => ({ cx: 1480 + 15 * Math.cos(t), cy: 420 }));
  const turns: Array<{ trackId: number; t0: number; t1: number }> = [];
  for (let i = 0; i < 18; i += 1) {
    turns.push({ trackId: i % 2 === 0 ? 1 : 2, t0: i * 5, t1: (i + 1) * 5 });
  }
  const single = plan(asd([a, b], turns));
  const cameraPlan = single.cameraPlan!;
  // 17 turn changes -> 17 short glides, and nothing else.
  assert.equal(cameraPlan.keyframes, 17, `one keyframe per turn (got ${cameraPlan.keyframes})`);
  assert.equal(cameraPlan.glides, 17);
  assert.ok(cameraPlan.keyframes < 90 / 60 * 25, 'far below the "one per second" the old path produced');
  assert.match(
    formatCameraPlanLog(cameraPlan, 90),
    /\[CAMERA-PLAN\] mode=locked segments=\d+ locks=\d+ recenters=\d+ switches=17 cutaways=0 keyframes=17/
  );
});

test('with 10 cutaways every switch still keeps its keyframes (nothing is dropped)', () => {
  // 82 s of one speaker, a listener on screen throughout: a visit every 8 s
  // (6 s hold + 2 s cutaway) -> t = 6, 14, … 78.
  const speaker = track(1, 82, (t) => ({ cx: 420 + 10 * Math.sin(t), cy: 420 }));
  const listener = track(2, 82, (t) => ({ cx: 1450 + 10 * Math.cos(t), cy: 440 }));
  const single = plan(asd([speaker, listener], [{ trackId: 1, t0: 0, t1: 82 }]), {
    cutaways: true,
  });
  const cameraPlan = single.cameraPlan!;
  assert.equal(cameraPlan.cutaways.length, 10, `10 listener visits (${cameraPlan.cutaways.length})`);
  // Each visit needs two glides (to the listener, back to the speaker).
  assert.ok(cameraPlan.glides >= 20, `every visit has its glides (${cameraPlan.glides})`);
  assert.equal(cameraPlan.glides, single.camera!.moves.length, 'all of them survive into the path');
  assert.equal(cameraPlan.keyframes, single.camera!.moves.length + (single.camera!.cuts?.length ?? 0));
  // Still short glide after glide - no pan can cross a 0.5 s budget.
  for (const move of single.camera!.moves) assert.ok(move.duration <= 0.5, `${move.duration}s glide`);
});

test('cutaway eligibility: live, big enough, on screen >=80%, co-visible, centerable', () => {
  const speaker = track(1, 40, () => ({ cx: 420, cy: 420 }));
  const tiny = track(2, 40, () => ({ cx: 1450, cy: 420, w: 30 })); // too small
  const flicker = track(3, 40, (t) => ({ cx: 1600, cy: 420, w: 120, ...(t % 4 < 1 ? {} : {}) }));
  // A listener that appears only for 20% of the time.
  const sporadic: Track = {
    ...track(4, 40, () => ({ cx: 1500, cy: 420, w: 120 })),
    points: track(4, 40, () => ({ cx: 1500, cy: 420, w: 120 })).points.filter((_, i) => i % 5 === 0),
  };
  const planTiny = plan(asd([speaker, tiny], [{ trackId: 1, t0: 0, t1: 40 }]), { cutaways: true });
  assert.equal(planTiny.cameraPlan!.cutaways.length, 0);
  assert.match(planTiny.cameraPlan!.skippedCutaways[0].reason, /% of the speaker/i);

  const planSporadic = plan(asd([speaker, sporadic], [{ trackId: 1, t0: 0, t1: 40 }]), {
    cutaways: true,
  });
  assert.equal(planSporadic.cameraPlan!.cutaways.length, 0);
  assert.match(planSporadic.cameraPlan!.skippedCutaways[0].reason, /only \d+% of the cutaway/i);

  // One sighting every 1.25 s, each covering +-0.3 s -> about half the grid.
  const coverage = onScreenShare(sporadic, 0, 8);
  assert.ok(coverage > 0.2 && coverage < 0.8, `sparse coverage ${coverage}`);
  void flicker;
});

// ---------------------------------------------------------------------------
// Task 2: the hook branch reuses the SAME plan
// ---------------------------------------------------------------------------

test('hook branch: same plan, cut times shifted - never a second decimation', () => {
  const person = track(1, 30, (t) => (t < 12 ? { cx: 600, cy: 400 } : { cx: 1500, cy: 430 }));
  const single = plan(asd([person], [{ trackId: 1, t0: 0, t1: 30 }], [12]));
  const main = buildSingleFilterParts(single, SRC.w, SRC.h, 1080, 1920, '').join(',');
  const hook = buildSingleFilterParts(single, SRC.w, SRC.h, 1080, 1920, '', 12, 5).join(',');

  assert.ok(main.includes('gte(t,12.000)*'), `main switches at the cut: ${main}`);
  // The hook replays clip time 12..17 - the cut is at its very first frame, so the
  // hook copy is simply the new shot's framing (a constant), not an interpolation.
  assert.ok(!hook.includes('gte(t,'), `no cut inside the hook: ${hook}`);
  const explored = cameraExpressions(sliceCameraPath(single.camera!, 12, 5), SRC.w, SRC.h, single.cropW, single.cropH, 0);
  assert.ok(!explored.x.includes('if(') && !explored.x.includes('gte(t,'), explored.x);
  for (const t of [0, 1, 2, 4.9]) {
    assert.deepEqual(
      positionAtPath(sliceCameraPath(single.camera!, 12, 5), t),
      positionAtPath(single.camera!, 12 + t),
      `hook frame ${t}s shows what the main branch shows at ${12 + t}s`
    );
  }
});

test('hook branch: a re-centre inside the replay window keeps the same easing', () => {
  const drifting = track(1, 40, (t) => ({ cx: 500 + Math.min(200, Math.max(0, (t - 4) * 60)), cy: 420 }));
  const single = plan(asd([drifting], [{ trackId: 1, t0: 0, t1: 40 }]));
  assert.ok(single.camera!.moves.length > 0, 'there is a re-centre to replay');
  const move = single.camera!.moves[0];
  const hook = buildSingleFilterParts(single, SRC.w, SRC.h, 1080, 1920, '', move.t - 0.5, 3).join(',');
  assert.ok(hook.includes('clip('), `the in-window glide is still there: ${hook}`);
});

// ---------------------------------------------------------------------------
// Rollback: the flags off reproduce the pre-lock output exactly
// ---------------------------------------------------------------------------

test('CAMERA_MODE=legacy reproduces the recorded pre-lock speaker path exactly', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-speaker-path.json'), 'utf8')
  ) as Record<
    string,
    { single: { cropW: number; cropH: number; points: Array<{ t: number; x: number; y: number }> } }
  >;

  const cases: Record<string, AsdResult> = {
    conversationTwoSpeakers: asd(
      [track(1, 10, () => ({ cx: 400, cy: 400, w: 240 })), track(2, 10, () => ({ cx: 1500, cy: 400, w: 240 }))],
      [
        { trackId: 1, t0: 0, t1: 5 },
        { trackId: 2, t0: 5, t1: 10 },
      ]
    ),
    singleSpeakerDrift: asd(
      [track(1, 10, (t) => ({ cx: 400 + Math.round(t / 0.25) * 15, cy: 400, w: 240 }))],
      [{ trackId: 1, t0: 0, t1: 10 }]
    ),
    jitterSpeaker: asd(
      [
        track(1, 20, () => ({ cx: 900, cy: 400, w: 240 })),
      ],
      [{ trackId: 1, t0: 0, t1: 20 }]
    ),
    rapidTurns: asd(
      [
        track(1, 10, () => ({ cx: 300, cy: 400, w: 240 })),
        track(2, 10, () => ({ cx: 1600, cy: 400, w: 240 })),
      ],
      [
        { trackId: 1, t0: 0, t1: 2 },
        { trackId: 2, t0: 2, t1: 4 },
        { trackId: 1, t0: 4, t1: 6 },
        { trackId: 2, t0: 6, t1: 8 },
        { trackId: 1, t0: 8, t1: 10 },
      ]
    ),
    noSpeakers: asd(
      [track(1, 10, (t) => ({ cx: 500 + Math.round(t / 0.25) * 5, cy: 400, w: 240 }))],
      [{ trackId: null, t0: 0, t1: 10 }]
    ),
  };

  for (const [name, result] of Object.entries(cases)) {
    const single = buildSinglePlan(result, SRC.w, SRC.h, ANCHOR_Y, {
      mode: 'legacy',
      legacyDetrend: false,
    });
    assert.equal(single.cameraMode, 'legacy', name);
    assert.equal(single.camera, undefined, `${name}: legacy has no locked path`);
    const got = single.points.map((point) => ({
      t: Math.round(point.t * 1000) / 1000,
      x: Math.round(point.x * 1000) / 1000,
      y: Math.round(point.y * 1000) / 1000,
    }));
    assert.deepEqual(got, fixture[name].single.points, `${name}: exact pre-lock output`);
  }
});

test('CAMERA_LEGACY_DETREND=1 opts the legacy path into drift removal', () => {
  // A /\/\/\ sway (a talker shifting weight), which the legacy path does follow.
  const swaying = track(1, 20, (t) => ({ cx: 900 + 180 * Math.sin((2 * Math.PI * t) / 6), cy: 420 }));
  const result = asd([swaying], [{ trackId: 1, t0: 0, t1: 20 }]);
  const legacyRaw = buildSinglePlan(result, SRC.w, SRC.h, ANCHOR_Y, {
    mode: 'legacy',
    legacyDetrend: false,
  });
  const legacyTrended = buildSinglePlan(result, SRC.w, SRC.h, ANCHOR_Y, {
    mode: 'legacy',
    legacyDetrend: true,
  });
  assert.notDeepEqual(legacyRaw.points, legacyTrended.points, 'detrend changes the legacy path');
  const spread = (points: Array<{ x: number }>): number =>
    Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
  assert.ok(spread(legacyRaw.points) > 200, `the raw legacy path follows the sway (${spread(legacyRaw.points)}px)`);
  assert.ok(
    spread(legacyTrended.points) < spread(legacyRaw.points) * 0.8,
    `the detrended path is calmer (${spread(legacyTrended.points)}px)`
  );

  assert.equal(getSpeakerCameraSettings({ CAMERA_LEGACY_DETREND: '1' }).legacyDetrend, true);
  assert.equal(getSpeakerCameraSettings({}).legacyDetrend, false, 'legacy stays exact by default');
});

test('CAMERA_MODE=legacy via the env flag (no explicit option) also works', () => {
  const previous = process.env.CAMERA_MODE;
  process.env.CAMERA_MODE = 'legacy';
  try {
    const person = track(1, 10, (t) => ({ cx: 500 + t * 30, cy: 420 }));
    const single = buildSinglePlan(asd([person], [{ trackId: 1, t0: 0, t1: 10 }]), SRC.w, SRC.h, ANCHOR_Y);
    assert.equal(single.cameraMode, 'legacy');
    assert.ok(single.points.length > 0);
  } finally {
    if (previous === undefined) delete process.env.CAMERA_MODE;
    else process.env.CAMERA_MODE = previous;
  }
});

// ---------------------------------------------------------------------------
// Task 2/5: the filter graph size guard and the logs
// ---------------------------------------------------------------------------

test('a filter graph over 24k characters is written to a script file', () => {
  assert.equal(FILTER_GRAPH_SCRIPT_THRESHOLD, 24_000);
  assert.equal(needsFilterScript('x'.repeat(23_999)), false);
  assert.equal(needsFilterScript('x'.repeat(24_001)), true);
  assert.equal(needsFilterScript('x'.repeat(30_000), 50_000), false, 'threshold is a parameter');
  assert.equal(getFilterGraphScriptThreshold({}), 24_000);
  assert.equal(getFilterGraphScriptThreshold({ CAMERA_KEYFRAME_MAX_CHARS: '1000' }), 24_000, 'floored');
  assert.equal(getFilterGraphScriptThreshold({ CAMERA_KEYFRAME_MAX_CHARS: '12000' }), 12_000);
});

test('the locked path keeps the filter graph tiny even on a long busy clip', () => {
  const a = track(1, 180, (t) => ({ cx: 400 + 30 * Math.sin(t), cy: 420 }));
  const b = track(2, 180, (t) => ({ cx: 1500 + 30 * Math.cos(t), cy: 420 }));
  const turns: Array<{ trackId: number; t0: number; t1: number }> = [];
  for (let i = 0; i < 60; i += 1) {
    turns.push({ trackId: i % 2 === 0 ? 1 : 2, t0: i * 3, t1: (i + 1) * 3 });
  }
  const single = plan(asd([a, b], turns));
  const parts = buildSingleFilterParts(single, SRC.w, SRC.h, 1080, 1920, 'eq=contrast=1.1');
  const graph = parts.join(',');
  assert.equal(needsFilterScript(graph), false, `graph is ${graph.length} chars`);
  assert.ok(graph.includes(':exact=1') && graph.includes('scale=1080:1920:flags=lanczos'));
});

test('[CAMERA-QA] reports dead-zone coverage, offsets, events and edge limits', () => {
  const head = track(1, 30, () => ({ cx: 900, cy: 420 }));
  // A person hugging the left edge: the crop cannot be centred on them.
  const edge = track(2, 30, () => ({ cx: 40, cy: 420 }));
  const single = plan(asd([edge], [{ trackId: 2, t0: 0, t1: 30 }]));
  const qa = measureCameraQa({
    path: single.camera!,
    samples: edge.points.map((p) => ({ t: p.t, cx: p.cx, cy: p.cy, w: p.w })),
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 30,
  });
  assert.ok(qa.edgeLimitedFrames > 0, 'the edge is reported, not hidden');
  assert.equal(qa.framesChecked, 300, 'one check every 0.1 s over 30 s');
  const line = formatCameraQaLog(qa);
  assert.match(
    line,
    /\[CAMERA-QA\] pctFramesInDeadzone=[\d.]+% pctFramesInStableBand=[\d.]+% pctFramesInDeadzoneAll=[\d.]+% maxOffsetPx=[\d.]+ maxSettledOffsetPx=[\d.]+ motionEventsPerMinute=[\d.]+/,
  );
  assert.match(line, /transitionFrames=\d+/);
  assert.match(line, /edgeLimitedFrames=\d+/);
  assert.equal(head.id, 1, 'the steady head is a control: the edge case is the subject');
});

test('[CAMERA-QA] measures the FOLLOWED person, not every face in the source', () => {
  // Two people on opposite sides. The camera can only be centred on one at a
  // time, so measuring "any face" would report ~50% no matter how good the plan
  // is; QA must follow the speaker of each segment instead.
  const left = track(1, 60, () => ({ cx: 400, cy: 420 }));
  const right = track(2, 60, () => ({ cx: 1520, cy: 420 }));
  const timeline = [
    { trackId: 1, t0: 0, t1: 30 },
    { trackId: 2, t0: 30, t1: 60 },
  ];
  const single = plan(asd([left, right], timeline));
  const qa = measureCameraPlanQa(single.cameraPlan!, [left, right], {
    srcW: SRC.w,
    srcH: SRC.h,
    cropW: single.cropW,
    cropH: single.cropH,
    anchorY: single.faceAnchorY,
    durationSeconds: 60,
  });
  assert.ok(qa.pctFramesInDeadzone > 95, `followed face is framed: ${qa.pctFramesInDeadzone}%`);
  assert.ok(qa.maxSettledOffsetPx < 5, 'settled framing is exactly centred');
  assert.ok(qa.framesChecked > 590);
});

test('a source cut overrides any move that was scheduled before it', () => {
  const path = {
    x0: 348,
    y0: 0,
    moves: [
      { t: 3.5, duration: 0.1, x: 1107, y: 0 },
      { t: 71.56, duration: 0.1, x: 345, y: 0 },
    ],
    cuts: [{ t: 66.7, x: 1100, y: 0 }],
    truncated: false,
  };
  assert.equal(positionAtPath(path, 66.69).x, 1107, 'still the previous shot');
  assert.equal(positionAtPath(path, 66.7).x, 1100, 'hard switch on the cut frame');
  assert.equal(positionAtPath(path, 71.5).x, 1100, 'no drift inside the new shot');
  assert.equal(positionAtPath(path, 71.7).x, 345, 'later glides still apply');
  assert.equal(isTransition(path, 66.7), true, 'the cut frame is a transition');
  assert.equal(isTransition(path, 71.8), false, 'a settled frame is not');
});
