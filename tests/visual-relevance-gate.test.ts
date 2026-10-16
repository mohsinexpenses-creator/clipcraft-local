import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSamplePngBuffer } from './visual-fixtures';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { getDatabase } from '../lib/db';
import { resetVisualProviderStateForTests, resolveVisualOverlaysForClip, scoreVisualCandidate, setVisualCacheDirForTests, type RawProviderCandidate } from '../lib/visual-providers';
import type { ClipVisualOverlay } from '../lib/types';

const moment: ClipVisualOverlay = {
  id: 'sentence-1', quote: 'Solar panels are being installed on our roof', sentenceMeaningEn: 'Workers install rooftop solar panels.',
  visualIntent: 'Workers installing rooftop solar panels', searchQueries: ['rooftop solar installation', 'sunlight energy independence', 'renewable energy panels'], negativeCues: [],
  sourceStart: 1, sourceEnd: 4, clipRelativeStart: 1, clipRelativeEnd: 4, displayDuration: 3, outputWindows: [{ segment: 'main', start: 1, end: 4 }],
  category: 'situation', entityName: '', emotionalPolarity: 'neutral', confidence: 0.9, animation: 'subtle-zoom', placement: 'main', framing: 'illustrative', kind: 'photo-card', status: 'planned',
};

test('one common token plus license/aspect/resolution bonuses cannot pass the content prefilter', () => {
  const candidate: RawProviderCandidate = { provider: 'pexels', assetId: '1', title: 'solar', description: '', alt: '', tags: [], creator: 'Test', licenseRaw: 'pexels', sourcePageUrl: 'https://www.pexels.com/photo/1', imageUrl: 'https://images.pexels.com/1.jpg', width: 1080, height: 1920 };
  assert.equal(scoreVisualCandidate(candidate, moment).accepted, false);
});

test('strict is fail-closed without vision, lenient is explicit, bank tags stay provider-owned and missing verdicts never accept', async (t) => {
  createTemporaryDatabase(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-gate-'));
  setVisualCacheDirForTests(dir); resetVisualProviderStateForTests();
  const original = globalThis.fetch;
  let visionMode: 'error' | 'empty' = 'error';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.pexels.com')) return Response.json({ photos: [1, 2, 3].map((id) => ({ id, width: 1080, height: 1920, alt: 'Workers installing rooftop solar panels', url: `https://www.pexels.com/photo/${id}`, src: { original: `https://images.pexels.com/${id}.png` }, photographer: 'Provider' })) });
    if (url.includes('images.pexels.com')) return new Response(new Uint8Array(makeSamplePngBuffer()), { headers: { 'content-type': 'image/png' } });
    if (url.includes('generativelanguage.googleapis.com')) return visionMode === 'error' ? new Response('', { status: 503 }) : Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"verdicts":[]}' }] } }] });
    return new Response('', { status: 404 });
  };
  const options = { pexelsApiKey: 'test-valid-pexels-key-1234', renderSettings: { visualProviders: { pexels: true, pixabay: false, unsplash: false, openverse: false, wikimedia: false }, visualVisionVerify: false } };
  try {
    const [strict] = await resolveVisualOverlaysForClip([moment], options);
    assert.equal(strict.status, 'skipped');
    assert.match(strict.skipReason ?? '', /key not configured/);
    const [lenient] = await resolveVisualOverlaysForClip([moment], { ...options, renderSettings: { ...options.renderSettings, visualRelevanceStrictness: 'lenient' } });
    assert.equal(lenient.status, 'resolved');
    assert.match(lenient.skipReason ?? '', /Lenient/);
    const row = getDatabase().prepare('SELECT tags FROM image_bank LIMIT 1').get() as { tags: string };
    assert.ok(!row.tags.includes('independence'), 'metaphor query tokens must never contaminate the bank');
    const [bankStrict] = await resolveVisualOverlaysForClip([moment], options);
    assert.equal(bankStrict.status, 'skipped', 'bank candidate cannot bypass vision');
    visionMode = 'empty';
    const [missing] = await resolveVisualOverlaysForClip([moment], { ...options, geminiApiKeys: ['test-valid-gemini-key-1234'] });
    assert.equal(missing.status, 'skipped');
    assert.match(missing.skipReason ?? '', /no verdict/);
  } finally { globalThis.fetch = original; setVisualCacheDirForTests(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('render has no provider resolution, bank lookup, planner completion or frame preparation', () => {
  const source = fs.readFileSync(path.resolve('worker/processor.ts'), 'utf8');
  for (const forbidden of ['resolveVisualOverlaysForClip', 'findMatchingImageBankEntry', 'preScaleCachedVisualImage', 'planSentenceVisuals', 'visualVisionVerify: false']) assert.ok(!source.includes(forbidden), forbidden);
});
