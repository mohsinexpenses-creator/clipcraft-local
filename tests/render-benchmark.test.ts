import assert from "node:assert/strict";
import test from "node:test";
import { STATIC_SPEAKER_FOCUS_BENCHMARK } from "../lib/render-benchmark";
import {
  DEFAULT_CAPTION_PRESETS,
  DEFAULT_FILTER_PRESETS,
  DEFAULT_OVERLAY_STYLE_PRESETS,
} from "../lib/presets";
import { DEFAULT_RENDER_SETTINGS } from "../lib/types";

test("the static speaker-focus benchmark freezes the intended render inputs", () => {
  const { renderDefaults } = STATIC_SPEAKER_FOCUS_BENCHMARK;

  assert.equal(STATIC_SPEAKER_FOCUS_BENCHMARK.id, "static-speaker-focus-v1");
  assert.ok(Object.isFrozen(STATIC_SPEAKER_FOCUS_BENCHMARK));
  assert.ok(Object.isFrozen(renderDefaults));
  assert.deepEqual(renderDefaults, {
    layout: "speaker-focus",
    filterPreset: "vibrant",
    captionPresetId: "caption-theme-kinetic-01",
    hookStylePresetId: "hook-signal-stamp",
    ctaStylePresetId: "cta-afterglow",
    hookDuration: 3,
    ctaDuration: 2.5,
    fadeOutSeconds: 1,
  });

  // The non-preset values stay aligned with the normal safe defaults; the
  // benchmark deliberately makes the three preset IDs explicit instead.
  assert.equal(renderDefaults.layout, DEFAULT_RENDER_SETTINGS.layout);
  assert.equal(renderDefaults.filterPreset, DEFAULT_RENDER_SETTINGS.filterPreset);
  assert.equal(renderDefaults.hookDuration, DEFAULT_RENDER_SETTINGS.hookDuration);
  assert.equal(renderDefaults.ctaDuration, DEFAULT_RENDER_SETTINGS.ctaDuration);
  assert.equal(renderDefaults.fadeOutSeconds, DEFAULT_RENDER_SETTINGS.fadeOutSeconds);
});

test("every frozen benchmark preset ID resolves to its shipped visual contract", () => {
  const { renderDefaults } = STATIC_SPEAKER_FOCUS_BENCHMARK;
  const caption = DEFAULT_CAPTION_PRESETS.find(
    (preset) => preset._id === renderDefaults.captionPresetId,
  );
  const hook = DEFAULT_OVERLAY_STYLE_PRESETS.find(
    (preset) => preset._id === renderDefaults.hookStylePresetId,
  );
  const cta = DEFAULT_OVERLAY_STYLE_PRESETS.find(
    (preset) => preset._id === renderDefaults.ctaStylePresetId,
  );
  const filter = DEFAULT_FILTER_PRESETS.find(
    (preset) => preset.id === renderDefaults.filterPreset,
  );

  assert.equal(caption?.name, "Kinetic 01");
  assert.equal(caption?.captionTheme, "kinetic-01");
  assert.equal(hook?.kind, "hook");
  assert.equal(hook?.name, "Signal Stamp");
  assert.equal(cta?.kind, "cta");
  assert.equal(cta?.name, "Afterglow");
  assert.equal(filter?.name, "Vibrant Boost");
});
