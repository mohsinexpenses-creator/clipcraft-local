import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Jimp, loadFont } from 'jimp';
import { SANS_64_WHITE } from 'jimp/fonts';
import { getFfmpegPath } from '../lib/ffmpeg';
import { processVideoSegment } from '../worker/ffmpeg-pipeline';

async function main() {
  const dir = path.resolve('data/visual-layering-test');
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = getFfmpegPath();
  function run(args: string[]) {
    const result = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  }
  const source = path.join(dir, 'speaker.mp4');
  run(['-f', 'lavfi', '-i', 'color=blue:s=1080x1920:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', source]);
  const image = new Jimp({ width: 1080, height: 1920, color: 0xff3000ff });
  const photo = path.join(dir, 'bright.png');
  await image.write(photo as `${string}.png`);
  const caption = new Jimp({ width: 1080, height: 1920, color: 0x00000000 });
  caption.print({ font: await loadFont(SANS_64_WHITE), x: 250, y: 1400, text: 'CAPTION ON TOP' });
  // A transparent Remotion-style frame sequence, held through the entire output.
  const framePattern = path.join(dir, 'overlay_%05d.png');
  await caption.write(path.join(dir, 'overlay_00000.png') as `${string}.png`);
  for (let i = 1; i < 120; i++) fs.copyFileSync(path.join(dir, 'overlay_00000.png'), path.join(dir, `overlay_${String(i).padStart(5, '0')}.png`));
  for (const hook of [false, true]) for (const debug of [false, true]) {
    const output = path.join(dir, `hook-${hook}-debug-${debug}.mp4`);
    const started = performance.now();
    await processVideoSegment({
      sourceVideoPath: source, outputPath: output, start: 0, end: 3,
      hookDuration: hook ? 0.6 : 0, hookStart: 0, filterPresetId: 'none',
      plan: { mode: 'single', cropW: 1080, cropH: 1920, points: [], faceAnchorY: 0.35 },
      sourceWidth: 1080, sourceHeight: 1920, targetFps: 30, sourceHasAudio: false,
      overlays: [{ name: 'captions', inputPattern: framePattern, startAtSeconds: 0 }],
      visualOverlays: [{ id: 'bright', imagePath: photo, x: 0, y: 0, width: 1080, height: 1920, start: 0.7, end: 2.7, animation: 'subtle-zoom', border: false }],
      ...(debug ? { debugOutputPath: path.join(dir, `debug-${hook}.mp4`) } : {}),
    });
    const pixels = run(['-ss', '1.5', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    let white = 0;
    for (let y = 1400; y < 1500; y++) for (let x = 250; x < 1000; x++) {
      const i = (y * 1080 + x) * 3;
      if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) white++;
    }
    assert.ok(white > 1000, `${output}: caption pixels obscured (${white})`);
    const center = (960 * 1080 + 540) * 3;
    assert.ok(pixels[center] > 200 && pixels[center + 2] < 60, 'bright image must be visible');
    console.log(JSON.stringify({ hook, debug, captionPixels: white, renderMs: Math.round(performance.now() - started), output }));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
