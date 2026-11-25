/**
 * Change 2 - a person who turns away must not be lost.
 *
 * When a tracked face disappears (they turn to a laptop, look down at notes, or a
 * mic covers their face) the tracker used to close the identity after ~0.75 s and
 * the camera jumped to somebody else - or to an empty chair.
 *
 * The fix is a slow, budgeted YOLOX person (body) pass that runs ONLY on frames
 * where a face was lost, and can only EXTEND a track that already exists. These
 * tests cover the three rules that matter:
 *
 *   1. the gap trigger (when the body detector may run at all),
 *   2. the track extension (body box -> held identity, never a NEW identity),
 *   3. the framing hold (a body-held person keeps the camera instead of the
 *      1.5 s face-lost fallback), and that body boxes cannot inflate person counts
 *      or add split-screen panes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeYoloxPersons,
  getPersonDetectorSettings,
  matchPersonsToLostTracks,
  personBoxToFaceEstimate,
  shouldRunPersonDetectorForGap,
  type PersonBox,
} from '../worker/person-detector';
import { Tracker, isLikelyLiveTrack, type FrameDetection, type Track } from '../worker/asd/tracker';
import { buildLockedSpeakerCamera, CAMERA_PLAN_DEFAULTS } from '../worker/camera-plan';
import { buildSpeakerTimeline } from '../worker/asd/speaker';
import { buildLayoutPlan } from '../worker/layout';
import type { AsdResult } from '../worker/asd/index';

// ---------------------------------------------------------------------------
// Gap trigger
// ---------------------------------------------------------------------------

const BASE_TRIGGER = {
  t: 1,
  facesFound: 0,
  openTracks: 1,
  lastRunAt: null as number | null,
  maxFps: 3,
  framesUsed: 0,
  maxFrames: 60,
  enabled: true,
};

test('the person detector runs only when a tracked face is missing', () => {
  assert.equal(shouldRunPersonDetectorForGap({ ...BASE_TRIGGER }), true);
  // Every open track has a face: nothing was lost.
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, facesFound: 1 }),
    false,
  );
  // Nobody was being tracked: an empty scene must not start a search for people.
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, openTracks: 0 }),
    false,
  );
  // Missing model / user opt-out / window budget spent.
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, enabled: false }),
    false,
  );
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, framesUsed: 60 }),
    false,
  );
});

test('the person detector is rate limited to 2-4 fps on gap frames', () => {
  // 3 fps => at least ~0.333 s between runs, so a 4 fps face cadence runs it on
  // every OTHER lost frame rather than on all of them.
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, t: 1.25, lastRunAt: 1 }),
    false,
  );
  assert.equal(
    shouldRunPersonDetectorForGap({ ...BASE_TRIGGER, t: 1.4, lastRunAt: 1 }),
    true,
  );
  // The default cadence is inside the requested 2-4 fps band.
  const settings = getPersonDetectorSettings({});
  assert.ok(settings.maxFps >= 2 && settings.maxFps <= 4, `default ${settings.maxFps}`);
  assert.equal(settings.enabled, true);
  assert.equal(getPersonDetectorSettings({ PERSON_DETECTION: '0' }).enabled, false);
  assert.equal(getPersonDetectorSettings({ PERSON_DETECT_MAX_FPS: '0.1' }).maxFps, 0.5);
});

// ---------------------------------------------------------------------------
// Track extension
// ---------------------------------------------------------------------------

function face(cx: number, cy: number, w = 60, motion: number | null = 0.03): FrameDetection {
  return { cx, cy, w, mouthOpen: null, motion };
}

/** A track that was seen for a while and then lost its face. */
function trackedThenLost(): { tracker: Tracker; trackId: number; lastFace: FrameDetection } {
  const tracker = new Tracker();
  const centre = { cx: 900, cy: 400 };
  for (let i = 0; i < 6; i += 1) {
    tracker.update(i * 0.25, [face(centre.cx, centre.cy)]);
  }
  return { tracker, trackId: tracker.allVisible()[0].id, lastFace: face(centre.cx, centre.cy) };
}

test('a body box keeps a lost face track alive through the gap', () => {
  const { tracker, trackId } = trackedThenLost();
  const hints = tracker.openTrackHints();
  assert.equal(hints.length, 1);

  // The person turned their head: no face, but a body box in the same place.
  // (The face of an upright body sits in the top ~1/6 of its box.)
  const bodyBox: PersonBox = { x: 780, y: 280, width: 240, height: 620, score: 0.9 };
  const matches = matchPersonsToLostTracks(hints, [bodyBox], 1.5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].trackId, trackId);

  assert.equal(tracker.holdThroughPersonGap(trackId, 1.5, matches[0].face), true);
  // Two more body-only samples: the identity survives where it used to close.
  assert.equal(tracker.holdThroughPersonGap(trackId, 1.75, matches[0].face), true);
  assert.equal(tracker.holdThroughPersonGap(trackId, 2, matches[0].face), true);
  assert.equal(tracker.openTrackHints().length, 1);

  const track = tracker.allVisible().find((candidate) => candidate.id === trackId)!;
  // Person-box sightings carry NO motion: they can never fake a speaking face.
  const held = track.points.filter((point) => point.personHold);
  assert.ok(held.length >= 3);
  assert.ok(held.every((point) => point.motion === null));
});

test('a body box can never create a new person', () => {
  const { tracker, trackId } = trackedThenLost();
  const before = tracker.allVisible().length;
  // A body far away from every open track must not become a track.
  const matches = matchPersonsToLostTracks(
    tracker.openTrackHints(),
    [{ x: 60, y: 60, width: 200, height: 500, score: 0.9 }],
    1.5,
  );
  assert.deepEqual(matches, []);
  assert.equal(tracker.allVisible().length, before);
  assert.equal(tracker.allVisible()[0].id, trackId);
});

test('a track stays holdable only while it is still open', () => {
  const tracker = new Tracker({ maxMissed: 2 });
  tracker.update(0, [face(500, 300)]);
  const id = tracker.allVisible()[0].id;
  tracker.update(0.25, []); // missed 1 of 2 -> still inside the grace period
  const face2 = personBoxToFaceEstimate({ x: 400, y: 200, width: 200, height: 500, score: 0.8 });
  assert.equal(tracker.holdThroughPersonGap(id, 0.5, face2), true);
  // Once the tracker has given up, a stale body box cannot resurrect the identity.
  tracker.update(0.75, []);
  tracker.update(1, []);
  assert.equal(tracker.holdThroughPersonGap(id, 1, face2), false);
});

test('one body box holds one person, and one person one body', () => {
  const hints = [
    { id: 1, cx: 400, cy: 300, w: 60, vx: 0, vy: 0, lastT: 1 },
    { id: 2, cx: 460, cy: 300, w: 60, vx: 0, vy: 0, lastT: 1 },
  ];
  // A single wide body box covering both faces: only the closest wins, the other
  // track is left to the normal grace period.
  const matches = matchPersonsToLostTracks(
    hints,
    [{ x: 300, y: 60, width: 260, height: 600, score: 0.9 }],
    1.25,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].trackId, 1);
});

test('the upper-body estimate sits where a face would be inside a person box', () => {
  const box: PersonBox = { x: 100, y: 200, width: 200, height: 500, score: 0.9 };
  const face = personBoxToFaceEstimate(box);
  assert.equal(face.cx, 200);
  assert.ok(face.cy > 200 && face.cy < 200 + 500 * 0.3, `face cy ${face.cy}`);
  assert.ok(face.h <= box.height * 0.35);
});

// ---------------------------------------------------------------------------
// YOLOX output decoding
// ---------------------------------------------------------------------------

test('YOLOX decode reads person rows, letterbox and NMS correctly', () => {
  // 2 rows, 85 columns (4 box + obj + 80 COCO classes), letterbox 0.5x + 20px pad.
  const rows = 2;
  const cols = 85;
  const data = new Float32Array(rows * cols);
  // Row 0: a strong person at letterbox (400, 300), 200x400 -> frame (760, 560), 400x800
  data[0] = 400;
  data[1] = 300;
  data[2] = 200;
  data[3] = 400;
  data[4] = 0.9; // objectness
  data[5] = 0.95; // person
  // Row 1: the same box at a lower score (must be removed by NMS)
  data[cols] = 402;
  data[cols + 1] = 302;
  data[cols + 2] = 198;
  data[cols + 3] = 396;
  data[cols + 4] = 0.5;
  data[cols + 5] = 0.9;

  const persons = decodeYoloxPersons(data, [1, rows, cols], {
    scale: 0.5,
    padX: 20,
    padY: 20,
  }, { confThreshold: 0.3, frameWidth: 1920 });
  assert.equal(persons.length, 1);
  assert.equal(Math.round(persons[0].x), 560);
  assert.equal(Math.round(persons[0].y), 160);
  assert.equal(Math.round(persons[0].width), 400);

  // A non-person COCO class is ignored even with high objectness.
  const notPerson = new Float32Array(cols);
  notPerson[2] = 100;
  notPerson[3] = 300;
  notPerson[4] = 0.95;
  notPerson[6] = 0.99; // class 1 = bicycle
  assert.deepEqual(
    decodeYoloxPersons(notPerson, [1, 1, cols], { scale: 1, padX: 0, padY: 0 }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Framing: the extended hold
// ---------------------------------------------------------------------------

const FPS = 4;

/** A speaker seen for 8 s, then no face at all until the end of the clip. */
function tracksForHold(): Track[] {
  const points = [];
  for (let i = 0; i < 8 * FPS; i += 1) {
    points.push({
      t: i / FPS,
      cx: 900,
      cy: 400,
      w: 120,
      mouthOpen: null,
      motion: i === 0 ? null : 0.03,
    });
  }
  const track = {
    id: 1,
    points,
    visibleTime: 8,
    avgW: 120,
    maxW: 120,
    cx: 900,
    cy: 400,
    vx: 0,
    vy: 0,
    lastT: 8,
    missed: 0,
  };
  assert.equal(isLikelyLiveTrack(track), true);
  return [track];
}

function planForHold(personHoldSeconds: number) {
  return buildLockedSpeakerCamera(tracksForHold(), [{ trackId: 1, t0: 0, t1: 20 }], {
    ...CAMERA_PLAN_DEFAULTS,
    srcW: 1920,
    srcH: 1080,
    cropW: 607,
    cropH: 1080,
    anchorY: 0.32,
    durationSeconds: 20,
    personHoldSeconds,
  });
}

test('a disappeared face still falls back after the 1.5s hold (today\'s behaviour)', () => {
  const plan = planForHold(0);
  const hole = plan.holes.find((candidate) => candidate.start > 7);
  assert.ok(hole, 'expected a hole after the last sighting');
  assert.equal(hole.holdSeconds, 1.5);
  // The fallback move happens 1.5 s after the face was last seen.
  assert.ok(
    plan.fallbackHoles.some((fallback) => Math.abs(fallback.t - (hole.start + 1.5)) < 0.2),
    `fallbacks: ${JSON.stringify(plan.fallbackHoles)}`,
  );
});

test('a body-held person keeps the camera for several seconds instead of 1.5s', () => {
  const plan = planForHold(4);
  const hole = plan.holes.find((candidate) => candidate.start > 7);
  assert.ok(hole);
  // Several seconds, not the ~0.75 s tracker grace and not the 1.5 s fallback.
  assert.equal(hole.holdSeconds, 4);
  // The camera keeps the SAME framing for 4 s (2.5 s longer than before) and the
  // fallback that does happen is shifted by exactly that extra hold.
  const fallback = plan.fallbackHoles.find((candidate) => candidate.t > hole.start);
  assert.ok(fallback, 'expected the deterministic fallback after the long hold');
  assert.ok(
    Math.abs(fallback.t - (hole.start + 4)) < 0.2,
    `fallback fired at ${fallback.t}, expected ~${hole.start + 4}`,
  );
});

// ---------------------------------------------------------------------------
// Speaker scoring + layout must be unaffected by body-only frames
// ---------------------------------------------------------------------------

test('body-only sightings never become speaker evidence on their own', () => {
  const duration = 6;
  const voice = new Array(duration * FPS).fill(0.6);
  const bodyOnly: Track = {
    id: 7,
    points: Array.from({ length: duration * FPS }, (_, index) => ({
      t: index / FPS,
      cx: 900,
      cy: 400,
      w: 120,
      mouthOpen: null,
      motion: null,
      personHold: true,
    })),
    visibleTime: duration,
    avgW: 120,
    maxW: 120,
    cx: 900,
    cy: 400,
    vx: 0,
    vy: 0,
    lastT: duration,
    missed: 0,
  };
  const timeline = buildSpeakerTimeline({
    duration,
    fps: FPS,
    voice,
    tracks: [bodyOnly],
    frameWidth: 1920,
  });
  // Without a scene-motion signal there is no evidence at all -> no speaker label.
  assert.ok(timeline.segments.every((segment) => segment.trackId === null));

  // With a scene-motion signal the body sighting contributes a DAMPED share, so a
  // still picture still does not produce a speaker.
  const still = buildSpeakerTimeline({
    duration,
    fps: FPS,
    voice,
    tracks: [bodyOnly],
    frameWidth: 1920,
    sceneMotion: new Array(duration * FPS).fill(0),
  });
  assert.ok(still.segments.every((segment) => segment.trackId === null));
});

test('a split-screen layout is unchanged when the only extra "person" is a body box', () => {
  const tracks = tracksForHold();
  const base: AsdResult = {
    tracks,
    speakerSegments: [{ t0: 0, t1: 20, trackId: 1 }],
    speakerCount: 1,
    method: 'yunet+audio-visual',
    hasLandmarks: false,
    hasAudio: true,
    maxFacesSeen: 1,
    framesUsed: 32,
    framesTotal: 40,
    sampleFps: 4,
    voicedRatio: 0.8,
    personHolds: 12,
    personHoldSeconds: 4,
  };
  const splitFraming = {
    faceTargetFrac: 0.3,
    zoom: 1.2,
    minFaceFrac: 0.03,
    seamGapPct: 0.02,
  };
  const plan = buildLayoutPlan(base, 'split-screen', 1920, 1080, splitFraming, {
    srcW: 1920,
    srcH: 1080,
    cropW: 607,
    cropH: 1080,
    anchorY: 0.32,
    cuts: [],
    mode: 'locked',
    legacyDetrend: false,
  });
  // One real face -> the established single-window fallback, not a second pane.
  assert.equal(plan.mode, 'single');
});
