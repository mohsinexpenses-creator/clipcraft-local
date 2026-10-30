/**
 * The built-in presets are seeded with `INSERT OR IGNORE`, so a row that an older build
 * created is never corrected by a later code change. `resetCaptionPresets` /
 * `resetOverlayStylePresets` are the deliberate re-sync the Style presets page exposes,
 * and these are the three properties that make it safe to offer:
 *
 *   1. an edited built-in goes back to the shipped values,
 *   2. rows the user created are not touched - not even their default flag,
 *   3. the result is stable: resetting twice changes nothing more.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultCaptionPreset,
  getCaptionPreset,
  listCaptionPresets,
  resetCaptionPresets,
  resetOverlayStylePresets,
  saveCaptionPreset,
  setDefaultCaptionPreset,
} from "../lib/db";
import {
  DEFAULT_CAPTION_PRESETS,
  DEFAULT_OVERLAY_STYLE_PRESETS,
  RETIRED_OVERLAY_STYLE_PRESET_IDS,
} from "../lib/presets";
import { CAPTION_THEME_NAMES } from "../lib/types";
import type { CaptionPreset } from "../lib/types";
import { createTemporaryDatabase } from "./sqlite-test-helpers";

const firstCaptionId = DEFAULT_CAPTION_PRESETS[0]._id;
const shippedDefaultId = DEFAULT_CAPTION_PRESETS.find(
  (preset) => preset.isDefault,
)?._id;

function captionFrom(id: string): CaptionPreset {
  const preset = DEFAULT_CAPTION_PRESETS.find(
    (candidate) => candidate._id === id,
  );
  if (!preset) throw new Error(`no shipped preset ${id}`);
  return preset;
}

test("database startup seeds each separate theme card into a pre-existing database", async (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);
  const addedThemeIds = DEFAULT_CAPTION_PRESETS.filter((preset) =>
    preset._id.startsWith("caption-theme-"),
  ).map((preset) => preset._id);
  assert.equal(addedThemeIds.length, CAPTION_THEME_NAMES.length);

  const removeBuiltInThemes = db.prepare(
    "DELETE FROM caption_presets WHERE id = ?",
  );
  for (const id of addedThemeIds) removeBuiltInThemes.run(id);
  openConnection();

  const seeded = await listCaptionPresets();
  const themed = seeded.filter((preset) => preset.captionTheme);
  assert.equal(
    seeded.length,
    CAPTION_THEME_NAMES.length,
    "the shipped catalogue contains the current code themes",
  );
  assert.equal(themed.length, CAPTION_THEME_NAMES.length, "each theme is represented once");
  assert.deepEqual(
    themed.map((preset) => preset.captionTheme).sort(),
    [...CAPTION_THEME_NAMES].sort(),
  );
});

test("reset replaces all caption rows with shipped defaults and restores the shipped default", async (t) => {
  createTemporaryDatabase(t);

  const builtIn = captionFrom(firstCaptionId);
  const drifted: CaptionPreset = {
    ...builtIn,
    name: "My old take on the bold one",
    fontSize: 20,
    textColor: "#123456",
    highlightColor: "#654321",
  };
  await saveCaptionPreset(drifted);

  const custom: CaptionPreset = {
    _id: "user-custom-style",
    name: "Mine",
    fontFamily: "Georgia, serif",
    fontSize: 44,
    fontWeight: "normal",
    textColor: "#EEEEEE",
    highlightColor: "#00FF00",
    strokeColor: "#000000",
    strokeWidth: 1,
    positionY: 33,
    animationStyle: "static",
    uppercase: false,
  };
  await saveCaptionPreset(custom);
  await setDefaultCaptionPreset(custom._id);

  const driftedBefore = await getCaptionPreset(builtIn._id);
  assert.equal(
    driftedBefore?.fontSize,
    20,
    "the drift the test is about to repair",
  );

  const presets = await resetCaptionPresets();

  const restored = presets.find((preset) => preset._id === builtIn._id);
  assert.ok(restored, "the built-in row is still there");
  assert.equal(restored.name, builtIn.name, "the shipped name comes back");
  assert.equal(restored.fontSize, builtIn.fontSize);
  assert.equal(
    restored.captionTheme,
    builtIn.captionTheme,
    "theme id persists in the preset config",
  );
  assert.equal(restored.matchOverlayTheme, builtIn.matchOverlayTheme);
  assert.equal(restored.textColor, builtIn.textColor);
  assert.equal(restored.highlightColor, builtIn.highlightColor);

  assert.equal(presets.length, DEFAULT_CAPTION_PRESETS.length);
  assert.ok(!presets.some((preset) => preset._id === custom._id), "custom row is removed");
  assert.equal(
    (await getDefaultCaptionPreset())?._id,
    shippedDefaultId,
    "the shipped code default is restored",
  );
});

test("reset does not resurrect retired caption themes from an older database", async (t) => {
  const { db } = createTemporaryDatabase(t);
  const retiredIds = [
    "kinetic-02", "hustle", "beast", "simple-one-word", "podcast", "flush-poster",
    "left-ladder", "right-ladder", "step-column", "arc-title", "wave-arc",
    "crescent-type", "tilted-run", "offset-columns", "duplex-type", "numbered-ledger",
    "index-list", "manifesto-list", "mosaic-grid", "mosaic-editorial", "mosaic-cutout",
    "mosaic-diagonal", "ribbon-sweep", "ribbon-offset", "ribbon-double", "ribbon-signal",
    "orbit-tilt", "orbit-index", "orbit-counter", "orbit-words", "corner-bracket",
    "open-frame", "caption-frame", "stencil-block", "stencil-outline", "stencil-stripe",
    "stencil-invert",
  ];
  const insertLegacy = db.prepare(
    `INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
     VALUES (?, ?, 0, 'legacy', 'legacy', ?)`
  );
  for (const theme of retiredIds) {
    insertLegacy.run(`caption-theme-${theme}`, theme, JSON.stringify({ captionTheme: theme }));
  }

  const result = await resetCaptionPresets();
  assert.equal(result.length, DEFAULT_CAPTION_PRESETS.length);
  assert.ok(
    result.every((preset) => !retiredIds.includes(preset.captionTheme ?? "")),
  );
  assert.equal((await getDefaultCaptionPreset())?._id, shippedDefaultId);
});

test("reset promotes the shipped default only when nothing is marked default", async (t) => {
  assert.ok(
    shippedDefaultId,
    "the shipped catalogue marks one preset as default",
  );
  const { db } = createTemporaryDatabase(t);

  // A database whose built-ins have lost their default flag - the state a half-finished
  // migration or a hand-edited row can leave behind.
  db.prepare("UPDATE caption_presets SET is_default = 0").run();
  assert.equal(await getDefaultCaptionPreset(), null);

  await resetCaptionPresets();
  assert.equal((await getDefaultCaptionPreset())?._id, shippedDefaultId);

  // Idempotent: running it again cannot keep moving the default around.
  const before = await listCaptionPresets();
  await resetCaptionPresets();
  const after = await listCaptionPresets();
  assert.deepEqual(
    after.map((preset) => ({
      id: preset._id,
      name: preset.name,
      isDefault: preset.isDefault,
      fontSize: preset.fontSize,
    })),
    before.map((preset) => ({
      id: preset._id,
      name: preset.name,
      isDefault: preset.isDefault,
      fontSize: preset.fontSize,
    })),
  );
});

test("reset re-syncs the built-in hook and CTA overlay styles too", async (t) => {
  const { db } = createTemporaryDatabase(t);

  const builtIn = DEFAULT_OVERLAY_STYLE_PRESETS[0];
  db.prepare(
    "UPDATE overlay_style_presets SET name = ?, config_json = ? WHERE id = ?",
  ).run(
    "Edited hook style",
    JSON.stringify({
      ...builtIn,
      _id: undefined,
      kind: undefined,
      name: undefined,
      isDefault: undefined,
    }),
    builtIn._id,
  );

  const custom = {
    ...builtIn,
    _id: "user-hook-style",
    name: "My hook style",
    isDefault: false,
  };
  db.prepare(
    "INSERT INTO overlay_style_presets (id, kind, is_default, created_at, updated_at, name, config_json) VALUES (?, ?, 0, 'test', 'test', ?, ?)",
  ).run(custom._id, custom.kind, custom.name, JSON.stringify({ ...custom, _id: undefined, kind: undefined, name: undefined, isDefault: undefined }));

  for (const id of RETIRED_OVERLAY_STYLE_PRESET_IDS) {
    db.prepare(
      "INSERT OR IGNORE INTO overlay_style_presets (id, kind, is_default, created_at, updated_at, name, config_json) VALUES (?, ?, 0, 'legacy', 'legacy', ?, '{}')",
    ).run(id, id.startsWith("hook-") ? "hook" : "cta", id);
  }

  const presets = await resetOverlayStylePresets();
  const restored = presets.find((preset) => preset._id === builtIn._id);
  assert.equal(restored?.name, builtIn.name);
  assert.equal(restored?.fontSize, builtIn.fontSize);
  assert.ok(presets.some((preset) => preset._id === custom._id), "custom overlay row survives");
  assert.ok(
    RETIRED_OVERLAY_STYLE_PRESET_IDS.every((id) => !presets.some((preset) => preset._id === id)),
    "retired built-in rows are removed",
  );
  assert.equal(
    presets.filter((preset) => preset.kind === builtIn.kind && preset.isDefault)
      .length,
    1,
    "exactly one default per kind, no matter how often things are reset",
  );
});
