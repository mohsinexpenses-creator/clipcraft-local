import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardCoversFace,
  mapFaceToCanvas,
  planCardRect,
} from '../lib/broll/card';
import {
  BROLL_OUTPUT_HEIGHT,
  BROLL_OUTPUT_WIDTH,
  planFullscreenCrop,
  planLandscapeCrop,
} from '../lib/broll/crop';

/**
 * Crop and card geometry: the difference between a celebrity's face centred in a
 * 9:16 frame and a forehead filling it, and between a card beside the captions and
 * a card sitting on the speaker's face.
 */

test('a 16:9 photo is cropped to a 9:16 window, centred on the face', () => {
  const crop = planFullscreenCrop({
    sourceWidth: 1920,
    sourceHeight: 1080,
    face: { x: 1200, y: 300, width: 200, height: 260 },
    entityType: 'person',
  });
  assert.equal(crop.mode, 'crop');
  assert.equal(crop.faceCentered, true);
  // Window has 9:16 aspect.
  assert.ok(Math.abs(crop.width / crop.height - 9 / 16) < 0.02);
  // Face centre sits inside the window, in its middle half horizontally.
  const faceCentre = 1200 + 100;
  const relative = (faceCentre - crop.x) / crop.width;
  assert.ok(relative > 0.25 && relative < 0.75, `face at ${relative.toFixed(2)}`);
  assert.ok(crop.x >= 0 && crop.x + crop.width <= 1920);
});

test('a face in an already-vertical photo is not cropped out of frame', () => {
  const crop = planFullscreenCrop({
    sourceWidth: 1080,
    sourceHeight: 1920,
    face: { x: 540, y: 200, width: 200, height: 240 },
  });
  assert.equal(crop.mode, 'crop');
  assert.ok(crop.y <= 200, 'the head stays in frame');
  assert.ok(crop.y + crop.height >= 440);
});

test('a landscape place/event without a face keeps the whole photo (blur fill)', () => {
  const crop = planFullscreenCrop({
    sourceWidth: 1920,
    sourceHeight: 1080,
    face: null,
    entityType: 'place',
  });
  assert.equal(crop.mode, 'blur-fill');
  assert.equal(crop.width, 1920);
  assert.equal(crop.height, 1080);
  assert.equal(crop.outputWidth, BROLL_OUTPUT_WIDTH);
  assert.equal(crop.outputHeight, BROLL_OUTPUT_HEIGHT);
});

test('a portrait photo without a face is centre-cropped, not blurred', () => {
  const crop = planFullscreenCrop({ sourceWidth: 900, sourceHeight: 1600, entityType: 'event' });
  assert.equal(crop.mode, 'crop');
  assert.ok(Math.abs(crop.width / crop.height - 9 / 16) < 0.03);
});

test('the card crop is a 16:9 centre window and never upscales the source', () => {
  const crop = planLandscapeCrop(4000, 3000);
  assert.ok(Math.abs(crop.width / crop.height - 16 / 9) < 0.02);
  assert.ok(crop.width <= 4000 && crop.height <= 3000);
  // Centred.
  assert.ok(Math.abs(crop.y - (3000 - crop.height) / 2) <= 2);
});

test('a card sits above the caption band and never covers it', () => {
  const rect = planCardRect({ captionBand: { top: 1300, bottom: 1460 } });
  assert.equal(rect.width, CARD_WIDTH);
  assert.equal(rect.height, CARD_HEIGHT);
  assert.ok(rect.y + rect.height <= 1300, `card bottom ${rect.y + rect.height} vs caption top 1300`);
});

test('a card avoids a detected face even when that pushes it lower', () => {
  const face = { x: 340, y: 500, width: 400, height: 460 };
  const rect = planCardRect({ captionBand: { top: 1500, bottom: 1700 }, faceZones: [face] });
  assert.equal(cardCoversFace(rect, [face]), false, `card ${JSON.stringify(rect)} covers the face`);
});

test('the card shrinks when the free space above the captions is small', () => {
  const rect = planCardRect({ captionBand: { top: 320, bottom: 500 } });
  assert.ok(rect.height < CARD_HEIGHT);
  assert.ok(Math.abs(rect.width / rect.height - CARD_WIDTH / CARD_HEIGHT) < 0.05, 'aspect preserved');
  assert.ok(rect.y + rect.height <= 320);
});

test('a face in a source frame maps onto the 9:16 canvas with head room', () => {
  const zone = mapFaceToCanvas(
    { x: 800, y: 200, width: 160, height: 200 },
    1920,
    1080
  );
  assert.ok(zone, 'a face zone is produced');
  assert.ok(zone!.y >= 0 && zone!.y + zone!.height <= 1920);
  assert.ok(zone!.x >= 0 && zone!.x + zone!.width <= 1080);
  // Head room above the mouth, chin room below.
  assert.ok(zone!.height > 200);
});

test('a degenerate face box produces no zone', () => {
  assert.equal(mapFaceToCanvas({ x: 0, y: 0, width: 0, height: 0 }, 1920, 1080), null);
});
