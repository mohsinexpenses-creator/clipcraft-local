import assert from "node:assert/strict";
import test from "node:test";
import { runParallelRenderBranches } from "../worker/parallel";
import {
  getParallelBrollAsdConcurrencyCap,
  getParallelBrollAsdEnabled,
} from "../worker/render-options";
import {
  getCaptionActiveRangeRenderingEnabled,
  getRemotionConcurrency,
} from "../worker/remotion-options";

test("B-roll/ASD overlap flag is opt-in", () => {
  assert.equal(getParallelBrollAsdEnabled({}), false);
  assert.equal(getParallelBrollAsdEnabled({ RENDER_PARALLEL_BROLL_ASD: "1" }), true);
  assert.equal(getParallelBrollAsdEnabled({ RENDER_PARALLEL_BROLL_ASD: "false" }), false);
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
