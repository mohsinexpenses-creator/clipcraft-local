import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ClipRecord, ClipVisualOverlay } from '../lib/types';
import { listClips } from '../lib/db';
import { resolveTimingsLogPath } from '../lib/timings';

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
    '| Clip | Source s | Beat / meaning | Entity / QID | Source / identity evidence | Face check | Query / title | Vision | Decision / reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...visuals.details.flatMap((clip) => clip.beats.length ? clip.beats.map((beat) => `| ${[beat.clipId, beat.sourceTime.toFixed(2), `${beat.sentence} / ${beat.meaning}`, `${beat.entity?.name ?? '—'} / ${beat.entity?.qid ?? 'no QID'}`, `${beat.source ?? '—'} / ${beat.identityEvidence ?? '—'}`, beat.faceCheck ? `${beat.faceCheck.prominent} prominent (${beat.faceCheck.total} total)` : 'not checked', `${beat.query} / ${beat.title}`, beat.visionScore, `${beat.decision}: ${beat.reason}`].map(cell).join(' | ')} |`) : [`| ${cell(clip.clipId)} | — | No photo beats | — | — | — | ${cell(clip.reason ?? 'No prefetch metadata')} |`]),
    '', ...visuals.details.map((clip) => `Images per 60s: ${clip.clipId}: ${clip.imagesPer60s.toFixed(1)}; floor ${clip.accepted}/${clip.floor}`), '', '## Timings', '```json', JSON.stringify(timings, null, 2), '```', '',
    report.caveat, ...warnings.map((warning) => `WARNING: ${warning}`),
    ...(missingDebug.length ? [`Missing debug files: ${missingDebug.length} (using clip metadata).`] : []),
  ];
  const output = json ? JSON.stringify(report, null, 2) : lines.join('\n');
  if (options['--output']) { fs.mkdirSync(path.dirname(path.resolve(options['--output'])), { recursive: true }); fs.writeFileSync(options['--output'], `${output}\n`); console.log(`Wrote ${options['--output']}`); }
  else console.log(output);
}

import type { ClipRenderTimingRecord, VisualPrefetchTimingRecord } from '../lib/timings';

export interface VisualDebugBeat {
  momentId: string; time?: number; sentence?: string; queriesTried?: string[];
  chosenQuery?: string; chosenTitle?: string; visionScore?: number; decision?: string; reason?: string;
  top3?: Array<{ candidateId: string; title?: string; textScore?: number; visionScore?: number | null }>;
}
export type TimingRow = Partial<ClipRenderTimingRecord & VisualPrefetchTimingRecord>;
const photo = (ov: ClipVisualOverlay) => ov.kind !== 'keyword-pop' && ov.kind !== 'zoom-beat' && ov.status !== 'removed';

export function evaluateVisualClips(clips: ClipRecord[], debug: Map<string, VisualDebugBeat[]> = new Map(), exists: (file: string) => boolean = () => true) {
  const details = clips.map((clip) => {
    const overlays = (clip.visualOverlays ?? []).filter(photo);
    const beats = overlays.map((ov) => {
      const trace = debug.get(clip._id)?.find((beat) => beat.momentId === ov.id);
      const missing = ov.status === 'resolved' && (!ov.localFilePath || !ov.visualVerificationHash || !ov.preparedContentHash || !exists(ov.localFilePath));
      return { clipId: clip._id, momentId: ov.id, sourceTime: ov.sourceStart, sourceEnd: ov.sourceEnd,
        entity: ov.primaryEntity, identityEvidence: ov.identityEvidence, faceCheck: ov.faceCheck, isBroll: ov.isBroll, source: ov.attribution?.provider,
        sentence: ov.quote, meaning: ov.sentenceMeaningEn ?? trace?.sentence ?? ov.quote,
        query: ov.chosenQuery ?? trace?.chosenQuery ?? ov.searchQueries[0] ?? '',
        queriesTried: trace?.queriesTried ?? ov.searchQueries,
        title: ov.attribution?.title ?? trace?.chosenTitle ?? '',
        visionScore: ov.visionScore ?? trace?.visionScore ?? null,
        decision: missing ? 'skipped' : ov.status === 'resolved' ? 'accepted' : 'skipped',
        reason: missing ? 'Verified local frame missing, incomplete or modified' : ov.skipReason ?? trace?.reason ?? (ov.status === 'resolved' ? '' : 'No verified frame; render skips without network'), candidates: trace?.top3 ?? [] };
    });
    const buckets = Math.max(0, Math.ceil((clip.end - clip.start) / 5.4));
    const accepted = beats.filter((beat) => beat.decision === 'accepted').length;
    return { clipId: clip._id, videoId: clip.videoId, imagesPer60s: clip.end > clip.start ? accepted * 60 / (clip.end - clip.start) : 0, floor: Math.ceil((clip.end - clip.start) * 7 / 60), buckets, accepted, fillRate: buckets ? accepted / buckets : null,
      reason: clip.visualsSkippedReason, prefetch: clip.visualsPrefetchStats, beats };
  });
  const buckets = details.reduce((sum, clip) => sum + clip.buckets, 0);
  const accepted = details.reduce((sum, clip) => sum + clip.accepted, 0);
  const fillRate = buckets ? accepted / buckets : null;
  return { clips: details.length, buckets, accepted, fillRate, target: 0.7, targetMet: fillRate === null ? null : fillRate >= 0.7, details };
}

export function readTimingLines(text: string): { rows: TimingRow[]; malformed: number } {
  const rows: TimingRow[] = []; let malformed = 0;
  for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
    try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as TimingRow); else malformed++; }
    catch { malformed++; }
  }
  return { rows, malformed };
}
function distribution(values: Array<number | undefined>) {
  const sorted = values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}
const render = (row: TimingRow) => !row.phase && typeof row.totalMs === 'number' && typeof row.clipId === 'string';
function latestRenders(rows: TimingRow[]) {
  const result = new Map<string, TimingRow>();
  for (const row of rows.filter(render)) if (!result.has(row.clipId!) || (row.timestamp ?? '') > (result.get(row.clipId!)?.timestamp ?? '')) result.set(row.clipId!, row);
  return result;
}

export function evaluateVisualTimings(rows: TimingRow[], baseline: TimingRow[] = []) {
  const renders = [...latestRenders(rows).values()];
  const prefetches = rows.filter((row) => row.phase === 'visual-prefetch' && !row.cancelled);
  const uncached = prefetches.filter((row) => (row.attempts ?? 0) > 0);
  const before = latestRenders(baseline);
  const pairs = renders.flatMap((after) => {
    const old = before.get(after.clipId!);
    if (!old || after.encoder !== old.encoder || after.preset !== old.preset || after.durationSeconds !== old.durationSeconds || (after.timestamp ?? '') <= (old.timestamp ?? '') || !old.totalMs) return [];
    return [{ clipId: after.clipId!, beforeMs: old.totalMs, afterMs: after.totalMs!, deltaPercent: (after.totalMs! / old.totalMs - 1) * 100 }];
  });
  return {
    render: { totalMs: distribution(renders.map((r) => r.totalMs)), ffmpegMs: distribution(renders.map((r) => r.ffmpegEncodeMs)), remotionMs: distribution(renders.map((r) => r.remotionOverlayMs)), visualsResolveMs: distribution(renders.map((r) => r.visualsResolveMs)) },
    prefetch: { records: prefetches.length, uncachedMs: distribution(uncached.map((r) => r.prefetchMs)), cacheReplays: prefetches.filter((r) => r.attempts === 0 && (r.cacheHits ?? 0) > 0).length,
      plannerCalls: prefetches.reduce((n, r) => n + (r.plannerCalls ?? 0), 0), visionCalls: prefetches.reduce((n, r) => n + (r.visionCalls ?? 0), 0), httpAttempts: prefetches.reduce((n, r) => n + (r.attempts ?? 0), 0),
      geminiCumulativeMs: distribution(uncached.map((r) => r.geminiMs)),
      plannerElapsedMs: distribution(prefetches.flatMap((r) => (r.geminiCalls ?? []).filter((c) => c.task === 'planner').map((c) => c.elapsedMs))),
      visionElapsedMs: distribution(prefetches.flatMap((r) => (r.geminiCalls ?? []).filter((c) => c.task === 'vision').map((c) => c.elapsedMs))) },
    baseline: { pairedClips: pairs.length, pairs, meanDeltaPercent: pairs.length ? pairs.reduce((n, p) => n + p.deltaPercent, 0) / pairs.length : null },
  };
}

if (/(?:^|[/\\])eval-visuals\.(?:ts|js)$/.test(process.argv[1] ?? '')) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
