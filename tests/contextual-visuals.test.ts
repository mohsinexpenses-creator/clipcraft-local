import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RENDER_SETTINGS,
  TranscriptData,
  ViralClip,
  VisualMomentPlan,
} from '../lib/types';
import {
  buildClipCreditsManifest,
  mapVisualMomentToOutputTimeline,
  planClipVisualMoments,
} from '../lib/contextual-visuals';
import {
  RawProviderCandidate,
  downloadVisualAssetSafely,
  evaluateVisualLicense,
  getProviderOrderForMoment,
  getVisualProviderStates,
  inspectImageBuffer,
  parseRetryAfterMs,
  resetVisualProviderStateForTests,
  resolveVisualOverlaysForClip,
  scoreVisualCandidate,
  searchOpenverseCandidates,
  searchPexelsCandidates,
  searchWikimediaCandidates,
  setVisualCacheDirForTests,
  updateProviderRateLimitFromResponse,
  validateSafeProviderDownloadUrl,
} from '../lib/visual-providers';
import { parseViralResponse } from '../lib/viral-response';
import {
  maskAiSecrets,
  resolveSettings,
  sanitizeSettingsSection,
} from '../lib/app-settings';
import { sanitizeClipEdits } from '../lib/clip-edits';
import { planVisualCardPlacement } from '../worker/overlay-layout';
import {
  buildOverlayFilterStatements,
  buildVisualOverlayFilterStatements,
} from '../worker/ffmpeg-pipeline';
import { validClip } from './viral-fixtures';

const SAMPLE_TRANSCRIPT: TranscriptData = {
  text:
    'In 1969 Apollo 11 landed on the Moon while mission control held its breath. ' +
    'Then the main alarm flashed red and fuel dropped below thirty seconds. ' +
    'Marie Curie pioneered radioactivity research in Paris despite enormous personal risk. ' +
    'Later in the discussion they mentioned Apollo 11 again as the ultimate teamwork test.',
  segments: [
    {
      id: 0,
      start: 60,
      end: 68,
      text: 'In 1969 Apollo 11 landed on the Moon while mission control held its breath.',
    },
    {
      id: 1,
      start: 68,
      end: 76,
      text: 'Then the main alarm flashed red and fuel dropped below thirty seconds.',
    },
    {
      id: 2,
      start: 76,
      end: 86,
      text: 'Marie Curie pioneered radioactivity research in Paris despite enormous personal risk.',
    },
    {
      id: 3,
      start: 86,
      end: 95,
      text: 'Later in the discussion they mentioned Apollo 11 again as the ultimate teamwork test.',
    },
  ],
  words: [
    { word: 'In', start: 60.0, end: 60.3 },
    { word: '1969', start: 60.3, end: 60.9 },
    { word: 'Apollo', start: 61.0, end: 61.5 },
    { word: '11', start: 61.5, end: 61.9 },
    { word: 'landed', start: 62.0, end: 62.6 },
    { word: 'on', start: 62.6, end: 62.8 },
    { word: 'the', start: 62.8, end: 63.0 },
    { word: 'Moon', start: 63.0, end: 63.6 },
    { word: 'while', start: 63.7, end: 64.1 },
    { word: 'mission', start: 64.1, end: 64.7 },
    { word: 'control', start: 64.7, end: 65.3 },
    { word: 'held', start: 65.3, end: 65.7 },
    { word: 'its', start: 65.7, end: 66.0 },
    { word: 'breath.', start: 66.0, end: 67.8 },
    { word: 'Then', start: 68.0, end: 68.4 },
    { word: 'the', start: 68.4, end: 68.6 },
    { word: 'main', start: 68.6, end: 69.0 },
    { word: 'alarm', start: 69.0, end: 69.6 },
    { word: 'flashed', start: 69.6, end: 70.2 },
    { word: 'red', start: 70.2, end: 70.7 },
    { word: 'and', start: 70.7, end: 71.0 },
    { word: 'fuel', start: 71.0, end: 71.5 },
    { word: 'dropped', start: 71.5, end: 72.1 },
    { word: 'below', start: 72.1, end: 72.6 },
    { word: 'thirty', start: 72.6, end: 73.2 },
    { word: 'seconds.', start: 73.2, end: 75.5 },
    { word: 'Marie', start: 76.0, end: 76.5 },
    { word: 'Curie', start: 76.5, end: 77.1 },
    { word: 'pioneered', start: 77.1, end: 77.8 },
    { word: 'radioactivity', start: 77.8, end: 78.7 },
    { word: 'research', start: 78.7, end: 79.3 },
    { word: 'in', start: 79.3, end: 79.5 },
    { word: 'Paris', start: 79.5, end: 80.1 },
    { word: 'despite', start: 80.1, end: 80.7 },
    { word: 'enormous', start: 80.7, end: 81.4 },
    { word: 'personal', start: 81.4, end: 82.0 },
    { word: 'risk.', start: 82.0, end: 85.5 },
    { word: 'Later', start: 86.0, end: 86.5 },
    { word: 'in', start: 86.5, end: 86.7 },
    { word: 'the', start: 86.7, end: 86.9 },
    { word: 'discussion', start: 86.9, end: 87.6 },
    { word: 'they', start: 87.6, end: 87.9 },
    { word: 'mentioned', start: 87.9, end: 88.5 },
    { word: 'Apollo', start: 88.5, end: 89.0 },
    { word: '11', start: 89.0, end: 89.4 },
    { word: 'again', start: 89.4, end: 89.9 },
    { word: 'as', start: 89.9, end: 90.2 },
    { word: 'the', start: 90.2, end: 90.4 },
    { word: 'ultimate', start: 90.4, end: 91.0 },
    { word: 'teamwork', start: 91.0, end: 91.8 },
    { word: 'test.', start: 91.8, end: 94.5 },
  ],
};

function makeSamplePngBuffer(width = 640, height = 480): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

function makeCandidate(overrides: Partial<RawProviderCandidate>): RawProviderCandidate {
  return {
    provider: 'openverse',
    assetId: 'cand-1',
    title: 'Sample Image',
    description: '',
    alt: '',
    tags: [],
    creator: 'Sample Creator',
    licenseRaw: 'cc0',
    sourcePageUrl: 'https://openverse.org/image/cand-1',
    imageUrl: 'https://live.staticflickr.com/sample.png',
    width: 1080,
    height: 1350,
    mimeType: 'image/png',
    ...overrides,
  };
}

test('parseViralResponse accepts clips with or without visualMoments and rejects malformed visualMoments', () => {
  const clipWithVisuals = validClip();
  const parsedWith = parseViralResponse(JSON.stringify({ clips: [clipWithVisuals] }), 3600);
  assert.equal(parsedWith.length, 1);
  assert.equal(parsedWith[0].clip.visualMoments?.length, 1);

  const clipWithoutVisuals: ViralClip = { ...validClip() };
  delete clipWithoutVisuals.visualMoments;
  const parsedWithout = parseViralResponse(JSON.stringify({ clips: [clipWithoutVisuals] }), 3600);
  assert.equal(parsedWithout.length, 1);
  assert.equal(parsedWithout[0].clip.visualMoments, undefined);

  const badVisualClip = {
    ...validClip(),
    visualMoments: [
      {
        ...validClip().visualMoments![0],
        category: 'invalid_category',
      },
    ],
  };
  assert.throws(
    () => parseViralResponse(JSON.stringify({ clips: [badVisualClip] }), 3600),
    /visualMoments/
  );
});

test('planClipVisualMoments validates against transcript words, expands single-word flashes, merges duplicates, and enforces max count & confidence threshold', () => {
  const rawMoments: VisualMomentPlan[] = [
    // 1. Named historical event with a tiny 0.4s timestamp -> expanded to complete beat (>= 2.5s)
    {
      quote: 'Apollo 11 landed on the Moon',
      timestamp: { start: '61.0', end: '61.4' },
      category: 'named_event',
      entity_name: 'Apollo 11',
      visual_intent: 'Apollo 11 lunar module on the Moon surface',
      emotional_polarity: 'tense',
      search_queries: ['Apollo 11 lunar module Moon', 'Apollo 11 landing 1969'],
      negative_cues: ['cartoon', 'toy'],
      confidence: 0.92,
      suggested_duration: 0.4,
      animation: 'subtle-zoom',
      placement: 'main',
    },
    // 2. Duplicate mention of Apollo 11 later in the clip -> merged with #1
    {
      quote: 'mentioned Apollo 11 again as the ultimate teamwork test',
      timestamp: { start: '87.9', end: '94.0' },
      category: 'named_event',
      entity_name: 'Apollo 11',
      visual_intent: 'Apollo 11 mission control teamwork',
      emotional_polarity: 'positive',
      search_queries: ['Apollo 11 mission control NASA'],
      negative_cues: [],
      confidence: 0.81,
      suggested_duration: 3.2,
      animation: 'fade',
      placement: 'main',
    },
    // 3. High-confidence generic tense action beat
    {
      quote: 'Then the main alarm flashed red and fuel dropped below thirty seconds',
      timestamp: { start: '68.0', end: '75.0' },
      category: 'situation',
      entity_name: '',
      visual_intent: 'Red warning alarm indicator on cockpit control panel',
      emotional_polarity: 'tense',
      search_queries: ['cockpit warning alarm red light', 'control panel alert gauge'],
      negative_cues: ['happy party', 'relaxing spa'],
      confidence: 0.84,
      suggested_duration: 3.5,
      animation: 'slide-up',
      placement: 'main',
    },
    // 4. Named public figure (3rd distinct moment, dropped when maxVisualMoments=2)
    {
      quote: 'Marie Curie pioneered radioactivity research in Paris',
      timestamp: { start: '76.0', end: '82.0' },
      category: 'person',
      entity_name: 'Marie Curie',
      visual_intent: 'Archival portrait of physicist Marie Curie in laboratory',
      emotional_polarity: 'positive',
      search_queries: ['Marie Curie portrait laboratory'],
      negative_cues: ['modern actress'],
      confidence: 0.78,
      suggested_duration: 3.5,
      animation: 'subtle-zoom',
      placement: 'main',
    },
    // 5. Low-confidence moment -> rejected by threshold
    {
      quote: 'while mission control held its breath',
      timestamp: { start: '64.0', end: '67.5' },
      category: 'emotion',
      entity_name: '',
      visual_intent: 'Anxious person holding breath',
      emotional_polarity: 'tense',
      search_queries: ['anxious person waiting'],
      negative_cues: [],
      confidence: 0.42,
      suggested_duration: 3.0,
      animation: 'fade',
      placement: 'main',
    },
    // 6. Unmatched quote completely absent from transcript -> rejected
    {
      quote: 'This sentence never appears anywhere in the transcript at all',
      timestamp: { start: '10.0', end: '14.0' },
      category: 'concept',
      entity_name: '',
      visual_intent: 'Unmatched concept',
      emotional_polarity: 'neutral',
      search_queries: ['abstract concept'],
      negative_cues: [],
      confidence: 0.95,
      suggested_duration: 3.0,
      animation: 'fade',
      placement: 'main',
    },
  ];

  const plannedDefault = planClipVisualMoments({
    rawMoments,
    clipStart: 60,
    clipEnd: 95,
    transcript: SAMPLE_TRANSCRIPT,
    hookTiming: { start: 8, duration: 4 },
    options: {
      autoVisuals: true,
      maxVisualMoments: 2,
      confidenceThreshold: 0.65,
      minDuration: 2.5,
      defaultDuration: 3.5,
    },
  });

  assert.equal(plannedDefault.length, 2, 'default cap is 2 high-value visual moments');
  assert.equal(plannedDefault[0].entityName, 'Apollo 11');
  assert.ok(
    plannedDefault[0].displayDuration >= 2.5,
    `never a single-word flash; got ${plannedDefault[0].displayDuration}s`
  );
  assert.ok(
    plannedDefault[0].searchQueries.includes('Apollo 11 mission control NASA'),
    'duplicate mentions of the same entity merge their search queries'
  );
  assert.equal(plannedDefault[0].framing, 'editorial');
  assert.equal(plannedDefault[1].category, 'situation');
  assert.equal(plannedDefault[1].framing, 'illustrative');

  // Configurable up to 3 moments
  const plannedThree = planClipVisualMoments({
    rawMoments,
    clipStart: 60,
    clipEnd: 95,
    transcript: SAMPLE_TRANSCRIPT,
    hookTiming: { start: 8, duration: 4 },
    options: {
      autoVisuals: true,
      maxVisualMoments: 3,
      confidenceThreshold: 0.65,
    },
  });
  assert.equal(plannedThree.length, 3);
  assert.equal(plannedThree[2].entityName, 'Marie Curie');
});

test('mapVisualMomentToOutputTimeline accurately maps source times across [replayed hook][0.5s dip][full segment]', () => {
  const mainOnly = mapVisualMomentToOutputTimeline({
    sourceStart: 68.5,
    sourceEnd: 71.5,
    clipStart: 60,
    clipEnd: 120,
    placement: 'main',
    hookTiming: { start: 8, duration: 4 },
  });
  assert.equal(mainOnly.effectivePlacement, 'main');
  assert.deepEqual(mainOnly.outputWindows, [
    { segment: 'main', start: 12.5, end: 15.5 },
  ]);

  const nearCut = mapVisualMomentToOutputTimeline({
    sourceStart: 60.1,
    sourceEnd: 63.1,
    clipStart: 60,
    clipEnd: 120,
    placement: 'main',
    hookTiming: { start: 8, duration: 4 },
  });
  assert.ok(
    nearCut.outputWindows[0].start >= 4.5,
    `expected main window to start after dip-to-black (4.5s), got ${nearCut.outputWindows[0].start}`
  );

  const both = mapVisualMomentToOutputTimeline({
    sourceStart: 68.5,
    sourceEnd: 71.5,
    clipStart: 60,
    clipEnd: 120,
    placement: 'both',
    hookTiming: { start: 8, duration: 4 },
    allowDuplicateHookReplay: true,
  });
  assert.equal(both.effectivePlacement, 'both');
  assert.equal(both.outputWindows.length, 2);
  assert.equal(both.outputWindows[0].segment, 'hook');
  assert.ok(both.outputWindows[0].end <= 3.5, 'hook visual ends before 0.5s fade-to-black');
  assert.equal(both.outputWindows[1].segment, 'main');
  assert.equal(both.outputWindows[1].start, 12.5);
});

test('provider router selects Pexels first for generic stock situations and Openverse/Wikimedia first for named entities', () => {
  const genericOrder = getProviderOrderForMoment({
    moment: { category: 'situation', entityName: '' },
    renderSettings: DEFAULT_RENDER_SETTINGS,
    hasPexelsKey: true,
  });
  assert.deepEqual(genericOrder, ['pexels', 'openverse', 'wikimedia']);

  const genericWithoutKey = getProviderOrderForMoment({
    moment: { category: 'action', entityName: '' },
    renderSettings: DEFAULT_RENDER_SETTINGS,
    hasPexelsKey: false,
  });
  assert.deepEqual(genericWithoutKey, ['openverse', 'wikimedia']);

  const personOrder = getProviderOrderForMoment({
    moment: { category: 'person', entityName: 'Marie Curie' },
    renderSettings: DEFAULT_RENDER_SETTINGS,
    hasPexelsKey: true,
  });
  assert.deepEqual(personOrder, ['openverse', 'wikimedia', 'pexels']);

  const placeOrder = getProviderOrderForMoment({
    moment: { category: 'place', entityName: 'Eiffel Tower' },
    renderSettings: DEFAULT_RENDER_SETTINGS,
    hasPexelsKey: true,
  });
  assert.deepEqual(placeOrder, ['openverse', 'wikimedia', 'pexels']);
});

test('evaluateVisualLicense accepts reusable/modifiable licenses and rejects NC, ND, and unknown licenses', () => {
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'pexels', licenseRaw: 'Pexels License' })).allowed,
    true
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'openverse', licenseRaw: 'cc0' })).allowed,
    true
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'openverse', licenseRaw: 'pdm' })).allowed,
    true
  );

  const ccBy = evaluateVisualLicense(
    makeCandidate({ provider: 'openverse', licenseRaw: 'by', licenseVersion: '4.0' })
  );
  assert.equal(ccBy.allowed, true);
  assert.equal(ccBy.requiresAttribution, true);
  assert.equal(ccBy.shareAlike, false);

  const ccBySa = evaluateVisualLicense(
    makeCandidate({ provider: 'wikimedia', licenseRaw: 'CC BY-SA 4.0' })
  );
  assert.equal(ccBySa.allowed, true);
  assert.equal(ccBySa.requiresAttribution, true);
  assert.equal(ccBySa.shareAlike, true);

  // Non-Commercial and No-Derivatives must be rejected
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'openverse', licenseRaw: 'by-nc' })).allowed,
    false
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'openverse', licenseRaw: 'by-nd' })).allowed,
    false
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'openverse', licenseRaw: 'by-nc-sa' })).allowed,
    false
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'wikimedia', licenseRaw: 'CC BY-NC-ND 3.0' })).allowed,
    false
  );
  assert.equal(
    evaluateVisualLicense(makeCandidate({ provider: 'wikimedia', licenseRaw: 'All rights reserved' })).allowed,
    false
  );
});

test('scoreVisualCandidate enforces exact identity matching for named people and penalizes negative cues', () => {
  const personMoment = {
    category: 'person' as const,
    entityName: 'Marie Curie',
    visualIntent: 'Archival portrait of physicist Marie Curie in laboratory',
    emotionalPolarity: 'positive' as const,
    searchQueries: ['Marie Curie portrait laboratory'],
    negativeCues: ['modern actress', 'illustration'],
    quote: 'Marie Curie pioneered radioactivity research in Paris',
  };

  const exactPerson = scoreVisualCandidate(
    makeCandidate({
      provider: 'wikimedia',
      assetId: '1',
      title: 'Marie Curie Nobel portrait in Paris laboratory',
      description: 'Archival photograph of physicist Marie Curie, Public Domain',
      tags: ['marie', 'curie', 'physicist', 'portrait'],
      creator: 'Henri Manuel',
      licenseRaw: 'Public Domain',
      sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Marie_Curie.jpg',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/marie_curie.jpg',
      width: 1200,
      height: 1600,
    }),
    personMoment
  );
  assert.equal(exactPerson.accepted, true);
  assert.equal(exactPerson.framing, 'editorial');

  const wrongPerson = scoreVisualCandidate(
    makeCandidate({
      provider: 'pexels',
      assetId: '2',
      title: 'Scientist looking into microscope in modern laboratory',
      description: 'Portrait of a physicist in a lab coat',
      tags: ['scientist', 'laboratory', 'portrait'],
      creator: 'Jane Doe',
      licenseRaw: 'Pexels License',
      sourcePageUrl: 'https://www.pexels.com/photo/2/',
      imageUrl: 'https://images.pexels.com/photos/2/lab.jpeg',
      width: 1200,
      height: 1600,
    }),
    personMoment
  );
  assert.equal(
    wrongPerson.accepted,
    false,
    'never substitute an unrelated person when a specific named person was requested'
  );

  // Negative cues exclusion on generic situation
  const tenseMoment = {
    category: 'situation' as const,
    entityName: '',
    visualIntent: 'Red warning alarm indicator on cockpit control panel',
    emotionalPolarity: 'tense' as const,
    searchQueries: ['cockpit warning alarm red light'],
    negativeCues: ['happy party', 'smiling celebration'],
    quote: 'Then the main alarm flashed red and fuel dropped below thirty seconds',
  };

  const contradictedCandidate = scoreVisualCandidate(
    makeCandidate({
      provider: 'pexels',
      assetId: '3',
      title: 'Happy party smiling celebration under red light',
      description: 'Friends celebrating at a party',
      tags: ['happy', 'party', 'smiling', 'celebration', 'red', 'light'],
      creator: 'John Smith',
      licenseRaw: 'Pexels License',
      sourcePageUrl: 'https://www.pexels.com/photo/3/',
      imageUrl: 'https://images.pexels.com/photos/3/party.jpeg',
      width: 1080,
      height: 1350,
    }),
    tenseMoment
  );
  assert.equal(contradictedCandidate.accepted, false);
});

test('rate-limit headers and Retry-After are parsed and tracked without hard-coded limits', () => {
  resetVisualProviderStateForTests();

  assert.equal(parseRetryAfterMs(new Headers({ 'Retry-After': '7' })), 7000);
  const futureDate = new Date(Date.now() + 12_000).toUTCString();
  const parsedDateMs = parseRetryAfterMs(new Headers({ 'Retry-After': futureDate }));
  assert.ok(parsedDateMs >= 9000 && parsedDateMs <= 15_000);

  const pexels200 = new Response('{}', {
    status: 200,
    headers: {
      'X-Ratelimit-Limit': '200',
      'X-Ratelimit-Remaining': '184',
      'X-Ratelimit-Reset': '1791763200',
    },
  });
  updateProviderRateLimitFromResponse('pexels', pexels200);
  let snapshot = getVisualProviderStates();
  assert.equal(snapshot.pexels.limit, 200);
  assert.equal(snapshot.pexels.remaining, 184);
  assert.equal(snapshot.pexels.resetAtEpochSeconds, 1791763200);

  const wikimedia429 = new Response('Too Many Requests', {
    status: 429,
    headers: {
      'Retry-After': '9',
    },
  });
  updateProviderRateLimitFromResponse('wikimedia', wikimedia429);
  snapshot = getVisualProviderStates();
  assert.equal(snapshot.wikimedia.lastStatus, 429);
  assert.ok(snapshot.wikimedia.backoffUntilMs > Date.now() + 7000);
  resetVisualProviderStateForTests();
});

test('SSRF and image download safety checks block non-HTTPS, private IPs, unapproved hosts, and invalid magic bytes', () => {
  assert.equal(
    validateSafeProviderDownloadUrl('https://images.pexels.com/photos/123/pexels-photo-123.jpeg').hostname,
    'images.pexels.com'
  );
  assert.equal(
    validateSafeProviderDownloadUrl('https://upload.wikimedia.org/wikipedia/commons/a/b/Test.png').hostname,
    'upload.wikimedia.org'
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('http://images.pexels.com/photos/123/pexels-photo-123.jpeg'),
    /non-HTTPS/
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('https://127.0.0.1/secret.png'),
    /private or loopback/
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('https://169.254.169.254/latest/meta-data/'),
    /private or loopback/
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('https://192.168.1.10/image.png'),
    /private or loopback/
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('https://172.20.0.5/image.png'),
    /private or loopback/
  );
  assert.throws(
    () => validateSafeProviderDownloadUrl('https://evil.example.com/photo.jpg'),
    /unapproved image host/
  );

  const validPng = makeSamplePngBuffer(800, 600);
  const inspected = inspectImageBuffer(validPng);
  assert.deepEqual(inspected, {
    format: 'png',
    mimeType: 'image/png',
    extension: 'png',
    width: 800,
    height: 600,
  });

  const fakeHtml = Buffer.from('<!DOCTYPE html><html><body>Not an image</body></html>', 'utf8');
  assert.throws(() => inspectImageBuffer(fakeHtml), /Unsupported or invalid image magic bytes/);
});

test('provider adapters normalize Pexels, Openverse (anonymous + OAuth2), and Wikimedia responses, cache queries, and download assets to local cache', async () => {
  resetVisualProviderStateForTests();

  const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-visual-test-'));
  setVisualCacheDirForTests(tempCacheDir);
  const samplePng = makeSamplePngBuffer(1080, 1350);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith('https://api.pexels.com/v1/search')) {
      const auth = new Headers(init?.headers).get('Authorization');
      assert.equal(auth, 'pexels-test-key-123456');
      return new Response(
        JSON.stringify({
          photos: [
            {
              id: 901,
              width: 1080,
              height: 1350,
              url: 'https://www.pexels.com/photo/red-cockpit-alarm-901/',
              photographer: 'Alex Pilot',
              photographer_url: 'https://www.pexels.com/@alexpilot',
              alt: 'Cockpit warning alarm red light gauge on control panel',
              src: {
                large2x: 'https://images.pexels.com/photos/901/alarm.png',
                large: 'https://images.pexels.com/photos/901/alarm.png',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Ratelimit-Limit': '200',
            'X-Ratelimit-Remaining': '199',
            'X-Ratelimit-Reset': '1791763200',
          },
        }
      );
    }

    if (url.startsWith('https://api.openverse.org/v1/auth_tokens/token/')) {
      return new Response(
        JSON.stringify({
          access_token: 'ov-oauth-token-123',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.startsWith('https://api.openverse.org/v1/images/')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'ov-apollo-11',
              title: 'Apollo 11 Lunar Module on the Moon surface 1969',
              foreign_landing_url: 'https://www.nasa.gov/apollo11-lunar-module',
              url: 'https://live.staticflickr.com/apollo11_moon.png',
              creator: 'NASA / Neil Armstrong',
              creator_url: 'https://www.nasa.gov',
              license: 'cc0',
              license_version: '1.0',
              license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
              width: 1200,
              height: 900,
              mature: false,
              tags: [{ name: 'apollo' }, { name: 'moon' }, { name: 'lunar' }],
            },
            {
              id: 'ov-nc-excluded',
              title: 'Apollo 11 poster non-commercial',
              foreign_landing_url: 'https://example.org/nc',
              url: 'https://live.staticflickr.com/apollo11_nc.png',
              creator: 'Poster Artist',
              license: 'by-nc',
              width: 1200,
              height: 900,
              mature: false,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.startsWith('https://commons.wikimedia.org/w/api.php')) {
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              '100': {
                pageid: 100,
                title: 'File:Marie Curie Nobel portrait.png',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/wikipedia/commons/marie_curie.png',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Marie_Curie_Nobel_portrait.png',
                    width: 1000,
                    height: 1400,
                    mime: 'image/png',
                    extmetadata: {
                      ObjectName: { value: 'Marie Curie archival portrait in Paris laboratory' },
                      ImageDescription: { value: 'Physicist Marie Curie in her Paris laboratory' },
                      Artist: { value: 'Henri Manuel' },
                      LicenseShortName: { value: 'Public domain' },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (
      url === 'https://images.pexels.com/photos/901/alarm.png' ||
      url === 'https://live.staticflickr.com/apollo11_moon.png' ||
      url === 'https://upload.wikimedia.org/wikipedia/commons/marie_curie.png'
    ) {
      return new Response(new Uint8Array(samplePng), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(samplePng.length),
        },
      });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const pexelsCandidates = await searchPexelsCandidates(
      'cockpit warning alarm red light',
      'pexels-test-key-123456'
    );
    assert.equal(pexelsCandidates.length, 1);
    assert.equal(pexelsCandidates[0].attributionRaw, 'Photo by Alex Pilot on Pexels');

    const openverseCandidates = await searchOpenverseCandidates('Apollo 11 lunar module Moon', {
      clientId: 'openverse-client-id-123',
      clientSecret: 'openverse-client-secret-123',
    });
    assert.equal(openverseCandidates.length, 2);
    assert.equal(evaluateVisualLicense(openverseCandidates[0]).allowed, true);
    assert.equal(evaluateVisualLicense(openverseCandidates[1]).allowed, false, 'by-nc is rejected');

    const wikiCandidates = await searchWikimediaCandidates('Marie Curie portrait laboratory', {
      userAgent: 'ClipCraftTest/1.0',
    });
    assert.equal(wikiCandidates.length, 1);
    assert.equal(evaluateVisualLicense(wikiCandidates[0]).licenseCode, 'pdm');

    const planned = planClipVisualMoments({
      rawMoments: [
        {
          quote: 'Apollo 11 landed on the Moon',
          timestamp: { start: '61.0', end: '64.5' },
          category: 'named_event',
          entity_name: 'Apollo 11',
          visual_intent: 'Apollo 11 lunar module on the Moon surface',
          emotional_polarity: 'tense',
          search_queries: ['Apollo 11 lunar module Moon'],
          negative_cues: [],
          confidence: 0.91,
          suggested_duration: 3.5,
          animation: 'subtle-zoom',
          placement: 'main',
        },
        {
          quote: 'Then the main alarm flashed red and fuel dropped below thirty seconds',
          timestamp: { start: '68.0', end: '74.0' },
          category: 'situation',
          entity_name: '',
          visual_intent: 'Cockpit warning alarm red light gauge on control panel',
          emotional_polarity: 'tense',
          search_queries: ['cockpit warning alarm red light'],
          negative_cues: [],
          confidence: 0.88,
          suggested_duration: 3.5,
          animation: 'slide-up',
          placement: 'main',
        },
      ],
      clipStart: 60,
      clipEnd: 95,
      transcript: SAMPLE_TRANSCRIPT,
      hookTiming: { start: 8, duration: 4 },
    });

    const resolved = await resolveVisualOverlaysForClip(planned, {
      renderSettings: DEFAULT_RENDER_SETTINGS,
      pexelsApiKey: 'pexels-test-key-123456',
      openverseClientId: 'openverse-client-id-123',
      openverseClientSecret: 'openverse-client-secret-123',
    });

    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].status, 'resolved');
    assert.equal(resolved[0].attribution?.provider, 'openverse');
    assert.ok(resolved[0].localFilePath && fs.existsSync(resolved[0].localFilePath));
    assert.match(resolved[0].mediaUrl ?? '', /^\/api\/media\/visual-cache\//);

    assert.equal(resolved[1].status, 'resolved');
    assert.equal(resolved[1].attribution?.provider, 'pexels');
    assert.equal(resolved[1].attribution?.providerAttributionText, 'Photos provided by Pexels');

    const manifest = buildClipCreditsManifest({
      clipId: 'clip_123',
      videoId: 'video_456',
      clipTitle: 'Apollo 11 Alarm Moment',
      visualOverlays: resolved,
    });
    assert.equal(manifest.usesPexels, true);
    assert.match(manifest.plainText, /Photos provided by Pexels/);
    assert.match(manifest.plainText, /Photo by Alex Pilot on Pexels/);
  } finally {
    globalThis.fetch = originalFetch;
    setVisualCacheDirForTests(null);
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  }
});

test('lack of suitable image marks overlay as skipped and never throws', async () => {
  resetVisualProviderStateForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ results: [], photos: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const planned = planClipVisualMoments({
      rawMoments: [
        {
          quote: 'Apollo 11 landed on the Moon',
          timestamp: { start: '61.0', end: '64.5' },
          category: 'named_event',
          entity_name: 'Apollo 11',
          visual_intent: 'Apollo 11 lunar module on the Moon surface',
          emotional_polarity: 'tense',
          search_queries: ['Apollo 11 lunar module Moon'],
          negative_cues: [],
          confidence: 0.91,
          suggested_duration: 3.5,
          animation: 'subtle-zoom',
          placement: 'main',
        },
      ],
      clipStart: 60,
      clipEnd: 95,
      transcript: SAMPLE_TRANSCRIPT,
    });

    const resolved = await resolveVisualOverlaysForClip(planned, {
      renderSettings: DEFAULT_RENDER_SETTINGS,
    });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].status, 'skipped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadVisualAssetSafely rejects redirect to private IP', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: {
        Location: 'https://127.0.0.1/internal.png',
      },
    });

  try {
    await assert.rejects(
      () =>
        downloadVisualAssetSafely({
          imageUrl: 'https://images.pexels.com/photos/901/alarm.png',
        }),
      /private or loopback/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings and clip-edits sanitize visual fields and mask Pexels/Openverse secrets', () => {
  const aiSanitized = sanitizeSettingsSection(
    'ai',
    {
      pexelsApiKey: 'pexels_secret_1234567890',
      openverseClientId: 'openverse_client_12345678',
      openverseClientSecret: 'openverse_secret_98765432',
      wikimediaUserAgent: 'MyClipCraft/1.0 (https://example.org)',
    },
    {}
  );
  const masked = maskAiSecrets(aiSanitized);
  assert.ok(!String(masked.pexelsApiKey ?? '').includes('123456'), 'Pexels API key must be masked');
  assert.ok(!String(masked.openverseClientId ?? '').includes('123456'), 'Openverse Client ID must be masked');
  assert.ok(!String(masked.openverseClientSecret ?? '').includes('987654'), 'Openverse Client Secret must be masked');

  const resolved = resolveSettings({ ai: aiSanitized });
  assert.equal(resolved.effective.ai.wikimediaUserAgent, 'MyClipCraft/1.0 (https://example.org)');
  assert.equal(resolved.effective.render.autoVisuals, true);
  assert.equal(resolved.effective.render.maxVisualMoments, 2);

  const edits = sanitizeClipEdits({
    start: 60,
    end: 95,
    autoVisuals: true,
    visualOverlays: [
      {
        id: 'vm-1',
        quote: 'Apollo 11 landed on the Moon',
        sourceStart: 61,
        sourceEnd: 64.5,
        placement: 'main',
        animation: 'slide-up',
        category: 'named_event',
        emotionalPolarity: 'tense',
      },
    ],
  });
  assert.equal(edits.autoVisuals, true);
  assert.equal(edits.visualOverlays?.length, 1);
  assert.equal(edits.visualOverlays?.[0].animation, 'slide-up');
});

test('planVisualCardPlacement and buildOverlayFilterStatements composite visual cards in a single FFmpeg pass without overlapping captions', () => {
  const card = planVisualCardPlacement({
    plan: {
      mode: 'single',
      cropW: 608,
      cropH: 1080,
      points: [],
      faceAnchorY: 0.32,
    },
    captionBand: { top: 1350, bottom: 1620 },
    hookBand: { top: 1180, bottom: 1320 },
  });
  assert.ok(card.y + card.height <= 1180, 'visual card stays above hook + caption stack');

  const visStatements = buildVisualOverlayFilterStatements(
    [
      {
        id: 'vm-1_main',
        imagePath: '/tmp/visual1.png',
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        start: 6.5,
        end: 10.0,
        animation: 'slide-up',
      },
    ],
    [3],
    'vbase',
    'vvis'
  );
  assert.equal(visStatements.statements.length, 2);
  assert.match(visStatements.statements[0], /^\[3:v\]scale=760:460/);
  assert.match(visStatements.statements[1], /enable='between\(t,6\.500,10\.000\)'/);

  const combined = buildOverlayFilterStatements(
    [{ name: 'captions', inputPattern: '/tmp/ov_%05d.png', startAtSeconds: 0 }],
    [2],
    'vbase',
    [
      {
        id: 'vm-1_main',
        imagePath: '/tmp/visual1.png',
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        start: 6.5,
        end: 10.0,
        animation: 'subtle-zoom',
      },
    ],
    [3]
  );
  assert.equal(combined.length, 4);
  assert.match(combined[1], /^\[vbase\]\[visimg0\]overlay=.*\[vvis\]$/);
  assert.match(combined[3], /^\[vvis\]\[overlay0\]overlay=.*\[v\]$/);
});
