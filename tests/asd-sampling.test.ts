import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAsdSamplingPlan,
  getAdaptiveAsdSamplingEnabled,
  getAsdQualityFallbackReason,
  interpolateTracksForAnalysis,
} from "../worker/asd/sampling";
import { buildSpeakerTimeline } from "../worker/asd/speaker";
import type { Track } from "../worker/asd/tracker";

function track(points: Track["points"]): Track {
  return {
    id: 1,
    points,
    visibleTime: 1,
    avgW: 120,
    maxW: 140,
    cx: points.at(-1)?.cx ?? 0,
    cy: points.at(-1)?.cy ?? 0,
    vx: 0,
    vy: 0,
    lastT: points.at(-1)?.t ?? 0,
    missed: 0,
  };
}

test("adaptive ASD starts with a bounded fast pass and retains the old quality retry", () => {
  const plan = buildAsdSamplingPlan({ sourceWidth: 1920, adaptive: true });
  assert.deepEqual(plan.initial, {
    name: "fast",
    maxFps: 4,
    maxFrames: 240,
    sampleWidth: 640,
    jpegQuality: 5,
  });
  assert.deepEqual(plan.qualityFallback, {
    name: "quality",
    maxFps: 8,
    maxFrames: 480,
    sampleWidth: 960,
    jpegQuality: 3,
  });
  assert.equal(plan.analysisFps, 8);
});

test("adaptive ASD can be rolled back to the quality profile", () => {
  const plan = buildAsdSamplingPlan({ sourceWidth: 1920, adaptive: false });
  assert.equal(plan.initial.name, "quality");
  assert.equal(plan.qualityFallback, null);
  assert.equal(getAdaptiveAsdSamplingEnabled({}), true);
  assert.equal(getAdaptiveAsdSamplingEnabled({ ASD_ADAPTIVE_SAMPLING: "0" }), false);
  assert.equal(getAdaptiveAsdSamplingEnabled({ ASD_ADAPTIVE_SAMPLING: "off" }), false);
});

test("adaptive sampling honors caller ceilings and does not upscale a smaller source", () => {
  const plan = buildAsdSamplingPlan({
    sourceWidth: 720,
    maxSampleFps: 6,
    maxFrames: 300,
    adaptive: true,
  });
  assert.equal(plan.initial.maxFps, 4);
  assert.equal(plan.initial.maxFrames, 240);
  assert.equal(plan.initial.sampleWidth, 640);
  assert.equal(plan.qualityFallback?.maxFps, 6);
  assert.equal(plan.qualityFallback?.maxFrames, 300);
  assert.equal(plan.qualityFallback?.sampleWidth, 720);
});

test("ASD quality fallback protects missing, fleeting and undersized face evidence", () => {
  assert.equal(
    getAsdQualityFallbackReason({
      framesTotal: 24,
      framesWithFaces: 0,
      tracks: 0,
      medianSampleFaceWidth: 0,
    }),
    "no faces were tracked",
  );
  assert.match(
    getAsdQualityFallbackReason({
      framesTotal: 20,
      framesWithFaces: 2,
      tracks: 1,
      medianSampleFaceWidth: 80,
    }) ?? "",
    /only 10%/,
  );
  assert.match(
    getAsdQualityFallbackReason({
      framesTotal: 20,
      framesWithFaces: 20,
      tracks: 1,
      medianSampleFaceWidth: 30,
    }) ?? "",
    /only 30px/,
  );
  assert.equal(
    getAsdQualityFallbackReason({
      framesTotal: 20,
      framesWithFaces: 18,
      tracks: 1,
      medianSampleFaceWidth: 80,
    }),
    null,
  );
});

test("interpolation fills adjacent sightings for the old analysis cadence but never invents motion", () => {
  const source = track([
    { t: 0, cx: 100, cy: 200, w: 80, mouthOpen: null, motion: 0.3 },
    { t: 0.25, cx: 140, cy: 220, w: 100, mouthOpen: null, motion: 0.5 },
    { t: 0.5, cx: 180, cy: 240, w: 120, mouthOpen: null, motion: 0.7 },
  ]);
  const [interpolated] = interpolateTracksForAnalysis([source], 4, 8);

  assert.deepEqual(interpolated.points.map((point) => point.t), [0, 0.125, 0.25, 0.375, 0.5]);
  const midpoint = interpolated.points[1];
  assert.equal(midpoint.cx, 120);
  assert.equal(midpoint.cy, 210);
  assert.equal(midpoint.w, 90);
  assert.equal(midpoint.motion, null, "only detector measurements may carry a visual speech cue");
  assert.equal(interpolated.points[2].motion, 0.5, "measured points remain exact");
  assert.equal(source.points.length, 3, "the detector-owned track is not mutated");
});

test("interpolation does not bridge a missed-face gap", () => {
  const source = track([
    { t: 0, cx: 100, cy: 200, w: 80, mouthOpen: null, motion: 0.3 },
    { t: 0.5, cx: 180, cy: 240, w: 120, mouthOpen: null, motion: 0.7 },
  ]);
  const [interpolated] = interpolateTracksForAnalysis([source], 4, 8);
  assert.deepEqual(interpolated.points.map((point) => point.t), [0, 0.5]);
});

test("interpolated position-only points retain a prompt speaker turn on the 8fps analysis grid", () => {
  const duration = 4;
  const detectorFps = 4;
  const analysisFps = 8;
  const voice = new Array(duration * analysisFps).fill(0.85);
  const measuredA: Track["points"] = [];
  const measuredB: Track["points"] = [];
  for (let frame = 0; frame < duration * detectorFps; frame += 1) {
    const t = frame / detectorFps;
    const aTalking = t < 2;
    measuredA.push({
      t,
      cx: 500,
      cy: 300,
      w: 220,
      mouthOpen: null,
      motion: aTalking ? 0.9 : 0.03,
    });
    measuredB.push({
      t,
      cx: 1400,
      cy: 300,
      w: 220,
      mouthOpen: null,
      motion: aTalking ? 0.03 : 0.9,
    });
  }
  const [a, b] = interpolateTracksForAnalysis(
    [track(measuredA), { ...track(measuredB), id: 2 }],
    detectorFps,
    analysisFps,
  );
  const timeline = buildSpeakerTimeline({
    duration,
    fps: analysisFps,
    voice,
    tracks: [a, b],
    frameWidth: 1920,
  });

  assert.equal(timeline.segments.find((segment) => segment.trackId !== null)?.trackId, 1);
  assert.equal(
    [...timeline.segments].reverse().find((segment) => segment.trackId !== null)?.trackId,
    2,
  );
});
