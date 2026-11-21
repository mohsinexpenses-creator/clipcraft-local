import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrollImagePreparationConcurrency,
  mapWithConcurrency,
} from "../lib/broll/preparation";

test("B-roll image preparation uses a bounded default with a serial rollback", () => {
  // DELIBERATE (Phase 7): the default is now 4 - each worker is bounded by one
  // card's crop, not by the plan, so four overlap decode/encode without turning a
  // 15-image plan into a RAM spike. An explicit value still wins, and a serial
  // run is still one setting away.
  assert.equal(getBrollImagePreparationConcurrency({}), 4);
  assert.equal(getBrollImagePreparationConcurrency({ BROLL_IMAGE_PREP_CONCURRENCY: "1" }), 1);
  assert.equal(getBrollImagePreparationConcurrency({ BROLL_IMAGE_PREP_CONCURRENCY: "4" }), 4);
  assert.equal(getBrollImagePreparationConcurrency({ BROLL_IMAGE_PREP_CONCURRENCY: "99" }), 4);
  assert.equal(
    getBrollImagePreparationConcurrency({ CLIPCRAFT_LOGICAL_THREADS: "4" }),
    4,
    'a small host still gets the same bounded default (it is not thread-derived)',
  );
});

test("bounded preparation waits for in-flight work after cancellation", async () => {
  const controller = new AbortController();
  let finished = 0;
  const pending = mapWithConcurrency(
    [1, 2],
    2,
    async () =>
      new Promise<number>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => setTimeout(() => {
            finished += 1;
            resolve(finished);
          }, 5),
          { once: true },
        );
      }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(finished, 2);
});

test("bounded preparation preserves result order and never exceeds its worker limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, value % 2 ? 5 : 1));
      active -= 1;
      return value * 10;
    },
  );

  assert.equal(peak, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});
