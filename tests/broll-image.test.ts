import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import {
  makeVisionThumbnail,
  prepareCard,
  prepareCardFile,
  prepareFullscreen,
  prepareFullscreenFile,
  readImage,
  UnreadableImageError,
} from '../lib/broll/image';

/**
 * The jimp side of B-roll: the frames it produces must be exactly the composition
 * canvas, never stretched, and readable by the renderer - and a corrupt download
 * must fail loudly instead of reaching Chromium.
 */

async function jpegBytes(width: number, height: number, color = 0x2b6cb0ff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return Buffer.from(
    await (image as unknown as { getBuffer(mime: string, options?: object): Promise<Buffer> }).getBuffer(
      'image/jpeg',
      { quality: 85 }
    )
  );
}

test('a landscape photo becomes a 1080x1920 blurred-fill frame, never stretched', async () => {
  const source = await jpegBytes(1600, 900);
  const prepared = await prepareFullscreen(source, { face: null, entityType: 'place' });

  assert.equal(prepared.crop.mode, 'blur-fill');
  const image = await readImage(prepared.buffer);
  assert.equal(image.bitmap.width, 1080);
  assert.equal(image.bitmap.height, 1920);
});

test('a portrait photo becomes a 9:16 crop at the exact canvas size', async () => {
  const source = await jpegBytes(900, 1600);
  const prepared = await prepareFullscreen(source, { face: null });
  assert.equal(prepared.crop.mode, 'crop');
  const image = await readImage(prepared.buffer);
  assert.equal(image.bitmap.width, 1080);
  assert.equal(image.bitmap.height, 1920);
});

test('the card image is exactly 960x540', async () => {
  const source = await jpegBytes(1920, 1080);
  const card = await prepareCard(source);
  const image = await readImage(card);
  assert.equal(image.bitmap.width, 960);
  assert.equal(image.bitmap.height, 540);
});

test('the vision thumbnail is ~512 px on its long edge', async () => {
  const source = await jpegBytes(2000, 1500);
  const thumb = await makeVisionThumbnail(source);
  assert.equal(thumb.mime, 'image/jpeg');
  const decoded = Buffer.from(thumb.data, 'base64');
  const image = await readImage(decoded);
  assert.equal(Math.max(image.bitmap.width, image.bitmap.height), 512);
  assert.ok(decoded.length < source.length, 'the thumbnail is smaller than the original');
});

test('prepared files land in the cache directory under their hash name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-img-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = await jpegBytes(1200, 1600);
  const fullscreen = await prepareFullscreenFile(source, { cacheKey: 'img-abc123', root, face: null });
  assert.equal(fullscreen.renderFile, 'fs-abc123.jpg');
  assert.ok(fs.existsSync(path.join(root, 'images', fullscreen.renderFile)));
  assert.equal(fullscreen.crop?.mode, 'crop');

  const card = await prepareCardFile(source, { cacheKey: 'img-def456', root });
  assert.equal(card.renderFile, 'card-def456.jpg');
  assert.ok(fs.existsSync(path.join(root, 'images', card.renderFile)));
});

test('a truncated download is rejected with a readable reason', async () => {
  await assert.rejects(() => readImage(Buffer.from('not an image at all')), UnreadableImageError);
  await assert.rejects(
    () => prepareFullscreen(Buffer.from([0xff, 0xd8, 0xff, 0x00]), { face: null }),
    /not a readable image/
  );
});
