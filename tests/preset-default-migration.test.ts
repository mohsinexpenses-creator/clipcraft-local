import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import {
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  openDatabase,
  type SqliteDatabase,
} from '../lib/db';

const captionConfig = JSON.stringify({
  fontFamily: 'Arial, sans-serif',
  fontSize: 48,
  fontWeight: 'bold',
  textColor: '#FFFFFF',
  highlightColor: '#FFE600',
  strokeColor: '#000000',
  strokeWidth: 3,
  positionY: 25,
  animationStyle: 'karaoke',
  uppercase: true,
});

const overlayConfig = JSON.stringify({
  fontFamily: 'Arial, sans-serif',
  fontSize: 36,
  fontWeight: 'bold',
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  borderColor: '#FFFFFF',
  borderWidth: 2,
  borderRadius: 12,
  textTransform: 'uppercase',
  positionY: 20,
  animationStyle: 'pop',
  showBadge: true,
});

test('schema v2 keeps user presets and migrates duplicate legacy defaults to one recent default per category', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-preset-migration-'));
  const filePath = path.join(directory, 'legacy.db');
  const legacy = new Database(filePath);
  let migrated: SqliteDatabase | null = null;
  try {
    legacy.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (id, version, applied_at) VALUES (1, 1, '2025-01-01T00:00:00.000Z');
      CREATE TABLE caption_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER, created_at TEXT, updated_at TEXT, config_json TEXT NOT NULL);
      CREATE TABLE overlay_style_presets (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('hook', 'cta')), name TEXT NOT NULL, is_default INTEGER, created_at TEXT, updated_at TEXT, config_json TEXT NOT NULL);
      CREATE TABLE text_presets (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('hook', 'cta')), text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE prompt_templates (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, config_json TEXT NOT NULL);
    `);
    legacy.prepare(`
      INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('preset-bold-yellow', 'Legacy built-in', 1, '2020-01-01', '2020-01-01', captionConfig);
    legacy.prepare(`
      INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-caption', 'User caption', 1, '2024-01-01', '2026-01-01', captionConfig);

    const addOverlay = legacy.prepare(`
      INSERT INTO overlay_style_presets (id, kind, name, is_default, created_at, updated_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    addOverlay.run('hook-bold-yellow', 'hook', 'Legacy hook', 1, '2020-01-01', '2020-01-01', overlayConfig);
    addOverlay.run('user-hook', 'hook', 'User hook', 1, '2024-01-01', '2026-01-01', overlayConfig);
    addOverlay.run('cta-gradient-green', 'cta', 'Legacy CTA', 1, '2020-01-01', '2020-01-01', overlayConfig);
    addOverlay.run('user-cta', 'cta', 'User CTA', 1, '2024-01-01', '2026-01-01', overlayConfig);
    legacy.close();

    migrated = openDatabase(filePath);
    const version = migrated.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    // Every pending migration runs on open, including the additive v3 pipeline column,
    // the v4 settings table and the v5 settings-table rebuild (paths section) - which
    // must tolerate this fixture having no `videos` table at all.
    assert.equal(version.version, 5);
    assert.equal((await getDefaultCaptionPreset(migrated))?._id, 'user-caption');
    assert.equal((await getDefaultOverlayStylePreset('hook', migrated))?._id, 'user-hook');
    assert.equal((await getDefaultOverlayStylePreset('cta', migrated))?._id, 'user-cta');

    assert.equal(migrated.prepare('SELECT 1 FROM caption_presets WHERE id = ?').get('user-caption') !== undefined, true);
    assert.equal(migrated.prepare('SELECT 1 FROM overlay_style_presets WHERE id = ?').get('user-hook') !== undefined, true);
    assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM caption_presets WHERE is_default = 1').get() as { count: number }).count, 1);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM overlay_style_presets WHERE is_default = 1 AND kind = 'hook'").get() as { count: number }).count, 1);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM overlay_style_presets WHERE is_default = 1 AND kind = 'cta'").get() as { count: number }).count, 1);

    assert.throws(
      () => migrated?.prepare('UPDATE caption_presets SET is_default = 1 WHERE id = ?').run('preset-bold-yellow'),
      /UNIQUE constraint failed/
    );
  } finally {
    if (legacy.open) legacy.close();
    if (migrated?.open) migrated.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
