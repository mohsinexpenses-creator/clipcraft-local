import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVisualClips, evaluateVisualTimings, readTimingLines, type TimingRow } from '../scripts/eval-visuals';
import type { ClipRecord, ClipVisualOverlay } from '../lib/types';

const overlay: ClipVisualOverlay = { id: 'solar', quote: 'Chhat par solar panel lagwa rahe hain.', sentenceMeaningEn: 'Installing solar panels on the roof.', visualIntent: 'Rooftop solar panels', sourceStart: 0.5, sourceEnd: 3.5, clipRelativeStart: 0.5, clipRelativeEnd: 3.5, displayDuration: 3, outputWindows: [], category: 'situation', entityName: '', emotionalPolarity: 'neutral', confidence: 0.9, searchQueries: ['rooftop solar panels'], negativeCues: [], animation: 'subtle-zoom', placement: 'main', framing: 'illustrative', kind: 'photo-card', status: 'resolved', localFilePath: '/photo.jpg', visionScore: 9, visualVerificationHash: 'proof', preparedContentHash: 'bytes' };
const clip = { _id: 'clip', videoId: 'video', start: 0, end: 16.2, visualOverlays: [overlay, { ...overlay, id: 'keyword', kind: 'keyword-pop' }, { ...overlay, id: 'removed', status: 'removed' }, { ...overlay, id: 'wrong', status: 'skipped', skipReason: 'Vision rejected candidate' }] } as ClipRecord;

test('fill denominator includes empty/abstract buckets; keyword/removed/rejected/missing photos cannot inflate it', () => {
  const report = evaluateVisualClips([clip]);
  assert.equal(report.buckets, 3); assert.equal(report.accepted, 1); assert.equal(report.fillRate, 1 / 3); assert.equal(report.targetMet, false);
  assert.equal(report.details[0].beats[0].sentence, overlay.quote);
  assert.equal(report.details[0].beats[0].visionScore, 9);
  assert.equal(evaluateVisualClips([clip], new Map(), () => false).accepted, 0);
  assert.equal(evaluateVisualClips([]).targetMet, null);
});

test('timing evaluator separates prefetch/benchmarks from actual renders and requires comparable newer baseline pairs', () => {
  const before: TimingRow = { clipId: 'clip', timestamp: '2026-10-15', totalMs: 1000, ffmpegEncodeMs: 700, durationSeconds: 16.2, encoder: 'x264', preset: 'fast' };
  const after: TimingRow = { ...before, timestamp: '2026-10-16', totalMs: 1080 };
  const prefetch: TimingRow = { clipId: 'clip', phase: 'visual-prefetch', prefetchMs: 20000, plannerCalls: 1, visionCalls: 3, attempts: 4, geminiMs: 17000 };
  const replay: TimingRow = { ...prefetch, prefetchMs: 1, plannerCalls: 0, visionCalls: 0, attempts: 0, cacheHits: 1 };
  const summary = evaluateVisualTimings([before, after, prefetch, replay, { ...prefetch, cancelled: true }], [before]);
  assert.equal(summary.render.totalMs.count, 1); assert.equal(summary.render.totalMs.p50, 1080);
  assert.equal(summary.prefetch.uncachedMs.p50, 20000); assert.equal(summary.prefetch.cacheReplays, 1);
  assert.equal(summary.prefetch.httpAttempts, 4); assert.equal(summary.prefetch.visionCalls, 3);
  assert.equal(summary.baseline.pairedClips, 1); assert.ok(Math.abs(summary.baseline.meanDeltaPercent! - 8) < 0.0001);
  assert.equal(evaluateVisualTimings([before], [before]).baseline.pairedClips, 0);
  assert.equal(evaluateVisualTimings([{ ...after, encoder: 'nvenc' }], [before]).baseline.pairedClips, 0);
  assert.equal(evaluateVisualTimings([{ ...after, durationSeconds: 20 }], [before]).baseline.pairedClips, 0);
});

test('truncated timing logs are tolerated and empty data stays N/A, never an invented success', () => {
  const result = readTimingLines('{"clipId":"a","totalMs":123}\n{"phase":"visual-prefetch","prefetchMs":22}\n{"truncated":\nnull\n');
  assert.equal(result.rows.length, 2); assert.equal(result.malformed, 2);
  assert.equal(evaluateVisualTimings([]).render.totalMs.p50, null);
  assert.equal(evaluateVisualTimings([]).baseline.meanDeltaPercent, null);
});

test('read-only CLI demo prints Roman Urdu/Hindi and explicit strict skips without opening SQLite or claiming a live target', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const output = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/eval-visuals.ts', '--demo', '--json'], {
    encoding: 'utf8', env: { ...process.env, DATABASE_PATH: os.tmpdir() }, // Opening a directory as SQLite would fail.
  });
  const result = JSON.parse(output);
  assert.equal(result.offlineDemo, true); assert.equal(result.visuals.clips, 1);
  assert.equal(result.visuals.accepted, 0); assert.equal(result.visuals.targetMet, false);
  assert.equal(result.timings.render.totalMs.count, 0);
  assert.match(output, /Bijli nahi aa rahi/); assert.match(output, /खेतों/);
  assert.match(output, /vision not run/);
});
