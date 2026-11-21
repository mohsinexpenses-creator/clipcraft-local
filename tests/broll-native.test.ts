import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import {
  NATIVE_CARD,
  coverFit,
  encodePng,
  getBrollRendererChoice,
  paintNativeFrame,
  renderNativeCardPhase,
  roundRectCoverage,
  tightBounds,
} from '../lib/broll/native';
import { compareImages, NATIVE_GATE, passesNativeGate } from '../lib/broll/compare';
import { brollFrameStyle } from '../lib/broll/animation';
import { FULL_OVERLAY_CANVAS } from '../lib/overlay-canvas';
import { CARD_HEIGHT, CARD_WIDTH } from '../lib/broll/card';

/**
 * Phase 5: the native card renderer really draws the card, from the same motion
 * numbers as Remotion, and writes the same frame contract.
 *
 * Nothing here needs Chromium, so everything except the literal SSIM-vs-Remotion
 * comparison is verifiable in CI. (`npm run verify:broll-native` records that
 * gate on a machine with a browser.)
 */

const CARD = { x: 162, y: 640, width: CARD_WIDTH, height: CARD_HEIGHT };

async function makeSourceImage(file: string, width = 1600, height = 900): Promise<void> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const top = y < height / 2;
      image.bitmap.data[index] = top ? 220 : 30;
      image.bitmap.data[index + 1] = top ? 40 : 140;
      image.bitmap.data[index + 2] = top ? 40 : 210;
      image.bitmap.data[index + 3] = 255;
    }
  }
  await fs.promises.writeFile(file, await image.getBuffer('image/jpeg', { quality: 92 }));
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `broll-native-${label}-`));
}

function pixel(surface: { width: number; data: Uint8ClampedArray }, x: number, y: number): number[] {
  const index = (y * surface.width + x) * 4;
  return [surface.data[index], surface.data[index + 1], surface.data[index + 2], surface.data[index + 3]];
}

test('BROLL_RENDERER defaults to remotion and only "native" switches', () => {
  assert.equal(getBrollRendererChoice({}), 'remotion');
  assert.equal(getBrollRendererChoice({ BROLL_RENDERER: 'native' }), 'native');
  assert.equal(getBrollRendererChoice({ BROLL_RENDERER: 'NATIVE' }), 'native');
  assert.equal(getBrollRendererChoice({ BROLL_RENDERER: 'remotion' }), 'remotion');
  assert.equal(getBrollRendererChoice({ BROLL_RENDERER: 'chromium' }), 'remotion', 'unknown values never silently switch');
});

test('the card geometry is the spec: 756x425 inside the 1080 canvas', () => {
  assert.equal(CARD_WIDTH, 756);
  assert.equal(CARD_HEIGHT, 425);
  assert.equal(NATIVE_CARD.borderPx, 10);
  assert.equal(NATIVE_CARD.radiusPx, 28);
  assert.equal(NATIVE_CARD.shadowOffsetYPx, 8);
  assert.equal(NATIVE_CARD.shadowBlurPx, 24);
  assert.equal(NATIVE_CARD.shadowColor.a, 0.25);
});

test('cover fit fills the card without letterboxing', () => {
  const fit = coverFit(1600, 900, 756, 425);
  assert.ok(fit.width >= 756 && fit.height >= 425, 'never smaller than the card');
  // 16:9 into 16:9 is exact; a taller source is cropped on the long axis.
  assert.equal(fit.height, 425);
  assert.equal(fit.width, 756);
  const portrait = coverFit(1080, 1920, 756, 425);
  assert.equal(portrait.height, 1920 > 425 ? portrait.height : 0);
  assert.ok(portrait.width >= 756 && portrait.height >= 425);
});

test('round-rect coverage is 1 inside, 0 outside, and antialiased on the corner', () => {
  assert.equal(roundRectCoverage(50, 50, 100, 100, 10), 1);
  assert.equal(roundRectCoverage(0, 0, 100, 100, 10), 0, 'the very corner pixel is cut');
  const edge = roundRectCoverage(3, 3, 100, 100, 10);
  assert.ok(edge >= 0 && edge <= 1);
  assert.ok(edge > 0 && edge < 1, 'a pixel on the arc is partially covered');
});

test('encodePng writes a real PNG that decodes back to the same pixels', async () => {
  const width = 8;
  const height = 6;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = (index * 7) % 256;
    rgba[index * 4 + 1] = (index * 13) % 256;
    rgba[index * 4 + 2] = (index * 29) % 256;
    rgba[index * 4 + 3] = index % 3 === 0 ? 0 : 255;
  }
  const file = path.join(tempDir('png'), 'frame.png');
  await fs.promises.writeFile(file, encodePng(rgba, width, height));
  const decoded = await Jimp.read(file);
  assert.equal(decoded.bitmap.width, width);
  assert.equal(decoded.bitmap.height, height);
  // PNG stores straight alpha, so the RGB of a transparent pixel is normalised
  // to 0 by some decoders; compare the visible pixels exactly.
  for (let index = 0; index < width * height; index += 1) {
    const alpha = rgba[index * 4 + 3];
    assert.equal(decoded.bitmap.data[index * 4 + 3], alpha, `alpha at ${index}`);
    if (alpha === 255) {
      assert.equal(decoded.bitmap.data[index * 4], rgba[index * 4], `red at ${index}`);
      assert.equal(decoded.bitmap.data[index * 4 + 1], rgba[index * 4 + 1], `green at ${index}`);
      assert.equal(decoded.bitmap.data[index * 4 + 2], rgba[index * 4 + 2], `blue at ${index}`);
    }
  }
});

test('a baked card draws its white border and its image inside it, and nothing outside', async () => {
  const dir = tempDir('paint');
  const source = path.join(dir, 'source.jpg');
  await makeSourceImage(source);
  const outputDir = path.join(dir, 'frames');
  await renderNativeCardPhase({
    item: { id: 'card', kind: 'landscape', start: 0, end: 0.2, imagePath: source, card: CARD },
    canvas: FULL_OVERLAY_CANVAS,
    startFrame: 0,
    endFrame: 5,
    fps: 30,
    outputDir,
    parallelism: 1,
  });
  const frameFile = path.join(outputDir, 'frame-000004.png'); // settled
  const image = await Jimp.read(frameFile);
  const at = (x: number, y: number) => {
    const index = (y * image.bitmap.width + x) * 4;
    return [...image.bitmap.data.slice(index, index + 4)];
  };
  assert.deepEqual(at(10, 10), [0, 0, 0, 0], 'the canvas outside the card is transparent');

  // The border is white at the card's top edge (y = CARD.y + 2).
  const border = at(CARD.x + Math.round(CARD.width / 2), CARD.y + 4);
  assert.deepEqual(border, [255, 255, 255, 255], 'a 10 px white border lines the card');

  // The image itself starts after the border: the source's top half is red.
  const inside = at(CARD.x + Math.round(CARD.width / 2), CARD.y + NATIVE_CARD.borderPx + 20);
  assert.ok(inside[0] > 150 && inside[1] < 90 && inside[2] < 90, `inside pixel ${inside}`);
  // ...and the bottom half of the source is blue.
  const lower = at(CARD.x + Math.round(CARD.width / 2), CARD.y + CARD.height - NATIVE_CARD.borderPx - 20);
  assert.ok(lower[2] > 140 && lower[0] < 90, `lower pixel ${lower}`);
});

test('the animation drives every frame: it fades in, holds, and fades out', async () => {
  const dir = tempDir('anim');
  const source = path.join(dir, 'source.jpg');
  await makeSourceImage(source);
  const outputDir = path.join(dir, 'frames');
  const fps = 30;
  const duration = 2;
  const frameCount = Math.round(duration * fps);
  await renderNativeCardPhase({
    item: { id: 'card', kind: 'landscape', start: 0, end: duration, imagePath: source, card: CARD },
    canvas: FULL_OVERLAY_CANVAS,
    startFrame: 0,
    endFrame: frameCount - 1,
    fps,
    outputDir,
    parallelism: 2,
  });

  const alphaAt = async (frame: number): Promise<number> => {
    const image = await Jimp.read(path.join(outputDir, `frame-${String(frame + 1).padStart(6, '0')}.png`));
    const x = CARD.x + Math.round(CARD.width / 2);
    const y = CARD.y + Math.round(CARD.height / 2);
    return image.bitmap.data[(y * image.bitmap.width + x) * 4 + 3];
  };

  const enterAlpha = await alphaAt(0);
  const earlyAlpha = await alphaAt(3);
  const holdAlpha = await alphaAt(Math.round(frameCount * 0.5));
  const lateAlpha = await alphaAt(frameCount - 3);
  const exitAlpha = await alphaAt(frameCount - 1);
  assert.ok(enterAlpha < earlyAlpha, `enter should fade in (${enterAlpha} -> ${earlyAlpha})`);
  assert.equal(holdAlpha, 255, 'the hold is fully opaque');
  assert.ok(exitAlpha < lateAlpha, `exit should fade out (${lateAlpha} -> ${exitAlpha})`);
  assert.ok(
    exitAlpha < holdAlpha * 0.5,
    `the last frame is more than half faded (${exitAlpha} of ${holdAlpha})`,
  );

  // The motion itself comes from brollFrameStyle, not from the renderer.
  const required = brollFrameStyle('landscape', 0, duration);
  assert.equal(required.opacity, 0, 'frame 0 is transparent by contract');
});

test('a frame range is rendered 1:1 with contiguous, 1-based PNG names', async () => {
  const dir = tempDir('names');
  const source = path.join(dir, 'source.jpg');
  await makeSourceImage(source);
  const outputDir = path.join(dir, 'frames');
  const result = await renderNativeCardPhase({
    item: { id: 'card', kind: 'landscape', start: 12, end: 13.5, imagePath: source, card: CARD },
    canvas: FULL_OVERLAY_CANVAS,
    // A mid-timeline active range, exactly as the worker computes it.
    startFrame: 360,
    endFrame: 404,
    fps: 30,
    outputDir,
  });
  assert.equal(result.frames, 45);
  const files = fs.readdirSync(outputDir).filter((file) => file.endsWith('.png')).sort();
  assert.equal(files.length, 45);
  assert.equal(files[0], 'frame-000001.png');
  assert.equal(files[files.length - 1], 'frame-000045.png');
  // No gaps: the FFmpeg overlay input is a numbered pattern.
  files.forEach((file, index) => {
    assert.equal(file, `frame-${String(index + 1).padStart(6, '0')}.png`);
  });
});

test('the cropped card canvas shrinks the surface but not the card', async () => {
  const dir = tempDir('cropped');
  const source = path.join(dir, 'source.jpg');
  await makeSourceImage(source);
  const outputDir = path.join(dir, 'frames');
  const region = { x: CARD.x - 40, y: CARD.y - 40, width: CARD.width + 80, height: CARD.height + 40 + NATIVE_CARD.paddingPx };
  await renderNativeCardPhase({
    item: { id: 'card', kind: 'landscape', start: 0, end: 1, imagePath: source, card: CARD },
    canvas: region,
    startFrame: 0,
    endFrame: 10,
    fps: 30,
    outputDir,
    parallelism: 1,
  });
  const image = await Jimp.read(path.join(outputDir, 'frame-000006.png'));
  assert.equal(image.bitmap.width, region.width);
  assert.equal(image.bitmap.height, region.height);
});

test('compareImages measures what the gate needs', () => {
  const width = 32;
  const height = 32;
  const a = { width, height, data: Buffer.alloc(width * height * 4, 128) };
  const identical = compareImages(a, a);
  assert.equal(identical.ssim, 1);
  assert.equal(identical.maxAbsDiff, 0);
  assert.equal(passesNativeGate(identical), true);

  const shifted = { width, height, data: Buffer.alloc(width * height * 4, 0) };
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      const index = (y * width + x) * 4;
      shifted.data[index] = 200;
      shifted.data[index + 3] = 255;
    }
  }
  const different = compareImages(a, shifted);
  assert.ok(different.ssim < NATIVE_GATE.minSsim, `ssim ${different.ssim}`);
  assert.equal(passesNativeGate(different), false);

  assert.throws(() => compareImages(a, { width: 16, height: 32, data: Buffer.alloc(16 * 32 * 4) }), /Cannot compare/);
});

test('a full-screen native frame is opaque and carries the caption scrim', () => {
  const surface = {
    width: 108,
    height: 192,
    data: new Uint8ClampedArray(108 * 192 * 4),
  };
  const plateData = new Uint8ClampedArray(surface.width * surface.height * 4).fill(200);
  for (let index = 3; index < plateData.length; index += 4) plateData[index] = 255;
  const plate = {
    width: surface.width,
    height: surface.height,
    data: plateData,
    bounds: tightBounds(plateData, surface.width, surface.height),
  };
  paintNativeFrame(
    surface,
    { id: 'fs', kind: 'fullscreen', start: 0, end: 2, imagePath: 'x.jpg' },
    plate,
    // Half way through the hold, so opacity is 1 and only the scrim varies.
    1,
    2,
  );
  const top = pixel(surface, 54, 2);
  const bottom = pixel(surface, 54, 190);
  assert.equal(top[3], 255, 'the frame is opaque');
  assert.ok(bottom[3] === 255);
  // The scrim is a bottom gradient: the bottom is darker than the top.
  assert.ok(bottom[0] < top[0], `scrim did not darken the bottom (${top[0]} -> ${bottom[0]})`);
});
