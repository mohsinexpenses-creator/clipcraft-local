import assert from "node:assert/strict";
import test from "node:test";
import {
  JobTimer,
  formatElapsedTime,
  formatJobTimingSummary,
} from "../lib/job-timing";

test("JobTimer records wall time and aggregates repeated named stages", async () => {
  let now = 10_000;
  const timer = new JobTimer({ job: "clip-render:clip-1", now: () => now });

  const first = timer.start("asd");
  now += 1_250;
  first();

  await timer.measure("broll-remotion", async () => {
    now += 2_500;
  });

  const second = timer.start("asd");
  now += 750;
  second();
  now += 500;

  const summary = timer.summary("done");
  assert.equal(summary.wallMs, 5_000);
  assert.deepEqual(summary.stages, [
    { name: "broll-remotion", elapsedMs: 2_500, count: 1 },
    { name: "asd", elapsedMs: 2_000, count: 2 },
  ]);
  assert.match(
    formatJobTimingSummary(summary),
    /^\[JOB-TIMING\] job=clip-render:clip-1 outcome=done wall=5\.00s wall_ms=5000 stages: broll-remotion=2\.50s, asd=2\.00s×2$/,
  );
});

test("JobTimer closes an active stage in a cancelled summary", () => {
  let now = 0;
  const timer = new JobTimer({ job: "clip-render:clip-2", now: () => now });
  timer.start("ffmpeg-composite");
  now = 65_250;

  const summary = timer.summary("cancelled");
  assert.equal(summary.wallMs, 65_250);
  assert.deepEqual(summary.stages, [
    { name: "ffmpeg-composite", elapsedMs: 65_250, count: 1 },
  ]);
  assert.equal(formatElapsedTime(summary.wallMs), "1m 5.3s");
});

test("JobTimer stops a failed measure before propagating the error", async () => {
  let now = 100;
  const timer = new JobTimer({ job: "clip-render:clip-3", now: () => now });

  await assert.rejects(
    timer.measure("source-probe", async () => {
      now += 333;
      throw new Error("probe unavailable");
    }),
    /probe unavailable/,
  );

  assert.deepEqual(timer.summary("failed").stages, [
    { name: "source-probe", elapsedMs: 333, count: 1 },
  ]);
});
