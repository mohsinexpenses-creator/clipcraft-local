import assert from "node:assert/strict";
import test from "node:test";
import { runParallelRenderBranches } from "../worker/parallel";
import {
  canParallelizeBrollWithAsd,
  getOverlayThreadQueueSize,
  getParallelBrollAsdConcurrencyCap,
  getParallelBrollAsdEnabled,
} from "../worker/render-options";
import {
  getBrollCardCroppedCanvasEnabled,
  getCaptionActiveRangeRenderingEnabled,
  getCaptionBandCroppedCanvasEnabled,
  getRemotionConcurrency,
} from "../worker/remotion-options";
import { remotionThreadsFromPercent } from "../worker/runtime-settings";

test("speaker-focus B-roll/ASD overlap is on by default and has a sequential rollback", () => {
  assert.equal(getParallelBrollAsdEnabled({}), true);
  assert.equal(getParallelBrollAsdEnabled({ RENDER_PARALLEL_BROLL_ASD: "1" }), true);
  assert.equal(getParallelBrollAsdEnabled({ RENDER_PARALLEL_BROLL_ASD: "0" }), false);
  assert.equal(getParallelBrollAsdEnabled({ RENDER_PARALLEL_BROLL_ASD: "false" }), false);
});

test("fullscreen-only split B-roll can overlap ASD while face-safe split cards stay sequential", () => {
  assert.equal(
    canParallelizeBrollWithAsd("speaker-focus", [{ kind: "landscape" }]),
    true,
    "speaker-focus retains its fixed landscape-card anchor",
  );
  assert.equal(
    canParallelizeBrollWithAsd("split-screen", [{ kind: "fullscreen" }]),
    true,
    "fullscreen imagery has no ASD-derived card placement",
  );
  assert.equal(
    canParallelizeBrollWithAsd("split-screen", [{ kind: "fullscreen" }, { kind: "landscape" }]),
    false,
    "a split landscape card still needs final face bands",
  );
  assert.equal(canParallelizeBrollWithAsd("split-screen", []), false);
});

test("Remotion percent budget becomes a bounded logical-thread tab count per job", () => {
  assert.equal(remotionThreadsFromPercent(50, 8), 4);
  assert.equal(remotionThreadsFromPercent(10, 8), 1);
  assert.equal(remotionThreadsFromPercent(100, 12), 12);
  assert.equal(remotionThreadsFromPercent(50, 1), 1);
  assert.equal(remotionThreadsFromPercent(100, 128), 32, "Remotion supported cap remains enforced");
});

test("parallel B-roll cap leaves capacity for ASD and respects a smaller manual tab count", () => {
  assert.equal(getParallelBrollAsdConcurrencyCap({}), 2);
  assert.equal(
    getParallelBrollAsdConcurrencyCap({ RENDER_PARALLEL_BROLL_CONCURRENCY: "3" }),
    3,
  );
  assert.equal(getRemotionConcurrency({}, { maxConcurrency: 2 }), 2);
  assert.equal(
    getRemotionConcurrency({ REMOTION_CONCURRENCY: "1" }, { maxConcurrency: 2 }),
    1,
  );
  assert.equal(
    getRemotionConcurrency({ REMOTION_CONCURRENCY: "8" }, { maxConcurrency: 2 }),
    2,
  );
  assert.equal(getRemotionConcurrency({ REMOTION_CONCURRENCY: "8" }), 8);
  assert.equal(getCaptionActiveRangeRenderingEnabled({}), false);
  assert.equal(
    getCaptionActiveRangeRenderingEnabled({ CAPTION_ACTIVE_RANGE_RENDERING: "yes" }),
    true,
  );
  // These canvas reductions remain explicit opt-ins until the five-timestamp
  // cropped/full render gate is recorded on a real host.
  assert.equal(getCaptionBandCroppedCanvasEnabled({}), false);
  assert.equal(getCaptionBandCroppedCanvasEnabled({ CAPTION_BAND_CROPPED_CANVAS: "on" }), true);
  assert.equal(getBrollCardCroppedCanvasEnabled({}), false);
  assert.equal(getBrollCardCroppedCanvasEnabled({ BROLL_CARD_CROPPED_CANVAS: "1" }), true);
  assert.equal(getOverlayThreadQueueSize({}), 2);
  assert.equal(getOverlayThreadQueueSize({ FFMPEG_OVERLAY_THREAD_QUEUE_SIZE: "16" }), 16);
  assert.equal(getOverlayThreadQueueSize({ FFMPEG_OVERLAY_THREAD_QUEUE_SIZE: "32" }), 32);
  assert.equal(getOverlayThreadQueueSize({ FFMPEG_OVERLAY_THREAD_QUEUE_SIZE: "100" }), 2);
});

test("parallel render branches wait for sibling cleanup after a failure", async () => {
  let siblingSawAbort = false;
  let siblingCleanedUp = false;

  await assert.rejects(
    runParallelRenderBranches(
      undefined,
      async () => {
        throw new Error("ASD failed");
      },
      async (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              siblingSawAbort = true;
              setTimeout(() => {
                siblingCleanedUp = true;
                resolve("cleaned");
              }, 5);
            },
            { once: true },
          );
        }),
    ),
    /ASD failed/,
  );

  assert.equal(siblingSawAbort, true);
  assert.equal(siblingCleanedUp, true, "the rejection waits for the sibling's cleanup");
});

test("parallel render branches propagate a parent cancellation as RenderCancelledError", async () => {
  const controller = new AbortController();
  const pending = runParallelRenderBranches(
    controller.signal,
    async (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    async (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
});
