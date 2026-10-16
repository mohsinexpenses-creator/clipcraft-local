import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { numberedVisualSegments, parseVisualBeats, planSentenceVisuals, selectVisualBeats, type VisualBeat } from '../lib/visual-planner';
import type { TranscriptData } from '../lib/types';

const transcript: TranscriptData = { text: '', words: [], segments: [
  { id: 7, start: 100, end: 104, text: 'Bijli nahi aa rahi, hum chhat par solar panel lagwa rahe hain.' },
  { id: 8, start: 105.4, end: 109, text: 'یہ بات سمجھنا مشکل ہے۔' },
  { id: 9, start: 110.8, end: 114, text: 'खेतों में पानी की कमी है।' },
] };
const beats: VisualBeat[] = [
  { segmentIds: [1], start: 100, end: 104, sentence_meaning_en: 'Power is unavailable, so we are installing rooftop solar panels.', visual_subject_en: 'Workers installing rooftop solar panels', queries_en: ['rooftop solar installation', 'sunlight energy independence', 'renewable energy panels'], negative_cues: ['nighttime', 'power station fire'], kind: 'literal', visualizable_score: 9 },
  { segmentIds: [2], start: 105.4, end: 109, sentence_meaning_en: 'This is difficult to understand.', visual_subject_en: 'Abstract understanding', queries_en: ['puzzled person thinking', 'complex tangled thread', 'deep thoughtful reflection'], negative_cues: [], kind: 'metaphor', visualizable_score: 3 },
  { segmentIds: [3], start: 110.8, end: 114, sentence_meaning_en: 'The fields are short of water.', visual_subject_en: 'Dry fields with cracked soil', queries_en: ['dry farmland soil', 'empty water bucket', 'agricultural drought field'], negative_cues: ['lush green crops', 'flooding'], kind: 'literal', visualizable_score: 9 },
];

test('Roman Urdu, Urdu and Hindi keep segment IDs/times without quote-string matching; English queries and cache contract', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-plan-'));
  let calls = 0;
  const options = { transcript, clipStart: 100, clipEnd: 116, maxVisualMoments: 12, cacheDir,
    complete: async (request: { prompt: string }) => {
      calls++;
      assert.match(request.prompt, /Bijli nahi aa rahi/);
      assert.match(request.prompt, /یہ بات/);
      assert.match(request.prompt, /खेतों/);
      return { text: JSON.stringify({ beats }) };
    },
  };
  try {
    const first = await planSentenceVisuals(options);
    assert.equal(first.length, 2);
    assert.deepEqual(first[0].segmentIds, [1]);
    assert.equal(first[0].searchQueries[0], 'rooftop solar installation');
    assert.deepEqual(await planSentenceVisuals(options), first);
    assert.equal(calls, 1);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('planner enforces max, score, distinct ideas, 2s speaker gap and hook dip exclusion', () => {
  const result = selectVisualBeats(beats, { clipStart: 100, clipEnd: 116, maxVisualMoments: 1, hookTiming: { start: 0, duration: 3 } });
  assert.equal(result.length, 1);
  assert.ok(result[0].sourceStart >= 100.5);
  assert.ok(result[0].outputWindows.every((window) => window.start >= 3.5));
  const duplicate = { ...beats[0], segmentIds: [3], start: 110.8, end: 114 };
  assert.equal(selectVisualBeats([beats[0], duplicate], { clipStart: 100, clipEnd: 116, maxVisualMoments: 12 }).length, 1);
  assert.deepEqual(selectVisualBeats(beats, { clipStart: 100, clipEnd: 116, maxVisualMoments: 0 }), []);
});

test('strict planner validation rejects unknown IDs, invented timing and keyword soup', () => {
  const segments = numberedVisualSegments(transcript, 100, 116);
  for (const change of [{ segmentIds: [99] }, { start: 101 }, { queries_en: ['first raw transcript words five', 'solar panels', 'energy independence'] }]) {
    assert.throws(() => parseVisualBeats(JSON.stringify({ beats: [{ ...beats[0], ...change }] }), segments));
  }
});
