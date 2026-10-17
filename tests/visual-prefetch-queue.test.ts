import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { saveSettingsSection } from '../lib/app-settings';
import { getClip, saveClip, saveVideo, updateClip } from '../lib/db';
import { claimNextJob, completeJob, enqueue, enqueueVisualPrefetchJob, getJob, recoverRunningJobs, VISUAL_PREFETCH_QUEUE_NAME, CLIP_QUEUE_NAME, TRANSCRIPTION_QUEUE_NAME } from '../lib/queue';
import { processVisualPrefetchJob } from '../lib/pipeline';
import { runVisualPrefetch } from '../lib/visual-prefetch';
import { setVisualCacheDirForTests, resetVisualProviderStateForTests } from '../lib/visual-providers';
import { makeSamplePngBuffer } from './visual-fixtures';
import type { ClipRecord, ClipVisualOverlay, VideoRecord, VisualPrefetchJobData } from '../lib/types';

function video(id: string, createdAt = '2026-10-16T00:00:00.000Z'): VideoRecord {
  return { _id: id, fileName: 'source.mp4', originalName: 'source.mp4', filePath: '/source.mp4', width: 1920, height: 1080, duration: 30, fileSize: 1,
    status: 'transcribed', createdAt, updatedAt: createdAt,
    transcript: { text: '', words: [], segments: [
      { id: 1, start: 0, end: 4, text: `Bijli nahi aa rahi, hum chhat par solar panel lagwa rahe hain. ${id}` },
      { id: 2, start: 5.4, end: 9.4, text: 'Kheton mein pani ki kami hai.' },
      { id: 3, start: 10.8, end: 14.8, text: 'Bachay school mein kitab parh rahe hain.' },
    ] } };
}
function clip(id: string, videoId: string): ClipRecord {
  return { _id: id, videoId, start: 0, end: 16.2, hookDuration: 0, hookText: '', filterPreset: 'none', captionPresetId: 'preset-bold-yellow', status: 'pending', autoVisuals: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test('two prefetch claims maximum; ready clip renders while sibling is unresolved; later videos remain FIFO-blocked and restart recovers work', async (t) => {
  createTemporaryDatabase(t);
  await saveVideo(video('old'));
  await saveVideo(video('new', '2026-10-16T01:00:00.000Z'));
  for (const id of ['a', 'b', 'c']) { await saveClip(clip(id, 'old')); await enqueueVisualPrefetchJob({ clipId: id, videoId: 'old', renderAfter: true }); }
  enqueue(TRANSCRIPTION_QUEUE_NAME, { videoId: 'new' }, { videoId: 'new' });
  const a = claimNextJob([VISUAL_PREFETCH_QUEUE_NAME])!;
  const b = claimNextJob([VISUAL_PREFETCH_QUEUE_NAME])!;
  assert.ok(a && b);
  assert.equal(claimNextJob([VISUAL_PREFETCH_QUEUE_NAME]), null, 'DB cap prevents a third prefetch');
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);
  await processVisualPrefetchJob(a.payload as VisualPrefetchJobData);
  const render = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(render, 'first render starts without waiting for sibling prefetch');
  assert.equal(render.clipId, a.clipId);
  assert.equal(getJob(b.id)?.status, 'running');
  completeJob(a.id, {}); completeJob(render.id, {});
  assert.equal(claimNextJob([TRANSCRIPTION_QUEUE_NAME]), null);
  assert.ok(recoverRunningJobs() >= 1);
  assert.equal(getJob(b.id)?.status, 'queued');
});

test('cancelled/deleted prefetch cannot resurrect a render handoff', async (t) => {
  createTemporaryDatabase(t);
  await saveVideo(video('cancel-source'));
  await saveClip(clip('cancel-clip', 'cancel-source'));
  await enqueueVisualPrefetchJob({ clipId: 'cancel-clip', videoId: 'cancel-source', renderAfter: true });
  const job = claimNextJob([VISUAL_PREFETCH_QUEUE_NAME])!;
  const current = (await getClip('cancel-clip'))!;
  current.cancelling = true; current.status = 'failed'; current.error = 'Cancelled by user.'; await updateClip(current);
  await processVisualPrefetchJob(job.payload as VisualPrefetchJobData);
  assert.equal(getJob('clip:cancel-clip'), null);
});

test('a transient network failure keeps already-resolved frames instead of downgrading the clip to zero', async (t) => {
  createTemporaryDatabase(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-preserve-'));
  const original = globalThis.fetch;
  const frame = path.join(dir, 'verified.fullscreen-v1.jpg');
  fs.writeFileSync(frame, makeSamplePngBuffer());
  const resolved: ClipVisualOverlay = {
    id: 'sentence-1-kept', quote: 'Bijli nahi aa rahi', sourceStart: 1, sourceEnd: 4,
    clipRelativeStart: 1, clipRelativeEnd: 4, displayDuration: 3,
    outputWindows: [{ segment: 'main', start: 1, end: 4 }], category: 'situation',
    entityName: '', visualIntent: 'Rooftop solar panels', emotionalPolarity: 'neutral',
    searchQueries: ['rooftop solar panels'], negativeCues: [], confidence: 0.9,
    animation: 'subtle-zoom', placement: 'main', framing: 'illustrative', kind: 'photo-card',
    status: 'resolved', localFilePath: frame, mediaUrl: '/api/media/visual-cache/verified.fullscreen-v1.jpg',
  };
  const id = randomUUID();
  await saveVideo(video(id));
  const record = { ...clip(`preserve-${id}`, id), autoVisuals: true, visualOverlays: [resolved] };
  await saveClip(record);
  await saveSettingsSection('ai', { geminiApiKeys: [`gemini-preserve-${id}`], geminiRequestsPerMinute: 1000 });
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await runVisualPrefetch(record._id, { cacheDir: path.join(dir, 'plans') });
    const saved = (await getClip(record._id))!;
    assert.equal(saved.visualOverlays?.[0]?.status, 'resolved', 'verified frame survives a failed refresh');
    assert.equal(saved.visualOverlays?.[0]?.localFilePath, frame);
    assert.match(saved.visualsSkippedReason ?? '', /Visual prefetch unavailable/);
    assert.doesNotMatch(saved.visualOverlays?.[0]?.skipReason ?? '', /Visual prefetch unavailable/);
  } finally { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uncached Roman Urdu clip makes one planner + one vision call, fills all three synthetic buckets; replay uses zero API requests', async (t) => {
  createTemporaryDatabase(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-flow-'));
  const original = globalThis.fetch;
  const id = randomUUID();
  await saveVideo(video(id));
  const record = { ...clip(`clip-${id}`, id), autoVisuals: true };
  await saveClip(record);
  await saveSettingsSection('ai', { geminiApiKeys: [`gemini-test-${id}`], pexelsApiKey: 'pexels-key-valid-1234', geminiRequestsPerMinute: 1000 });
  await saveSettingsSection('render', { maxVisualMoments: 12, visualProviders: { pexels: true, pixabay: false, unsplash: false, openverse: false, wikimedia: false } });
  setVisualCacheDirForTests(path.join(dir, 'images')); resetVisualProviderStateForTests();
  let planner = 0; let vision = 0;
  const queries = ['rooftop solar panels', 'dry farmland soil', 'children reading books'];
  const subjects = ['Workers installing rooftop solar panels', 'Dry farmland with cracked soil', 'Children reading books in school'];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      let text: string;
      if (body.systemInstruction) {
        planner++;
        const { segments } = JSON.parse(body.contents[0].parts[0].text);
        text = JSON.stringify({ beats: segments.map((segment: { id: number; start: number; end: number }, index: number) => ({ entities: [], primary_entity: null, segmentIds: [segment.id], start: segment.start, end: segment.end, sentence_meaning_en: subjects[index], visual_subject_en: subjects[index], queries_en: [queries[index], `metaphor topic ${index}`, `broad theme ${index}`], negative_cues: [], kind: 'literal', visualizable_score: 9 })) });
      } else {
        vision++;
        let momentId = '';
        const verdicts: object[] = [];
        for (const part of body.contents[0].parts) if (part.text?.startsWith('{')) {
          const item = JSON.parse(part.text);
          if (item.momentId) momentId = item.momentId;
          if (item.candidateId) verdicts.push({ momentId, candidateId: item.candidateId, relevance: 9 });
        }
        text = JSON.stringify({ verdicts });
      }
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
    }
    if (url.includes('api.pexels.com')) {
      const query = new URL(url).searchParams.get('query')!;
      const topic = Math.max(0, queries.indexOf(query));
      return Response.json({ photos: [1, 2, 3].map((n) => ({ id: topic * 10 + n, width: 1080, height: 1920, alt: subjects[topic], photographer: 'Fixture', url: `https://www.pexels.com/photo/${topic * 10 + n}`, src: { original: `https://images.pexels.com/${topic * 10 + n}.png` } })) });
    }
    if (url.includes('images.pexels.com')) {
      const number = Number(new URL(url).pathname.replace(/\D/g, ''));
      return new Response(new Uint8Array(makeSamplePngBuffer(1080, 1920, 50 + number)), { headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const successFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Temporary network outage'); };
    await runVisualPrefetch(record._id, { cacheDir: path.join(dir, 'plans') });
    assert.equal(fs.existsSync(path.join(dir, 'plans')) ? fs.readdirSync(path.join(dir, 'plans')).filter((name) => name.endsWith('.json')).length : 0, 0, 'transient failure must never be persisted as a whole result');
    globalThis.fetch = successFetch;
    const first = await runVisualPrefetch(record._id, { cacheDir: path.join(dir, 'plans') });
    assert.equal(first.cancelled, false);
    assert.equal(planner, 1); assert.equal(vision, 1);
    assert.equal(first.stats.attempts, 2);
    const saved = (await getClip(record._id))!;
    assert.equal(saved.visualOverlays?.filter((ov) => ov.status === 'resolved').length, 3);
    assert.ok(first.stats.prefetchMs < 25000);
    globalThis.fetch = async () => { throw new Error('Replay touched the network'); };
    const replay = await runVisualPrefetch(record._id, { cacheDir: path.join(dir, 'plans') });
    assert.equal(replay.stats.attempts, 0);
    assert.ok(replay.stats.cacheHits > 0);
  } finally { globalThis.fetch = original; setVisualCacheDirForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});
