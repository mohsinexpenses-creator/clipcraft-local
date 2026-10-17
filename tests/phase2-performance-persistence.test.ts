import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';

import { closeDatabase, getDatabase } from '../lib/db';
import {
  appendClipTimingRecord,
  formatClipTimingSummary,
} from '../lib/timings';
import {
  buildVideoCodecArgs,
  getConfiguredVideoEncoder,
  getVideoEncodeSettings,
  probeVideoEncoder,
  setSessionVideoEncoderOverride,
} from '../worker/ffmpeg-pipeline';
import {
  clearVisualMemoryCachesOnly,
  getVisualProviderStates,
  getVisualSearchCacheTtlMs,
  pruneVisualCacheDirectory,
  resetVisualProviderStateForTests,
  resolveSingleVisualOverlay,
  setVisualCacheDirForTests,
  upsertImageBankEntry,
} from '../lib/visual-providers';
import { evaluateMemoryAwareConcurrency } from '../lib/startup-validation';
import type { ClipVisualOverlay } from '../lib/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-phase2-'));
const dbFile = path.join(tmpDir, 'phase2.sqlite');
const cacheDir = path.join(tmpDir, 'visual-cache');

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createValidPngBuffer(width = 480, height = 600): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rawData = Buffer.alloc((width * 4 + 1) * height, 100);
  for (let y = 0; y < height; y += 1) {
    rawData[y * (width * 4 + 1)] = 0;
  }
  const idat = zlib.deflateSync(rawData);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

before(() => {
  process.env.DATABASE_PATH = dbFile;
  closeDatabase();
  setVisualCacheDirForTests(cacheDir);
});

after(() => {
  setSessionVideoEncoderOverride(null);
  setVisualCacheDirForTests(null);
  closeDatabase();
  delete process.env.DATABASE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('1. per-clip timings append to timings.jsonl and format a concise summary line', () => {
  const timingsPath = path.join(tmpDir, 'timings.jsonl');
  const rec = {
    timestamp: '2026-10-13T12:00:00.000Z',
    clipId: 'clip-101',
    videoId: 'video-01',
    durationSeconds: 64.5,
    encoder: 'x264' as const,
    preset: 'medium',
    prepMs: 420.4,
    visualsResolveMs: 85.2,
    remotionOverlayMs: 3120.8,
    ffmpegEncodeMs: 11850.1,
    totalMs: 15476.5,
  };

  appendClipTimingRecord(rec, timingsPath);
  const lines = fs.readFileSync(timingsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.clipId, 'clip-101');
  assert.equal(parsed.encoder, 'x264');
  assert.equal(parsed.preset, 'medium');
  assert.equal(parsed.ffmpegEncodeMs, 11850);

  const summary = formatClipTimingSummary(rec);
  assert.ok(summary.includes('[timings] clip=clip-101 video=video-01'));
  assert.ok(summary.includes('encoder=x264(medium)'));
  assert.ok(summary.includes('total=15477ms'));
});

test('2. VIDEO_ENCODER supports x264, nvenc, qsv and falls back to x264 when hardware test fails', async () => {
  assert.deepEqual(getVideoEncodeSettings({}), { crf: 17, preset: 'medium' });
  assert.equal(getConfiguredVideoEncoder({}), 'x264');
  assert.equal(getConfiguredVideoEncoder({ VIDEO_ENCODER: 'nvenc' }), 'nvenc');
  assert.equal(getConfiguredVideoEncoder({ VIDEO_ENCODER: 'qsv' }), 'qsv');
  assert.equal(getConfiguredVideoEncoder({ VIDEO_ENCODER: 'invalid' }), 'x264');

  const nvencArgs = buildVideoCodecArgs('nvenc');
  assert.deepEqual(nvencArgs.args, [
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p6',
    '-tune',
    'hq',
    '-rc',
    'vbr',
    '-cq',
    '19',
    '-b:v',
    '0',
    '-spatial-aq',
    '1',
    '-temporal-aq',
    '1',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
  ]);

  const qsvArgs = buildVideoCodecArgs('qsv');
  assert.deepEqual(qsvArgs.args, [
    '-c:v',
    'h264_qsv',
    '-preset',
    'slower',
    '-global_quality',
    '20',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
  ]);

  const remotionFfmpeg = path.join(
    process.cwd(),
    'node_modules',
    '@remotion',
    'compositor-linux-x64-gnu',
    'ffmpeg'
  );
  if (fs.existsSync(remotionFfmpeg)) {
    const probeNvenc = await probeVideoEncoder({
      ffmpegPath: remotionFfmpeg,
      env: { VIDEO_ENCODER: 'nvenc' },
      activateForSession: false,
    });
    assert.equal(probeNvenc.requested, 'nvenc');
    assert.equal(probeNvenc.active, 'x264');
    assert.ok(probeNvenc.fallbackReason);

    const probeQsv = await probeVideoEncoder({
      ffmpegPath: remotionFfmpeg,
      env: { VIDEO_ENCODER: 'qsv' },
      activateForSession: false,
    });
    assert.equal(probeQsv.requested, 'qsv');
    assert.equal(probeQsv.active, 'x264');
    assert.ok(probeQsv.fallbackReason);
  }
});

test('3. SQLite visual_search_cache (14-30 day TTL) and image_bank persist across restarts without API calls', async () => {
  getDatabase();
  resetVisualProviderStateForTests();

  const ttlMs = getVisualSearchCacheTtlMs();
  const ttlDays = ttlMs / (24 * 3600 * 1000);
  assert.ok(ttlDays >= 14 && ttlDays <= 30, `TTL ${ttlDays} days must be in 14-30 day window`);

  const pngBytes = createValidPngBuffer(1080, 1920);
  let searchHttpCalls = 0;
  let imageHttpCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://api.pexels.com/v1/search')) {
      searchHttpCalls += 1;
      return new Response(
        JSON.stringify({
          photos: [
            {
              id: 777001,
              width: 1080,
              height: 1350,
              url: 'https://www.pexels.com/photo/podcast-microphone-studio-777001/',
              photographer: 'Alex Studio',
              alt: 'Podcast microphone studio recording desk',
              src: {
                large2x: 'https://images.pexels.com/photos/777001/mic.png',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.startsWith('https://images.pexels.com/photos/777001/mic.png')) {
      imageHttpCalls += 1;
      return new Response(new Uint8Array(pngBytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(pngBytes.length),
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const moment1: ClipVisualOverlay = {
      id: 'vm-p2-1',
      quote: 'recording in the podcast studio',
      sourceStart: 10,
      sourceEnd: 13.5,
      clipRelativeStart: 10,
      clipRelativeEnd: 13.5,
      displayDuration: 3.5,
      outputWindows: [{ segment: 'main', start: 13, end: 16.5 }],
      category: 'situation',
      entityName: '',
      visualIntent: 'Podcast microphone studio desk',
      emotionalPolarity: 'neutral',
      searchQueries: ['podcast microphone studio'],
      negativeCues: ['cartoon'],
      confidence: 0.85,
      animation: 'pop',
      placement: 'main',
      framing: 'illustrative',
      status: 'planned',
    };

    const resolved1 = await resolveSingleVisualOverlay(moment1, {
      pexelsApiKey: 'pexels_valid_test_key_1234567890',
      renderSettings: { visualRelevanceStrictness: 'lenient' },
    });
    assert.equal(resolved1.status, 'resolved');
    assert.equal(searchHttpCalls, 1);
    assert.equal(imageHttpCalls, 1);

    // Simulate process restart by clearing in-memory caches while keeping SQLite intact
    clearVisualMemoryCachesOnly();

    // Moment 2 shares matching tags ("podcast", "microphone", "studio") with a brand-new query phrasing.
    // It should hit the SQLite image_bank BEFORE making any API search or download call!
    const moment2: ClipVisualOverlay = {
      ...moment1,
      id: 'vm-p2-2',
      searchQueries: ['studio microphone podcast setup'],
      status: 'planned',
      localFilePath: undefined,
      attribution: undefined,
    };

    const resolved2 = await resolveSingleVisualOverlay(moment2, {
      pexelsApiKey: 'pexels_valid_test_key_1234567890',
      renderSettings: { visualRelevanceStrictness: 'lenient' },
    });
    assert.equal(resolved2.status, 'resolved');
    assert.equal(searchHttpCalls, 2, 'bank candidates do not bypass building the ordinary pool');
    assert.equal(imageHttpCalls, 1, 'image_bank match must avoid image download calls');
    assert.ok(getVisualProviderStates().pexels.requestsCount >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('4. pruneVisualCacheDirectory evicts least-recently-used files when cache exceeds maxBytes', () => {
  fs.mkdirSync(cacheDir, { recursive: true });
  const fileOld = path.join(cacheDir, 'old_asset.png');
  const fileNew = path.join(cacheDir, 'new_asset.png');
  fs.writeFileSync(fileOld, Buffer.alloc(4096, 1));
  fs.writeFileSync(fileNew, Buffer.alloc(4096, 2));

  upsertImageBankEntry({
    provider: 'pexels',
    assetId: 'old-1',
    localPath: fileOld,
    tags: ['old', 'tag'],
    width: 400,
    height: 500,
    fileSize: 4096,
    attribution: {
      provider: 'pexels',
      assetId: 'old-1',
      title: 'Old',
      creator: 'A',
      license: 'Pexels License',
      licenseCode: 'pexels',
      sourcePageUrl: 'https://www.pexels.com',
      imageUrl: 'https://images.pexels.com/old.png',
      attributionText: 'Photo by A on Pexels',
      requiresAttribution: true,
      shareAlike: false,
    },
  });
  const db = getDatabase();
  db.prepare(`UPDATE image_bank SET last_used = ? WHERE asset_id = 'old-1'`).run(
    '2026-01-01T00:00:00.000Z'
  );

  upsertImageBankEntry({
    provider: 'pexels',
    assetId: 'new-1',
    localPath: fileNew,
    tags: ['new', 'tag'],
    width: 400,
    height: 500,
    fileSize: 4096,
    attribution: {
      provider: 'pexels',
      assetId: 'new-1',
      title: 'New',
      creator: 'B',
      license: 'Pexels License',
      licenseCode: 'pexels',
      sourcePageUrl: 'https://www.pexels.com',
      imageUrl: 'https://images.pexels.com/new.png',
      attributionText: 'Photo by B on Pexels',
      requiresAttribution: true,
      shareAlike: false,
    },
  });

  const pruned = pruneVisualCacheDirectory(4500, cacheDir);
  assert.ok(pruned.removedFiles >= 1);
  assert.ok(pruned.totalBytesAfter <= 4500);
  assert.equal(fs.existsSync(fileOld), false, 'oldest LRU file must be evicted first');
  assert.equal(fs.existsSync(fileNew), true, 'newest LRU file must be retained');
});

test('5. evaluateMemoryAwareConcurrency warns when tabs exceed RAM and passes 16 GB recommendation', () => {
  const ram16Gb = 16 * 1024 ** 3;

  // Recommended 16 GB settings: clipConcurrency=2, remotionConcurrency=3 (6 tabs -> ~8 GB total with headroom)
  const recommended = evaluateMemoryAwareConcurrency({
    clipConcurrency: 2,
    remotionConcurrency: 3,
    totalMemoryBytes: ram16Gb,
    cpuCount: 12,
  });
  assert.equal(recommended.warning, false);
  assert.equal(recommended.totalTabs, 6);

  // Excessive concurrency on 16 GB: clipConcurrency=6, remotionConcurrency=6 (36 tabs -> ~25 GB)
  const excessive = evaluateMemoryAwareConcurrency({
    clipConcurrency: 6,
    remotionConcurrency: 6,
    totalMemoryBytes: ram16Gb,
    cpuCount: 12,
  });
  assert.equal(excessive.warning, true);
  assert.ok(excessive.summary?.includes('may exceed installed RAM'));
});
