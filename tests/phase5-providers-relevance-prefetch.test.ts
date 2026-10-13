import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  findFallbackCachedVisualFile,
  getProviderOrderForMoment,
  resetVisualProviderStateForTests,
  resolveVisualOverlaysForClip,
  scoreVisualCandidate,
  searchOpenverseCandidates,
  searchPexelsCandidates,
  searchPixabayCandidates,
  searchUnsplashCandidates,
  setVisualCacheDirForTests,
  type RawProviderCandidate,
} from '../lib/visual-providers';
import { maskAiSecrets, resolveSettings, sanitizeSettingsSection } from '../lib/app-settings';
import { getClip, getVideo, saveClip, saveVideo, updateClip } from '../lib/db';
import { POST as cancelClipPost } from '../app/api/clips/[id]/cancel/route';
import { POST as cancelPipelinePost } from '../app/api/videos/[id]/cancel-pipeline/route';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import type { ClipVisualOverlay } from '../lib/types';

function makeSamplePngBuffer(width = 800, height = 1000): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const rawScanline = Buffer.alloc(1 + 4 * 3, 128);
  rawScanline[0] = 0;
  const idatData = zlib.deflateSync(rawScanline);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('settings sanitize and mask Pixabay and Unsplash keys and resolve visualVisionVerify', () => {
  const sanitized = sanitizeSettingsSection(
    'ai',
    {
      pixabayApiKey: 'pixabay_secret_key_1234567890',
      unsplashAccessKey: 'unsplash_access_key_9876543210',
    },
    {}
  );
  const masked = maskAiSecrets(sanitized);
  assert.ok(!String(masked.pixabayApiKey ?? '').includes('123456'));
  assert.ok(!String(masked.unsplashAccessKey ?? '').includes('987654'));

  const resolved = resolveSettings({
    ai: sanitized,
    render: { visualCardAspect: 'portrait', visualVisionVerify: true },
  });
  assert.equal(resolved.effective.ai.pixabayApiKey, 'pixabay_secret_key_1234567890');
  assert.equal(resolved.effective.ai.unsplashAccessKey, 'unsplash_access_key_9876543210');
  assert.equal(resolved.effective.render.visualVisionVerify, true);
  assert.equal(resolved.effective.render.visualCardAspect, 'portrait');
});

test('orientation filter is sent to Pexels, Pixabay, Unsplash, and Openverse, and scoreVisualCandidate prefers matching aspect', async (t) => {
  createTemporaryDatabase(t);
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-phase5-'));
  setVisualCacheDirForTests(tempCache);
  resetVisualProviderStateForTests();

  const seenUrls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    if (url.includes('api.pexels.com')) {
      return new Response(
        JSON.stringify({
          photos: [
            {
              id: 101,
              width: 800,
              height: 1000,
              url: 'https://www.pexels.com/photo/101',
              photographer: 'Alex',
              alt: 'Creator filming vertical video in studio',
              src: { large: 'https://images.pexels.com/photos/101/photo.jpeg', small: 'https://images.pexels.com/photos/101/small.jpeg' },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('pixabay.com/api/')) {
      return new Response(
        JSON.stringify({
          hits: [
            {
              id: 202,
              pageURL: 'https://pixabay.com/photos/studio-202/',
              tags: 'studio, microphone, podcast, recording',
              previewURL: 'https://cdn.pixabay.com/photo/202_150.jpg',
              largeImageURL: 'https://cdn.pixabay.com/photo/202_1280.jpg',
              imageWidth: 960,
              imageHeight: 1200,
              user: 'PixUser',
              user_id: 99,
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('api.unsplash.com/search/photos')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'u303',
              width: 1080,
              height: 1350,
              alt_description: 'podcast microphone on desk in studio',
              urls: {
                regular: 'https://images.unsplash.com/photo-303?w=1080',
                thumb: 'https://images.unsplash.com/photo-303?w=200',
              },
              links: {
                html: 'https://unsplash.com/photos/u303',
                download_location: 'https://api.unsplash.com/photos/u303/download',
              },
              user: { name: 'Sam Photographer', username: 'samphoto' },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('api.openverse.org')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  try {
    const pexels = await searchPexelsCandidates('studio microphone', 'pexels_valid_key_12345', 5000, 'portrait');
    const pixabay = await searchPixabayCandidates('studio microphone', 'pixabay_valid_key_12345', { orientation: 'portrait' });
    const unsplash = await searchUnsplashCandidates('studio microphone', 'unsplash_valid_key_12345', { orientation: 'portrait' });
    await searchOpenverseCandidates('studio microphone', { orientation: 'portrait' });

    assert.equal(pexels.length, 1);
    assert.equal(pixabay.length, 1);
    assert.equal(unsplash.length, 1);

    assert.ok(seenUrls.some((u) => u.includes('api.pexels.com') && u.includes('orientation=portrait')));
    assert.ok(seenUrls.some((u) => u.includes('pixabay.com/api/') && u.includes('orientation=vertical')));
    assert.ok(seenUrls.some((u) => u.includes('api.unsplash.com') && u.includes('orientation=portrait')));
    assert.ok(seenUrls.some((u) => u.includes('api.openverse.org') && u.includes('aspect_ratio=tall')));

    // Aspect ratio preference: portrait candidate scores higher than wide candidate when preferredAspect='portrait'
    const baseMoment = {
      quote: 'recording a podcast in the studio',
      category: 'situation' as const,
      entityName: '',
      visualIntent: 'podcast microphone in studio',
      emotionalPolarity: 'neutral' as const,
      searchQueries: ['podcast microphone studio'],
      negativeCues: [],
    };
    const portraitCand: RawProviderCandidate = {
      ...pixabay[0],
      width: 960,
      height: 1200, // 4:5
    };
    const wideCand: RawProviderCandidate = {
      ...pixabay[0],
      width: 1600,
      height: 900, // 16:9
    };
    const scorePortrait = scoreVisualCandidate(portraitCand, baseMoment, 'portrait');
    const scoreWide = scoreVisualCandidate(wideCand, baseMoment, 'portrait');
    assert.ok(scorePortrait.score > scoreWide.score);

    const orderWithAllKeys = getProviderOrderForMoment({
      moment: { category: 'situation', entityName: '' },
      hasPexelsKey: true,
      hasPixabayKey: true,
      hasUnsplashKey: true,
    });
    assert.deepEqual(orderWithAllKeys, ['pexels', 'pixabay', 'unsplash', 'openverse', 'wikimedia']);
  } finally {
    globalThis.fetch = origFetch;
    setVisualCacheDirForTests(null);
    fs.rmSync(tempCache, { recursive: true, force: true });
  }
});

test('Gemini vision relevance check sends one batch call per clip and can promote candidate #1 or skip a moment to keyword-pop', async (t) => {
  createTemporaryDatabase(t);
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-vision-'));
  setVisualCacheDirForTests(tempCache);
  resetVisualProviderStateForTests();

  const pngBytes = makeSamplePngBuffer(800, 1000);
  let geminiCallCount = 0;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('pixabay.com/api/')) {
      return new Response(
        JSON.stringify({
          hits: [
            {
              id: 501,
              pageURL: 'https://pixabay.com/photos/501/',
              tags: 'financial chart desk analysis growth',
              previewURL: 'https://cdn.pixabay.com/photo/501_thumb.png',
              largeImageURL: 'https://cdn.pixabay.com/photo/501_large.png',
              imageWidth: 800,
              imageHeight: 1000,
              user: 'CandidateZero',
            },
            {
              id: 502,
              pageURL: 'https://pixabay.com/photos/502/',
              tags: 'financial chart desk analysis growth',
              previewURL: 'https://cdn.pixabay.com/photo/502_thumb.png',
              largeImageURL: 'https://cdn.pixabay.com/photo/502_large.png',
              imageWidth: 800,
              imageHeight: 1000,
              user: 'CandidateOne',
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('cdn.pixabay.com/photo/')) {
      return new Response(new Uint8Array(pngBytes), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCallCount += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      decisions: [
                        { momentId: 'm-keep', pickIndex: 1 },
                        { momentId: 'm-skip', pickIndex: -1 },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  };

  try {
    const overlays: ClipVisualOverlay[] = [
      {
        id: 'm-keep',
        quote: 'Analyzing the financial chart on the desk',
        sourceStart: 10,
        sourceEnd: 13,
        clipRelativeStart: 10,
        clipRelativeEnd: 13,
        displayDuration: 3,
        outputWindows: [{ segment: 'main', start: 10, end: 13 }],
        category: 'situation',
        entityName: '',
        visualIntent: 'Financial chart analysis on desk',
        emotionalPolarity: 'neutral',
        searchQueries: ['financial chart desk analysis'],
        negativeCues: [],
        confidence: 0.85,
        animation: 'pop',
        placement: 'main',
        framing: 'illustrative',
        kind: 'photo-card',
        status: 'planned',
      },
      {
        id: 'm-skip',
        quote: 'Another financial chart moment that vision rejects',
        sourceStart: 20,
        sourceEnd: 23,
        clipRelativeStart: 20,
        clipRelativeEnd: 23,
        displayDuration: 3,
        outputWindows: [{ segment: 'main', start: 20, end: 23 }],
        category: 'situation',
        entityName: '',
        visualIntent: 'Financial chart analysis on desk',
        emotionalPolarity: 'neutral',
        searchQueries: ['financial chart desk analysis'],
        negativeCues: [],
        confidence: 0.82,
        animation: 'pop',
        placement: 'main',
        framing: 'illustrative',
        kind: 'photo-card',
        status: 'planned',
      },
    ];

    const resolved = await resolveVisualOverlaysForClip(overlays, {
      renderSettings: {
        autoVisuals: true,
        visualVisionVerify: true,
        visualCardAspect: 'portrait',
        visualProviders: {
          pexels: false,
          pixabay: true,
          unsplash: false,
          openverse: false,
          wikimedia: false,
        },
      },
      geminiApiKeys: ['AIzaSyFakeVisionTestKey123456789'],
      pixabayApiKey: 'pixabay_fake_key_123456789',
    });

    // Exactly ONE Gemini vision verification request for the whole clip
    assert.equal(geminiCallCount, 1);

    // m-keep picked Candidate #1 (id=502, creator="CandidateOne") and cached it locally
    assert.equal(resolved[0].status, 'resolved');
    assert.equal(resolved[0].attribution?.assetId, '502');
    assert.equal(resolved[0].attribution?.creator, 'CandidateOne');
    assert.ok(resolved[0].localFilePath && fs.existsSync(resolved[0].localFilePath));

    // m-skip was rejected by Gemini vision (pickIndex: -1) and converted to keyword-pop
    assert.equal(resolved[1].kind, 'keyword-pop');
    assert.equal(resolved[1].status, 'skipped');
  } finally {
    globalThis.fetch = origFetch;
    setVisualCacheDirForTests(null);
    fs.rmSync(tempCache, { recursive: true, force: true });
  }
});

test('Clip cancel, pipeline cancel, and visual cache disk fallback work reliably', async (t) => {
  createTemporaryDatabase(t);
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-fallback-cache-'));
  setVisualCacheDirForTests(tempCache);

  try {
    // 1. Visual cache disk fallback finds downloaded images in data/visual-cache/
    const sampleImgPath = path.join(tempCache, 'cached_photo.png');
    fs.writeFileSync(sampleImgPath, makeSamplePngBuffer(800, 1000));
    const usedPaths = new Set<string>();
    const found = findFallbackCachedVisualFile(usedPaths);
    assert.ok(found);
    assert.ok(found.localFilePath.endsWith('cached_photo.png'));
    assert.equal(findFallbackCachedVisualFile(usedPaths), null);

    // 2. Cancel clip and cancel pipeline transition clips/video out of pending/processing
    // and prevent worker progress updates from overwriting the cancelled state.
    const now = new Date().toISOString();
    await saveVideo({
      _id: 'vid-cancel-1',
      originalName: 'test.mp4',
      fileName: 'test.mp4',
      filePath: '/tmp/test.mp4',
      duration: 120,
      width: 1920,
      height: 1080,
      fileSize: 1000,
      status: 'transcribing',
      pipeline: {
        autoDetect: true,
        autoRender: true,
        viral: {
          clipCount: 5,
          minClipDuration: 60,
          maxClipDuration: 90,
          includeHookText: true,
          includeCta: true,
          includeVisuals: true,
          maxVisualMoments: 12,
          visualConfidenceThreshold: 0.65,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    const staleWorkerCopy = await saveClip({
      _id: 'clip-cancel-1',
      videoId: 'vid-cancel-1',
      videoTitle: 'test.mp4',
      start: 0,
      end: 60,
      hookDuration: 3,
      hookText: 'HOOK',
      filterPreset: 'none',
      captionPresetId: 'preset-bold-yellow',
      status: 'processing',
      progress: 45,
      cancelling: false,
      createdAt: now,
      updatedAt: now,
    });

    const cancelRes = await cancelClipPost(new Request('http://localhost/api/clips/clip-cancel-1/cancel', { method: 'POST' }), {
      params: Promise.resolve({ id: 'clip-cancel-1' }),
    });
    assert.equal(cancelRes.status, 200);

    const afterCancel = await getClip('clip-cancel-1');
    assert.equal(afterCancel?.status, 'failed');
    assert.equal(afterCancel?.error, 'Cancelled by user.');
    assert.equal(afterCancel?.cancelling, true);

    // Simulate in-flight worker progress tick trying to save stale `status: 'processing', cancelling: false`
    staleWorkerCopy.progress = 55;
    await updateClip(staleWorkerCopy);
    assert.equal(staleWorkerCopy.cancelling, true, 'worker in-memory copy receives cancelling=true signal');
    const afterStaleTick = await getClip('clip-cancel-1');
    assert.equal(afterStaleTick?.status, 'failed', 'cancelled status in DB is not overwritten by progress tick');

    // Cancel pipeline stops video transcription/automation and any remaining pending clips
    await saveClip({
      _id: 'clip-cancel-2',
      videoId: 'vid-cancel-1',
      videoTitle: 'test.mp4',
      start: 60,
      end: 120,
      hookDuration: 3,
      hookText: 'HOOK',
      filterPreset: 'none',
      captionPresetId: 'preset-bold-yellow',
      status: 'pending',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    });

    const pipeRes = await cancelPipelinePost(new Request('http://localhost/api/videos/vid-cancel-1/cancel-pipeline', { method: 'POST' }), {
      params: Promise.resolve({ id: 'vid-cancel-1' }),
    });
    assert.equal(pipeRes.status, 200);

    const vidAfter = await getVideo('vid-cancel-1');
    assert.equal(vidAfter?.status, 'failed');
    assert.equal(vidAfter?.error, 'Cancelled by user.');
    assert.equal(vidAfter?.pipeline?.autoDetect, false);
    assert.equal(vidAfter?.pipeline?.autoRender, false);

    const clip2After = await getClip('clip-cancel-2');
    assert.equal(clip2After?.status, 'failed');
    assert.equal(clip2After?.error, 'Cancelled by user.');
  } finally {
    setVisualCacheDirForTests(null);
    fs.rmSync(tempCache, { recursive: true, force: true });
  }
});

