import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { chooseEntity, resolvePublicEntity, inspectVisualFaces, passesVisualFacePolicy } from '../lib/entity-visuals';
import { planSentenceVisuals, selectVisualBeats, parseVisualBeats, parseVisualBeatsDetailed, normalizeVisualEntity, type VisualBeat, type VisualPlanValidation } from '../lib/visual-planner';
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


test('planner cannot inject a QID or trusted identity fields through extra entity keys', () => {
  const inferred = normalizeVisualEntity({ ...kaia, qid: 'Q22673974', commonsCategory: 'Kaia Gerber' });
  assert.ok(inferred.entity);
  assert.equal(inferred.entity.qid, undefined, 'a model-supplied QID is ignored, never trusted');
  assert.equal(inferred.entity.commonsCategory, undefined);
  // Unicode descriptions are accepted; only empty/whitespace is rejected.
  assert.equal(normalizeVisualEntity({ ...kaia, description_en: 'actrice française' }).entity?.description_en, 'actrice française');
  assert.match(normalizeVisualEntity({ ...kaia, description_en: '   ' }).entity?.description_en ?? 'missing', /^$/);
});

test('Beyoncé, curly quotes and em/en dashes pass entity and plan validation', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Beyoncé discusses her album.' }];
  const entity = { name: 'Beyoncé', type: 'person', description_en: 'Beyoncé\u2019s album \u2014 Renaissance', public_figure: true };
  const parsed = parseVisualBeats(JSON.stringify({ beats: [{
    ...beat(0), entities: [entity], primary_entity: 'Beyoncé',
    sentence_meaning_en: 'Beyoncé discusses her album \u2014 Renaissance.',
    visual_subject_en: 'Beyoncé portrait', queries_en: ['Beyoncé album cover', 'stage lights concert', 'pop superstar portrait'],
  }] }), segments);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].entities[0].name, 'Beyoncé');
  assert.equal(parsed[0].entities[0].description_en, "Beyoncé's album - Renaissance");
  assert.equal(parsed[0].primary_entity, 'Beyoncé');
  assert.equal(parsed[0].sentence_meaning_en, 'Beyoncé discusses her album - Renaissance.');
  assert.deepEqual(parsed[0].queries_en, ['Beyoncé album cover', 'stage lights concert', 'pop superstar portrait']);
});

test('one malformed beat is dropped with its reason while valid beats survive', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }, { id: 2, start: 6, end: 10, text: 'She reads a lot.' }];
  const result = parseVisualBeatsDetailed(JSON.stringify({ beats: [beat(0), { ...beat(1), segmentIds: [99] }, { ...beat(1), start: 99 }] }), segments);
  assert.equal(result.total, 3);
  assert.equal(result.beats.length, 1);
  assert.equal(result.dropped.length, 2);
  assert.match(result.dropped[0].reasons.join(' '), /Unknown visual segment ID/);
  assert.match(result.dropped[1].reasons.join(' '), /Visual times do not match segment IDs/);
});

test('a plan with no valid beat still throws', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  assert.throws(() => parseVisualBeats(JSON.stringify({ beats: [{ ...beat(0), segmentIds: [99] }] }), segments), /no valid beats/);
  assert.throws(() => parseVisualBeats('not json', segments), /Invalid visual plan/);
});

test('missing description_en/public_figure default instead of dropping the entity', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  const [parsed] = parseVisualBeats(JSON.stringify({ beats: [{
    ...beat(0), entities: [{ name: 'Kaia Gerber', type: 'person' }, { name: '', type: 'person' }, { name: 'Bad', type: 'alien' }],
    primary_entity: 'Kaia Gerber',
  }] }), segments);
  assert.deepEqual(parsed.entities, [{ name: 'Kaia Gerber', type: 'person', description_en: '', public_figure: false }]);
  assert.equal(parsed.primary_entity, 'Kaia Gerber');
});

test('a dropped primary entity becomes null without losing the beat', () => {
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  const [parsed] = parseVisualBeats(JSON.stringify({ beats: [{
    ...beat(0), entities: [{ name: '', type: 'person', description_en: '', public_figure: true }], primary_entity: 'Ghost Person',
  }] }), segments);
  assert.equal(parsed.primary_entity, null);
  assert.deepEqual(parsed.entities, []);
});

test('invalid plans are retried once with the validation errors, and only a valid plan is cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-retry-'));
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  const invalid = JSON.stringify({ beats: [{ ...beat(0), segmentIds: [99] }] });
  let calls = 0; const validations: VisualPlanValidation[] = [];
  try {
    const result = await planSentenceVisuals({ transcript: { text: '', words: [], segments }, clipStart: 0, clipEnd: 6, maxVisualMoments: 12, cacheDir: dir,
      onPlanValidation: (validation) => { validations.push(validation); },
      complete: async (request) => {
        calls += 1;
        if (calls === 1) return { text: invalid };
        assert.match(request.prompt, /previous_validation_errors/);
        assert.match(request.prompt, /Unknown visual segment ID/);
        return { text: JSON.stringify({ beats: [beat(0)] }) };
      } });
    assert.equal(calls, 2);
    assert.equal(result.length, 1);
    assert.equal(validations.at(-1)?.attempts, 2);
    assert.equal(validations.at(-1)?.retried, true);
    assert.equal(validations.at(-1)?.parsed, 1);
    assert.ok(fs.readdirSync(dir).some((name) => name.endsWith('.json')), 'a valid retried plan is cached');
    // The cached plan replays without another model call.
    await planSentenceVisuals({ transcript: { text: '', words: [], segments }, clipStart: 0, clipEnd: 6, maxVisualMoments: 12, cacheDir: dir,
      complete: async () => { throw new Error('cache replay must not call the model'); } });
    assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a plan that stays invalid after the retry throws and is never cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-invalid-'));
  const segments = [{ id: 1, start: 0, end: 4, text: 'Kaia Gerber discusses her book club.' }];
  let calls = 0;
  try {
    await assert.rejects(planSentenceVisuals({ transcript: { text: '', words: [], segments }, clipStart: 0, clipEnd: 6, maxVisualMoments: 12, cacheDir: dir,
      complete: async () => { calls += 1; return { text: JSON.stringify({ beats: [{ ...beat(0), segmentIds: [99] }] }) }; },
    }), /no valid beats/);
    assert.equal(calls, 2, 'one initial call plus one bounded retry');
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length, 0, 'failed parses are not cached');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
