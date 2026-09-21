import { MongoClient, Db } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { VideoRecord, ClipRecord, PromptTemplate, CaptionPreset } from './types';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_PROMPT_TEMPLATES } from './presets';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clipcraft';
const DATA_DIR = path.join(process.cwd(), '.data');
const FILE_DB_PATH = path.join(DATA_DIR, 'db.json');

let client: MongoClient | null = null;
let db: Db | null = null;
let useFileFallback = false;

interface MemoryDB {
  videos: Record<string, VideoRecord>;
  clips: Record<string, ClipRecord>;
  promptTemplates: Record<string, PromptTemplate>;
  captionPresets: Record<string, CaptionPreset>;
}

function loadFileDB(): MemoryDB {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(FILE_DB_PATH)) {
      const data = fs.readFileSync(FILE_DB_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('[DB] File fallback load error:', err);
  }

  const initial: MemoryDB = {
    videos: {},
    clips: {},
    promptTemplates: {},
    captionPresets: {},
  };

  DEFAULT_PROMPT_TEMPLATES.forEach((pt) => {
    initial.promptTemplates[pt._id] = pt;
    initial.promptTemplates[pt.type] = pt;
  });

  DEFAULT_CAPTION_PRESETS.forEach((cp) => {
    initial.captionPresets[cp._id] = cp;
  });

  saveFileDB(initial);
  return initial;
}

function saveFileDB(dbData: MemoryDB) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(FILE_DB_PATH, JSON.stringify(dbData, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Failed to save file DB fallback:', err);
  }
}

export async function getDb(): Promise<Db | null> {
  if (useFileFallback) return null;
  if (db) return db;

  try {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    db = client.db('clipcraft');
    console.log('[DB] Connected to MongoDB at:', MONGODB_URI);

    // Ensure initial seeds in MongoDB if empty
    const ptCol = db.collection<PromptTemplate>('promptTemplates');
    const cpCol = db.collection<CaptionPreset>('captionPresets');

    const ptCount = await ptCol.countDocuments();
    if (ptCount === 0) {
      await ptCol.insertMany(DEFAULT_PROMPT_TEMPLATES as any);
    }

    const cpCount = await cpCol.countDocuments();
    if (cpCount === 0) {
      await cpCol.insertMany(DEFAULT_CAPTION_PRESETS as any);
    }

    return db;
  } catch (err) {
    console.warn('[DB] Could not connect to MongoDB. Using local file storage fallback (.data/db.json)');
    useFileFallback = true;
    return null;
  }
}

// --- Videos API ---

export async function saveVideo(video: VideoRecord): Promise<VideoRecord> {
  const mongodb = await getDb();
  video.updatedAt = new Date().toISOString();
  if (!video.createdAt) video.createdAt = video.updatedAt;

  if (mongodb) {
    await mongodb.collection('videos').updateOne(
      { _id: video._id as any },
      { $set: video },
      { upsert: true }
    );
  } else {
    const mem = loadFileDB();
    mem.videos[video._id] = video;
    saveFileDB(mem);
  }
  return video;
}

export async function getVideo(id: string): Promise<VideoRecord | null> {
  const mongodb = await getDb();
  if (mongodb) {
    return (await mongodb.collection('videos').findOne({ _id: id as any })) as unknown as VideoRecord | null;
  } else {
    const mem = loadFileDB();
    return mem.videos[id] || null;
  }
}

export async function listVideos(): Promise<VideoRecord[]> {
  const mongodb = await getDb();
  if (mongodb) {
    return (await mongodb
      .collection('videos')
      .find()
      .sort({ createdAt: -1 })
      .toArray()) as unknown as VideoRecord[];
  } else {
    const mem = loadFileDB();
    return Object.values(mem.videos).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}

export async function deleteVideo(id: string): Promise<boolean> {
  const mongodb = await getDb();
  if (mongodb) {
    await mongodb.collection('videos').deleteOne({ _id: id as any });
    await mongodb.collection('clips').deleteMany({ videoId: id });
  } else {
    const mem = loadFileDB();
    delete mem.videos[id];
    Object.keys(mem.clips).forEach((clipId) => {
      if (mem.clips[clipId].videoId === id) {
        delete mem.clips[clipId];
      }
    });
    saveFileDB(mem);
  }
  return true;
}

// --- Clips API ---

export async function saveClip(clip: ClipRecord): Promise<ClipRecord> {
  const mongodb = await getDb();
  clip.updatedAt = new Date().toISOString();
  if (!clip.createdAt) clip.createdAt = clip.updatedAt;

  if (mongodb) {
    await mongodb.collection('clips').updateOne(
      { _id: clip._id as any },
      { $set: clip },
      { upsert: true }
    );
  } else {
    const mem = loadFileDB();
    mem.clips[clip._id] = clip;
    saveFileDB(mem);
  }
  return clip;
}

export async function getClip(id: string): Promise<ClipRecord | null> {
  const mongodb = await getDb();
  if (mongodb) {
    return (await mongodb.collection('clips').findOne({ _id: id as any })) as unknown as ClipRecord | null;
  } else {
    const mem = loadFileDB();
    return mem.clips[id] || null;
  }
}

export async function listClips(videoId?: string): Promise<ClipRecord[]> {
  const mongodb = await getDb();
  if (mongodb) {
    const query = videoId ? { videoId } : {};
    return (await mongodb
      .collection('clips')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray()) as unknown as ClipRecord[];
  } else {
    const mem = loadFileDB();
    let clips = Object.values(mem.clips);
    if (videoId) {
      clips = clips.filter((c) => c.videoId === videoId);
    }
    return clips.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}

export async function deleteClip(id: string): Promise<boolean> {
  const mongodb = await getDb();
  if (mongodb) {
    await mongodb.collection('clips').deleteOne({ _id: id as any });
  } else {
    const mem = loadFileDB();
    delete mem.clips[id];
    saveFileDB(mem);
  }
  return true;
}

// --- Prompt Templates API ---

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  const mongodb = await getDb();
  if (mongodb) {
    return (await mongodb
      .collection('promptTemplates')
      .find()
      .toArray()) as unknown as PromptTemplate[];
  } else {
    const mem = loadFileDB();
    return Object.values(mem.promptTemplates);
  }
}

export async function getPromptTemplate(typeOrId: string): Promise<PromptTemplate | null> {
  const mongodb = await getDb();
  if (mongodb) {
    return (await mongodb
      .collection('promptTemplates')
      .findOne({ $or: [{ _id: typeOrId as any }, { type: typeOrId }] })) as unknown as PromptTemplate | null;
  } else {
    const mem = loadFileDB();
    return (
      mem.promptTemplates[typeOrId] ||
      Object.values(mem.promptTemplates).find((pt) => pt.type === typeOrId) ||
      DEFAULT_PROMPT_TEMPLATES.find((pt) => pt.type === typeOrId || pt._id === typeOrId) ||
      null
    );
  }
}

export async function savePromptTemplate(template: PromptTemplate): Promise<PromptTemplate> {
  const mongodb = await getDb();
  template.updatedAt = new Date().toISOString();

  if (mongodb) {
    await mongodb.collection('promptTemplates').updateOne(
      { _id: template._id as any },
      { $set: template },
      { upsert: true }
    );
  } else {
    const mem = loadFileDB();
    mem.promptTemplates[template._id] = template;
    mem.promptTemplates[template.type] = template;
    saveFileDB(mem);
  }
  return template;
}

// --- Caption Presets API ---

export async function listCaptionPresets(): Promise<CaptionPreset[]> {
  const mongodb = await getDb();
  if (mongodb) {
    const presets = (await mongodb
      .collection('captionPresets')
      .find()
      .toArray()) as unknown as CaptionPreset[];
    if (presets.length > 0) return presets;
  }
  
  const mem = loadFileDB();
  const presets = Object.values(mem.captionPresets);
  if (presets.length > 0) return presets;
  return DEFAULT_CAPTION_PRESETS;
}

export async function getCaptionPreset(id: string): Promise<CaptionPreset | null> {
  const mongodb = await getDb();
  if (mongodb) {
    const preset = await mongodb.collection('captionPresets').findOne({ _id: id as any });
    if (preset) return preset as unknown as CaptionPreset;
  }
  
  const mem = loadFileDB();
  if (mem.captionPresets[id]) return mem.captionPresets[id];
  return DEFAULT_CAPTION_PRESETS.find((cp) => cp._id === id) || DEFAULT_CAPTION_PRESETS[0];
}

export async function saveCaptionPreset(preset: CaptionPreset): Promise<CaptionPreset> {
  const mongodb = await getDb();
  preset.updatedAt = new Date().toISOString();

  if (mongodb) {
    await mongodb.collection('captionPresets').updateOne(
      { _id: preset._id as any },
      { $set: preset },
      { upsert: true }
    );
  } else {
    const mem = loadFileDB();
    mem.captionPresets[preset._id] = preset;
    saveFileDB(mem);
  }
  return preset;
}

export async function deleteCaptionPreset(id: string): Promise<boolean> {
  const mongodb = await getDb();
  if (mongodb) {
    await mongodb.collection('captionPresets').deleteOne({ _id: id as any });
  } else {
    const mem = loadFileDB();
    delete mem.captionPresets[id];
    saveFileDB(mem);
  }
  return true;
}
