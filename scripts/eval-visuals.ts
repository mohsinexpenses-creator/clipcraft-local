import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ClipRecord } from '../lib/types';
import { listClips } from '../lib/db';
import { resolveTimingsLogPath } from '../lib/timings';
import { evaluateVisualClips, evaluateVisualTimings, readTimingLines, type VisualDebugBeat } from '../lib/visual-evaluation';

async function main() {
  const args = process.argv.slice(2);
  const help = 'Usage: npx tsx scripts/eval-visuals.ts [--video ID] [--recent N] [--timings FILE] [--baseline FILE] [--json] [--output FILE] [--demo]';
  if (args.includes('--help')) { console.log(help); return; }
  const options: Record<string, string> = {}; let json = false; let demo = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo') { demo = true; continue; }
    if (args[i] === '--json') { json = true; continue; }
    if (!['--video', '--recent', '--timings', '--baseline', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(help);
    options[args[i]] = args[++i];
  }
  const recent = Number(options['--recent'] ?? 20);
  if (!Number.isInteger(recent) || recent < 1 || recent > 10000) throw new Error('--recent must be an integer from 1 to 10000');
  if (demo && options['--video']) throw new Error('--demo cannot select a real video');
  const source: ClipRecord[] = demo ? JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/visual-evaluation-demo.json'), 'utf8')) : await listClips(options['--video']);
  const clips = source.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a._id.localeCompare(b._id)).slice(0, recent);
  const ids = new Set(clips.map((clip) => clip._id));
  const debug = new Map<string, VisualDebugBeat[]>();
  const missingDebug: string[] = [];
  for (const clip of demo ? [] : clips) {
    try {
      const value = JSON.parse(fs.readFileSync(path.resolve('data/visual-debug', `${path.basename(clip._id)}.json`), 'utf8'));
      if (!Array.isArray(value.beats)) throw new Error('Invalid debug record');
      debug.set(clip._id, value.beats);
    } catch { missingDebug.push(clip._id); }
  }
  const warnings: string[] = [];
  const readTimings = (file: string | undefined) => {
    if (!file) return [];
    if (!fs.existsSync(file)) { warnings.push(`Timing file missing: ${file}`); return []; }
    const parsed = readTimingLines(fs.readFileSync(file, 'utf8'));
    if (parsed.malformed) warnings.push(`${parsed.malformed} malformed/truncated timing lines ignored in ${file}`);
    return parsed.rows.filter((row) => ids.has(row.clipId ?? ''));
  };
  const timingPath = resolveTimingsLogPath(options['--timings']);
  const expected = new Map(clips.flatMap((clip) => (clip.visualOverlays ?? []).map((ov) => [ov.localFilePath, ov.preparedContentHash] as const)));
  const visuals = evaluateVisualClips(clips, debug, (file) => {
    try { return fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected.get(file); } catch { return false; }
  });
  const timings = evaluateVisualTimings(demo ? [] : readTimings(timingPath), demo ? [] : readTimings(options['--baseline']));
  const report = { offlineDemo: demo, measuredAt: new Date().toISOString(), host: { platform: os.platform(), cpu: os.cpus()[0]?.model }, video: options['--video'] ?? 'recent clips', timingPath, missingDebug, warnings,
    caveat: 'Read-only metadata evaluation; vision acceptance is not human-verified relevance. Fill is accepted local photos / ceil(source duration / 5.4), including unfilled/abstract buckets. Do not lower the gate to hit 70%. Gemini elapsed time includes retries/RPM waits and parallel calls may overlap. Baseline pairs require same clip ID, duration, encoder/preset and a newer timestamp; other render settings must be controlled manually. No API requests or renders are performed.', visuals, timings };
  const pct = (n: number | null) => n === null ? 'N/A' : `${(n * 100).toFixed(1)}%`;
  const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const lines = [
    '# Visual evaluation', ...(demo ? ['', '**OFFLINE DEMO — scripted meanings/queries, no live provider or vision calls; all photos intentionally skipped.**'] : []), '', `Clips: ${visuals.clips}; photos/buckets: ${visuals.accepted}/${visuals.buckets}; fill: **${pct(visuals.fillRate)}** (target 70%, ${visuals.targetMet === null ? 'no samples' : visuals.targetMet ? 'met' : 'unmet — relevance first'}).`, '',
    '| Clip | Source s | Sentence / English meaning | Query | Chosen title | Vision | Decision / reason |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...visuals.details.flatMap((clip) => clip.beats.length ? clip.beats.map((beat) => `| ${[beat.clipId, beat.sourceTime.toFixed(2), `${beat.sentence} / ${beat.meaning}`, beat.query, beat.title, beat.visionScore, `${beat.decision}: ${beat.reason}`].map(cell).join(' | ')} |`) : [`| ${cell(clip.clipId)} | — | No photo beats | — | — | — | ${cell(clip.reason ?? 'No prefetch metadata')} |`]),
    '', '## Timings', '```json', JSON.stringify(timings, null, 2), '```', '',
    report.caveat, ...warnings.map((warning) => `WARNING: ${warning}`),
    ...(missingDebug.length ? [`Missing debug files: ${missingDebug.length} (using clip metadata).`] : []),
  ];
  const output = json ? JSON.stringify(report, null, 2) : lines.join('\n');
  if (options['--output']) { fs.mkdirSync(path.dirname(path.resolve(options['--output'])), { recursive: true }); fs.writeFileSync(options['--output'], `${output}\n`); console.log(`Wrote ${options['--output']}`); }
  else console.log(output);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
