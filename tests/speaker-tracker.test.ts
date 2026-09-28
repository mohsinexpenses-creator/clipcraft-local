/**
 * Active-speaker tracking tests (pure logic - no YuNet model needed).
 *
 * Covers the multi-cue speaker decision (audio/motion correlation, motion
 * energy, continuity, face size), the covered-mouth worst case, hysteresis,
 * and both crop timelines (speaker-focus glide + split-screen pane swapping).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFocusTimeline,
  buildSplitTimeline,
  decideSpeakers,
  Keyframe,
  Sample,
  SpeakerSegmentInfo,
  TrackState,
} from '../worker/speaker-tracker';
import { DetectedFace } from '../worker/yunet-detector';

type Box = DetectedFace['box'];
const box = (x: number, y: number, w = 200, h = 200): Box => ({ x, y, width: w, height: h });

function makeTrack(id: number, faceH = 200, totalVisible = 12): TrackState {
  return {
    id,
    lastBox: box(0, 0),
    lastSeenT: 999,
    prevMouthThumb: null,
    prevFaceThumb: null,
    totalSpeaking: 0,
    totalVisible,
    faceHeightSum: faceH * totalVisible,
    samples: [],
  };
}

interface Scene {
  samples: Sample[];
  tracks: Map<number, TrackState>;
}

/** Two faces side by side; per-sample motion and audio from the given series. */
function makeScene(motionA: number[], motionB: number[], audio: number[], boxA: Box, boxB: Box): Scene {
  const tracks = new Map<number, TrackState>();
  const tA = makeTrack(1);
  const tB = makeTrack(2);
  tracks.set(1, tA);
  tracks.set(2, tB);

  const samples: Sample[] = [];
  for (let i = 0; i < motionA.length; i += 1) {
    const t = i * 0.25;
    tA.samples.push({ t, box: boxA, motion: motionA[i] });
    tB.samples.push({ t, box: boxB, motion: motionB[i] });
    samples.push({
      t,
      faces: [
        { trackId: 1, box: boxA, motion: motionA[i], score: 0.9 },
        { trackId: 2, box: boxB, motion: motionB[i], score: 0.9 },
      ],
      audioRms: audio[i],
      activeTrackId: null,
    });
  }
  (samples as Sample[] & { _tracks?: Map<number, TrackState> })._tracks = tracks;
  return { samples, tracks };
}

const BOX_A = box(100, 300); // center x=200
const BOX_B = box(1400, 300); // center x=1500

test('single visible face is always the active speaker', () => {
  const tracks = new Map<number, TrackState>();
  const track = makeTrack(7);
  tracks.set(7, track);
  const samples: Sample[] = [];
  for (let i = 0; i < 8; i += 1) {
    const t = i * 0.25;
    track.samples.push({ t, box: BOX_A, motion: 0.5 });
    samples.push({
      t,
      faces: [{ trackId: 7, box: BOX_A, motion: 0.5, score: 0.9 }],
      audioRms: 0.5,
      activeTrackId: null,
    });
  }
  (samples as Sample[] & { _tracks?: Map<number, TrackState> })._tracks = tracks;

  const analysis = decideSpeakers(samples, 1920, 1080, true, makeFallbackFocus(), makeFallbackSplit());
  assert.ok(samples.every((s) => s.activeTrackId === 7));
  assert.equal(analysis.method, 'yunet-audio-visual');
  assert.equal(analysis.trackCount, 1);
});

test('audio-correlated mouth/face motion picks the talking speaker', () => {
  // First 6 samples: A's motion tracks the audio envelope. Last 6: B's does.
  const motionA = [0.2, 0.9, 0.2, 0.9, 0.2, 0.9, 0, 0, 0, 0, 0, 0];
  const motionB = [0, 0, 0, 0, 0, 0, 0.2, 0.9, 0.2, 0.9, 0.2, 0.9];
  const audio = [0.2, 0.9, 0.2, 0.9, 0.2, 0.9, 0.2, 0.9, 0.2, 0.9, 0.2, 0.9];
  const { samples, tracks } = makeScene(motionA, motionB, audio, BOX_A, BOX_B);

  const analysis = decideSpeakers(samples, 1920, 1080, true, makeFallbackFocus(), makeFallbackSplit());

  const early = samples.filter((s) => s.t <= 1.0 && s.activeTrackId !== null);
  const late = samples.filter((s) => s.t >= 2.25 && s.activeTrackId !== null);
  assert.ok(early.length > 0 && early.every((s) => s.activeTrackId === 1), 'A speaks first');
  assert.ok(late.length > 0 && late.every((s) => s.activeTrackId === 2), 'B takes over');

  const segs = analysis.speakerSegments;
  assert.ok(segs.length >= 1 && segs.length <= 4, `no flapping (got ${segs.length} segments)`);
  assert.equal(segs[0].trackId, 1);
  assert.equal(segs[segs.length - 1].trackId, 2);
  assertSwitchSpacing(segs);
  void tracks;
});

test('covered mouths (flat motion, no audio): continuity + face size decide, no flip-flop', () => {
  // Both faces move equally little and audio is missing entirely: the
  // correlation and energy cues vanish, so size/continuity must carry it.
  const motion = new Array(12).fill(0.5);
  const audio = new Array(12).fill(0);
  const { samples } = makeScene(motion, motion, audio, BOX_A, box(1400, 300, 120, 120)); // A is bigger

  decideSpeakers(samples, 1920, 1080, false, makeFallbackFocus(), makeFallbackSplit());

  assert.ok(samples.every((s) => s.activeTrackId === 1), 'bigger face wins and keeps the frame (continuity)');
});

test('hysteresis: frame switches never come faster than once per 0.75s', () => {
  // Near-tie scores every sample: without hysteresis the frame would chatter.
  const base = [0.6, 0.55, 0.6, 0.55, 0.6, 0.55, 0.6, 0.55, 0.6, 0.55, 0.6, 0.55];
  const motionA = base.map((v) => v * 1.01);
  const motionB = base.map((v) => v * 0.99);
  const audio = base;
  const { samples } = makeScene(motionA, motionB, audio, BOX_A, BOX_B);

  const analysis = decideSpeakers(samples, 1920, 1080, true, makeFallbackFocus(), makeFallbackSplit());
  assertSwitchSpacing(analysis.speakerSegments);
});

/** The core hysteresis invariant: no two frame switches less than 0.75s apart. */
function assertSwitchSpacing(segments: Array<{ start: number }>) {
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(
      segments[i].start - segments[i - 1].start > 0.75,
      `switch at ${segments[i].start} came only ${segments[i].start - segments[i - 1].start}s after ${segments[i - 1].start}`
    );
  }
}

test('focus timeline glides to the new speaker over ~0.45s at a speaker change', () => {
  const { samples, tracks } = makeScene(
    new Array(12).fill(0.5),
    new Array(12).fill(0.5),
    new Array(12).fill(0.5),
    BOX_A,
    BOX_B
  );
  // Hand-set the decision: A active 0..1.0s, then B.
  for (const s of samples) {
    s.activeTrackId = s.t < 1.0 ? 1 : 2;
    tracks.get(s.activeTrackId)!.totalSpeaking += 1;
  }
  const segments: SpeakerSegmentInfo[] = [
    { trackId: 1, start: 0, end: 1.0 },
    { trackId: 2, start: 1.0, end: 3.0 },
  ];

  const focus = buildFocusTimeline(samples, tracks, 1920, 1080, segments);

  assert.equal(focus.axis, 'x');
  assert.equal(focus.cropW, 608); // round(1080*9/16)
  assert.equal(focus.cropH, 1080);
  assert.equal(focus.keyframes[0].t, 0, 'anchored at t=0');

  const sorted = [...focus.keyframes].sort((a, b) => a.t - b.t);
  assert.deepEqual(focus.keyframes, sorted, 'keyframes sorted');
  for (const k of focus.keyframes) {
    assert.ok(k.v >= 0 && k.v <= 1920 - 608, `clamped: ${k.v}`);
  }

  // Glide pair: hold A's position at the change, land on B's 0.45s later.
  const hold = focus.keyframes.find((k) => k.t === 1.0);
  const land = focus.keyframes.find((k) => Math.abs(k.t - 1.45) < 1e-9);
  assert.ok(hold && land, 'glide pair present');
  // A center 200 -> pos 200-304 < 0 -> clamped 0; B center 1500 -> 1196.
  assert.equal(hold!.v, 0);
  assert.equal(land!.v, 1196);

  // No raw keyframes survive inside the glide window besides the pair itself.
  const inside = focus.keyframes.filter((k) => k.t > 1.0 && k.t < 1.45);
  assert.equal(inside.length, 0);
});

test('split timeline puts the active speaker on top and swaps panes at a change', () => {
  const { samples, tracks } = makeScene(
    new Array(12).fill(0.5),
    new Array(12).fill(0.5),
    new Array(12).fill(0.5),
    BOX_A,
    BOX_B
  );
  for (const s of samples) {
    s.activeTrackId = s.t < 1.0 ? 1 : 2;
    tracks.get(s.activeTrackId)!.totalSpeaking += 1;
  }
  const segments: SpeakerSegmentInfo[] = [
    { trackId: 1, start: 0, end: 1.0 },
    { trackId: 2, start: 1.0, end: 3.0 },
  ];

  const split = buildSplitTimeline(samples, tracks, 1920, 1080, segments);

  assert.ok(split.top.length > 0 && split.bottom.length > 0);
  for (const k of [...split.top, ...split.bottom]) {
    assert.ok(k.x >= 0 && k.y >= 0);
    assert.ok(k.x <= 1920 - split.cropW + 1e-9, `x clamped: ${k.x} vs ${1920 - split.cropW}`);
    assert.ok(k.y <= 1080 - split.cropH + 1e-9, `y clamped: ${k.y}`);
  }

  // Top pane starts on A (x near 0 after clamping), lands on B after the change.
  const topFirst = split.top[0];
  const topLast = split.top[split.top.length - 1];
  assert.equal(topFirst.x, 0, 'A first on top');
  assert.ok(topLast.x > 1000, `top follows B after change (x=${topLast.x})`);

  // Bottom pane is the mirror image: B first, A after the swap.
  const bottomFirst = split.bottom[0];
  const bottomLast = split.bottom[split.bottom.length - 1];
  assert.ok(bottomFirst.x > 1000, `B starts on bottom (x=${bottomFirst.x})`);
  assert.ok(bottomLast.x < 500, `A arrives on bottom (x=${bottomLast.x})`);

  // Top pane glides across the swap.
  const hold = split.top.find((k) => k.t === 1.0);
  const land = split.top.find((k) => Math.abs(k.t - 1.45) < 1e-9);
  assert.ok(hold && land && land.x > hold.x, 'top pane glides to the new speaker');
});

function makeFallbackFocus(): ReturnType<typeof buildFocusTimeline> {
  return { cropW: 608, cropH: 1080, axis: 'x', keyframes: [{ t: 0, v: 656 } as Keyframe] };
}

function makeFallbackSplit(): ReturnType<typeof buildSplitTimeline> {
  return { cropW: 608, cropH: 540, top: [{ t: 0, x: 656, y: 0 }], bottom: [{ t: 0, x: 656, y: 540 }] };
}
