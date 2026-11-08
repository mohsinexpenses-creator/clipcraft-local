import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBrollActiveFrameRanges,
  getBrollActiveRangeRenderingEnabled,
  type BrollOverlayItem,
} from "../worker/remotion-renderer";

const item = (
  id: string,
  start: number,
  end: number,
): BrollOverlayItem => ({
  id,
  kind: id.includes("card") ? "landscape" : "fullscreen",
  start,
  end,
  imageUrl: `http://127.0.0.1/${id}.jpg`,
});

test("B-roll active ranges use the composition's frame rounding and rebase to final timeline frames", () => {
  const ranges = calculateBrollActiveFrameRanges(
    [
      item("fullscreen", 10, 13),
      item("card-partial", -0.2, 1.1),
      item("ending", 69.8, 71),
      item("outside", 75, 78),
    ],
    60,
    70,
  );

  assert.deepEqual(
    ranges.map((range) => ({
      id: range.item.id,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      frameCount: range.frameCount,
      startAtSeconds: range.startAtSeconds,
    })),
    [
      // A three-second item at 60fps paints 180 frames, not the whole 4,200-frame clip.
      { id: "fullscreen", startFrame: 600, endFrame: 779, frameCount: 180, startAtSeconds: 10 },
      { id: "card-partial", startFrame: 0, endFrame: 65, frameCount: 66, startAtSeconds: 0 },
      { id: "ending", startFrame: 4188, endFrame: 4199, frameCount: 12, startAtSeconds: 69.8 },
    ],
  );
});

test("B-roll active-range rendering is on by default and has a documented rollback switch", () => {
  assert.equal(getBrollActiveRangeRenderingEnabled({}), true);
  assert.equal(getBrollActiveRangeRenderingEnabled({ BROLL_ACTIVE_RANGE_RENDERING: "0" }), false);
  assert.equal(getBrollActiveRangeRenderingEnabled({ BROLL_ACTIVE_RANGE_RENDERING: "false" }), false);
  assert.equal(getBrollActiveRangeRenderingEnabled({ BROLL_ACTIVE_RANGE_RENDERING: "1" }), true);
});
