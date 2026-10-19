import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPTION_PRESETS } from "../lib/presets";
import { CAPTION_THEME_NAMES } from "../lib/types";
import { createTemporaryDatabase } from "./sqlite-test-helpers";

test("theme-only seed keeps the shipped caption themes and preserves custom rows", (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);

  db.prepare("UPDATE caption_presets SET is_default = 0").run();
  const insert = db.prepare(
    `INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
     VALUES (?, ?, ?, 'x', 'x', '{}')`,
  );
  insert.run("legacy-theme-backup", "Legacy", 1);
  insert.run("user-custom-style", "Mine", 0);

  const reopened = openConnection();
  const rows = reopened
    .prepare("SELECT id, is_default FROM caption_presets")
    .all() as Array<{ id: string; is_default: number | null }>;
  const ids = rows.map((row) => row.id);

  assert.equal(DEFAULT_CAPTION_PRESETS.length, CAPTION_THEME_NAMES.length);
  assert.ok(
    DEFAULT_CAPTION_PRESETS.every((preset) =>
      preset._id.startsWith("caption-theme-"),
    ),
  );
  assert.ok(ids.includes("user-custom-style"), "custom preset survives");
  assert.ok(
    ids.includes("caption-theme-kinetic-01"),
    "the default theme entry exists",
  );
  assert.ok(
    rows
      .filter((row) => row.is_default === 1)
      .every(
        (row) =>
          row.id.startsWith("caption-theme-") ||
          row.id === "legacy-theme-backup",
      ),
    "only shipped theme defaults or a preserved custom default remain flagged default",
  );
  assert.ok(
    ids.every((id) => !id.startsWith("cc-")),
    "legacy cc-* caption backup ids are not kept",
  );
});
