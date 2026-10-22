import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import { getClip, getClipBrollPlan, saveClip, saveClipBrollPlan, saveVideo } from '../lib/db';
import { removeBrollItem, swapBrollItem } from '../lib/broll/edit';
import type { BrollHttpResponse, BrollFetch } from '../lib/broll/http';
import { DEFAULT_BROLL_OPTIONS, type BrollItem, type BrollPlan, type ClipRecord, type VideoRecord } from '../lib/types';
import { createTemporaryDatabase } from './sqlite-test-helpers';

/**
 * Per-item plan edits from the clip tile. Swapping must use an alternative that was
 * recorded with the plan (never a new search, never a different subject), and both
 * edits must leave a valid, saveable plan behind.
 */

function makeVideo(id: string): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: 'clip.mp4',
    fileName: `${id}.mp4`,
    filePath: `/tmp/${id}.mp4`,
    duration: 60,
    width: 1920,
    height: 1080,
    fileSize: 1000,
    status: 'transcribed',
    createdAt: now,
    updatedAt: now,
  };
}

function makeClip(id: string, videoId: string): ClipRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    videoId,
    start: 0,
    end: 30,
    hookDuration: 0,
    hookText: 'HOOK',
    filterPreset: 'none',
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function landscapeItem(id: string, alternatives: BrollItem['attribution'][]): BrollItem {
  return {
    id,
    kind: 'landscape',
    start: 5,
    end: 8,
    desiredStart: 2,
    desiredEnd: 5,
    query: 'city skyline',
    attribution: {
      provider: 'pexels',
      sourceUrl: 'https://www.pexels.com/photo/1/',
      imageUrl: 'https://images.pexels.com/photos/1/a.jpg',
      author: 'First Photographer',
      license: 'Pexels License',
    },
    cacheKey: 'img-first',
    renderFile: 'card-first.jpg',
    card: { x: 100, y: 900, width: 880, height: 495 },
    alternatives,
  };
}

function makePlan(items: BrollItem[]): BrollPlan {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    trigger: 'auto',
    clipDuration: 30,
    hookDuration: 0,
    totalDuration: 30,
    options: { ...DEFAULT_BROLL_OPTIONS },
    items,
    skipped: [],
    counts: { targetMin: 5, targetMax: 7, fullscreen: 0, landscape: items.length },
  };
}

function imageResponse(bytes: Buffer): BrollHttpResponse {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

async function jpegBytes(width = 1600, height = 900): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x3366ccff });
  return Buffer.from(await (image as unknown as { getBuffer(mime: string): Promise<Buffer> }).getBuffer('image/jpeg'));
}

test('swap replaces the image with the next recorded alternative and keeps the old one', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-swap');
  await saveVideo(video);
  const clip = makeClip('clip-swap', video._id);
  await saveClip(clip);

  const alternative = {
    provider: 'pixabay' as const,
    sourceUrl: 'https://pixabay.com/photos/2/',
    imageUrl: 'https://cdn.pixabay.com/2.jpg',
    author: 'Second Photographer',
    license: 'Pixabay Content License',
  };
  await saveClipBrollPlan(clip._id, makePlan([landscapeItem('card-city', [alternative])]));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = await jpegBytes();
  const fetcher: BrollFetch = () => Promise.resolve(imageResponse(bytes));

  const plan = await swapBrollItem(clip._id, 'card-city', { fetcher, root });
  const item = plan.items[0];
  assert.equal(item.attribution.author, 'Second Photographer');
  assert.equal(item.attribution.license, 'Pixabay Content License');
  assert.notEqual(item.renderFile, 'card-first.jpg');
  assert.ok(fs.existsSync(path.join(root, 'images', item.renderFile)), 'the new frame was written to the cache');
  assert.equal(item.alternatives?.[0].author, 'First Photographer', 'the old image is reversible');

  const stored = await getClipBrollPlan(clip._id);
  assert.equal(stored?.items[0].attribution.author, 'Second Photographer');
});

test('swap without alternatives is a clear 400, not a new provider search', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-swap-2');
  await saveVideo(video);
  const clip = makeClip('clip-swap-2', video._id);
  await saveClip(clip);
  await saveClipBrollPlan(clip._id, makePlan([landscapeItem('card-lonely', [])]));

  let fetched = 0;
  const fetcher: BrollFetch = () => {
    fetched += 1;
    return Promise.resolve(imageResponse(Buffer.alloc(0)));
  };
  await assert.rejects(() => swapBrollItem(clip._id, 'card-lonely', { fetcher }), /no other verified image/i);
  assert.equal(fetched, 0);
});

test('remove drops exactly one item and refreshes the counts', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-remove');
  await saveVideo(video);
  const clip = makeClip('clip-remove', video._id);
  await saveClip(clip);

  const second: BrollItem = {
    ...landscapeItem('card-two', []),
    start: 12,
    end: 15,
    attribution: { ...landscapeItem('x', []).attribution, imageUrl: 'https://images.pexels.com/photos/2/b.jpg' },
  };
  await saveClipBrollPlan(clip._id, makePlan([landscapeItem('card-one', []), second]));

  const plan = await removeBrollItem(clip._id, 'card-one');
  assert.deepEqual(plan.items.map((item) => item.id), ['card-two']);
  assert.equal(plan.counts.landscape, 1);
  assert.ok(plan.notes?.some((note) => note.includes('Removed')));

  const stored = await getClip(clip._id);
  assert.equal(stored?.broll?.items.length, 1);
  assert.equal(stored?.brollStatus, 'done');
});

test('editing a clip with no plan is a 404 with guidance', async (t) => {
  createTemporaryDatabase(t);
  const video = makeVideo('video-noplan');
  await saveVideo(video);
  const clip = makeClip('clip-noplan', video._id);
  await saveClip(clip);
  await assert.rejects(() => removeBrollItem(clip._id, 'anything'), /no B-roll plan/i);
});
