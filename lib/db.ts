import { Db, MongoClient } from 'mongodb';
import { CaptionPreset, ClipRecord, PromptTemplate, VideoRecord } from './types';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_PROMPT_TEMPLATES } from './presets';
import { AppError, ensureEnvVar, toErrorMessage } from './errors';

const DB_NAME = 'clipcraft';

let dbPromise: Promise<Db> | null = null;
let seedsInitialized = false;

async function initializeSeeds(database: Db) {
  if (seedsInitialized) return;

  const promptTemplates = database.collection<PromptTemplate>('promptTemplates');
  const captionPresets = database.collection<CaptionPreset>('captionPresets');

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
      console.log('[DB] Connected to MongoDB at:', mongoUri);
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

export async function saveVideo(video: VideoRecord): Promise<VideoRecord> {
  const mongodb = await getDb();
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
