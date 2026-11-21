/**
 * Core-aware defaults (Phase 7).
 *
 * Every concurrency knob in the worker used to have one hard-coded number tuned
 * on somebody else's laptop: 2 Remotion tabs on a 24-thread Ryzen is a waste, and
 * 12 tabs on a 4-core container is a swap storm. This module derives each default
 * from the logical CPU count, and every value stays overridable - the env var
 * always wins, so a host that knows better keeps full control.
 *
 * The whole point is that the SUMS never exceed the thread count:
 *
 *   Remotion tabs            clamp(floor(threads * 0.5), 2, 12)
 *   B-roll/ASD concurrency   clamp(floor(threads / 6), 2, 4)   (ASD keeps its 3 cap)
 *   FFmpeg threads           threads - tabs - ASD workers, clamped 1..32
 *
 * On the reference host (Ryzen 9 9900X, 12 cores / 24 threads) that is 12 tabs,
 * 4 B-roll/ASD workers, 4 image-preparation workers and 9 FFmpeg threads - 24 of
 * 24 threads, so the profile fits the machine instead of oversubscribing it.
 *
 * Nothing here reads `process.env` at import time except through the exported
 * functions, so tests can pass their own environment.
 */

import os from "node:os";

/** The reference host from the tuning brief, used as the documented example. */
export const REFERENCE_HOST = { name: "Ryzen 9 9900X", cores: 12, threads: 24 } as const;

export const CORE_DEFAULT_LIMITS = {
  remotionTabs: { min: 2, max: 12 },
  brollParallel: { min: 2, max: 4 },
  asdConcurrency: { min: 2, max: 4 },
  imagePrep: { min: 1, max: 4 },
  ffmpegThreads: { min: 1, max: 32 },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Logical thread count, honouring container/cgroup limits when Node exposes them.
 * A value of 0 or a throw resolves to 1, which every caller clamps up.
 */
export function logicalThreads(env: Readonly<Record<string, string | undefined>> = process.env): number {
  // An explicit override exists for benchmarking a profile on another host.
  const forced = Number(env.CLIPCRAFT_LOGICAL_THREADS?.trim());
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  try {
    const available =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.floor(available) || 1);
  } catch {
    return 1;
  }
}

function readExplicit(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

/**
 * Chrome tabs for Remotion: half the threads, at least 2 and at most 12.
 * `REMOTION_CONCURRENCY` (set by the Settings percentage) still wins.
 */
export function coreAwareRemotionTabs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const explicit = readExplicit(env.REMOTION_CONCURRENCY);
  if (explicit !== null) return clamp(explicit, 1, 32);
  const { min, max } = CORE_DEFAULT_LIMITS.remotionTabs;
  return clamp(Math.floor(logicalThreads(env) * 0.5), min, max);
}

/** B-roll beside ASD, and ASD's own worker pool: threads / 6, bounded 2..4. */
export function coreAwareParallelBrollConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const explicit = readExplicit(env.RENDER_PARALLEL_BROLL_CONCURRENCY);
  if (explicit !== null) return clamp(explicit, 1, 32);
  const { min, max } = CORE_DEFAULT_LIMITS.brollParallel;
  return clamp(Math.floor(logicalThreads(env) / 6), min, max);
}

export function coreAwareAsdDetectionConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const explicit = readExplicit(env.ASD_DETECTION_CONCURRENCY);
  if (explicit !== null) return clamp(explicit, 1, 3);
  const { min, max } = CORE_DEFAULT_LIMITS.asdConcurrency;
  // The hard cap stays 3: YuNet is decoding JPEGs, not computing a matrix
  // product, and past 3 workers the tracker's input order stops paying off.
  return clamp(Math.floor(logicalThreads(env) / 6), min, Math.min(max, 3));
}

/**
 * Jimp image preparation: a fixed 4 by default (it is I/O-and-decode bound, not
 * thread-count bound), still overridable and still bounded to 1..4.
 */
export function coreAwareImagePrepConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const explicit = readExplicit(env.BROLL_IMAGE_PREP_CONCURRENCY);
  if (explicit !== null) return clamp(explicit, 1, 4);
  return CORE_DEFAULT_LIMITS.imagePrep.max;
}

/**
 * FFmpeg's own thread count: whatever is left after the Remotion tabs and ASD
 * workers, so the encoder cannot claim every core while another stage still needs
 * the CPU. Explicit `FFMPEG_THREADS` wins.
 */
export function coreAwareFfmpegThreads(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const explicit = readExplicit(env.FFMPEG_THREADS);
  if (explicit !== null) return clamp(explicit, 1, 64);
  // Remaining headroom, so tabs + ASD workers + encoder threads fit the host.
  const remaining =
    logicalThreads(env) - coreAwareRemotionTabs(env) - coreAwareAsdDetectionConcurrency(env);
  return clamp(
    remaining,
    CORE_DEFAULT_LIMITS.ffmpegThreads.min,
    CORE_DEFAULT_LIMITS.ffmpegThreads.max,
  );
}

export interface RenderBudget {
  threads: number;
  remotionTabs: number;
  parallelBroll: number;
  asdDetection: number;
  imagePrep: number;
  ffmpegThreads: number;
  /** True when tabs + ASD workers + FFmpeg threads fit the host. */
  fitsHost: boolean;
  /** Everything the profile was derived from, for the log line and the report. */
  note: string;
}

/**
 * The whole profile at once - what the worker logs at startup and what
 * `npm run bench:render` prints beside each timing.
 */
export function renderBudget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RenderBudget {
  const threads = logicalThreads(env);
  const remotionTabs = coreAwareRemotionTabs(env);
  const parallelBroll = coreAwareParallelBrollConcurrency(env);
  const asdDetection = coreAwareAsdDetectionConcurrency(env);
  const imagePrep = coreAwareImagePrepConcurrency(env);
  const ffmpegThreads = coreAwareFfmpegThreads(env);
  const used = remotionTabs + asdDetection + ffmpegThreads;
  return {
    threads,
    remotionTabs,
    parallelBroll,
    asdDetection,
    imagePrep,
    ffmpegThreads,
    fitsHost: used <= threads,
    note:
      `threads=${threads} remotion_tabs=${remotionTabs} broll_parallel=${parallelBroll} ` +
      `asd_workers=${asdDetection} image_prep=${imagePrep} ffmpeg_threads=${ffmpegThreads} ` +
      `sum(tabs+asd+ffmpeg)=${used}/${threads}${used <= threads ? "" : " OVER BUDGET"}`,
  };
}

/** One line, for the worker's startup log. */
export function formatRenderBudget(budget: RenderBudget): string {
  return `[RENDER-BUDGET] ${budget.note}`;
}
