import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Jimp } from 'jimp';
import { getFfmpegPath } from '../lib/ffmpeg';
import { resolveTimingsLogPath } from '../lib/timings';
import { buildVisualOverlayFilterStatements, type StillVisualOverlayInput } from '../worker/ffmpeg-pipeline';

/** Synthetic filter-only A/B, NOT full worker/Remotion or a Windows performance claim. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: npx tsx scripts/benchmark-visual-render.ts [--baseline COMMIT] [--rounds N]'); return; }
  let baseline = '09b7432'; let rounds = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline') baseline = args[++i] ?? '';
    else if (args[i] === '--rounds') rounds = Number(args[++i]);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!/^[a-f0-9]{7,40}$/i.test(baseline) || !Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('Use a commit hash and 1–20 rounds');
  const old = execFileSync('git', ['show', `${baseline}:worker/ffmpeg-pipeline.ts`], { encoding: 'utf8' });
  const start = old.indexOf('export function buildVisualOverlayFilterStatements(');
  const end = old.indexOf('export function buildOverlayFilterStatements(', start);
  if (start < 0 || end < 0) throw new Error('Baseline does not contain the expected filter builder');
  const scratch = path.resolve('.tmp'); fs.mkdirSync(scratch, { recursive: true });
  const modulePath = path.join(scratch, `visual-baseline-${randomUUID()}.ts`);
  fs.writeFileSync(modulePath, `import type { StillVisualOverlayInput } from '../worker/ffmpeg-pipeline';\nconst evenSize = (value: number, minimum = 2) => Math.max(minimum, Math.floor(value / 2) * 2);\nconst MAX_OUTPUT_WIDTH=1080, MAX_OUTPUT_HEIGHT=1920;\n${old.slice(start, end)}`);
  try {
    const previous = (await import(pathToFileURL(modulePath).href)).buildVisualOverlayFilterStatements as typeof buildVisualOverlayFilterStatements;
    const dir = path.resolve('data/visual-render-benchmark'); fs.mkdirSync(dir, { recursive: true });
    const ffmpeg = getFfmpegPath();
    const fixture = path.join(dir, 'prepared.fullscreen-v1.jpg');
    const image = new Jimp({ width: 1080, height: 1920, color: 0x285f8aff });
    image.scan(0, 0, 1080, 1920, (x, y, index) => {
      image.bitmap.data[index] = (Math.floor(x / 100) * 23 + Math.floor(y / 100) * 11) % 230;
      image.bitmap.data[index + 1] = (Math.floor(y / 50) * 13) % 230;
    });
    await image.write(fixture as `${string}.jpg`);
    const visuals: StillVisualOverlayInput[] = [0.6, 6].map((time, i) => ({ id: String(i), imagePath: fixture, x: 0, y: 0, width: 1080, height: 1920, start: time, end: time + 3, animation: 'subtle-zoom' }));
    const encode = (builder: typeof buildVisualOverlayFilterStatements, name: string, round: number) => {
      const graph = builder(visuals, [1, 2], '0:v', 'photos');
      const filter = [...graph.statements, `[${graph.lastLabel}]drawbox=x=250:y=1400:w=600:h=65:color=white:t=fill,format=yuv420p[out]`].join(';');
      const started = performance.now();
      const run = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'color=blue:s=1080x1920:r=30:d=10.8',
        '-loop', '1', '-framerate', '30', '-i', fixture, '-loop', '1', '-framerate', '30', '-i', fixture,
        '-filter_complex', filter, '-map', '[out]', '-t', '10.8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '2',
        path.join(dir, `${name}-${round}.mp4`)], { maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
      if (run.status !== 0) throw new Error(run.error?.message ?? run.stderr.toString());
      return Math.round(performance.now() - started);
    };
    const measurements: Array<{ round: number; beforeMs: number; afterMs: number; deltaPercent: number }> = [];
    for (let round = 1; round <= rounds; round++) {
      // Alternate order to reduce warm-cache/order bias.
      let beforeMs: number; let afterMs: number;
      if (round % 2) { beforeMs = encode(previous, 'before', round); afterMs = encode(buildVisualOverlayFilterStatements, 'after', round); }
      else { afterMs = encode(buildVisualOverlayFilterStatements, 'after', round); beforeMs = encode(previous, 'before', round); }
      measurements.push({ round, beforeMs, afterMs, deltaPercent: (afterMs / beforeMs - 1) * 100 });
      console.log(JSON.stringify(measurements[measurements.length - 1]));
    }
    const average = (key: 'beforeMs' | 'afterMs') => measurements.reduce((n, row) => n + row[key], 0) / rounds;
    const summary = { timestamp: new Date().toISOString(), phase: 'visual-render-benchmark', scope: 'Synthetic FFmpeg-filter-only; excludes Remotion/face analysis/network/prefetch; not a Windows or full-worker baseline', platform: os.platform(), cpu: os.cpus()[0]?.model,
      baselineCommit: baseline, durationSeconds: 10.8, width: 1080, height: 1920, fps: 30, encoder: 'libx264', preset: 'ultrafast', threads: 2, filterThreads: 1, measurements,
      beforeMs: Math.round(average('beforeMs')), afterMs: Math.round(average('afterMs')), deltaPercent: (average('afterMs') / average('beforeMs') - 1) * 100 };
    const timings = resolveTimingsLogPath(); fs.mkdirSync(path.dirname(timings), { recursive: true }); fs.appendFileSync(timings, `${JSON.stringify(summary)}\n`);
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally { fs.rmSync(modulePath, { force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
