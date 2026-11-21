import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_DEFAULT_LIMITS,
  REFERENCE_HOST,
  coreAwareAsdDetectionConcurrency,
  coreAwareFfmpegThreads,
  coreAwareImagePrepConcurrency,
  coreAwareParallelBrollConcurrency,
  coreAwareRemotionTabs,
  formatRenderBudget,
  logicalThreads,
  renderBudget,
} from "../lib/core-defaults";
import { getRemotionConcurrency } from "../worker/remotion-options";
import { getParallelBrollAsdConcurrencyCap } from "../worker/render-options";
import { getAsdDetectionConcurrency } from "../worker/asd/sampling";
import { getBrollImagePreparationConcurrency } from "../lib/broll/preparation";

const host = (threads: number) => ({ CLIPCRAFT_LOGICAL_THREADS: String(threads) });

test("the reference 24-thread host gets the documented profile", () => {
  const budget = renderBudget(host(REFERENCE_HOST.threads));
  assert.equal(budget.threads, 24);
  assert.equal(budget.remotionTabs, 12, "half the threads, capped at 12");
  assert.equal(budget.parallelBroll, 4);
  assert.equal(budget.asdDetection, 3, "ASD stays capped at 3");
  assert.equal(budget.imagePrep, 4);
  assert.equal(budget.ffmpegThreads, 9, "the 24 - 12 tabs - 3 ASD workers that remain");
  assert.equal(budget.fitsHost, true, "12 + 3 + 9 == 24 threads exactly");
  assert.match(budget.note, /sum\(tabs\+asd\+ffmpeg\)=24\/24/);
});

test("a small host drops to the minimums and says so below 5 threads", () => {
  const four = renderBudget(host(4));
  assert.equal(four.remotionTabs, CORE_DEFAULT_LIMITS.remotionTabs.min);
  assert.equal(four.parallelBroll, CORE_DEFAULT_LIMITS.brollParallel.min);
  assert.equal(four.asdDetection, 2);
  assert.equal(four.ffmpegThreads, 1, "4 - 2 tabs - 2 ASD workers leaves nothing, so the floor");
  // The floors themselves (2 tabs + 2 ASD workers + 1 encoder) need 5 threads, so
  // a 4-thread box is genuinely too small and is reported rather than hidden.
  assert.equal(four.fitsHost, false);
  assert.match(four.note, /OVER BUDGET/);
});

test("a 2-thread container gets the floor for every knob", () => {
  assert.equal(coreAwareRemotionTabs(host(2)), 2);
  assert.equal(coreAwareParallelBrollConcurrency(host(2)), 2);
  assert.equal(coreAwareAsdDetectionConcurrency(host(2)), 2);
  assert.equal(coreAwareFfmpegThreads(host(2)), 1);
});

test("every derived profile fits the host it was derived from", () => {
  for (const threads of [5, 6, 7, 8, 12, 16, 24, 32, 48, 64, 128]) {
    const budget = renderBudget(host(threads));
    assert.equal(
      budget.fitsHost,
      true,
      `${threads} threads -> ${budget.remotionTabs} tabs + ${budget.asdDetection} ASD + ${budget.ffmpegThreads} ffmpeg`,
    );
  }
});

test("out-of-range explicit values can still oversubscribe, and the log says so", () => {
  const budget = renderBudget({ ...host(4), REMOTION_CONCURRENCY: "8" });
  assert.equal(budget.fitsHost, false);
  assert.match(budget.note, /OVER BUDGET/);
});

test("a huge host is capped rather than given a tab per thread", () => {
  const budget = renderBudget(host(64));
  assert.equal(budget.remotionTabs, CORE_DEFAULT_LIMITS.remotionTabs.max);
  assert.equal(budget.parallelBroll, CORE_DEFAULT_LIMITS.brollParallel.max);
  assert.equal(budget.asdDetection, 3);
  assert.equal(budget.ffmpegThreads, CORE_DEFAULT_LIMITS.ffmpegThreads.max, "32 is the ceiling");
});

test("explicit environment values always beat the derived default", () => {
  const env = {
    ...host(24),
    REMOTION_CONCURRENCY: "6",
    RENDER_PARALLEL_BROLL_CONCURRENCY: "2",
    ASD_DETECTION_CONCURRENCY: "1",
    BROLL_IMAGE_PREP_CONCURRENCY: "1",
    FFMPEG_THREADS: "8",
  };
  const budget = renderBudget(env);
  assert.deepEqual(
    [budget.remotionTabs, budget.parallelBroll, budget.asdDetection, budget.imagePrep, budget.ffmpegThreads],
    [6, 2, 1, 1, 8],
  );
  assert.equal(budget.fitsHost, true, "6 + 1 + 8 fits 24 threads");
});

test("out-of-range explicit values are clamped, not trusted", () => {
  assert.equal(coreAwareRemotionTabs({ REMOTION_CONCURRENCY: "999" }), 32);
  assert.equal(coreAwareParallelBrollConcurrency({ RENDER_PARALLEL_BROLL_CONCURRENCY: "999" }), 32);
  assert.equal(coreAwareAsdDetectionConcurrency({ ASD_DETECTION_CONCURRENCY: "9" }), 3);
  assert.equal(coreAwareImagePrepConcurrency({ BROLL_IMAGE_PREP_CONCURRENCY: "9" }), 4);
  assert.equal(coreAwareFfmpegThreads({ FFMPEG_THREADS: "999" }), 64);
});

test("blank and non-numeric overrides fall back to the derived default", () => {
  for (const value of ["", "   ", "auto", "0", "-2"]) {
    assert.equal(coreAwareRemotionTabs({ ...host(24), REMOTION_CONCURRENCY: value }), 12, value);
    assert.equal(coreAwareFfmpegThreads({ ...host(24), FFMPEG_THREADS: value }), 9, value);
  }
});

test("the worker's own knob readers now return the core-aware defaults", () => {
  // These are the four call sites Phase 7 changed; each keeps its own explicit
  // override and each now scales instead of returning a hard-coded 2.
  assert.equal(getRemotionConcurrency(host(24) as unknown as Record<string, string>), 12);
  assert.equal(getRemotionConcurrency({ REMOTION_CONCURRENCY: "3" }), 3);
  assert.equal(getParallelBrollAsdConcurrencyCap(host(24) as unknown as Record<string, string>), 4);
  assert.equal(getAsdDetectionConcurrency(host(24) as unknown as Record<string, string>), 3);
  assert.equal(getBrollImagePreparationConcurrency(host(2) as unknown as Record<string, string>), 4);
});

test("a caller-supplied cap still wins over the derived tab count", () => {
  // The B-roll-beside-ASD path passes a cap so both stages share the host.
  assert.equal(getRemotionConcurrency(host(24) as unknown as Record<string, string>, { maxConcurrency: 2 }), 2);
  assert.equal(getRemotionConcurrency({ REMOTION_CONCURRENCY: "8" }, { maxConcurrency: 3 }), 3);
  assert.equal(getRemotionConcurrency({ REMOTION_CONCURRENCY: "2" }, { maxConcurrency: 8 }), 2);
});

test("logicalThreads never returns zero and honours the override", () => {
  assert.equal(logicalThreads({ CLIPCRAFT_LOGICAL_THREADS: "7" }), 7);
  assert.equal(logicalThreads({ CLIPCRAFT_LOGICAL_THREADS: "0" }) >= 1, true);
  assert.equal(logicalThreads({}) >= 1, true);
});

test("the budget line is a single greppable log entry", () => {
  const line = formatRenderBudget(renderBudget(host(12)));
  assert.match(line, /^\[RENDER-BUDGET\] threads=12 /);
  assert.match(line, /remotion_tabs=6 /);
  assert.equal(line.includes("\n"), false);
});
