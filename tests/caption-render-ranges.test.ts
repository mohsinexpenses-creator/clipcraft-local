import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPTION_PRESETS } from "../lib/presets";
import {
  calculateCaptionActiveFrameRanges,
  shouldUseCaptionActiveFrameRanges,
  type CaptionActiveFrameRange,
} from "../worker/remotion-renderer";

const preset = DEFAULT_CAPTION_PRESETS[0];

function range(startFrame: number, endFrame: number): CaptionActiveFrameRange {
  return {
    startFrame,
    endFrame,
    frameCount: endFrame - startFrame + 1,
    startAtSeconds: startFrame / 30,
  };
}

test("caption active ranges retain hook, caption and CTA timing on the full composition clock", () => {
  const ranges = calculateCaptionActiveFrameRanges(
    {
      hookText: "Watch this",
      hookDuration: 1,
      hookStart: 0,
      hookTransitionDuration: 0.2,
      ctaText: "Follow",
      ctaDuration: 2,
      words: [{ word: "later", start: 2, end: 2.2 }],
      preset,
    },
    30,
    10,
  );

  assert.deepEqual(
    ranges.map(({ startFrame, endFrame, startAtSeconds }) => [startFrame, endFrame, startAtSeconds]),
    [
      [0, 24, 0], // hook: 0 through its transition-trimmed 0.8-second end
      [88, 107, 88 / 30], // source word is shifted by the 1-second hook intro
      [240, 299, 8], // CTA: final two seconds
    ],
  );
});

test("caption active ranges merge adjacent caption holds without overlapping FFmpeg sequences", () => {
  const ranges = calculateCaptionActiveFrameRanges(
    {
      hookText: "",
      hookDuration: 0,
      hookStart: 0,
      hookTransitionDuration: 0,
      ctaText: "",
      ctaDuration: 0,
      words: [
        { word: "one", start: 1, end: 1.1 },
        { word: "two", start: 1.2, end: 1.3 },
        { word: "three", start: 1.4, end: 1.5 },
        { word: "four", start: 1.6, end: 1.7 },
        { word: "five", start: 1.9, end: 2 },
      ],
      preset,
    },
    30,
    5,
  );

  assert.equal(ranges.length, 1);
  assert.deepEqual([ranges[0].startFrame, ranges[0].endFrame], [28, 71]);
});

test("sparse-caption heuristic only opts in for useful, bounded work reductions", () => {
  assert.equal(shouldUseCaptionActiveFrameRanges(false, [range(0, 20)], 300), false);
  assert.equal(shouldUseCaptionActiveFrameRanges(true, [], 300), true);
  assert.equal(shouldUseCaptionActiveFrameRanges(true, [range(0, 20), range(200, 220)], 300), true);
  assert.equal(shouldUseCaptionActiveFrameRanges(true, [range(0, 299)], 300), false);
  assert.equal(
    shouldUseCaptionActiveFrameRanges(
      true,
      Array.from({ length: 9 }, (_, index) => range(index * 20, index * 20 + 2)),
      300,
    ),
    false,
  );
});
