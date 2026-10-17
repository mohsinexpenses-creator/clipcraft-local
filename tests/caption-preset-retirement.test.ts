import fs from 'node:fs';
import path from 'node:path';
import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_CAPTION_PRESET_IDS } from "../lib/presets";
import { createTemporaryDatabase } from "./sqlite-test-helpers";

test("opening an old database deletes retired caption presets, backs up themeless rows, keeps valid custom themes and moves the default", (t) => {
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
  db.prepare("INSERT INTO caption_presets (id,name,is_default,created_at,updated_at,config_json) VALUES ('valid-custom','Valid theme',0,'x','x',?)").run(JSON.stringify({ captionTheme: 'pop' }));
  const backups = path.resolve('data/backups');
  const before = new Set(fs.existsSync(backups) ? fs.readdirSync(backups) : []);
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('render', ?, 'x')`,
  ).run(JSON.stringify({ captionPresetId: "caption-luxe-gold" }));

  db.prepare("INSERT INTO videos (id,file_name,original_name,file_path,duration,width,height,file_size,status,created_at,updated_at) VALUES ('reference-video','v.mp4','v.mp4','/v.mp4',60,1920,1080,1,'transcribed','x','x')").run();
  db.prepare("INSERT INTO clips (id,video_id,start,end,status,record_json,created_at,updated_at) VALUES ('reference-clip','reference-video',0,60,'pending',?,'x','x')").run(JSON.stringify({ captionPresetId: 'user-custom-style' }));
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
  assert.ok(!ids.includes("user-custom-style"), "theme-less custom preset is retired too");
  assert.ok(ids.includes("valid-custom"), "valid custom theme survives");
  const created = fs.readdirSync(backups).filter((name) => !before.has(name));
  const backed = created.flatMap((name) => JSON.parse(fs.readFileSync(path.join(backups, name), 'utf8')) as Array<{ id: string }>);
  assert.ok(backed.some((row) => row.id === 'user-custom-style'), 'deleted row backed up before migration');
  assert.ok(ids.includes("cc-bold-punch"), "new default exists");
  assert.deepEqual(
    rows.filter((row) => row.is_default === 1).map((row) => row.id),
    ["cc-bold-punch"],
  );

  const render = reopened
    .prepare(`SELECT value_json FROM app_settings WHERE key = 'render'`)
    .get() as { value_json: string };
  assert.equal(JSON.parse(render.value_json).captionPresetId, "cc-bold-punch");

  const savedClip = reopened.prepare("SELECT record_json FROM clips WHERE id = 'reference-clip'").get() as { record_json: string };
  assert.equal(JSON.parse(savedClip.record_json).captionPresetId, 'cc-bold-punch');

  // Idempotent: opening again changes nothing.
  const again = openConnection()
    .prepare("SELECT COUNT(*) AS n FROM caption_presets")
    .get() as { n: number };
  assert.equal(again.n, rows.length);
});

test('invalid shipped themes and corrupt default are backed up, deleted and reseeded in the same open', (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);
  db.prepare("UPDATE caption_presets SET config_json = '{broken' WHERE id = 'cc-bold-punch'").run();
  db.prepare("UPDATE caption_presets SET config_json = ? WHERE id = 'caption-theme-pop'").run(JSON.stringify({ captionTheme: 'not-a-theme' }));
  const directory = path.resolve('data/backups');
  const before = new Set(fs.readdirSync(directory));
  const opened = openConnection();
  const rows = opened.prepare('SELECT id,is_default,config_json FROM caption_presets').all() as Array<{ id: string; is_default: number; config_json: string }>;
  assert.equal(rows.length, 13);
  assert.equal(JSON.parse(rows.find((row) => row.id === 'cc-bold-punch')!.config_json).captionTheme, 'kinetic-01');
  assert.equal(JSON.parse(rows.find((row) => row.id === 'caption-theme-pop')!.config_json).captionTheme, 'pop');
  assert.deepEqual(rows.filter((row) => row.is_default).map((row) => row.id), ['cc-bold-punch']);
  const backup = fs.readdirSync(directory).filter((name) => !before.has(name)).flatMap((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) as Array<{ id: string; config_json: string }>;
  assert.equal(backup.find((row) => row.id === 'cc-bold-punch')?.config_json, '{broken');
  assert.equal(backup.find((row) => row.id === 'caption-theme-pop')?.config_json, JSON.stringify({ captionTheme: 'not-a-theme' }));
  const after = fs.readdirSync(directory).length;
  openConnection(); assert.equal(fs.readdirSync(directory).length, after, 'second open is idempotent');
});
