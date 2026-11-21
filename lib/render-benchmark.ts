import type { RenderDefaults } from "./types";
import { renderBudget, type RenderBudget } from "./core-defaults";

/**
 * Stable visual inputs for the same-sample render benchmark. This is deliberately
 * an explicit opt-in fixture rather than a new application default: importing it
 * never writes SQLite settings or changes an ordinary render.
 */
export interface StaticSpeakerFocusBenchmarkConfig {
  /** Bump when any frozen visual input intentionally changes. */
  readonly id: "static-speaker-focus-v1";
  readonly label: "Static speaker-focus";
  /**
   * A complete render-defaults patch with direct shipped preset IDs. Direct IDs
   * avoid drifting when a user selects another database default for normal jobs.
   */
  readonly renderDefaults: Readonly<RenderDefaults>;
}

const STATIC_SPEAKER_FOCUS_RENDER_DEFAULTS: Readonly<RenderDefaults> = Object.freeze({
  layout: "speaker-focus",
  filterPreset: "vibrant",
  captionPresetId: "caption-theme-kinetic-01",
  hookStylePresetId: "hook-signal-stamp",
  ctaStylePresetId: "cta-afterglow",
  hookDuration: 3,
  ctaDuration: 2.5,
  fadeOutSeconds: 1,
});

/**
 * The concurrency profile a comparison run used. Recorded beside the timings so
 * two benchmark runs on different hosts (or after a defaults change) are not
 * compared as if only the picture had changed.
 */
export function benchmarkEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RenderBudget & { benchmarkId: string } {
  return {
    ...renderBudget(env),
    benchmarkId: STATIC_SPEAKER_FOCUS_BENCHMARK_ID,
  };
}

/**
 * The one static configuration used when collecting before/after timings and
 * visual gates. Source media and the exact clip window remain external inputs,
 * so a benchmark run must record those separately.
 */
const STATIC_SPEAKER_FOCUS_BENCHMARK_ID = "static-speaker-focus-v1" as const;

export const STATIC_SPEAKER_FOCUS_BENCHMARK: StaticSpeakerFocusBenchmarkConfig =
  Object.freeze({
    id: STATIC_SPEAKER_FOCUS_BENCHMARK_ID,
    label: "Static speaker-focus",
    renderDefaults: STATIC_SPEAKER_FOCUS_RENDER_DEFAULTS,
  });
