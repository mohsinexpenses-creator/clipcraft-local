import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteCaptionPreset,
  deleteOverlayStylePreset,
  getCaptionPreset,
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  getClip,
  saveCaptionPreset,
  saveClip,
  saveOverlayStylePreset,
  saveVideo,
  setDefaultCaptionPreset,
  setDefaultOverlayStylePreset,
  updateClip,
} from '../lib/db';
import type { CaptionPreset, ClipRecord, OverlayStylePreset, VideoRecord } from '../lib/types';
import { createTemporaryDatabase } from './sqlite-test-helpers';

function video(id: string): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: `${id}.mp4`,
    fileName: `${id}.mp4`,
    filePath: `/uploads/${id}.mp4`,
    duration: 90,
    width: 1920,
    height: 1080,
    fileSize: 2048,
    status: 'uploaded',
    createdAt: now,
    updatedAt: now,
  };
}

function clip(id: string, videoId: string): ClipRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    videoId,
    start: 0,
    end: 60,
    hookDuration: 3,
    hookText: 'Hook line',
    filterPreset: 'none',
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test('caption, hook, and CTA defaults switch independently and saving edits never changes default status', async (t) => {
  const { db, openConnection } = createTemporaryDatabase(t);
  const other = openConnection();
  const captionDefault = await getDefaultCaptionPreset(db);
  const hookDefault = await getDefaultOverlayStylePreset('hook', db);
  const ctaDefault = await getDefaultOverlayStylePreset('cta', db);
  assert.ok(captionDefault && hookDefault && ctaDefault);
  if (!captionDefault || !hookDefault || !ctaDefault) throw new Error('Expected seeded defaults.');

  const caption: CaptionPreset = { ...captionDefault, _id: 'custom-caption', name: 'Custom caption', isDefault: false };
  const hook: OverlayStylePreset = { ...hookDefault, _id: 'custom-hook', name: 'Custom hook', isDefault: false };
  const cta: OverlayStylePreset = { ...ctaDefault, _id: 'custom-cta', name: 'Custom CTA', isDefault: false };
  await saveCaptionPreset(caption);
  await saveOverlayStylePreset(hook);
  await saveOverlayStylePreset(cta);

  await setDefaultCaptionPreset(caption._id, db);
  await setDefaultOverlayStylePreset(hook._id, db);
  assert.equal((await getDefaultCaptionPreset(db))?._id, caption._id);
  assert.equal((await getDefaultOverlayStylePreset('hook', db))?._id, hook._id);
  assert.equal((await getDefaultOverlayStylePreset('cta', db))?._id, ctaDefault._id);

  const editedCaption = await saveCaptionPreset({ ...caption, name: 'Edited, still default', isDefault: false });
  const editedHook = await saveOverlayStylePreset({ ...hook, name: 'Edited hook, still default', isDefault: false });
  assert.equal(editedCaption.isDefault, true);
  assert.equal(editedHook.isDefault, true);
  assert.equal((await getDefaultCaptionPreset(db))?._id, caption._id);
  assert.equal((await getDefaultOverlayStylePreset('hook', db))?._id, hook._id);

  // Two independently opened connections can switch the same category; each
  // operation clears then selects inside BEGIN IMMEDIATE, leaving one winner.
  await Promise.all([
    Promise.resolve().then(() => setDefaultCaptionPreset(captionDefault._id, db)),
    Promise.resolve().then(() => setDefaultCaptionPreset(caption._id, other)),
  ]);
  const captionDefaultCount = db.prepare(
    'SELECT COUNT(*) AS count FROM caption_presets WHERE is_default = 1'
  ).get() as { count: number };
  assert.equal(captionDefaultCount.count, 1);
  assert.ok(['custom-caption', captionDefault._id].includes((await getDefaultCaptionPreset(db))?._id ?? ''));

  assert.throws(
    () => db.prepare('UPDATE caption_presets SET is_default = 1 WHERE id = ?').run(captionDefault._id),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.prepare('UPDATE overlay_style_presets SET is_default = 1 WHERE id = ?').run(hookDefault._id),
    /UNIQUE constraint failed/
  );
});

test('new clips snapshot current defaults while existing and manually selected clip IDs remain stable', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const initialCaption = await getDefaultCaptionPreset(db);
  const initialHook = await getDefaultOverlayStylePreset('hook', db);
  const initialCta = await getDefaultOverlayStylePreset('cta', db);
  assert.ok(initialCaption && initialHook && initialCta);
  if (!initialCaption || !initialHook || !initialCta) throw new Error('Expected seeded defaults.');

  await saveVideo(video('defaults-video'));
  const existing = clip('existing-with-selection', 'defaults-video');
  existing.captionPresetId = initialCaption._id;
  existing.hookStylePresetId = initialHook._id;
  existing.ctaStylePresetId = initialCta._id;
  await saveClip(existing);

  const nextCaption: CaptionPreset = {
    ...initialCaption,
    _id: 'next-caption',
    name: 'Next caption',
    isDefault: false,
  };
  const nextHook: OverlayStylePreset = { ...initialHook, _id: 'next-hook', name: 'Next hook', isDefault: false };
  const nextCta: OverlayStylePreset = { ...initialCta, _id: 'next-cta', name: 'Next CTA', isDefault: false };
  await saveCaptionPreset(nextCaption);
  await saveOverlayStylePreset(nextHook);
  await saveOverlayStylePreset(nextCta);
  await setDefaultCaptionPreset(nextCaption._id, db);
  await setDefaultOverlayStylePreset(nextHook._id, db);
  await setDefaultOverlayStylePreset(nextCta._id, db);

  const createdWithoutSelections = clip('new-without-selections', 'defaults-video');
  await saveClip(createdWithoutSelections);
  assert.equal(createdWithoutSelections.captionPresetId, nextCaption._id);
  assert.equal(createdWithoutSelections.hookStylePresetId, nextHook._id);
  assert.equal(createdWithoutSelections.ctaStylePresetId, nextCta._id);

  existing.status = 'failed';
  await updateClip(existing);
  assert.equal((await getClip(existing._id))?.captionPresetId, initialCaption._id);
  assert.equal((await getClip(existing._id))?.hookStylePresetId, initialHook._id);
  assert.equal((await getClip(existing._id))?.ctaStylePresetId, initialCta._id);

  const manuallySelected = clip('manual-selection', 'defaults-video');
  manuallySelected.captionPresetId = initialCaption._id;
  manuallySelected.hookStylePresetId = initialHook._id;
  manuallySelected.ctaStylePresetId = initialCta._id;
  await saveClip(manuallySelected);
  assert.equal((await getClip(manuallySelected._id))?.captionPresetId, initialCaption._id);
  assert.equal((await getClip(manuallySelected._id))?.hookStylePresetId, initialHook._id);
  assert.equal((await getClip(manuallySelected._id))?.ctaStylePresetId, initialCta._id);
});

test('server-side deletion protection is transactional and allows deletion after switching defaults', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const currentCaption = await getDefaultCaptionPreset(db);
  const currentHook = await getDefaultOverlayStylePreset('hook', db);
  const currentCta = await getDefaultOverlayStylePreset('cta', db);
  assert.ok(currentCaption && currentHook && currentCta);
  if (!currentCaption || !currentHook || !currentCta) throw new Error('Expected seeded defaults.');

  await assert.rejects(() => deleteCaptionPreset(currentCaption._id), /default caption presets cannot be deleted/i);
  await assert.rejects(() => deleteOverlayStylePreset(currentHook._id), /default overlay style presets cannot be deleted/i);
  await assert.rejects(() => deleteOverlayStylePreset(currentCta._id), /default overlay style presets cannot be deleted/i);

  const replacementCaption: CaptionPreset = {
    ...currentCaption,
    _id: 'delete-caption-replacement',
    isDefault: false,
  };
  await saveCaptionPreset(replacementCaption);
  const replacementHook: OverlayStylePreset = { ...currentHook, _id: 'delete-hook-replacement', isDefault: false };
  const replacementCta: OverlayStylePreset = { ...currentCta, _id: 'delete-cta-replacement', isDefault: false };
  await saveOverlayStylePreset(replacementHook);
  await saveOverlayStylePreset(replacementCta);
  await setDefaultCaptionPreset(replacementCaption._id, db);
  await setDefaultOverlayStylePreset(replacementHook._id, db);
  await setDefaultOverlayStylePreset(replacementCta._id, db);

  assert.equal(await deleteCaptionPreset(currentCaption._id), true);
  assert.equal(await deleteOverlayStylePreset(currentHook._id), true);
  assert.equal(await deleteOverlayStylePreset(currentCta._id), true);
  assert.equal(await getCaptionPreset(currentCaption._id), null);
});
