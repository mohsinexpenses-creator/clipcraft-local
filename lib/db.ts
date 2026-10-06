import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  CaptionPreset,
  ClipRecord,
  OverlayStylePreset,
  PromptTemplate,
  TextPreset,
  TranscriptData,
  VideoRecord,
} from "./types";
import {
  DEFAULT_CAPTION_PRESETS,
  DEFAULT_OVERLAY_STYLE_PRESETS,
  DEFAULT_PROMPT_TEMPLATES,
} from "./presets";
import { AppError } from "./errors";

export type SqliteDatabase = InstanceType<typeof Database>;

type GlobalDatabase = typeof globalThis & {
  __clipcraftSqliteDatabase?: SqliteDatabase;
  __clipcraftSqliteDatabasePath?: string;
};

const globalDatabase = globalThis as GlobalDatabase;
let databaseOverrideForTests: SqliteDatabase | null = null;

interface VideoRow {
  id: string;
  original_name: string;
  file_name: string;
  file_base: string | null;
  file_path: string;
  duration: number;
  width: number;
  height: number;
  file_size: number;
  status: VideoRecord["status"];
  transcript_json: string | null;
  transcription_provider: VideoRecord["transcriptionProvider"] | null;
  transcription_model: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ClipRow {
  id: string;
  video_id: string;
  start: number;
  end: number;
  output_path: string | null;
  status: ClipRecord["status"];
  progress: number | null;
  record_json: string;
  created_at: string;
  updated_at: string;
}

interface CaptionPresetRow {
  id: string;
  name: string;
  is_default: number | null;
  created_at: string | null;
  updated_at: string | null;
  config_json: string;
}

interface OverlayStylePresetRow extends CaptionPresetRow {
  kind: OverlayStylePreset["kind"];
}

interface TextPresetRow {
  id: string;
  kind: TextPreset["kind"];
  text: string;
  created_at: string;
  updated_at: string;
}

interface PromptTemplateRow {
  id: string;
  type: PromptTemplate["type"];
  name: string;
  updated_at: string;
  config_json: string;
}

const VIDEO_COLUMNS = `
  id, original_name, file_name, file_base, file_path, duration, width, height,
  file_size, status, transcript_json, transcription_provider, transcription_model,
  error, created_at, updated_at
`;

const CLIP_COLUMNS = `
  id, video_id, start, end, output_path, status, progress, record_json, created_at, updated_at
`;

const CURRENT_SCHEMA_VERSION = 1;

/** Absolute path used by the web process and the worker. */
export function getDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim() || "./data/clipcraft.db";
  return configured === ":memory:"
    ? configured
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), configured);
}

function configureDatabase(filePath: string): SqliteDatabase {
  const resolvedPath =
    filePath === ":memory:" ? filePath : path.resolve(filePath);
  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
    seedDefaults(db);
    return db;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

/**
 * Open an independent initialized connection. Production code uses getDatabase();
 * tests use this helper to exercise real temporary SQLite files and two-connection claims.
 */
export function openDatabase(filePath: string): SqliteDatabase {
  return configureDatabase(filePath);
}

/** Module-level connection, shared across Next.js development hot reloads. */
export function getDatabase(): SqliteDatabase {
  if (databaseOverrideForTests) return databaseOverrideForTests;

  const filePath = getDatabasePath();
  if (globalDatabase.__clipcraftSqliteDatabase) {
    if (globalDatabase.__clipcraftSqliteDatabasePath !== filePath) {
      throw new AppError("DATABASE_PATH changed after SQLite was opened.", {
        status: 500,
        resolution:
          "Restart the web process and worker after changing DATABASE_PATH.",
      });
    }
    return globalDatabase.__clipcraftSqliteDatabase;
  }

  try {
    globalDatabase.__clipcraftSqliteDatabase = configureDatabase(filePath);
    globalDatabase.__clipcraftSqliteDatabasePath = filePath;
    return globalDatabase.__clipcraftSqliteDatabase;
  } catch (error) {
    throw new AppError("SQLite database could not be opened.", {
      status: 500,
      details: error instanceof Error ? error.message : String(error),
      resolution: `Check DATABASE_PATH (${filePath}) and make sure its parent directory is writable.`,
      cause: error,
    });
  }
}

/** Backward-compatible alias for callers that await a database accessor. */
export async function getDb(): Promise<SqliteDatabase> {
  return getDatabase();
}

/** Test-only connection override; the application singleton remains untouched. */
export function setDatabaseForTests(db: SqliteDatabase | null): void {
  databaseOverrideForTests = db;
}

/** Close and clear the process singleton (used on worker shutdown and in tests). */
export function closeDatabase(): void {
  databaseOverrideForTests = null;
  if (globalDatabase.__clipcraftSqliteDatabase?.open) {
    globalDatabase.__clipcraftSqliteDatabase.close();
  }
  delete globalDatabase.__clipcraftSqliteDatabase;
  delete globalDatabase.__clipcraftSqliteDatabasePath;
}

function migrateSchemaV1(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_base TEXT,
      file_path TEXT NOT NULL,
      duration REAL NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('uploaded', 'transcribing', 'transcribed', 'failed')),
      transcript_json TEXT,
      transcription_provider TEXT,
      transcription_model TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      start REAL NOT NULL,
      end REAL NOT NULL,
      output_path TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      progress INTEGER,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS caption_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER,
      created_at TEXT,
      updated_at TEXT,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS overlay_style_presets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('hook', 'cta')),
      name TEXT NOT NULL,
      is_default INTEGER,
      created_at TEXT,
      updated_at TEXT,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS text_presets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('hook', 'cta')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('viral_detection', 'hook_generation', 'cta_generation')),
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      error TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      retry_delay_ms INTEGER NOT NULL DEFAULT 2000,
      video_id TEXT,
      clip_id TEXT,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY (clip_id) REFERENCES clips(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS videos_created_at_idx ON videos(created_at DESC);
    CREATE INDEX IF NOT EXISTS videos_status_idx ON videos(status);
    CREATE INDEX IF NOT EXISTS clips_video_created_at_idx ON clips(video_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS clips_status_idx ON clips(status);
    CREATE INDEX IF NOT EXISTS caption_presets_default_idx ON caption_presets(is_default);
    CREATE INDEX IF NOT EXISTS overlay_style_kind_name_idx ON overlay_style_presets(kind, name);
    CREATE INDEX IF NOT EXISTS text_presets_kind_idx ON text_presets(kind);
    CREATE INDEX IF NOT EXISTS prompt_templates_type_idx ON prompt_templates(type);
    CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, type, available_at, created_at);
    CREATE INDEX IF NOT EXISTS jobs_video_idx ON jobs(video_id, status);
    CREATE INDEX IF NOT EXISTS jobs_clip_idx ON jobs(clip_id, status);
  `);
}

const SCHEMA_MIGRATIONS: Record<number, (db: SqliteDatabase) => void> = {
  1: migrateSchemaV1,
};

export function initializeSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const versionRow = db
    .prepare("SELECT version FROM schema_version WHERE id = 1")
    .get() as { version: number } | undefined;
  let version = versionRow?.version ?? 0;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${version} is newer than this application supports (v${CURRENT_SCHEMA_VERSION}).`,
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const nextVersion = version + 1;
    const migrate = SCHEMA_MIGRATIONS[nextVersion];
    if (!migrate)
      throw new Error(`No SQLite migration exists for schema v${nextVersion}.`);

    const appliedAt = new Date().toISOString();
    version = db
      .transaction(() => {
        // Another process may have applied this migration while we waited for the
        // write lock; always re-read the version inside the transaction.
        const currentRow = db
          .prepare("SELECT version FROM schema_version WHERE id = 1")
          .get() as { version: number } | undefined;
        const currentVersion = currentRow?.version ?? 0;
        if (currentVersion >= nextVersion) return currentVersion;
        if (currentVersion !== nextVersion - 1) {
          throw new Error(
            `Unexpected SQLite schema version ${currentVersion} while applying v${nextVersion}.`,
          );
        }

        migrate(db);
        db.prepare(
          `
        INSERT INTO schema_version (id, version, applied_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
      `,
        ).run(nextVersion, appliedAt);
        return nextVersion;
      })
      .immediate();
  }
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Cannot serialize undefined as JSON.");
  return serialized;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(
      `SQLite ${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function seedDefaults(db: SqliteDatabase): void {
  const insertCaption = db.prepare(`
    INSERT OR IGNORE INTO caption_presets
      (id, name, is_default, created_at, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertOverlay = db.prepare(`
    INSERT OR IGNORE INTO overlay_style_presets
      (id, kind, name, is_default, created_at, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPrompt = db.prepare(`
    INSERT OR IGNORE INTO prompt_templates (id, type, name, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const preset of DEFAULT_CAPTION_PRESETS) {
      const { _id, name, isDefault, createdAt, updatedAt, ...config } = preset;
      insertCaption.run(
        _id,
        name,
        isDefault === undefined ? null : Number(isDefault),
        createdAt ?? now,
        updatedAt ?? now,
        serializeJson(config),
      );
    }

    for (const preset of DEFAULT_OVERLAY_STYLE_PRESETS) {
      const { _id, kind, name, isDefault, createdAt, updatedAt, ...config } =
        preset;
      insertOverlay.run(
        _id,
        kind,
        name,
        isDefault === undefined ? null : Number(isDefault),
        createdAt ?? now,
        updatedAt ?? now,
        serializeJson(config),
      );
    }

    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      const { _id, type, name, updatedAt, ...config } = template;
      insertPrompt.run(_id, type, name, updatedAt, serializeJson(config));
    }
  }).immediate();
}

function mapVideo(row: VideoRow): VideoRecord {
  return {
    _id: row.id,
    originalName: row.original_name,
    fileName: row.file_name,
    ...(row.file_base !== null ? { fileBase: row.file_base } : {}),
    filePath: row.file_path,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    status: row.status,
    ...(row.transcript_json !== null
      ? {
          transcript: parseJson<TranscriptData>(
            row.transcript_json,
            "video transcript",
          ),
        }
      : {}),
    ...(row.transcription_provider !== null
      ? { transcriptionProvider: row.transcription_provider }
      : {}),
    ...(row.transcription_model !== null
      ? { transcriptionModel: row.transcription_model }
      : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClip(row: ClipRow): ClipRecord {
  const record = parseJson<Partial<ClipRecord>>(row.record_json, "clip record");
  return {
    ...record,
    _id: row.id,
    videoId: row.video_id,
    start: row.start,
    end: row.end,
    ...(row.output_path !== null ? { outputPath: row.output_path } : {}),
    status: row.status,
    ...(row.progress !== null ? { progress: row.progress } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ClipRecord;
}

function mapCaptionPreset(row: CaptionPresetRow): CaptionPreset {
  const config = parseJson<
    Omit<
      CaptionPreset,
      "_id" | "name" | "isDefault" | "createdAt" | "updatedAt"
    >
  >(row.config_json, "caption preset config");
  return {
    ...config,
    _id: row.id,
    name: row.name,
    ...(row.is_default !== null ? { isDefault: row.is_default === 1 } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
  };
}

function mapOverlayStylePreset(row: OverlayStylePresetRow): OverlayStylePreset {
  const config = parseJson<
    Omit<
      OverlayStylePreset,
      "_id" | "kind" | "name" | "isDefault" | "createdAt" | "updatedAt"
    >
  >(row.config_json, "overlay style preset config");
  return {
    ...config,
    _id: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.is_default !== null ? { isDefault: row.is_default === 1 } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
  };
}

function mapTextPreset(row: TextPresetRow): TextPreset {
  return {
    _id: row.id,
    kind: row.kind,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  const config = parseJson<
    Omit<PromptTemplate, "_id" | "type" | "name" | "updatedAt">
  >(row.config_json, "prompt template config");
  return {
    ...config,
    _id: row.id,
    type: row.type,
    name: row.name,
    updatedAt: row.updated_at,
  };
}

function serializeClipRecord(clip: ClipRecord): string {
  const record = { ...clip } as Partial<ClipRecord>;
  delete record._id;
  delete record.videoId;
  delete record.start;
  delete record.end;
  delete record.outputPath;
  delete record.status;
  delete record.progress;
  delete record.createdAt;
  delete record.updatedAt;
  return serializeJson(record);
}

function removeJobsForRecord(
  db: SqliteDatabase,
  filter: "clip_id" | "video_id",
  id: string,
): void {
  // filter is selected from a closed union, never supplied by request data.
  db.prepare(`DELETE FROM jobs WHERE ${filter} = ?`).run(id);
}

export async function listOverlayStylePresets(
  kind?: "hook" | "cta",
): Promise<OverlayStylePreset[]> {
  const db = getDatabase();
  const rows = kind
    ? db
        .prepare(
          "SELECT * FROM overlay_style_presets WHERE kind = ? ORDER BY kind, name",
        )
        .all(kind)
    : db
        .prepare("SELECT * FROM overlay_style_presets ORDER BY kind, name")
        .all();
  return (rows as OverlayStylePresetRow[]).map(mapOverlayStylePreset);
}

export async function getOverlayStylePreset(
  id: string,
): Promise<OverlayStylePreset | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM overlay_style_presets WHERE id = ?")
    .get(id) as OverlayStylePresetRow | undefined;
  return row ? mapOverlayStylePreset(row) : null;
}

export async function saveOverlayStylePreset(
  preset: OverlayStylePreset,
): Promise<OverlayStylePreset> {
  const db = getDatabase();
  if (!preset._id)
    preset._id = `overlay-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  preset.updatedAt = new Date().toISOString();
  if (!preset.createdAt) preset.createdAt = preset.updatedAt;
  const { _id, kind, name, isDefault, createdAt, updatedAt, ...config } =
    preset;

  db.prepare(
    `
    INSERT INTO overlay_style_presets
      (id, kind, name, is_default, created_at, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, is_default = excluded.is_default,
      created_at = COALESCE(overlay_style_presets.created_at, excluded.created_at),
      updated_at = excluded.updated_at, config_json = excluded.config_json
  `,
  ).run(
    _id,
    kind,
    name,
    isDefault === undefined ? null : Number(isDefault),
    createdAt,
    updatedAt,
    serializeJson(config),
  );

  return preset;
}

export async function deleteOverlayStylePreset(id: string): Promise<boolean> {
  const preset = await getOverlayStylePreset(id);
  if (!preset) return false;
  if (preset.isDefault) {
    throw new AppError("Default overlay style presets cannot be deleted.", {
      status: 400,
      resolution:
        "Create a custom style preset if you need a variation instead of deleting the built-in presets.",
    });
  }
  getDatabase()
    .prepare("DELETE FROM overlay_style_presets WHERE id = ?")
    .run(id);
  return true;
}

/** Restore the shipped overlay style presets (hook + CTA). Custom presets are kept. */
export async function resetOverlayStylePresets(): Promise<
  OverlayStylePreset[]
> {
  const now = new Date().toISOString();
  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO overlay_style_presets
      (id, kind, name, is_default, created_at, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, is_default = excluded.is_default,
      updated_at = excluded.updated_at, config_json = excluded.config_json
  `);

  db.transaction(() => {
    for (const preset of DEFAULT_OVERLAY_STYLE_PRESETS) {
      const { _id, kind, name, isDefault, createdAt, ...config } = preset;
      upsert.run(
        _id,
        kind,
        name,
        isDefault === undefined ? null : Number(isDefault),
        createdAt ?? now,
        now,
        serializeJson(config),
      );
    }
  })();

  return DEFAULT_OVERLAY_STYLE_PRESETS.map((preset) => ({
    ...preset,
    updatedAt: now,
  }));
}

export async function saveVideo(video: VideoRecord): Promise<VideoRecord> {
  const db = getDatabase();
  if (!video._id) video._id = randomUUID();
  video.updatedAt = new Date().toISOString();
  if (!video.createdAt) video.createdAt = video.updatedAt;

  db.prepare(
    `
    INSERT INTO videos (
      id, original_name, file_name, file_base, file_path, duration, width, height,
      file_size, status, transcript_json, transcription_provider, transcription_model,
      error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      original_name = excluded.original_name,
      file_name = excluded.file_name,
      file_base = excluded.file_base,
      file_path = excluded.file_path,
      duration = excluded.duration,
      width = excluded.width,
      height = excluded.height,
      file_size = excluded.file_size,
      status = excluded.status,
      transcript_json = COALESCE(excluded.transcript_json, videos.transcript_json),
      transcription_provider = excluded.transcription_provider,
      transcription_model = excluded.transcription_model,
      error = excluded.error,
      created_at = videos.created_at,
      updated_at = excluded.updated_at
  `,
  ).run(
    video._id,
    video.originalName,
    video.fileName,
    video.fileBase ?? null,
    video.filePath,
    video.duration,
    video.width,
    video.height,
    video.fileSize,
    video.status,
    video.transcript ? serializeJson(video.transcript) : null,
    video.transcriptionProvider ?? null,
    video.transcriptionModel ?? null,
    video.error ?? null,
    video.createdAt,
    video.updatedAt,
  );

  return video;
}

/** Synchronous update helper for composing an atomic queue + video transaction. */
export function updateVideoRecordSync(
  db: SqliteDatabase,
  video: VideoRecord,
): boolean {
  video.updatedAt = new Date().toISOString();
  const result = db
    .prepare(
      `
    UPDATE videos SET
      original_name = ?, file_name = ?, file_base = ?, file_path = ?, duration = ?,
      width = ?, height = ?, file_size = ?, status = ?,
      transcript_json = COALESCE(?, transcript_json),
      transcription_provider = ?, transcription_model = ?, error = ?, updated_at = ?
    WHERE id = ?
  `,
    )
    .run(
      video.originalName,
      video.fileName,
      video.fileBase ?? null,
      video.filePath,
      video.duration,
      video.width,
      video.height,
      video.fileSize,
      video.status,
      video.transcript ? serializeJson(video.transcript) : null,
      video.transcriptionProvider ?? null,
      video.transcriptionModel ?? null,
      video.error ?? null,
      video.updatedAt,
      video._id,
    );
  return result.changes > 0;
}

/** Update-only variant for worker code; it must not resurrect a deleted video. */
export async function updateVideo(video: VideoRecord): Promise<boolean> {
  return updateVideoRecordSync(getDatabase(), video);
}

export async function getVideo(id: string): Promise<VideoRecord | null> {
  const row = getDatabase()
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE id = ?`)
    .get(id) as VideoRow | undefined;
  return row ? mapVideo(row) : null;
}

export async function listVideos(): Promise<VideoRecord[]> {
  const rows = getDatabase()
    .prepare(
      `
    SELECT ${VIDEO_COLUMNS} FROM videos ORDER BY created_at DESC
  `,
    )
    .all() as VideoRow[];
  return rows.map(mapVideo);
}

export async function deleteVideo(id: string): Promise<boolean> {
  const db = getDatabase();
  db.transaction(() => {
    removeJobsForRecord(db, "video_id", id);
    db.prepare("DELETE FROM videos WHERE id = ?").run(id);
  })();
  return true;
}

export async function saveClip(clip: ClipRecord): Promise<ClipRecord> {
  const db = getDatabase();
  if (!clip._id) clip._id = randomUUID();
  clip.updatedAt = new Date().toISOString();
  if (!clip.createdAt) clip.createdAt = clip.updatedAt;

  db.prepare(
    `
    INSERT INTO clips (${CLIP_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      video_id = excluded.video_id,
      start = excluded.start,
      end = excluded.end,
      output_path = excluded.output_path,
      status = excluded.status,
      progress = excluded.progress,
      record_json = excluded.record_json,
      created_at = clips.created_at,
      updated_at = excluded.updated_at
  `,
  ).run(
    clip._id,
    clip.videoId,
    clip.start,
    clip.end,
    clip.outputPath ?? null,
    clip.status,
    clip.progress ?? null,
    serializeClipRecord(clip),
    clip.createdAt,
    clip.updatedAt,
  );

  return clip;
}

/** Synchronous update helper for composing an atomic queue + clip transaction. */
export function updateClipRecordSync(
  db: SqliteDatabase,
  clip: ClipRecord,
): boolean {
  clip.updatedAt = new Date().toISOString();
  const result = db
    .prepare(
      `
    UPDATE clips SET
      video_id = ?, start = ?, end = ?, output_path = ?, status = ?, progress = ?,
      record_json = ?, updated_at = ?
    WHERE id = ?
  `,
    )
    .run(
      clip.videoId,
      clip.start,
      clip.end,
      clip.outputPath ?? null,
      clip.status,
      clip.progress ?? null,
      serializeClipRecord(clip),
      clip.updatedAt,
      clip._id,
    );
  return result.changes > 0;
}

/** Update-only variant for worker code; it must not resurrect a deleted clip. */
export async function updateClip(clip: ClipRecord): Promise<boolean> {
  return updateClipRecordSync(getDatabase(), clip);
}

export async function getClip(id: string): Promise<ClipRecord | null> {
  const row = getDatabase()
    .prepare(`SELECT ${CLIP_COLUMNS} FROM clips WHERE id = ?`)
    .get(id) as ClipRow | undefined;
  return row ? mapClip(row) : null;
}

export async function listClips(videoId?: string): Promise<ClipRecord[]> {
  const rows = videoId
    ? getDatabase()
        .prepare(
          `SELECT ${CLIP_COLUMNS} FROM clips WHERE video_id = ? ORDER BY created_at DESC`,
        )
        .all(videoId)
    : getDatabase()
        .prepare(`SELECT ${CLIP_COLUMNS} FROM clips ORDER BY created_at DESC`)
        .all();
  return (rows as ClipRow[]).map(mapClip);
}

export async function deleteClip(id: string): Promise<boolean> {
  const db = getDatabase();
  db.transaction(() => {
    removeJobsForRecord(db, "clip_id", id);
    db.prepare("DELETE FROM clips WHERE id = ?").run(id);
  })();
  return true;
}

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM prompt_templates ORDER BY rowid")
    .all() as PromptTemplateRow[];
  return rows.map(mapPromptTemplate);
}

export async function getPromptTemplate(
  typeOrId: string,
): Promise<PromptTemplate | null> {
  const row = getDatabase()
    .prepare(
      `
    SELECT * FROM prompt_templates
    WHERE id = ? OR type = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, rowid
    LIMIT 1
  `,
    )
    .get(typeOrId, typeOrId, typeOrId) as PromptTemplateRow | undefined;
  return row ? mapPromptTemplate(row) : null;
}

export async function savePromptTemplate(
  template: PromptTemplate,
): Promise<PromptTemplate> {
  const db = getDatabase();
  template.updatedAt = new Date().toISOString();
  const { _id, type, name, updatedAt, ...config } = template;

  db.prepare(
    `
    INSERT INTO prompt_templates (id, type, name, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, name = excluded.name, updated_at = excluded.updated_at,
      config_json = excluded.config_json
  `,
  ).run(_id, type, name, updatedAt, serializeJson(config));

  return template;
}

/** Restore built-ins; edits to unrelated/custom template rows are preserved. */
export async function resetPromptTemplates(): Promise<PromptTemplate[]> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO prompt_templates (id, type, name, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, name = excluded.name, updated_at = excluded.updated_at,
      config_json = excluded.config_json
  `);

  db.transaction(() => {
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      const { _id, type, name, ...config } = template;
      upsert.run(_id, type, name, now, serializeJson(config));
    }
  })();

  return DEFAULT_PROMPT_TEMPLATES.map((template) => ({
    ...template,
    updatedAt: now,
  }));
}

export async function listCaptionPresets(): Promise<CaptionPreset[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM caption_presets ORDER BY rowid")
    .all() as CaptionPresetRow[];
  return rows.map(mapCaptionPreset);
}

export async function getCaptionPreset(
  id: string,
): Promise<CaptionPreset | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM caption_presets WHERE id = ?")
    .get(id) as CaptionPresetRow | undefined;
  return row ? mapCaptionPreset(row) : null;
}

export async function saveCaptionPreset(
  preset: CaptionPreset,
): Promise<CaptionPreset> {
  const db = getDatabase();
  const now = new Date().toISOString();
  preset.updatedAt = now;
  if (!preset.createdAt) preset.createdAt = now;
  const { _id, name, isDefault, createdAt, updatedAt, ...config } = preset;

  db.prepare(
    `
    INSERT INTO caption_presets (id, name, is_default, created_at, updated_at, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, is_default = excluded.is_default,
      created_at = COALESCE(caption_presets.created_at, excluded.created_at),
      updated_at = excluded.updated_at, config_json = excluded.config_json
  `,
  ).run(
    _id,
    name,
    isDefault === undefined ? null : Number(isDefault),
    createdAt,
    updatedAt,
    serializeJson(config),
  );

  return preset;
}

export async function deleteCaptionPreset(id: string): Promise<boolean> {
  const existing = await getCaptionPreset(id);
  if (existing?.isDefault) {
    throw new AppError("Default caption presets cannot be deleted.", {
      status: 400,
      resolution:
        "Create a custom preset if you need a variation instead of deleting the built-in presets.",
    });
  }
  getDatabase().prepare("DELETE FROM caption_presets WHERE id = ?").run(id);
  return true;
}

export async function listTextPresets(
  kind?: TextPreset["kind"],
): Promise<TextPreset[]> {
  const rows = kind
    ? getDatabase()
        .prepare("SELECT * FROM text_presets WHERE kind = ? ORDER BY rowid")
        .all(kind)
    : getDatabase().prepare("SELECT * FROM text_presets ORDER BY rowid").all();
  return (rows as TextPresetRow[]).map(mapTextPreset);
}

export async function getTextPreset(id: string): Promise<TextPreset | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM text_presets WHERE id = ?")
    .get(id) as TextPresetRow | undefined;
  return row ? mapTextPreset(row) : null;
}

export async function saveTextPreset(preset: TextPreset): Promise<TextPreset> {
  const db = getDatabase();
  const now = new Date().toISOString();
  preset.updatedAt = now;
  if (!preset.createdAt) preset.createdAt = now;

  db.prepare(
    `
    INSERT INTO text_presets (id, kind, text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, text = excluded.text,
      created_at = text_presets.created_at, updated_at = excluded.updated_at
  `,
  ).run(
    preset._id,
    preset.kind,
    preset.text,
    preset.createdAt,
    preset.updatedAt,
  );

  return preset;
}

export async function deleteTextPreset(id: string): Promise<boolean> {
  getDatabase().prepare("DELETE FROM text_presets WHERE id = ?").run(id);
  return true;
}
