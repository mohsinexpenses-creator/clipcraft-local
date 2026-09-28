import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { CaptionPreset, ClipRecord, PromptTemplate, TextPreset, VideoRecord, OverlayStylePreset } from './types';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_PROMPT_TEMPLATES, DEFAULT_TEXT_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from './presets';
import { AppError, ensureEnvVar, toErrorMessage } from './errors';
import { log } from './logger';

const DB_NAME = 'clipcraft';

let dbPromise: Promise<Db> | null = null;
let seedsInitialized = false;

async function initializeSeeds(database: Db) {
  if (seedsInitialized) return;

  const promptTemplates = database.collection<PromptTemplate>('promptTemplates');
  const captionPresets = database.collection<CaptionPreset>('captionPresets');
  const textPresets = database.collection<TextPreset>('textPresets');
  const overlayStylePresets = database.collection<OverlayStylePreset>('overlayStylePresets');

  await Promise.all([
    ...DEFAULT_PROMPT_TEMPLATES.map((template) =>
      promptTemplates.updateOne(
        { _id: template._id },
        { $setOnInsert: template },
        { upsert: true }
      )
    ),
    ...DEFAULT_CAPTION_PRESETS.map((preset) =>
      captionPresets.updateOne(
        { _id: preset._id },
        { $setOnInsert: preset },
        { upsert: true }
      )
    ),
    ...DEFAULT_TEXT_PRESETS.map((preset) =>
      textPresets.updateOne(
        { _id: preset._id },
        { $setOnInsert: preset },
        { upsert: true }
      )
    ),
    ...DEFAULT_OVERLAY_STYLE_PRESETS.map((preset) =>
      overlayStylePresets.updateOne(
        { _id: preset._id },
        { $setOnInsert: preset },
        { upsert: true }
      )
    ),
  ]);

  seedsInitialized = true;
}

export async function getDb(): Promise<Db> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = (async () => {
    const mongoUri = ensureEnvVar(
      'MONGODB_URI',
      'store videos, clips, prompt templates, and caption presets'
    );

    try {
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const database = client.db(DB_NAME);
      await initializeSeeds(database);
      log.ok(`Connected to MongoDB at ${mongoUri}`);
      return database;
    } catch (error) {
      dbPromise = null;
      throw new AppError('MongoDB connection failed.', {
        status: 500,
        details: toErrorMessage(error),
        resolution:
          'Start MongoDB locally or point MONGODB_URI to a reachable MongoDB instance, then retry the request.',
      });
    }
  })();

  return dbPromise;
}



export async function listOverlayStylePresets(kind?: 'hook' | 'cta'): Promise<OverlayStylePreset[]> {
  const mongodb = await getDb();
  const query = kind ? { kind } : {};
  return (await mongodb
    .collection<OverlayStylePreset>('overlayStylePresets')
    .find(query)
    .sort({ kind: 1, name: 1 })
    .toArray()) as OverlayStylePreset[];
}

export async function getOverlayStylePreset(id: string): Promise<OverlayStylePreset | null> {
  const mongodb = await getDb();
  return (await mongodb
    .collection<OverlayStylePreset>('overlayStylePresets')
    .findOne({ _id: id })) as OverlayStylePreset | null;
}

export async function saveOverlayStylePreset(preset: OverlayStylePreset): Promise<OverlayStylePreset> {
  const mongodb = await getDb();
  if (!preset._id) preset._id = `overlay-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  preset.updatedAt = new Date().toISOString();
  if (!preset.createdAt) preset.createdAt = preset.updatedAt;

  await mongodb.collection<OverlayStylePreset>('overlayStylePresets').updateOne(
    { _id: preset._id },
    { $set: preset },
    { upsert: true }
  );

  return preset;
}

export async function deleteOverlayStylePreset(id: string): Promise<boolean> {
  const mongodb = await getDb();
  const existing = await getOverlayStylePreset(id);
  if (!existing) return false;

  if (existing.isDefault) {
    throw new AppError('Default overlay style presets cannot be deleted.', {
      status: 400,
      resolution: 'Create a custom style preset if you need a variation instead of deleting the built-in presets.',
    });
  }

  await mongodb.collection<OverlayStylePreset>('overlayStylePresets').deleteOne({ _id: id });
  return true;
}

/** Restore the shipped overlay style presets (hook + CTA). Custom presets are kept. */
export async function resetOverlayStylePresets(): Promise<OverlayStylePreset[]> {
  const mongodb = await getDb();
  const collection = mongodb.collection<OverlayStylePreset>('overlayStylePresets');

  await Promise.all(
    DEFAULT_OVERLAY_STYLE_PRESETS.map((preset) => {
      const { _id, ...rest } = preset;
      return collection.updateOne(
        { _id },
        { $set: { ...rest, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    })
  );

  return DEFAULT_OVERLAY_STYLE_PRESETS.map((preset) => ({
    ...preset,
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveVideo(video: VideoRecord): Promise<VideoRecord> {
  const mongodb = await getDb();

  /**
   * New records arrive without an _id. The old code upserted on `{ _id: undefined }`,
   * which MongoDB treats as `_id: null` - so the SECOND upload ever made would
   * overwrite the first video's document, and `video._id` stayed undefined for the
   * caller (which then crashed on `video._id.toString()`).
   */
  if (!video._id) video._id = randomUUID();

  video.updatedAt = new Date().toISOString();
  if (!video.createdAt) video.createdAt = video.updatedAt;

  await mongodb.collection<VideoRecord>('videos').updateOne(
    { _id: video._id },
    { $set: video },
    { upsert: true }
  );

  return video;
}

export async function getVideo(id: string): Promise<VideoRecord | null> {
  const mongodb = await getDb();
  return (await mongodb.collection<VideoRecord>('videos').findOne({ _id: id })) as VideoRecord | null;
}

export async function listVideos(): Promise<VideoRecord[]> {
  const mongodb = await getDb();
  return (await mongodb
    .collection<VideoRecord>('videos')
    .find()
    .sort({ createdAt: -1 })
    .toArray()) as VideoRecord[];
}

export async function deleteVideo(id: string): Promise<boolean> {
  const mongodb = await getDb();
  await mongodb.collection<VideoRecord>('videos').deleteOne({ _id: id });
  await mongodb.collection<ClipRecord>('clips').deleteMany({ videoId: id });
  return true;
}

export async function saveClip(clip: ClipRecord): Promise<ClipRecord> {
  const mongodb = await getDb();
  // Same guard as saveVideo: never upsert on an undefined _id.
  if (!clip._id) clip._id = randomUUID();
  clip.updatedAt = new Date().toISOString();
  if (!clip.createdAt) clip.createdAt = clip.updatedAt;

  await mongodb.collection<ClipRecord>('clips').updateOne(
    { _id: clip._id },
    { $set: clip },
    { upsert: true }
  );

  return clip;
}

export async function getClip(id: string): Promise<ClipRecord | null> {
  const mongodb = await getDb();
  return (await mongodb.collection<ClipRecord>('clips').findOne({ _id: id })) as ClipRecord | null;
}

export async function listClips(videoId?: string): Promise<ClipRecord[]> {
  const mongodb = await getDb();
  const query = videoId ? { videoId } : {};
  return (await mongodb
    .collection<ClipRecord>('clips')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray()) as ClipRecord[];
}

export async function deleteClip(id: string): Promise<boolean> {
  const mongodb = await getDb();
  await mongodb.collection<ClipRecord>('clips').deleteOne({ _id: id });
  return true;
}

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  const mongodb = await getDb();
  return (await mongodb.collection<PromptTemplate>('promptTemplates').find().toArray()) as PromptTemplate[];
}

export async function getPromptTemplate(typeOrId: string): Promise<PromptTemplate | null> {
  const mongodb = await getDb();
  return (await mongodb
    .collection<PromptTemplate>('promptTemplates')
    .findOne({ $or: [{ _id: typeOrId }, { type: typeOrId as PromptTemplate['type'] }] })) as PromptTemplate | null;
}

export async function savePromptTemplate(template: PromptTemplate): Promise<PromptTemplate> {
  const mongodb = await getDb();
  template.updatedAt = new Date().toISOString();

  await mongodb.collection<PromptTemplate>('promptTemplates').updateOne(
    { _id: template._id },
    { $set: template },
    { upsert: true }
  );

  return template;
}

/**
 * Overwrite the built-in prompt templates with the shipped defaults.
 *
 * Seeding uses `$setOnInsert` so user edits survive restarts - this function is
 * the explicit "restore the defaults" escape hatch (e.g. to pick up a new
 * built-in viral prompt after an app update). Custom templates with other _ids
 * are untouched. The `_id` stays in the filter only - never in `$set` - so
 * MongoDB's immutable `_id` rule cannot trip.
 */
export async function resetPromptTemplates(): Promise<PromptTemplate[]> {
  const mongodb = await getDb();
  const collection = mongodb.collection<PromptTemplate>('promptTemplates');

  await Promise.all(
    DEFAULT_PROMPT_TEMPLATES.map((template) => {
      const { _id, ...rest } = template;
      return collection.updateOne(
        { _id },
        { $set: { ...rest, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    })
  );

  return DEFAULT_PROMPT_TEMPLATES.map((template) => ({
    ...template,
    updatedAt: new Date().toISOString(),
  }));
}

export async function listCaptionPresets(): Promise<CaptionPreset[]> {
  const mongodb = await getDb();
  return (await mongodb.collection<CaptionPreset>('captionPresets').find().toArray()) as CaptionPreset[];
}

export async function getCaptionPreset(id: string): Promise<CaptionPreset | null> {
  const mongodb = await getDb();
  return (await mongodb.collection<CaptionPreset>('captionPresets').findOne({ _id: id })) as CaptionPreset | null;
}

export async function saveCaptionPreset(preset: CaptionPreset): Promise<CaptionPreset> {
  const mongodb = await getDb();
  preset.updatedAt = new Date().toISOString();

  await mongodb.collection<CaptionPreset>('captionPresets').updateOne(
    { _id: preset._id },
    { $set: preset },
    { upsert: true }
  );

  return preset;
}

export async function deleteCaptionPreset(id: string): Promise<boolean> {
  const mongodb = await getDb();
  const existing = await mongodb.collection<CaptionPreset>('captionPresets').findOne({ _id: id });

  if (existing?.isDefault) {
    throw new AppError('Default caption presets cannot be deleted.', {
      status: 400,
      resolution:
        'Create a custom preset if you need a variation instead of deleting the built-in presets.',
    });
  }

  await mongodb.collection<CaptionPreset>('captionPresets').deleteOne({ _id: id });
  return true;
}

// ---------------------------------------------------------------------------
// Text presets (intro hook / end CTA overlay texts)
// ---------------------------------------------------------------------------

export async function listTextPresets(kind?: TextPreset['kind']): Promise<TextPreset[]> {
  const mongodb = await getDb();
  const query = kind ? { kind } : {};
  return (await mongodb.collection<TextPreset>('textPresets').find(query).toArray()) as TextPreset[];
}

export async function saveTextPreset(preset: TextPreset): Promise<TextPreset> {
  const mongodb = await getDb();
  preset.updatedAt = new Date().toISOString();
  if (!preset.createdAt) preset.createdAt = preset.updatedAt;

  await mongodb.collection<TextPreset>('textPresets').updateOne(
    { _id: preset._id },
    { $set: preset },
    { upsert: true }
  );

  return preset;
}

export async function deleteTextPreset(id: string): Promise<boolean> {
  const mongodb = await getDb();
  await mongodb.collection<TextPreset>('textPresets').deleteOne({ _id: id });
  return true;
}
