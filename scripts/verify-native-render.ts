/**
 * End-to-end check of the NATIVE caption engine's final FFmpeg pass:
 *
 *   npx tsx scripts/verify-native-render.ts            (needs ffmpeg; set FFMPEG_PATH if not on PATH)
 *
 * Builds a synthetic source (color bars + tone), runs the real
 * `processVideoSegment` with a real `generateAssFile` (plus a font-independent
 * ASS vector shape, so the check works on machines without the preset fonts),
 * a transparent hook-card PNG sequence, and a hook intro + dip-to-black - then
 * inspects the rendered frames:
 *
 *   1. the base video is NOT black (the old bug covered everything in black),
 *   2. the ASS content is burned onto the video (the vector shape is visible),
 *   3. the transparent PNG overlay composites without hiding the video.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { runFfmpeg } from '../lib/ffmpeg';
import { processVideoSegment } from '../worker/ffmpeg-pipeline';
import { generateAssFile } from '../worker/captions-ass';
import type { SinglePlan } from '../worker/layout';

interface Rgba { r: number; g: number; b: number; a: number }

/** Decode the first scanlines of an RGBA/RGB PNG far enough to sample (x, y). */
function decodePngTo(buffer: Buffer, x: number, y: number): Rgba {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'not a PNG');
  let pos = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.subarray(pos + 4, pos + 8).toString('ascii');
    const chunk = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = chunk;
    if (type === 'IDAT') idat.push(chunk);
    pos += 12 + len;
  }
  assert.ok(ihdr, 'no IHDR');
  const w = ihdr.readUInt32BE(0);
  const colorType = ihdr[9];
  assert.ok(colorType === 6 || colorType === 2, `unexpected color type ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = w * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let r = 0; r <= y; r += 1) {
    const filter = raw[p];
    const cur = Buffer.from(raw.subarray(p + 1, p + 1 + stride));
    p += 1 + stride;
    if (filter === 1) {
      for (let i = channels; i < stride; i += 1) cur[i] = (cur[i] + cur[i - channels]) & 255;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) cur[i] = (cur[i] + prev[i]) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? cur[i - channels] : 0;
        cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const pred = a + b - c;
        const pa = Math.abs(pred - a);
        const pb = Math.abs(pred - b);
        const pc = Math.abs(pred - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev = cur;
    if (r === y) {
      const o = x * channels;
      return { r: cur[o], g: cur[o + 1], b: cur[o + 2], a: channels === 4 ? cur[o + 3] : 255 };
    }
  }
  throw new Error('unreachable');
}

function extractFrame(videoPath: string, atSeconds: number, outPng: string): void {
  const result = spawnSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', atSeconds.toFixed(3), '-i', videoPath, '-frames:v', '1', '-c:v', 'png', outPng],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`frame extract failed: ${result.stderr}`);
}

async function main(): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-native-verify-'));
  const sourcePath = path.join(workDir, 'source.mp4');
  const outputPath = path.join(workDir, 'rendered.mp4');
  const hookDir = path.join(workDir, 'hook');
  fs.mkdirSync(hookDir, { recursive: true });

  try {
    // 1) Synthetic 1920x1080 source: STATIC color bars + tone (8 s), so the same
    //    output pixel maps to the same base colour at every point on the timeline.
    await runFfmpeg(
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30:duration=8',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest',
        sourcePath,
      ],
      { label: 'verify-source' }
    );

    // 2) Transparent "hook card" PNG sequence: full-frame white at ~40% alpha for 2 s.
    //    (geq writes the alpha channel directly - independent of libass.)
    await runFfmpeg(
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=white:s=1080x1920:r=30:d=2',
        // format=rgba FIRST: geq can only write an alpha plane that exists.
        '-vf', "format=rgba,geq=r='255':g='255':b='255':a='100'",
        '-start_number', '1', '-c:v', 'png', '-pix_fmt', 'rgba',
        path.join(hookDir, 'ov_%05d.png'),
      ],
      { label: 'verify-hook-pngs' }
    );

    // 3) Real ASS captions + a font-independent vector shape (yellow, centred at y=300).
    const words = [
      { word: 'Nobody', start: 0.2, end: 0.5 },
      { word: 'tells', start: 0.5, end: 0.8 },
      { word: 'you', start: 0.8, end: 1.0 },
      { word: 'this', start: 1.0, end: 1.3 },
      { word: 'about', start: 1.4, end: 1.7 },
      { word: 'short', start: 1.7, end: 2.0 },
      { word: 'video', start: 2.0, end: 2.4 },
      { word: 'retention', start: 2.6, end: 3.1 },
      { word: 'is', start: 3.1, end: 3.3 },
      { word: 'everything', start: 3.3, end: 4.0 },
    ];
    const ass = generateAssFile({
      words,
      preset: {
        _id: 'verify', name: 'Verify', fontFamily: 'Arial', fontSize: 48, fontWeight: 'bold',
        textColor: '#FFFFFF', highlightColor: '#FFE600', strokeColor: '#000000', strokeWidth: 3,
        positionY: 25, animationStyle: 'karaoke', uppercase: true,
      },
      totalDurationSeconds: 7,
      hookDuration: 2,
      hookStart: 1,
      ctaDuration: 0,
      hookTransitionDuration: 0.5,
    });
    const shapeDialogue =
      'Dialogue: 0,0:00:00.00,0:00:07.00,Cap,,0,0,0,,{\\an5\\pos(540,300)\\1c&H00FFFF\\p1}m 0 0 l 400 0 400 200 0 200{\\p0}\n';
    const assPath = path.join(workDir, 'captions.ass');
    fs.writeFileSync(assPath, ass + shapeDialogue, 'utf8');

    // 4) Real worker pipeline: hook intro (2 s replay of t=1..3) + base clip (t=2..7).
    const plan: SinglePlan = { mode: 'single', cropW: 606, cropH: 1080, points: [], faceAnchorY: 0.32 };
    await processVideoSegment({
      sourceVideoPath: sourcePath,
      outputPath,
      start: 2,
      end: 7,
      hookDuration: 2,
      hookStart: 1,
      filterPresetId: 'none',
      plan,
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetFps: 30,
      sourceHasAudio: true,
      overlays: [{ name: 'hook', inputPattern: path.join(hookDir, 'ov_%05d.png'), startAtSeconds: 0 }],
      assFilePath: assPath,
      words,
    });

    // 5) Assertions on rendered frames.
    const frame = (t: number): Buffer => {
      const png = path.join(workDir, `frame_${t.toFixed(1)}.png`);
      extractFrame(outputPath, t, png);
      return fs.readFileSync(png);
    };

    // Mid-clip, outside the dip window and the hook overlay: video must NOT be black.
    const mid = decodePngTo(frame(5.0), 900, 150);
    const midLuma = (mid.r + mid.g + mid.b) / 3;
    assert.ok(midLuma > 30, `base video looks black at t=5 (luma=${midLuma.toFixed(0)})`);

    // The ASS vector shape is burned in: a yellow block centred at (540, 300).
    const shape = decodePngTo(frame(5.0), 540, 300);
    assert.ok(shape.r > 190 && shape.g > 190 && shape.b < 90,
      `ASS shape not visible at (540,300): rgb(${shape.r},${shape.g},${shape.b})`);
    // ...and the same spot at t=1 (hook window, overlay active) is still the shape.
    const shapeHook = decodePngTo(frame(1.0), 540, 300);
    assert.ok(shapeHook.r > 190 && shapeHook.g > 190, 'ASS shape missing during the hook window');

    // Hook overlay composites WITHOUT hiding the video: with static bars the same
    // pixel has the same base colour at t=1 (overlay on) and t=5 (overlay off), so
    // the ~40% white card must LIFT the value noticeably but not white it out.
    const under = decodePngTo(frame(5.0), 100, 1500);
    const over = decodePngTo(frame(1.0), 100, 1500);
    const brighter = (over.r + over.g + over.b) / 3 - (under.r + under.g + under.b) / 3;
    assert.ok(brighter > 8, `transparent overlay had no visible effect (delta=${brighter.toFixed(0)})`);
    assert.ok(brighter < 140, `overlay looks opaque - it white-washed the video (delta=${brighter.toFixed(0)})`);
    assert.ok(over.a === 255, 'output frame alpha must be opaque');
    console.log(`✓ base video visible (luma=${midLuma.toFixed(0)})`);
    console.log(`✓ ASS burned in (shape rgb=${shape.r},${shape.g},${shape.b})`);
    console.log(`✓ transparent overlay composited (delta=${brighter.toFixed(0)})`);
    console.log('NATIVE ENGINE RENDER OK');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('NATIVE ENGINE RENDER CHECK FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
