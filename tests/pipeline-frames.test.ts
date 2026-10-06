/**
 * Frame accuracy of the REAL render pass, and the small pure helpers around it.
 *
 * The expensive tests need an ffmpeg with libx264 (the one the app uses); they SKIP
 * when there is none. They cut a clip at a time that is NOT on a frame boundary - the
 * normal case, since clip windows come from transcript timestamps - and check that
 * the output still has exactly the source's frames: no black first frame, no repeated
 * first/last frame, the right frame count and the source's frame rate. (Both layouts
 * used to get this wrong, in different ways: split screen started with a black frame
 * and ended with a repeated one, speaker focus repeated its first frame.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getFfmpegPath, getVideoMetadata } from '../lib/ffmpeg';
import {
  buildOverlayFilterStatements,
  ffmpegFpsArg,
  getVideoEncodeSettings,
  normalizeFps,
  processVideoSegment,
} from '../worker/ffmpeg-pipeline';
import { buildSingleFilterParts, buildSplitFilterComplex, LayoutPlan, SinglePlan, SplitPlan } from '../worker/layout';

test('ffmpegFpsArg: NTSC rates are exact fractions, everything else is the plain number', () => {
  assert.equal(ffmpegFpsArg(normalizeFps(23.98)), '24000/1001');
  assert.equal(ffmpegFpsArg(normalizeFps(29.97)), '30000/1001');
  assert.equal(ffmpegFpsArg(normalizeFps(59.94)), '60000/1001');
  assert.equal(ffmpegFpsArg(24), '24');
  assert.equal(ffmpegFpsArg(25), '25');
  assert.equal(ffmpegFpsArg(30), '30');
  assert.equal(ffmpegFpsArg(60), '60');
});

function twoPanePlan(): SplitPlan {
  const cell = (trackId: number, cellY: number, x0: number) => ({
    trackId,
    cellX: 0,
    cellY,
    cellW: 1080,
    cellH: 960,
    cropW: 540,
    cropH: 480,
    camera: { x0, y0: 200, moves: [], truncated: false },
    faceZone: { top: cellY + 300, bottom: cellY + 600 },
    headZone: { top: cellY + 200, bottom: cellY + 650 },
    trace: [],
  });
  return { mode: 'split', cells: [cell(1, 0, 300), cell(2, 960, 1100)] };
}

function singlePlan(): SinglePlan {
  return { mode: 'single', cropW: 606, cropH: 1080, points: [], faceAnchorY: 0.32 };
}

test('speaker and split crops keep exact coordinates and use Lanczos for final scaling', () => {
  const single = buildSingleFilterParts(singlePlan(), 1920, 1080, 1080, 1920, '').join(',');
  assert.ok(single.includes(':exact=1'), single);
  assert.ok(single.includes('scale=1080:1920:flags=lanczos'), single);

  const split = buildSplitFilterComplex(twoPanePlan(), 1920, 1080, '');
  assert.equal((split.match(/:exact=1/g) ?? []).length, 2, split);
  assert.equal((split.match(/flags=lanczos/g) ?? []).length, 2, split);
});

test('split graph: the canvas is built from the first pane - no free-running black source', () => {
  const graph = buildSplitFilterComplex(twoPanePlan(), 1920, 1080, '');
  assert.ok(!/color=c=black|color=black:s=/.test(graph), `no generated canvas: ${graph}`);
  assert.ok(/pad=1080:1920:0:0:color=black\[o0\]/.test(graph), 'the first pane is padded onto the canvas');
  assert.ok(graph.startsWith('[0:v]setpts=PTS-STARTPTS,hflip'), 'the clock restarts at 0 before anything else');
  assert.ok(graph.endsWith('[vout]'));
});

test('split graph: every pad label is produced once and consumed once (FFmpeg rejects anything else)', () => {
  for (const cells of [2, 3, 4]) {
    const plan = twoPanePlan();
    while (plan.cells.length < cells) {
      const i = plan.cells.length;
      plan.cells.push({ ...plan.cells[0], trackId: i + 1, cellX: (i % 2) * 540, cellY: 960 });
    }
    const graph = buildSplitFilterComplex(plan, 1920, 1080, '');
    const outputs = [...graph.matchAll(/\[(\w+)\](?=;|$|,)/g)].map((m) => m[1]);
    const inputs = [...graph.matchAll(/(?:^|;)((?:\[\w+\])+)/g)].flatMap((m) => [...m[1].matchAll(/\[(\w+)\]/g)].map((x) => x[1]));
    const produced = new Set<string>();
    for (const label of outputs) {
      assert.ok(!produced.has(label) || inputs.includes(label), `label ${label} reused`);
      produced.add(label);
    }
    for (const label of new Set(inputs)) {
      if (label === 'vout') continue;
      assert.equal(inputs.filter((l) => l === label).length <= 1 || label.startsWith('0'), true, `label ${label} consumed twice`);
    }
    assert.equal((graph.match(/\[vout\]/g) ?? []).length, 1, 'one final output');
  }
});

test('hook branch: glides are shifted by the hook offset (it replays a later part of the clip)', () => {
  const plan = twoPanePlan();
  plan.cells[0].camera = {
    x0: 300,
    y0: 200,
    moves: [{ t: 14.85, duration: 0.8, x: 100, y: 200 }],
    truncated: false,
  };
  const main = buildSplitFilterComplex(plan, 1920, 1080, '');
  const hook = buildSplitFilterComplex(plan, 1920, 1080, '', { timeOffset: 13.5, prefix: 'h_', input: '1:v', output: 'hv' });
  assert.ok(main.includes('(t-14.850)'), 'main branch glides at 14.85');
  assert.ok(hook.includes('(t-1.350)'), 'hook branch glides 13.5s earlier: 1.35');
  assert.ok(hook.includes('[1:v]setpts') && hook.endsWith('[hv]'));
  assert.ok(hook.includes('[h_s0]') && !hook.includes('[s0]'), 'labels are namespaced');

  const single = { ...singlePlan(), points: [{ t: 0, x: 500, y: 540 }, { t: 20, x: 1200, y: 540 }] };
  const off = buildSingleFilterParts(single, 1920, 1080, 1080, 1920, '', 10).join(',');
  const none = buildSingleFilterParts(single, 1920, 1080, 1080, 1920, '', 0).join(',');
  assert.notEqual(off, none, 'speaker-focus pan expression is shifted too');
  assert.ok(!off.includes('--'), `no double minus in: ${off}`);
  assert.ok(off.startsWith('setpts=PTS-STARTPTS,hflip,crop='), 'clock restarts at 0 in speaker focus as well');
});

/** Evaluate a speaker-focus pan expression (if/gte/lte/min/max) at time t. */
function evalPanExpr(expr: string, t: number): number {
  const js = expr
    .replace(/\bif\(/g, '__if(')
    .replace(/\bgte\(/g, '__gte(')
    .replace(/\blte\(/g, '__lte(')
    .replace(/\bmin\(/g, '__min(')
    .replace(/\bmax\(/g, '__max(');
  const fn = new Function('t', '__if', '__gte', '__lte', '__min', '__max', `return ${js};`) as (t: number, ...f: unknown[]) => number;
  return fn(t, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a >= b ? 1 : 0), (a: number, b: number) => (a <= b ? 1 : 0), Math.min, Math.max);
}

test('speaker focus hook branch: keyframes outside the hook window are pruned, positions are unchanged', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ t: i * 2, x: 400 + 25 * i * (i % 2 === 0 ? 1 : 0.5), y: 540 }));
  const plan = { ...singlePlan(), points };
  const crop = (parts: string[]): string => /crop=\d+:\d+:'(.*)':'.*'(?::exact=1)?$/.exec(parts.find((p) => p.startsWith('crop='))!)![1];
  const full = buildSingleFilterParts(plan, 1920, 1080, 1080, 1920, '', 20);
  const windowed = buildSingleFilterParts(plan, 1920, 1080, 1080, 1920, '', 20, 3);
  assert.ok(crop(windowed).length < crop(full).length / 3, `pruned: ${crop(windowed).length} chars vs ${crop(full).length}`);
  for (let t = 0; t <= 3; t += 0.25) {
    assert.ok(Math.abs(evalPanExpr(crop(windowed), t) - evalPanExpr(crop(full), t)) < 0.05, `same x at hook t=${t}`);
  }
});

test('final H.264 settings default to quality-first and accept safe env overrides', () => {
  assert.deepEqual(getVideoEncodeSettings({}), { crf: 17, preset: 'slow' });
  assert.deepEqual(getVideoEncodeSettings({ VIDEO_CRF: '16', VIDEO_PRESET: 'medium' }), {
    crf: 16,
    preset: 'medium',
  });
  assert.deepEqual(getVideoEncodeSettings({ VIDEO_CRF: '30', VIDEO_PRESET: 'unknown' }), {
    crf: 17,
    preset: 'slow',
  });
});

test('transparent overlays are composited into the base filter graph before the only final encode', () => {
  const graph = buildOverlayFilterStatements([
    { name: 'captions', inputPattern: '/tmp/captions_%05d.png', startAtSeconds: 0 },
    { name: 'cta', inputPattern: '/tmp/cta_%05d.png', startAtSeconds: 17.5 },
  ], [2, 3]);
  assert.ok(graph[0].includes('[2:v]format=rgba[overlay0]'));
  assert.ok(graph[1].includes('[vbase][overlay0]overlay='));
  assert.ok(graph[2].includes('[3:v]setpts=PTS+17.5000/TB,format=rgba[overlay1]'));
  assert.ok(graph[3].includes('[vcomp0][overlay1]overlay=') && graph[3].endsWith('[v]'));
  assert.ok(graph.filter((statement) => statement.includes('overlay=')).every((statement) =>
    statement.includes('eof_action=pass:repeatlast=0')
  ));
});

test('hook intervals outside the base segment fail instead of being clamped to a partial replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-hook-window-'));
  try {
    await assert.rejects(
      processVideoSegment({
        sourceVideoPath: path.join(dir, 'source-does-not-need-to-exist.mp4'),
        outputPath: path.join(dir, 'out.mp4'),
        start: 0,
        end: 2,
        hookDuration: 1.2,
        hookStart: 1,
        filterPresetId: 'none',
        plan: singlePlan(),
        sourceWidth: 1920,
        sourceHeight: 1080,
        targetFps: 25,
        sourceHasAudio: false,
      }),
      /complete detected hook interval/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real-ffmpeg frame accuracy
// ---------------------------------------------------------------------------

function haveFfmpeg(): string | null {
  try {
    const bin = getFfmpegPath();
    const encoders = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const filters = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    if (encoders.status === 0 && encoders.stdout.includes('libx264') && filters.stdout.includes('testsrc2')) return bin;
  } catch {
    // no ffmpeg
  }
  return null;
}

const FFMPEG = haveFfmpeg();
const SKIP = FFMPEG ? false : 'no ffmpeg with libx264 available';

/** Per-frame md5 of the first video stream. */
function frameHashes(bin: string, file: string): string[] {
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return r.stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop()!.trim());
}

/** Mean luma (0-255) of frame `index`, from a 16x16 gray thumbnail. */
function meanLuma(bin: string, file: string, index: number): number {
  const r = spawnSync(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${index}),scale=16:16:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 }
  );
  const px = r.stdout;
  let sum = 0;
  for (const v of px) sum += v;
  return px.length ? sum / px.length : 0;
}

async function renderClip(plan: LayoutPlan, hookDuration: number, tag: string, hookStart = 1) {
  const bin = FFMPEG!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clipcraft-frames-${tag}-`));
  const source = path.join(dir, 'source.mp4');
  // 25 fps, 4 s, every frame different (testsrc2 has a running counter + motion), with audio.
  const gen = spawnSync(bin, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '25',
    '-c:a', 'aac', '-shortest', source,
  ]);
  assert.equal(gen.status, 0, 'test source generated');

  const out = path.join(dir, 'out.mp4');
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = bin;
  try {
    await processVideoSegment({
      sourceVideoPath: source,
      outputPath: out,
      start: 0.405, // NOT a frame boundary: the first frame is 0.875 of a frame later (frames are every 0.04 s)
      end: 2.405,
      hookDuration,
      hookStart,
      filterPresetId: 'none',
      plan,
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetFps: 25,
      sourceHasAudio: true,
    });
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
  return { bin, out, dir };
}

for (const [name, plan] of [
  ['split screen', twoPanePlan()],
  ['speaker focus', singlePlan()],
] as Array<[string, LayoutPlan]>) {
  test(`${name}: a mid-frame cut gives exactly the source's frames (no black/duplicated first or last frame)`, { skip: SKIP }, async () => {
    const { bin, out, dir } = await renderClip(plan, 0, name.replace(' ', '-'));
    try {
      const hashes = frameHashes(bin, out);
      assert.equal(hashes.length, 50, `2.0 s at 25 fps is exactly 50 frames (got ${hashes.length})`);
      for (let i = 1; i < hashes.length; i += 1) {
        assert.notEqual(hashes[i], hashes[i - 1], `frame ${i} repeats frame ${i - 1} (a duplicated frame)`);
      }
      assert.ok(meanLuma(bin, out, 0) > 25, 'the very first frame is picture, not black');
      assert.ok(meanLuma(bin, out, 49) > 25, 'and so is the last');
      const meta = await getVideoMetadata(out);
      assert.equal(meta.fps, 25, 'frame rate is the source\'s');
      assert.equal(meta.width, 1080);
      assert.equal(meta.height, 1920);
      assert.ok(meta.hasAudio);
      assert.ok(Math.abs(meta.duration - 2) < 0.1, `duration ${meta.duration}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: with the hook intro the file is exactly hook + clip long, and ends on a real frame`, { skip: SKIP }, async () => {
    const { bin, out, dir } = await renderClip(plan, 1, name.replace(' ', '-') + '-hook');
    try {
      const hashes = frameHashes(bin, out);
      assert.equal(hashes.length, 75, `1 s hook + 2 s clip at 25 fps is exactly 75 frames (got ${hashes.length})`);
      assert.notEqual(hashes[hashes.length - 1], hashes[hashes.length - 2], 'last frame is not a repeat');
      assert.ok(meanLuma(bin, out, 0) > 25, 'the hook starts on picture');
      assert.ok(meanLuma(bin, out, 74) > 25, 'the clip ends on picture');
      // the dip to black at the join (hook fades out, clip fades in) really is dark
      assert.ok(meanLuma(bin, out, 25) < meanLuma(bin, out, 0) * 0.5, 'the join dips towards black');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: a timestamp-length hook (1.2s) is not shortened to the old 1s value`, { skip: SKIP }, async () => {
    const { bin, out, dir } = await renderClip(plan, 1.2, name.replace(' ', '-') + '-timestamp-hook', 0.4);
    try {
      const hashes = frameHashes(bin, out);
      assert.equal(hashes.length, 80, `1.2 s hook + 2 s clip at 25 fps is exactly 80 frames (got ${hashes.length})`);
      assert.ok(meanLuma(bin, out, 0) > 25, 'the hook starts on picture');
      assert.ok(meanLuma(bin, out, 79) > 25, 'the base clip ends on picture');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
