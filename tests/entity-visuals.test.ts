import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { chooseEntity, resolvePublicEntity, inspectVisualFaces, passesVisualFacePolicy } from '../lib/entity-visuals';
import { planSentenceVisuals, selectVisualBeats, parseVisualBeats, type VisualBeat } from '../lib/visual-planner';
import { scoreVisualCandidate, resolveVisualOverlaysForClip } from '../lib/visual-providers';
import { makeSamplePngBuffer } from './visual-fixtures';
import type { VisualEntity } from '../lib/types';

const kaia: VisualEntity = { name: 'Kaia Gerber', type: 'person', description_en: 'American model actress', public_figure: true };
const beat = (i: number, score = 9): VisualBeat => ({ entities: [kaia], primary_entity: kaia.name, segmentIds: [i + 1], start: i * 6, end: i * 6 + 4, sentence_meaning_en: 'Kaia Gerber discusses her book club.', visual_subject_en: 'Kaia Gerber portrait', queries_en: ['Kaia Gerber portrait', 'book club reading', 'literary magazine books'], broll_queries_en: ['stacked books table'], negative_cues: [], kind: 'literal', visualizable_score: score });

test('whole-clip coreference routes She has her book club to Kaia, without a name keyword pop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-coref-'));
  const segments = [
    { id: 1, start: 0, end: 4, text: 'Not to be like a nepo hater... Kaia Gerber is a model.' },
    { id: 2, start: 6, end: 10, text: 'She has her book club and she loves reading.' },
  ];
  try {
    const result = await planSentenceVisuals({ transcript: { text: '', words: [], segments }, clipStart: 0, clipEnd: 12, maxVisualMoments: 12, cacheDir: dir,
      complete: async (request) => {
        assert.match(request.prompt, /nepo hater/); assert.match(request.prompt, /She has her book club/);
        assert.match(request.system ?? '', /WHOLE clip/); assert.match(request.system ?? '', /not become animated/);
        return { text: JSON.stringify({ beats: [beat(0), beat(1)] }) };
      } });
    assert.equal(result.length, 2);
    assert.ok(result.every((ov) => ov.primaryEntity?.name === 'Kaia Gerber' && ov.category === 'person' && ov.kind === 'photo-card'));
    assert.equal(result[1].sourceStart, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no unambiguous QID means no person photo; stock provider is forbidden even with an exact celebrity name', async (t) => {
  createTemporaryDatabase(t);
  const original = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = async (input, init) => { seen.push(String(input)); assert.match(new Headers(init?.headers).get('user-agent') ?? '', /ClipCraft-test/); return Response.json({ search: [] }); };
  try {
    const moments = selectVisualBeats([beat(0)], { clipStart: 0, clipEnd: 6, maxVisualMoments: 12 });
    const [result] = await resolveVisualOverlaysForClip([{ ...moments[0], brollQueries: [] }], { pexelsApiKey: 'valid-pexels-test', wikimediaUserAgent: 'ClipCraft-test (test@example.org)' });
    assert.equal(result.status, 'skipped'); assert.match(result.skipReason ?? '', /QID/);
    assert.equal(seen.length, 1); assert.match(seen[0], /wbsearchentities/);
    assert.equal(scoreVisualCandidate({ provider: 'pexels', assetId: 'fake', title: 'Kaia Gerber portrait', description: 'Kaia Gerber portrait', alt: '', tags: [], creator: 'Test', licenseRaw: 'pexels', sourcePageUrl: 'https://www.pexels.com/photo/fake', imageUrl: 'https://images.pexels.com/fake.jpg', width: 1080, height: 1920 }, moments[0]).accepted, false);
  } finally { globalThis.fetch = original; }
});

test('QID disambiguation uses descriptions and positive SQLite TTL cache, not faces', async (t) => {
  createTemporaryDatabase(t); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ search: [{ id: 'Q22673974', label: 'Kaia Gerber', description: 'American model and actress (born 2001)' }] }); };
  try {
    const one = await resolvePublicEntity(kaia, 'ClipCraft-test (test@example.org)');
    const two = await resolvePublicEntity(kaia, 'ClipCraft-test (test@example.org)');
    assert.equal(one?.qid, 'Q22673974'); assert.deepEqual(two, one); assert.equal(calls, 1);
    assert.equal(chooseEntity({ ...kaia, public_figure: false }, [{ id: 'Q1', label: kaia.name, description: 'model' }]), undefined);
    assert.equal(chooseEntity(kaia, [{ id: 'Q1', label: kaia.name, description: 'model' }, { id: 'Q2', label: kaia.name, description: 'model' }]), undefined);
  } finally { globalThis.fetch = original; }
});

test('lower-threshold ladder can reach seven per minute; repeated entity references permit different photos without overlaps', () => {
  const result = selectVisualBeats(Array.from({ length: 10 }, (_, i) => beat(i, 4)), { clipStart: 0, clipEnd: 60, threshold: 4, maxVisualMoments: 12 });
  assert.ok(result.length >= 7);
  for (let i = 0; i < result.length; i++) {
    assert.ok(result[i].displayDuration >= 2.4 && result[i].displayDuration <= 3.4);
    if (i) assert.ok(result[i].sourceStart >= result[i - 1].sourceEnd + 2);
  }
});

test('group shots and prominent faces in B-roll fail; real Node YuNet can inspect a face-free fixture', async () => {
  assert.equal(passesVisualFacePolicy({ width: 1080, height: 1920, total: 2, prominent: 2 }, false), false);
  assert.equal(passesVisualFacePolicy({ width: 1080, height: 1920, total: 1, prominent: 1 }, true), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunet-image-')); const file = path.join(dir, 'texture.png');
  fs.writeFileSync(file, makeSamplePngBuffer());
  try { const check = await inspectVisualFaces(file); assert.equal(check.prominent, 0); assert.equal(passesVisualFacePolicy(check, true), true); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generic numeric/word pops remain while explicit celebrity-name pops are removed', async () => {
  const { isNamedPersonKeywordPop } = await import('../lib/contextual-visuals');
  const person = selectVisualBeats([beat(0)], { clipStart: 0, clipEnd: 6, maxVisualMoments: 12 })[0];
  const pop = { ...person, category: 'statistic' as const, primaryEntity: undefined, kind: 'keyword-pop' as const, quote: 'Kaia', visualIntent: 'Kaia' };
  assert.equal(isNamedPersonKeywordPop(pop, [person]), true);
  assert.equal(isNamedPersonKeywordPop({ ...pop, quote: '2026', visualIntent: '100 books' }, [person]), false);
});

test('pipeline retains generic numbers/words but defers ALL photos to the sole sentence planner', async () => {
  const { normalizeGenericVisualPops } = await import('../lib/contextual-visuals');
  const generic = { kind: 'keyword-pop', category: 'statistic', quote: '100 books', entity_name: '100 books', confidence: 0.9, timestamp: { start: '1', end: '4' } };
  const result = normalizeGenericVisualPops({ rawMoments: [generic, { ...generic, kind: 'photo-card' }, { ...generic, category: 'person', entity_name: 'Kaia Gerber' }], clipStart: 0, clipEnd: 10, enabled: true, max: 12 });
  assert.equal(result.length, 1); assert.equal(result[0].entityName, '100 books'); assert.equal(result[0].kind, 'keyword-pop');
  assert.equal(normalizeGenericVisualPops({ rawMoments: [generic], clipStart: 0, clipEnd: 10, enabled: false, max: 12 }).length, 0);
});


test('planner cannot inject a QID or non-English identity description as trusted evidence', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  for (const entity of [{ ...kaia, qid: 'Q22673974' }, { ...kaia, description_en: 'actrice française' }]) {
    assert.throws(() => parseVisualBeats(JSON.stringify({ beats: [{ ...beat(0), entities: [entity] }] }), segments), /Invalid visual entities/);
  }
});
