/**
 * Change 1 - a printed poster / framed photo must never be counted as a person.
 *
 * The old liveness gate watched RAW face motion, and a handheld camera shake or a
 * slow zoom moves every pixel - so a face printed on a poster "moved", the tracker
 * kept it, and the 9:16 crop locked onto a wall. The fix measures the RING of
 * background around every face box with the same thumbnail diff and makes both
 * liveness and speaker scoring use face motion RELATIVE to it: a rigid picture
 * moves with its surroundings (relative motion ~0), a real person does not.
 *
 * These tests drive the REAL measurement path on synthetic RGBA frames
 * (`measureFaceMotionForTests`) instead of poking at numbers, so the thumbnail
 * maths, the ring cut-out and the relative-motion rule are all exercised together.
 * No FFmpeg, no ONNX model, no video file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveFaceMotion,
  includePersistentCoVisibleCompanions,
  isCameraUsableTrack,
  isLikelyLiveTrack,
  Tracker,
  type Track,
  type TrackPoint,
} from '../worker/asd/tracker';
import {
  backgroundRingThumbForTests,
  measureFaceMotionForTests,
  ringDiffForTests,
} from '../worker/asd/index';
import { buildSpeakerTimeline } from '../worker/asd/speaker';

const FRAME_W = 640;
const FRAME_H = 360;

type Rgba = { data: Uint8Array; width: number; height: number };

/** Deterministic pseudo-random fill so "texture" is repeatable across runs. */
function noise(x: number, y: number, seed = 1): number {
  const v = Math.sin((x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453);
  return Math.floor((v - Math.floor(v)) * 256);
}

function blankFrame(): Rgba {
  return { data: new Uint8Array(FRAME_W * FRAME_H * 4), width: FRAME_W, height: FRAME_H };
}

function put(frame: Rgba, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  const i = (y * frame.width + x) * 4;
  frame.data[i] = r;
  frame.data[i + 1] = g;
  frame.data[i + 2] = b;
  frame.data[i + 3] = 255;
}

/**
 * A textured wall with a "face" painted on it at `faceX/faceY`.
 * `mottle` adds per-frame wall texture (a real background with its own life);
 * with mottle = 0 the whole picture is rigid.
 */
function scene(faceX: number, faceY: number, mottle = 0, faceTint = 0): Rgba {
  const frame = blankFrame();
  for (let y = 0; y < FRAME_H; y += 1) {
    for (let x = 0; x < FRAME_W; x += 1) {
      // Wall: vertical stripes + grain, so the ring has real structure to compare.
      let base = 90 + ((x >> 4) % 2) * 40 + noise(x, y, 3) * 0.08;
      if (mottle > 0) base += (noise(x + mottle, y, 7) - 128) * 0.35;
      put(frame, x, y, base, base, base);
    }
  }
  // The "face": a bright oval with eyes and a mouth, fixed to the wall.
  for (let dy = -30; dy <= 30; dy += 1) {
    for (let dx = -22; dx <= 22; dx += 1) {
      if ((dx * dx) / (22 * 22) + (dy * dy) / (30 * 30) > 1) continue;
      const shade = 175 + faceTint;
      put(frame, faceX + dx, faceY + dy, shade, shade - 10, shade - 25);
    }
  }
  for (const eyeDx of [-9, 9]) {
    for (let dy = -12; dy <= -6; dy += 1) put(frame, faceX + eyeDx, faceY + dy, 30, 30, 40);
  }
  for (let dx = -10; dx <= 10; dx += 1) put(frame, faceX + dx, faceY + 12, 60, 30, 30);
  return frame;
}

const FACE_BOX = { x: 300, y: 150, w: 44, h: 60 };

// ---------------------------------------------------------------------------
// Rigid picture under a moving camera
// ---------------------------------------------------------------------------

test('a poster under camera shake is NOT live (its face moves exactly with the wall)', () => {
  // Fast handheld shake: 1% of the frame per sample at 4 fps. The face, the eyes,
  // the mouth AND the wall all move together, which is exactly what fooled the
  // raw-motion gate before.
  let previous: Rgba | null = null;
  const motions: Array<number | null> = [];
  for (let step = 0; step < 8; step += 1) {
    const drift = step * 6;
    const frame = scene(322 + drift, 180 + (step % 2) * 4);
    const boxNow = { ...FACE_BOX, x: FACE_BOX.x + drift, y: FACE_BOX.y + (step % 2) * 2 };
    const boxBefore = {
      ...FACE_BOX,
      x: FACE_BOX.x + Math.max(0, step - 1) * 2,
      y: FACE_BOX.y + ((step - 1 + 2) % 2) * 2,
    };
    motions.push(
      measureFaceMotionForTests(
        step === 0 ? null : previous,
        frame,
        boxNow,
        boxBefore,
      ).motion,
    );
    previous = frame;
  }

  const measured = motions.slice(1) as number[];
  assert.ok(measured.length >= 4);
  const median = [...measured].sort((a, b) => a - b)[Math.floor(measured.length / 2)];
  // The relative motion of a rigid poster collapses to ~0 - the camera moved, the
  // picture did not.
  assert.ok(median < 0.004, `rigid median relative motion was ${median}`);

  const track: Track = {
    id: 1,
    points: measured.map((motion, index) => point(index / 4, motion)),
    visibleTime: 2,
    avgW: 44,
    maxW: 44,
    cx: 322,
    cy: 180,
    vx: 0,
    vy: 0,
    lastT: 2,
    missed: 0,
  };
  assert.equal(isLikelyLiveTrack(track), false);
});

test('a real person moving against a still wall IS live', () => {
  let previous: Rgba | null = null;
  const motions: Array<number | null> = [];
  for (let step = 0; step < 8; step += 1) {
    // Same fixed framing (tripod); only the head/mouth changes.
    const frame = scene(322, 180, 0, step * 12);
    motions.push(measureFaceMotionForTests(previous, frame, FACE_BOX).motion);
    previous = frame;
  }

  const measured = motions.slice(1) as number[];
  const median = [...measured].sort((a, b) => a - b)[Math.floor(measured.length / 2)];
  assert.ok(median > 0.01, `live median relative motion was ${median}`);

  const track: Track = {
    id: 1,
    points: measured.map((motion, index) => point(index / 4, motion)),
    visibleTime: 2,
    avgW: 44,
    maxW: 44,
    cx: 322,
    cy: 180,
    vx: 0,
    vy: 0,
    lastT: 2,
    missed: 0,
  };
  assert.equal(isLikelyLiveTrack(track), true);
});

test('a seated speaker with sparse face movement stays live in a long clip', () => {
  const track: Track = {
    id: 1,
    points: Array.from({ length: 240 }, (_, index) =>
      point(index / 2.847, index % 48 === 12 ? 0.018 : 0.002),
    ),
    visibleTime: 84,
    avgW: 120,
    maxW: 120,
    cx: 320,
    cy: 180,
    vx: 0,
    vy: 0,
    lastT: 84,
    missed: 0,
  };

  assert.equal(isLikelyLiveTrack(track), true);
});

test('a persistent co-visible conversation partner is retained for framing only', () => {
  const primary = Array.from({ length: 40 }, (_, index) => ({
    ...point(index / 4, index % 8 === 0 ? 0.03 : 0.002),
    backgroundMotion: 0.001,
  }));
  const companion = Array.from({ length: 40 }, (_, index) => ({
    ...point(index / 4, 0.002),
    cx: 500,
  }));
  const transient = Array.from({ length: 4 }, (_, index) => ({
    ...point(2 + index / 4, 0.002),
    cx: 700,
  }));
  const makeTrack = (id: number, points: Track['points']): Track => ({
    id,
    points,
    visibleTime: points[points.length - 1].t - points[0].t,
    avgW: 120,
    maxW: 120,
    cx: points[points.length - 1].cx,
    cy: 180,
    vx: 0,
    vy: 0,
    lastT: points[points.length - 1].t,
    missed: 0,
  });
  const tracks = [makeTrack(1, primary), makeTrack(2, companion), makeTrack(3, transient)];

  const retained = includePersistentCoVisibleCompanions(tracks, 4);

  assert.deepEqual(retained.map((track) => track.id), [1, 2]);
  assert.equal(retained[1].coVisibleWithLiveFace, true);
  assert.equal(isLikelyLiveTrack(retained[1]), false);
  assert.equal(isCameraUsableTrack(retained[1]), true);
});

test('a real head turn under a shaking camera still out-moves the background', () => {
  let previous: Rgba | null = null;
  const motions: Array<number | null> = [];
  for (let step = 0; step < 8; step += 1) {
    // A realistic handheld wobble is a couple of pixels, not a jump across the
    // frame; the person's own head/mouth movement is stronger than that.
    const drift = step * 2;
    const frame = scene(322 + drift, 180 + (step % 2) * 2, 0, step * 20);
    const boxNow = { ...FACE_BOX, x: FACE_BOX.x + drift, y: FACE_BOX.y + (step % 2) * 2 };
    const boxBefore = {
      ...FACE_BOX,
      x: FACE_BOX.x + Math.max(0, step - 1) * 2,
      y: FACE_BOX.y + ((step - 1 + 2) % 2) * 2,
    };
    motions.push(
      measureFaceMotionForTests(
        step === 0 ? null : previous,
        frame,
        boxNow,
        boxBefore,
      ).motion,
    );
    previous = frame;
  }
  const measured = motions.slice(1) as number[];
  const meaningful = measured.filter((value) => value >= 0.025).length;
  assert.ok(meaningful >= 3, `meaningful relative motions: ${measured.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The ring measurement itself
// ---------------------------------------------------------------------------

test('the background ring excludes the face box and follows the wall', () => {
  const frame = scene(322, 180);
  const ring = backgroundRingThumbForTests(frame, FACE_BOX);
  assert.ok(ring, 'expected a ring for a face well inside the frame');
  // Cut-out cells (inside the face) are NaN, the rest carry the wall's brightness.
  const insideFaceCells = ring.filter((value) => Number.isNaN(value)).length;
  assert.ok(insideFaceCells > 0, 'some cells must be the face box cut out');
  assert.ok(insideFaceCells < ring.length, 'the ring must actually contain background');

  // Two identical frames: nothing moved, ring diff is 0.
  assert.equal(ringDiffForTests(ring, ring), 0);

  // The wall moved: the ring changes.
  const shifted = scene(322, 180, 25);
  const shiftedRing = backgroundRingThumbForTests(shifted, FACE_BOX);
  assert.ok(ringDiffForTests(ring, shiftedRing) > 0.002);
});

test('a face box filling the frame has no ring, so plain face motion is kept', () => {
  const frame = scene(320, 180);
  const hugeBox = { x: 2, y: 2, w: FRAME_W - 4, h: FRAME_H - 4 };
  assert.equal(backgroundRingThumbForTests(frame, hugeBox), null);
});

test('an almost still wall keeps the face\'s own motion instead of subtracting noise', () => {
  // Background motion below the floor is noise, not a camera move: subtracting it
  // would erase genuine lip motion on a tripod shot.
  const motion = effectiveFaceMotion({
    motion: 0.03,
    faceMotion: 0.03,
    backgroundMotion: 0.001,
  });
  assert.equal(motion, 0.03);

  const shaken = effectiveFaceMotion({
    motion: 0.03,
    faceMotion: 0.03,
    backgroundMotion: 0.02,
  });
  assert.equal(shaken, 0);

  const mixed = effectiveFaceMotion({
    motion: 0.06,
    faceMotion: 0.06,
    backgroundMotion: 0.02,
  });
  assert.ok(mixed !== null && Math.abs(mixed - 0.04) < 1e-9, `mixed was ${mixed}`);

  // Producers that never measured a ring keep the old meaning.
  assert.equal(effectiveFaceMotion({ motion: 0.04 }), 0.04);
});

// ---------------------------------------------------------------------------
// Speaker scoring uses the same relative motion
// ---------------------------------------------------------------------------

test('a shaking camera cannot make a still poster the active speaker', () => {
  const FPS = 4;
  const DURATION = 6;
  const voice = Array.from({ length: DURATION * FPS }, () => 0.6);
  const poster: Track = {
    ...emptyTrack(1, FPS, DURATION),
    cx: 320,
    cy: 180,
    // Raw pixels changed a lot (camera shake) but the wall around the poster moved
    // just as much, so the background-relative motion is zero.
    points: Array.from({ length: DURATION * FPS }, (_, index) => ({
      t: index / FPS,
      cx: 320,
      cy: 180,
      w: 160,
      mouthOpen: null,
      motion: 0,
      faceMotion: 0.05,
      backgroundMotion: 0.05,
    })),
  };
  const timeline = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [poster],
    frameWidth: 1920,
  });
  // Nobody qualifies as a speaker: the poster is not a person.
  assert.ok(timeline.segments.every((segment) => segment.trackId === null));
  assert.equal(timeline.speakerCount, 0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function point(t: number, motion: number | null): TrackPoint {
  return { t, cx: 322, cy: 180, w: 44, mouthOpen: null, motion };
}

function emptyTrack(id: number, fps: number, duration: number): Track {
  return {
    id,
    points: Array.from({ length: duration * fps }, (_, index) => point(index / fps, 0)),
    visibleTime: duration,
    avgW: 44,
    maxW: 44,
    cx: 320,
    cy: 180,
    vx: 0,
    vy: 0,
    lastT: duration,
    missed: 0,
  };
}

void Tracker;
