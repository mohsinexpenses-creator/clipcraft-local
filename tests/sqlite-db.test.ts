import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteCaptionPreset,
  deleteClip,
  deleteOverlayStylePreset,
  deleteTextPreset,
  deleteVideo,
  getCaptionPreset,
  getClip,
  getOverlayStylePreset,
  getPromptTemplate,
  getTextPreset,
  getVideo,
  listCaptionPresets,
  listClips,
  listOverlayStylePresets,
  listPromptTemplates,
  listTextPresets,
  listVideos,
  saveCaptionPreset,
  saveClip,
  saveOverlayStylePreset,
  savePromptTemplate,
  saveTextPreset,
  saveVideo,
} from '../lib/db';
import type { CaptionPreset, ClipRecord, OverlayStylePreset, PromptTemplate, TextPreset, VideoRecord } from '../lib/types';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { validClip } from './viral-fixtures';

function makeVideo(id: string): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: `${id}.mp4`,
    fileName: `${id}.mp4`,
    fileBase: id,
    filePath: `/uploads/${id}.mp4`,
    duration: 120,
    width: 1920,
    height: 1080,
    fileSize: 1024,
    status: 'uploaded',
    createdAt: now,
    updatedAt: now,
  };
}

function makeClip(id: string, videoId: string): ClipRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    videoId,
    start: 10,
    end: 70,
    hookDuration: 3,
    hookText: 'Watch this moment',
    filterPreset: 'none',
    captionPresetId: 'preset-bold-yellow',
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test('SQLite schema is versioned, indexed, WAL-enabled, and has a five-second busy timeout', (t) => {
  const { db } = createTemporaryDatabase(t);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  const version = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { version: number }
    | undefined;
  assert.deepEqual(version, { version: 1 });

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  for (const table of [
    'videos',
    'clips',
    'caption_presets',
    'overlay_style_presets',
    'text_presets',
    'prompt_templates',
    'jobs',
  ]) {
    assert.ok(tables.has(table), `missing table ${table}`);
  }

  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  for (const index of ['videos_created_at_idx', 'clips_video_created_at_idx', 'jobs_claim_idx']) {
    assert.ok(indexes.has(index), `missing index ${index}`);
  }
});

test('video and clip CRUD preserves public _id records and cascades clip deletion', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-crud');
  await saveVideo(video);
  assert.deepEqual(await getVideo(video._id), video);
  assert.deepEqual((await listVideos()).map((item) => item._id), [video._id]);

  const clip = makeClip('clip-crud', video._id);
  await saveClip(clip);
  assert.deepEqual(await getClip(clip._id), clip);
  assert.deepEqual((await listClips(video._id)).map((item) => item._id), [clip._id]);

  assert.equal(await deleteClip(clip._id), true);
  assert.equal(await getClip(clip._id), null);
  assert.ok(await getVideo(video._id));

  const secondClip = makeClip('clip-video-delete', video._id);
  await saveClip(secondClip);
  assert.equal(await deleteVideo(video._id), true);
  assert.equal(await getVideo(video._id), null);
  assert.equal(await getClip(secondClip._id), null);
});

test('large transcript and clip JSON values round-trip without truncation', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-large-json');
  const repeatedText = 'A precise word-level transcript stays intact. '.repeat(2500);
  const words = Array.from({ length: 2500 }, (_, index) => ({
    word: `word-${index}`,
    start: index * 0.1,
    end: index * 0.1 + 0.08,
    confidence: 0.99,
  }));
  video.transcript = {
    text: repeatedText,
    segments: [{ id: 0, start: 0, end: 250, text: repeatedText, words }],
    words,
  };
  await saveVideo(video);
  assert.deepEqual((await getVideo(video._id))?.transcript, video.transcript);

  const clip = makeClip('clip-large-json', video._id);
  clip.hookText = 'Detailed analysis. '.repeat(5000);
  const analysis = validClip();
  analysis.why_this_will_go_viral = 'Detailed analysis. '.repeat(5000);
  analysis.viral_packaging.hashtags = Array.from({ length: 1500 }, (_, index) => `tag-${index}`);
  clip.aiAnalysis = analysis;
  await saveClip(clip);
  assert.deepEqual(await getClip(clip._id), clip);

});

test('seeded presets and prompt templates stay editable through typed CRUD helpers', async (t) => {
  createTemporaryDatabase(t);
  const captions = await listCaptionPresets();
  const overlays = await listOverlayStylePresets();
  const texts = await listTextPresets();
  const prompts = await listPromptTemplates();
  assert.ok(captions.length > 0);
  assert.ok(overlays.length > 0);
  assert.ok(texts.length > 0);
  assert.ok(prompts.length > 0);
  assert.equal((await getPromptTemplate('viral_detection'))?._id, 'prompt-viral-detection');

  const caption: CaptionPreset = { ...captions[0], _id: 'custom-caption', name: 'Custom caption', isDefault: false };
  await saveCaptionPreset(caption);
  assert.equal((await getCaptionPreset(caption._id))?.name, caption.name);
  assert.equal(await deleteCaptionPreset(caption._id), true);
  await assert.rejects(() => deleteCaptionPreset(captions.find((preset) => preset.isDefault)!._id));

  const overlay: OverlayStylePreset = {
    ...overlays[0],
    _id: 'custom-overlay',
    name: 'Custom overlay',
    isDefault: false,
  };
  await saveOverlayStylePreset(overlay);
  assert.equal((await getOverlayStylePreset(overlay._id))?.name, overlay.name);
  assert.equal(await deleteOverlayStylePreset(overlay._id), true);

  const text: TextPreset = {
    _id: 'custom-text',
    kind: 'hook',
    text: 'A custom hook',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveTextPreset(text);
  assert.equal((await getTextPreset(text._id))?.text, text.text);
  assert.ok((await listTextPresets('hook')).some((preset) => preset._id === text._id));
  assert.equal(await deleteTextPreset(text._id), true);

  const prompt: PromptTemplate = {
    ...prompts[0],
    _id: 'custom-prompt',
    name: 'Custom prompt',
    updatedAt: new Date().toISOString(),
  };
  await savePromptTemplate(prompt);
  assert.equal((await getPromptTemplate(prompt._id))?.name, prompt.name);
});
