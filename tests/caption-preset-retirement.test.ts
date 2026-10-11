import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_CAPTION_PRESET_IDS } from "../lib/presets";
import { createTemporaryDatabase } from "./sqlite-test-helpers";

test("opening an old database deletes retired caption presets, keeps custom ones and moves the default", (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);

  // Recreate what an older build left behind: a retired built-in marked default, a user preset,
  // and saved render settings that point at the retired default.
  db.prepare("UPDATE caption_presets SET is_default = 0").run();
  const insert = db.prepare(
    `INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
     VALUES (?, ?, ?, 'x', 'x', '{}')`,
  );
  insert.run("caption-luxe-gold", "Old built-in", 1);
  insert.run("user-custom-style", "Mine", 0);
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('render', ?, 'x')`,
  ).run(JSON.stringify({ captionPresetId: "caption-luxe-gold" }));

  const reopened = openConnection(); // every open runs seedDefaults()
  const rows = reopened
    .prepare("SELECT id, is_default FROM caption_presets")
    .all() as Array<{
    id: string;
    is_default: number | null;
  }>;
  const ids = rows.map((row) => row.id);

  assert.ok(
    RETIRED_CAPTION_PRESET_IDS.every((id) => !ids.includes(id)),
    "retired rows are gone",
  );
  assert.ok(ids.includes("user-custom-style"), "custom preset survives");
  assert.ok(ids.includes("cc-bold-punch"), "new default exists");
  assert.deepEqual(
    rows.filter((row) => row.is_default === 1).map((row) => row.id),
    ["cc-bold-punch"],
  );

  const render = reopened
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'render'`)
    .get() as { value_json: string };
  assert.equal(JSON.parse(render.value_json).captionPresetId, "cc-bold-punch");

  // Idempotent: opening again changes nothing.
  const again = openConnection()
    .prepare("SELECT COUNT(*) AS n FROM caption_presets")
    .get() as { n: number };
  assert.equal(again.n, rows.length);
});
