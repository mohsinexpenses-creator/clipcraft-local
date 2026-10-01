/**
 * Multi-cue active-speaker fusion tests (pure logic - no YuNet model needed).
 *
 * Covers the covered-mouth worst case (no mouth landmark cue), audio↔motion
 * correlation, prominence/size fallbacks, and anti-flicker hysteresis.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpeakerTimeline, SpeakerSegment } from '../worker/asd/speaker';
import { Track, TrackPoint } from '../worker/asd/tracker';

const FPS = 4;
const DURATION = 12;
const FRAME_WIDTH = 1920;

function makeTrack(
  id: number,
  opts: {
    cx: number;
    w: number;
    motion: (i: number) => number | null;
    mouthOpen?: (i: number) => number | null;
  }
): Track {
  const points: TrackPoint[] = [];
  for (let i = 0; i < DURATION * FPS; i += 1) {
    points.push({
      t: i / FPS,
      cx: opts.cx,
      cy: 400,
      w: opts.w,
      mouthOpen: opts.mouthOpen ? opts.mouthOpen(i) : null,
      motion: opts.motion(i),
    });
  }
  return {
    id,
    points,
    visibleTime: DURATION,
    avgW: opts.w,
    maxW: opts.w,
    cx: opts.cx,
    cy: 400,
    vx: 0,
    vy: 0,
    lastT: DURATION,
    missed: 0,
  };
}

/** Voice envelope: low at even seconds, high at odd seconds (a clear pattern). */
function patternVoice(): number[] {
  const voice: number[] = [];
  for (let i = 0; i < DURATION * FPS; i += 1) voice.push(i % 8 < 4 ? 0.1 : 0.9);
  return voice;
}

function switches(segments: SpeakerSegment[]): Array<{ from: number | null; to: number | null; t: number }> {
  const out: Array<{ from: number | null; to: number | null; t: number }> = [];
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].trackId !== segments[i - 1].trackId) {
      out.push({ from: segments[i - 1].trackId, to: segments[i].trackId, t: segments[i].t0 });
    }
  }
  return out;
}

test('single visible person is always the active speaker', () => {
  const voice = patternVoice();
  const track = makeTrack(1, { cx: 900, w: 240, motion: (i) => (voice[i] > 0.5 ? 0.8 : 0.2) });
  const { segments, speakerCount } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [track],
    frameWidth: FRAME_WIDTH,
  });
  assert.equal(speakerCount, 1);
  assert.ok(segments.every((s) => s.trackId === 1), JSON.stringify(segments));
});

test('audio-correlated face motion picks the talking speaker, then follows the change', () => {
  const voice = patternVoice();
  // A moves WITH the voice in the first half; B does in the second half.
  const a = makeTrack(1, {
    cx: 500,
    w: 240,
    motion: (i) => (i < (DURATION * FPS) / 2 ? (voice[i] > 0.5 ? 0.9 : 0.1) : 0.05),
  });
  const b = makeTrack(2, {
    cx: 1400,
    w: 240,
    motion: (i) => (i >= (DURATION * FPS) / 2 ? (voice[i] > 0.5 ? 0.9 : 0.1) : 0.05),
  });
  const { segments, speakerCount } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [a, b],
    frameWidth: FRAME_WIDTH,
  });

  assert.equal(speakerCount, 2, 'both people get the frame at some point');
  const first = segments.find((s) => s.trackId !== null);
  const last = [...segments].reverse().find((s) => s.trackId !== null);
  assert.equal(first?.trackId, 1, 'A starts as the speaker');
  assert.equal(last?.trackId, 2, 'B takes over when they start talking');

  for (const sw of switches(segments)) {
    assert.ok(sw.t >= 0.8, `switch at ${sw.t}s respects the 0.8s minimum hold`);
  }
});

test('covered mouths (no mouth cue, flat motion): size + continuity decide, no flip-flop', () => {
  // The worst case: audio says SOMEONE talks, but both faces barely move and
  // neither exposes a mouth cue. The bigger face must win and KEEP the frame.
  const voice = new Array(DURATION * FPS).fill(0.8);
  const big = makeTrack(1, { cx: 500, w: 320, motion: () => 0.3 });
  const small = makeTrack(2, { cx: 1400, w: 150, motion: () => 0.3 });

  const { segments } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [big, small],
    frameWidth: FRAME_WIDTH,
  });

  const ids = new Set(segments.map((s) => s.trackId));
  assert.deepEqual([...ids], [1], `the larger face keeps the frame: ${JSON.stringify(segments)}`);
});

test('mouth-open cue drives the decision when it is available (second method)', () => {
  // No motion cue at all - only the mouth-landmark channel (the pre-YuNet
  // pipeline's cue) speaks. It must still pick the articulating person.
  const voice = patternVoice();
  const talker = makeTrack(1, {
    cx: 500,
    w: 220,
    motion: () => null,
    mouthOpen: (i) => (voice[i] > 0.5 ? 0.25 : 0.05),
  });
  const quiet = makeTrack(2, {
    cx: 1400,
    w: 220,
    motion: () => null,
    mouthOpen: () => 0.15,
  });

  const { segments } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [talker, quiet],
    frameWidth: FRAME_WIDTH,
  });

  const winner = segments.find((s) => s.trackId !== null);
  assert.equal(winner?.trackId, 1, 'the person articulating with the audio wins');
});

test('reactive turn change: a new speaker takes the frame within ~1.5s of starting', () => {
  // The reported bug: A talks, B starts talking, and the frame lingers on A
  // for seconds (or never moves). With voice-gated motion + the reactive
  // switch the label must follow B promptly and STAY with B.
  const voice = patternVoice();
  const half = (DURATION * FPS) / 2; // 6s
  const a = makeTrack(1, {
    cx: 500,
    w: 300, // A is ALSO the bigger face (the prominence bias case)
    motion: (i) => (i < half ? (voice[i] > 0.5 ? 0.9 : 0.1) : 0.03),
  });
  const b = makeTrack(2, {
    cx: 1400,
    w: 200,
    motion: (i) => (i >= half ? (voice[i] > 0.5 ? 0.9 : 0.1) : 0.03),
  });
  const { segments } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [a, b],
    frameWidth: FRAME_WIDTH,
  });

  const sw = switches(segments).find((s) => s.to === 2);
  assert.ok(sw, `B never gets the frame: ${JSON.stringify(segments)}`);
  assert.ok(sw.t <= half + 1.5, `switch to B at ${sw.t}s is too late (B started at ${half}s)`);

  // Once B has the frame it keeps it for the rest of the clip.
  for (const s of segments) {
    if (s.t0 >= half + 1.5 && s.trackId !== null) {
      assert.equal(s.trackId, 2, `frame left B at t=${s.t0}s: ${JSON.stringify(segments)}`);
    }
  }
});

test('hysteresis: a marginal challenger cannot flip the frame every window', () => {
  // Alternating near-tie scores: the 1.3x margin + 0.8s hold must keep the
  // number of switches small and well-spaced.
  const voice = patternVoice();
  const a = makeTrack(1, { cx: 500, w: 240, motion: (i) => (i % 2 === 0 ? 0.55 : 0.45) });
  const b = makeTrack(2, { cx: 1400, w: 240, motion: (i) => (i % 2 === 0 ? 0.45 : 0.55) });

  const { segments } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice,
    tracks: [a, b],
    frameWidth: FRAME_WIDTH,
  });

  const sw = switches(segments);
  assert.ok(sw.length <= Math.floor(DURATION / 0.8), `too many switches: ${sw.length}`);
  for (let i = 1; i < sw.length; i += 1) {
    assert.ok(sw[i].t - sw[i - 1].t >= 0.8, `switches ${sw[i - 1].t} -> ${sw[i].t} too close`);
  }
});

test('no faces: the timeline is a single null segment (framing falls back)', () => {
  const { segments, speakerCount } = buildSpeakerTimeline({
    duration: DURATION,
    fps: FPS,
    voice: patternVoice(),
    tracks: [],
    frameWidth: FRAME_WIDTH,
  });
  assert.equal(speakerCount, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].trackId, null);
  assert.equal(segments[0].t0, 0);
  assert.equal(segments[0].t1, DURATION);
});
