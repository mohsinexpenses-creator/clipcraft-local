import type { RenderDefaults } from "./types";

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
 * The one static configuration used when collecting before/after timings and
 * visual gates. Source media and the exact clip window remain external inputs,
 * so a benchmark run must record those separately.
 */
export const STATIC_SPEAKER_FOCUS_BENCHMARK: StaticSpeakerFocusBenchmarkConfig =
  Object.freeze({
    id: "static-speaker-focus-v1",
    label: "Static speaker-focus",
    renderDefaults: STATIC_SPEAKER_FOCUS_RENDER_DEFAULTS,
  });
