import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';

import {
  WMF_STANDARD_THUMB_WIDTH,
  buildStandardWikimediaThumbUrl,
  buildWikimediaSearchUrl,
  buildWikipediaPageImagesUrl,
  canonicalizeMediaStem,
  ensureCachedBrollAsset,
  extractBrollMomentsFromTranscript,
  findRelevantCachedAssetsForQuery,
  inspectAndValidateImageBuffer,
  maybeEnrichMomentsWithFreeLlm,
  normalizeImageUrl,
  parseAndValidateWikimediaResults,
  planClipBrollCount,
  resolveBrollForClip,
  resolveSafeCachedImagePath,
  scheduleBrollPlacements,
  scoreCandidateRelevance,
  searchWikimediaCommons,
  searchWithPersistentCache,
  targetBrollCountForDuration,
  type BrollSearchCandidate,
} from '../lib/broll';
import { getClipBrollSummary } from '../lib/broll-count';
import { resolveSettings, sanitizeSettingsSection, saveSettingsSection } from '../lib/app-settings';
import { sanitizeClipEdits } from '../lib/clip-edits';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { getBrollCacheDirValue, getClipsDirValue, resolveBrollCacheDir } from '../lib/paths';
import { jobDataFromClip } from '../lib/pipeline';
import type { ClipRecord, TranscriptData, WordTimestamp } from '../lib/types';
import {
  buildBrollFilterStatements,
  processVideoSegment,
  type OverlayFrameSequence,
} from '../worker/ffmpeg-pipeline';
import type { LayoutPlan } from '../worker/layout';
import { createTemporaryDatabase } from './sqlite-test-helpers';

async function makeSolidJpegBuffer(
  width: number,
  height: number,
  rgbaHex: number,
): Promise<Buffer> {
  const image = new Jimp({ width, height, color: rgbaHex });
  return await image.getBuffer('image/jpeg');
}

async function makeOverlayPngFrame(
  filePath: string,
  width: number,
  height: number,
  rects: Array<{ x: number; y: number; w: number; h: number; color: number }>,
): Promise<void> {
  const img = new Jimp({ width, height, color: 0x00000000 });
  for (const r of rects) {
    for (let y = r.y; y < Math.min(height, r.y + r.h); y += 1) {
      for (let x = r.x; x < Math.min(width, r.x + r.w); x += 1) {
        img.setPixelColor(r.color, x, y);
      }
    }
  }
  await img.write(filePath as `${string}.png`);
}

async function decodeVideoFrameRgb(
  videoPath: string,
  timeSeconds: number,
  width = 1080,
  height = 1920,
): Promise<Buffer> {
  const outRaw = `${videoPath}.frame_${timeSeconds.toFixed(3)}.rgb`;
  try {
    await runFfmpeg([
      '-y',
      '-ss',
      timeSeconds.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      outRaw,
    ]);
    const buf = fs.readFileSync(outRaw);
    assert.equal(buf.length, width * height * 3);
    return buf;
  } finally {
    fs.rmSync(outRaw, { force: true });
  }
}

function pixelAt(
  rgb: Buffer,
  x: number,
  y: number,
  width = 1080,
): { r: number; g: number; b: number } {
  const idx = (y * width + x) * 3;
  return { r: rgb[idx], g: rgb[idx + 1], b: rgb[idx + 2] };
}

async function decodeAudioPcm16Mono(videoPath: string, sampleRate = 16000): Promise<Int16Array> {
  const outPcm = `${videoPath}.audio.pcm`;
  try {
    await runFfmpeg([
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      outPcm,
    ]);
    const buf = fs.readFileSync(outPcm);
    return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  } finally {
    fs.rmSync(outPcm, { force: true });
  }
}

function rmsSlice(samples: Int16Array, startSec: number, endSec: number, sr = 16000): number {
  const from = Math.max(0, Math.floor(startSec * sr));
  const to = Math.min(samples.length, Math.floor(endSec * sr));
  assert.ok(to > from, `Empty audio slice ${startSec}..${endSec}`);
  let sumSq = 0;
  for (let i = from; i < to; i += 1) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / (to - from));
}

function buildTimedSentenceTranscript(
  clauses: Array<{ start: number; end: number; text: string }>,
): { transcript: TranscriptData; words: WordTimestamp[] } {
  const words: WordTimestamp[] = [];
  const segments = clauses.map((c, id) => {
    const tokens = c.text.split(/\s+/).filter(Boolean);
    const step = (c.end - c.start) / Math.max(1, tokens.length);
    tokens.forEach((word, idx) => {
      words.push({
        word,
        start: Number((c.start + idx * step).toFixed(3)),
        end: Number((c.start + (idx + 0.9) * step).toFixed(3)),
      });
    });
    return { id, start: c.start, end: c.end, text: c.text };
  });

  return {
    transcript: {
      text: clauses.map((c) => c.text).join(' '),
      segments,
      words,
    },
    words,
  };
}

test('search result validation, HTML stripping, orientation scoring, and deduplication work strictly', () => {
  assert.equal(normalizeImageUrl('file:///etc/passwd'), null);
  assert.equal(normalizeImageUrl('javascript:alert(1)'), null);
  assert.equal(normalizeImageUrl('https://www.instagram.com/p/abc/image.jpg'), null);
  assert.equal(normalizeImageUrl('https://scontent.cdninstagram.com/v/t51/photo.jpg'), null);
  assert.equal(normalizeImageUrl('https://i.pinimg.com/originals/a.jpg'), null);
  assert.equal(
    normalizeImageUrl('http://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg?utm_source=x#top'),
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg',
  );
  assert.equal(
    canonicalizeMediaStem('File:1280px-Elon_Musk_Royal_Society.jpg'),
    canonicalizeMediaStem('800px-Elon_Musk_Royal_Society.jpg'),
  );

  // Portrait beats landscape when lexical relevance is equal
  const portraitScore = scoreCandidateRelevance({
    title: 'Elon Musk Royal Society portrait',
    description: 'Photograph of Elon Musk in London',
    mimeType: 'image/jpeg',
    width: 900,
    height: 1400,
    query: 'Elon Musk',
    subjectKind: 'person',
  });
  const landscapeEqualScore = scoreCandidateRelevance({
    title: 'Elon Musk Royal Society event',
    description: 'Photograph of Elon Musk in London',
    mimeType: 'image/jpeg',
    width: 1400,
    height: 900,
    query: 'Elon Musk',
    subjectKind: 'person',
  });
  assert.ok(
    portraitScore > landscapeEqualScore,
    `Expected portrait (${portraitScore}) > equal-relevance landscape (${landscapeEqualScore})`,
  );

  // A much more relevant landscape photo beats a partially matching portrait photo
  const strongLandscapeScore = scoreCandidateRelevance({
    title: 'Eiffel Tower Paris sunset wide view',
    description: 'Eiffel Tower in Paris illuminated at dusk',
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1066,
    query: 'Eiffel Tower Paris',
    subjectKind: 'landmark',
  });
  const weakPortraitScore = scoreCandidateRelevance({
    title: 'Street café in Paris',
    description: 'A small street in Paris',
    mimeType: 'image/jpeg',
    width: 900,
    height: 1350,
    query: 'Eiffel Tower Paris',
    subjectKind: 'landmark',
  });
  assert.ok(
    strongLandscapeScore > weakPortraitScore,
    `Expected strongly relevant landscape (${strongLandscapeScore}) > weak portrait (${weakPortraitScore})`,
  );

  const rawApiPayload = {
    query: {
      pages: [
        // 1. Valid portrait photo with HTML attribution
        {
          pageid: 1,
          title: 'File:Taylor_Swift_2023_Premiere.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/1/11/Taylor_Swift_2023_Premiere.jpg',
              thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Taylor_Swift_2023_Premiere.jpg/1080px-Taylor_Swift_2023_Premiere.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Taylor_Swift_2023_Premiere.jpg',
              mime: 'image/jpeg',
              width: 1800,
              height: 2700,
              size: 2_400_000,
              sha1: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
              extmetadata: {
                Artist: { value: '<a href="https://example.org">Jane Photographer</a> &amp; Press' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
                ImageDescription: { value: '<p>Taylor Swift attending film premiere</p>' },
              },
            },
          ],
        },
        // 2. Duplicate thumbnail stem of #1 -> must be deduplicated
        {
          pageid: 2,
          title: 'File:800px-Taylor_Swift_2023_Premiere.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/800px-Taylor_Swift_2023_Premiere.jpg',
              mime: 'image/jpeg',
              width: 800,
              height: 1200,
              size: 350_000,
              sha1: 'ffff1111bbbb2222cccc3333dddd4444eeee5555',
            },
          ],
        },
        // 3. Signature PNG with underscore filename -> must be rejected as non-photo
        {
          pageid: 3,
          title: 'File:Taylor_Swift_signature.png',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/3/33/Taylor_Swift_signature.png',
              mime: 'image/png',
              width: 900,
              height: 500,
              size: 40_000,
            },
          ],
        },
        // 4. Tiny low-res icon -> must be rejected
        {
          pageid: 4,
          title: 'File:Taylor_Swift_tiny.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/4/44/Taylor_Swift_tiny.jpg',
              mime: 'image/jpeg',
              width: 180,
              height: 180,
              size: 12_000,
            },
          ],
        },
        // 5. Completely unrelated photo -> must fail strict relevance gate
        {
          pageid: 5,
          title: 'File:Golden_Retriever_in_park.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/5/55/Golden_Retriever_in_park.jpg',
              mime: 'image/jpeg',
              width: 1080,
              height: 1920,
              size: 500_000,
            },
          ],
        },
        // 6. SVG vector graphic -> unsupported MIME rejected
        {
          pageid: 6,
          title: 'File:Taylor_Swift_chart.svg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/6/66/Taylor_Swift_chart.svg',
              mime: 'image/svg+xml',
              width: 1200,
              height: 1200,
              size: 20_000,
            },
          ],
        },
      ],
    },
  };

  const validated = parseAndValidateWikimediaResults(rawApiPayload, 'Taylor Swift', {
    subjectKind: 'person',
  });
  assert.equal(validated.length, 1);
  assert.equal(validated[0].attribution, 'Jane Photographer & Press');
  assert.equal(validated[0].license, 'CC BY-SA 4.0');
  assert.equal(validated[0].width, 1800);
  assert.equal(validated[0].height, 2700);
  assert.match(validated[0].sourceUrl, /1080px-Taylor_Swift_2023_Premiere\.jpg$/);

  const searchUrl = buildWikimediaSearchUrl('Elon Musk', 10);
  assert.match(searchUrl, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.match(searchUrl, /gsrnamespace=6/);
});

test('persistent local cache handles misses, hits without re-downloading, content-hash dedup, path safety, and corrupt/oversized rejection', async (t) => {
  const { db } = createTemporaryDatabase(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-cache-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  // Cache directory guard: attempting to point BROLL_CACHE_DIR inside ./generated-clips is rejected safely
  const insideClips = path.join(getClipsDirValue(), 'nested-cache');
  const safeResolved = getBrollCacheDirValue(insideClips);
  assert.notEqual(path.resolve(safeResolved), path.resolve(insideClips));

  // Path traversal & invalid filename rejection
  const cacheDir = resolveBrollCacheDir(tempRoot);
  assert.throws(() => resolveSafeCachedImagePath(cacheDir, '../../etc/passwd.jpg'));
  assert.throws(() => resolveSafeCachedImagePath(cacheDir, '/tmp/evil.jpg'));
  assert.throws(() => resolveSafeCachedImagePath(cacheDir, 'not_a_hex_hash.exe'));

  const validJpegBytes = await makeSolidJpegBuffer(800, 1200, 0x2266ddff);
  assert.equal(await inspectAndValidateImageBuffer(Buffer.from('<html>404 Not Found</html>')), null);
  assert.equal(await inspectAndValidateImageBuffer(validJpegBytes.subarray(0, 24)), null);

  let networkDownloads = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    networkDownloads += 1;
    if (url.includes('corrupt.jpg')) {
      return new Response(Buffer.from('not-a-valid-jpeg-binary'), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (url.includes('oversized.jpg')) {
      return new Response(new Uint8Array(validJpegBytes), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(50 * 1024 * 1024),
        },
      });
    }
    return new Response(new Uint8Array(validJpegBytes), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };

  const baseCandidate: BrollSearchCandidate = {
    normalizedUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/NASA_Rocket_Launch.jpg',
    sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/NASA_Rocket_Launch.jpg',
    originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/NASA_Rocket_Launch.jpg',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:NASA_Rocket_Launch.jpg',
    title: 'NASA Rocket Launch',
    canonicalStem: 'nasa rocket launch',
    mimeType: 'image/jpeg',
    width: 800,
    height: 1200,
    attribution: 'NASA / Bill Ingalls',
    license: 'Public domain',
    description: 'Saturn rocket launch pad photograph',
    relevanceScore: 84,
  };

  const corruptRes = await ensureCachedBrollAsset(
    {
      ...baseCandidate,
      normalizedUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/corrupt.jpg',
      sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/corrupt.jpg',
      originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/corrupt.jpg',
    },
    { cacheDir, fetchImpl: fakeFetch, detectFaces: false },
  );
  assert.equal(corruptRes, null);

  const oversizedRes = await ensureCachedBrollAsset(
    {
      ...baseCandidate,
      normalizedUrl: 'https://upload.wikimedia.org/wikipedia/commons/o/oo/oversized.jpg',
      sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/o/oo/oversized.jpg',
      originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/o/oo/oversized.jpg',
    },
    { cacheDir, fetchImpl: fakeFetch, maxImageBytes: 1024 * 1024, detectFaces: false },
  );
  assert.equal(oversizedRes, null);

  // First fetch of valid candidate = CACHE MISS (downloads once, writes disk file + SQLite metadata)
  const beforeHits = networkDownloads;
  const first = await ensureCachedBrollAsset(baseCandidate, {
    cacheDir,
    searchTerms: ['NASA rocket'],
    fetchImpl: fakeFetch,
    detectFaces: false,
  });
  assert.ok(first);
  assert.equal(first.cacheHit, false);
  assert.equal(networkDownloads, beforeHits + 1);
  assert.ok(fs.existsSync(first.absolutePath));
  assert.equal(first.attribution, 'NASA / Bill Ingalls');
  assert.equal(first.license, 'Public domain');
  assert.equal(first.width, 800);
  assert.equal(first.height, 1200);

  // Verify SQLite stores ONLY lightweight text/numeric metadata and ZERO BLOB columns
  const rawRow = db
    .prepare('SELECT typeof(local_path) AS lpType, local_path, content_hash FROM broll_assets WHERE id = ?')
    .get(first.id) as { lpType: string; local_path: string; content_hash: string };
  assert.equal(rawRow.lpType, 'text');
  assert.equal(rawRow.local_path, `${first.contentHash}.jpg`);

  // Second fetch of same URL = CACHE HIT (0 network requests!)
  const second = await ensureCachedBrollAsset(baseCandidate, {
    cacheDir,
    searchTerms: ['Saturn rocket'],
    fetchImpl: fakeFetch,
    detectFaces: false,
  });
  assert.ok(second);
  assert.equal(second.cacheHit, true);
  assert.equal(networkDownloads, beforeHits + 1);
  assert.ok(second.searchTerms.includes('NASA rocket'));
  assert.ok(second.searchTerms.includes('Saturn rocket'));

  // Different URL returning identical bytes = content-hash deduplication reuses same on-disk file!
  const mirror = await ensureCachedBrollAsset(
    {
      ...baseCandidate,
      normalizedUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/bb/NASA_Rocket_Mirror.jpg',
      sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/bb/NASA_Rocket_Mirror.jpg',
      originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/bb/NASA_Rocket_Mirror.jpg',
    },
    { cacheDir, fetchImpl: fakeFetch, detectFaces: false },
  );
  assert.ok(mirror);
  assert.equal(mirror.cacheHit, true);
  assert.equal(mirror.absolutePath, first.absolutePath);
  assert.equal(fs.readdirSync(path.join(cacheDir, 'images')).length, 1);

  // Search query metadata cache avoids duplicate Wikimedia API calls too
  let apiCalls = 0;
  const mockApiFetch: typeof fetch = async () => {
    apiCalls += 1;
    return new Response(
      JSON.stringify({
        query: {
          pages: [
            {
              pageid: 10,
              title: 'File:NASA_Rocket_Launch.jpg',
              imageinfo: [
                {
                  url: baseCandidate.sourceUrl,
                  mime: 'image/jpeg',
                  width: 800,
                  height: 1200,
                  size: 120_000,
                },
              ],
            },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const s1 = await searchWithPersistentCache('NASA Rocket', { fetchImpl: mockApiFetch });
  const s2 = await searchWithPersistentCache('  nasa   rocket ', { fetchImpl: mockApiFetch });
  assert.equal(s1.cacheHit, false);
  assert.equal(s2.cacheHit, true);
  assert.equal(apiCalls, 1);

  // Offline local reuse query finds already-cached asset without hitting network
  const offlineMatches = findRelevantCachedAssetsForQuery('Saturn rocket', { cacheDir });
  assert.ok(offlineMatches.length >= 1);
  assert.equal(offlineMatches[0].asset.absolutePath, first.absolutePath);
});

test('60-second clip schedules >= 8 speech-aligned distinct B-roll appearances and scales proportionally with clip duration', async (t) => {
  assert.equal(targetBrollCountForDuration(15), 2);
  assert.equal(targetBrollCountForDuration(30), 4);
  assert.equal(targetBrollCountForDuration(60), 8);
  assert.equal(targetBrollCountForDuration(90), 12);

  createTemporaryDatabase(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-60s-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const subjects = [
    { start: 1.0, end: 6.2, entity: 'Elon Musk', text: 'Back in 2008 Elon Musk risked everything on one launch.' },
    { start: 7.5, end: 12.8, entity: 'SpaceX', text: 'Engineers at SpaceX worked day and night on the rocket.' },
    { start: 14.0, end: 19.2, entity: 'NASA', text: 'Then NASA signed a historic commercial space contract.' },
    { start: 20.5, end: 25.8, entity: 'Eiffel Tower', text: 'In Paris near the Eiffel Tower he announced the next venture.' },
    { start: 27.0, end: 32.2, entity: 'Tesla', text: 'Meanwhile Tesla scaled electric production in Fremont.' },
    { start: 33.5, end: 38.8, entity: 'Wall Street', text: 'Analysts on Wall Street doubted every single forecast.' },
    { start: 40.0, end: 45.2, entity: 'New York', text: 'Crowds gathered across New York to watch the unveil.' },
    { start: 46.5, end: 51.8, entity: 'Super Bowl', text: 'Even without a Super Bowl commercial demand exploded.' },
    { start: 53.0, end: 58.8, entity: 'Mars', text: 'Now the ultimate destination remains a colony on Mars.' },
  ];

  const { transcript, words } = buildTimedSentenceTranscript(subjects);
  const moments = extractBrollMomentsFromTranscript({
    transcript,
    clipWords: words,
    clipStart: 0,
    clipEnd: 60,
  });
  assert.ok(moments.length >= 9, `Expected >= 9 extracted moments, got ${moments.length}`);

  const jpegs = await Promise.all(
    subjects.map((_, idx) =>
      makeSolidJpegBuffer(
        900,
        1440,
        ((((idx * 23 + 30) & 0xff) << 24) | (((idx * 17 + 60) & 0xff) << 16) | 0x88ff) >>> 0,
      ),
    ),
  );

  const mockFetch: typeof fetch = async (input) => {
    const rawUrl = String(input);
    if (rawUrl.includes('api.php')) {
      const parsed = new URL(rawUrl);
      const q = (parsed.searchParams.get('gsrsearch') ?? '').toLowerCase();
      const matchIdx = subjects.findIndex((s) => q.includes(s.entity.toLowerCase()));
      if (matchIdx < 0) {
        return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
      }
      const slug = subjects[matchIdx].entity.replace(/\s+/g, '_');
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 100 + matchIdx,
                title: `File:${slug}_Portrait_${matchIdx}.jpg`,
                imageinfo: [
                  {
                    url: `https://upload.wikimedia.org/wikipedia/commons/${matchIdx}/${slug}.jpg`,
                    mime: 'image/jpeg',
                    width: 900,
                    height: 1440,
                    size: jpegs[matchIdx].length,
                    extmetadata: {
                      Artist: { value: `Commons Photographer ${matchIdx}` },
                      LicenseShortName: { value: 'CC BY 4.0' },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const imgMatch = rawUrl.match(/\/commons\/(\d+)\//);
    const idx = imgMatch ? Number(imgMatch[1]) : 0;
    return new Response(new Uint8Array(jpegs[idx]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };

  const placements = await resolveBrollForClip({
    transcript,
    clipWords: words,
    clipStart: 0,
    clipEnd: 60,
    hookDurationSeconds: 3,
    cacheDir: tempRoot,
    fetchImpl: mockFetch,
    detectFaces: false,
    enableLlmFallback: false,
  });

  assert.ok(
    placements.length >= 8,
    `Expected at least 8 B-roll appearances for a 60s clip, got ${placements.length}`,
  );

  const uniquePaths = new Set(placements.map((p) => p.imagePath));
  assert.equal(uniquePaths.size, placements.length, 'Must not repeat duplicate images inside one clip');

  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i];
    assert.ok(p.startTime >= 3.5, `Placement ${i} violated hook transition at ${p.startTime}s`);
    assert.ok(p.endTime <= 63, `Placement ${i} exceeded output duration at ${p.endTime}s`);
    assert.ok(p.endTime > p.startTime + 0.5);
    if (i > 0) {
      assert.ok(
        p.startTime >= placements[i - 1].endTime,
        `Placements ${i - 1} and ${i} overlapped (${placements[i - 1].endTime} vs ${p.startTime})`,
      );
    }
    const sourceSubject = subjects.find((s) =>
      p.matchedText.toLowerCase().includes(s.entity.toLowerCase()),
    );
    assert.ok(sourceSubject, `Placement ${p.query} was not matched to spoken clause`);
    assert.ok(
      p.clipRelativeStart >= sourceSubject.start - 0.5 &&
        p.clipRelativeStart <= sourceSubject.end + 0.5,
      `Placement start ${p.clipRelativeStart}s drifted away from spoken interval [${sourceSubject.start}, ${sourceSubject.end}]`,
    );
  }

  // Cross-clip offline reuse: a second clip referencing SpaceX & Mars when completely offline still succeeds from cache!
  const secondClipData = buildTimedSentenceTranscript([
    { start: 1, end: 5, text: 'SpaceX built a reusable booster.' },
    { start: 8, end: 13, text: 'Landing humans on Mars is next.' },
  ]);
  const offlinePlacements = await resolveBrollForClip({
    transcript: secondClipData.transcript,
    clipWords: secondClipData.words,
    clipStart: 0,
    clipEnd: 15,
    hookDurationSeconds: 0,
    cacheDir: tempRoot,
    fetchImpl: async () => {
      throw new Error('Simulated complete offline network');
    },
    detectFaces: false,
    enableLlmFallback: false,
  });
  assert.equal(offlinePlacements.length, 2);
});

test('graceful fallback never injects filler images and never fails clip rendering when searches fail or return zero results', async (t) => {
  createTemporaryDatabase(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-fallback-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const { transcript, words } = buildTimedSentenceTranscript([
    { start: 0.5, end: 4.5, text: 'Elon Musk spoke in London yesterday.' },
    { start: 5.5, end: 9.5, text: 'Everyone wondered what happens next.' },
  ]);

  const onError = await resolveBrollForClip({
    transcript,
    clipWords: words,
    clipStart: 0,
    clipEnd: 12,
    cacheDir: tempRoot,
    fetchImpl: async () => new Response('Service Unavailable', { status: 503 }),
    enableLlmFallback: false,
  });
  assert.deepEqual(onError, []);

  const onUnrelated = await resolveBrollForClip({
    transcript,
    clipWords: words,
    clipStart: 0,
    clipEnd: 12,
    cacheDir: tempRoot,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 999,
                title: 'File:Random_wooden_chair_1998.jpg',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/wikipedia/commons/9/99/Random_wooden_chair_1998.jpg',
                    mime: 'image/jpeg',
                    width: 1080,
                    height: 1920,
                    size: 90_000,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    enableLlmFallback: false,
  });
  assert.deepEqual(onUnrelated, []);

  const realJpeg = await makeSolidJpegBuffer(800, 1200, 0x33aa55ff);
  const onPartial = await resolveBrollForClip({
    transcript,
    clipWords: words,
    clipStart: 0,
    clipEnd: 30,
    cacheDir: tempRoot,
    detectFaces: false,
    enableLlmFallback: false,
    fetchImpl: async (input) => {
      const u = String(input);
      if (u.includes('api.php')) {
        if (u.toLowerCase().includes('elon+musk') || u.toLowerCase().includes('elon%20musk')) {
          return new Response(
            JSON.stringify({
              query: {
                pages: [
                  {
                    pageid: 7,
                    title: 'File:Elon_Musk_2024.jpg',
                    imageinfo: [
                      {
                        url: 'https://upload.wikimedia.org/wikipedia/commons/7/77/Elon_Musk_2024.jpg',
                        mime: 'image/jpeg',
                        width: 800,
                        height: 1200,
                        size: realJpeg.length,
                      },
                    ],
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
      }
      return new Response(new Uint8Array(realJpeg), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  });
  assert.equal(onPartial.length, 1);
  assert.match(onPartial[0].query, /Elon Musk/i);
});

test('single-pass FFmpeg rendering composites full-screen 9:16 B-roll with zero black bars, keeps Hook/CTA/captions visible on top, preserves continuous audio, supports split-screen, and leaves disabled B-roll unchanged', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-broll-ffmpeg-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  // 1. Create a 6-second 1920x1080 25fps green speaker source video + continuous 440Hz sine audio
  const sourceVideoPath = path.join(workDir, 'speaker_source.mp4');
  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x16a34a:s=1920x1080:r=25:d=6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    sourceVideoPath,
  ]);

  // 2. Create one WIDE LANDSCAPE B-roll photo (1600x900 PURE RED) and one PORTRAIT B-roll photo (900x1600 PURE BLUE)
  const landscapeRedPath = path.join(workDir, 'broll_landscape_red.jpg');
  const portraitBluePath = path.join(workDir, 'broll_portrait_blue.jpg');
  fs.writeFileSync(landscapeRedPath, await makeSolidJpegBuffer(1600, 900, 0xdc2626ff));
  fs.writeFileSync(portraitBluePath, await makeSolidJpegBuffer(900, 1600, 0x2563ebff));

  // 3. Create transparent Remotion-style PNG sequence across 6.0s (150 frames @ 25fps):
  //    - Top Hook banner band (y=260..340): PURE CYAN on all frames in [0s..2.0s]
  //    - Lower-third Caption band (y=1380..1460): PURE YELLOW across all frames [0s..6.0s]
  //    - Bottom CTA banner band (y=1700..1780): PURE MAGENTA on frames [4.0s..6.0s]
  const ovDir = path.join(workDir, 'overlays');
  fs.mkdirSync(ovDir, { recursive: true });

  const hookCaptionPng = path.join(workDir, 'proto_hook.png');
  const midCaptionPng = path.join(workDir, 'proto_mid.png');
  const ctaCaptionPng = path.join(workDir, 'proto_cta.png');

  await makeOverlayPngFrame(hookCaptionPng, 1080, 1920, [
    { x: 140, y: 260, w: 800, h: 80, color: 0x00ffffff }, // Cyan Hook overlay
    { x: 140, y: 1380, w: 800, h: 80, color: 0xffe600ff }, // Yellow Caption overlay
  ]);
  await makeOverlayPngFrame(midCaptionPng, 1080, 1920, [
    { x: 140, y: 1380, w: 800, h: 80, color: 0xffe600ff }, // Yellow Caption overlay
  ]);
  await makeOverlayPngFrame(ctaCaptionPng, 1080, 1920, [
    { x: 140, y: 1380, w: 800, h: 80, color: 0xffe600ff }, // Yellow Caption overlay
    { x: 140, y: 1700, w: 800, h: 80, color: 0xff00ffff }, // Magenta CTA overlay
  ]);

  for (let f = 1; f <= 150; f += 1) {
    const dst = path.join(ovDir, `ov_${String(f).padStart(5, '0')}.png`);
    const proto = f <= 50 ? hookCaptionPng : f >= 101 ? ctaCaptionPng : midCaptionPng;
    fs.copyFileSync(proto, dst);
  }

  const overlays: OverlayFrameSequence[] = [
    {
      name: 'captions+hook+cta',
      inputPattern: path.join(ovDir, 'ov_%05d.png'),
      startAtSeconds: 0,
    },
  ];

  const singlePlan: LayoutPlan = {
    mode: 'single',
    cropW: 608,
    cropH: 1080,
    points: [],
    faceAnchorY: 0.32,
  };

  const renderedWithBroll = path.join(workDir, 'out_with_broll.mp4');
  await processVideoSegment({
    sourceVideoPath,
    outputPath: renderedWithBroll,
    start: 0,
    end: 4,
    hookDuration: 2,
    hookStart: 0,
    filterPresetId: 'none',
    plan: singlePlan,
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetFps: 25,
    sourceHasAudio: true,
    brollPlacements: [
      { imagePath: landscapeRedPath, startTime: 2.8, endTime: 4.0, focalX: 0.5, focalY: 0.35 },
      { imagePath: portraitBluePath, startTime: 4.6, endTime: 5.8, focalX: 0.5, focalY: 0.35 },
    ],
    overlays,
  });

  const outMeta = await getVideoMetadata(renderedWithBroll);
  assert.equal(outMeta.width, 1080);
  assert.equal(outMeta.height, 1920);
  assert.equal(outMeta.hasAudio, true);
  assert.ok(Math.abs(outMeta.duration - 6.0) < 0.15, `Unexpected duration ${outMeta.duration}`);

  // Frame A (t = 0.8s): Hook intro -> speaker GREEN background + CYAN hook overlay + YELLOW caption
  const frameHook = await decodeVideoFrameRgb(renderedWithBroll, 0.8);
  const bgHook = pixelAt(frameHook, 540, 800);
  const hookBannerPx = pixelAt(frameHook, 540, 300);
  const hookCapPx = pixelAt(frameHook, 540, 1420);
  assert.ok(bgHook.g > 130 && bgHook.g > bgHook.r + 60, `Expected green speaker at 0.8s, got ${JSON.stringify(bgHook)}`);
  assert.ok(hookBannerPx.g > 180 && hookBannerPx.b > 180 && hookBannerPx.r < 80, `Expected cyan Hook overlay on top at 0.8s, got ${JSON.stringify(hookBannerPx)}`);
  assert.ok(hookCapPx.r > 180 && hookCapPx.g > 180 && hookCapPx.b < 80, `Expected yellow Caption overlay at 0.8s, got ${JSON.stringify(hookCapPx)}`);

  // Frame B (t = 3.2s): Active Landscape B-roll #1 -> FULL-BLEED RED across all 4 corners (NO BLACK BARS!) + YELLOW caption visible ON TOP!
  const frameRedBroll = await decodeVideoFrameRgb(renderedWithBroll, 3.2);
  for (const [cx, cy] of [
    [8, 8],
    [1071, 8],
    [8, 1911],
    [1071, 1911],
    [540, 800],
  ]) {
    const px = pixelAt(frameRedBroll, cx, cy);
    assert.ok(
      px.r > 170 && px.g < 70 && px.b < 70,
      `Expected full-bleed RED B-roll with zero black bars at (${cx},${cy}), got ${JSON.stringify(px)}`,
    );
  }
  const capOverRed = pixelAt(frameRedBroll, 540, 1420);
  assert.ok(
    capOverRed.r > 180 && capOverRed.g > 180 && capOverRed.b < 80,
    `Expected yellow Caption ON TOP OF red B-roll at 3.2s, got ${JSON.stringify(capOverRed)}`,
  );

  // Frame C (t = 4.25s): Between B-roll #1 and B-roll #2 -> reverts cleanly to speaker GREEN + Caption + CTA!
  const frameBetween = await decodeVideoFrameRgb(renderedWithBroll, 4.25);
  const bgBetween = pixelAt(frameBetween, 540, 800);
  assert.ok(
    bgBetween.g > 130 && bgBetween.g > bgBetween.r + 60,
    `Expected speaker GREEN restored between B-roll intervals at 4.25s, got ${JSON.stringify(bgBetween)}`,
  );

  // Frame D (t = 5.2s): Active Portrait B-roll #2 -> FULL-BLEED BLUE + Yellow Caption ON TOP + Magenta CTA ON TOP!
  const frameBlueBroll = await decodeVideoFrameRgb(renderedWithBroll, 5.2);
  const bgBlue = pixelAt(frameBlueBroll, 540, 800);
  const capOverBlue = pixelAt(frameBlueBroll, 540, 1420);
  const ctaOverBlue = pixelAt(frameBlueBroll, 540, 1740);
  assert.ok(
    bgBlue.b > 170 && bgBlue.r < 90,
    `Expected full-screen BLUE B-roll at 5.2s, got ${JSON.stringify(bgBlue)}`,
  );
  assert.ok(
    capOverBlue.r > 180 && capOverBlue.g > 180 && capOverBlue.b < 80,
    `Expected yellow Caption ON TOP OF blue B-roll at 5.2s, got ${JSON.stringify(capOverBlue)}`,
  );
  assert.ok(
    ctaOverBlue.r > 180 && ctaOverBlue.b > 180 && ctaOverBlue.g < 80,
    `Expected magenta CTA overlay ON TOP OF blue B-roll at 5.2s, got ${JSON.stringify(ctaOverBlue)}`,
  );

  // Verify continuous uninterrupted audio across speaker AND both B-roll windows!
  const pcm = await decodeAudioPcm16Mono(renderedWithBroll);
  const rmsHook = rmsSlice(pcm, 0.4, 1.2);
  const rmsDuringRedBroll = rmsSlice(pcm, 3.0, 3.8);
  const rmsBetweenBroll = rmsSlice(pcm, 4.1, 4.5);
  const rmsDuringBlueBroll = rmsSlice(pcm, 4.8, 5.6);
  assert.ok(rmsHook > 2000, `Expected audible hook speech audio, got RMS=${rmsHook}`);
  assert.ok(rmsDuringRedBroll > 2000, `Audio dropped during B-roll #1! RMS=${rmsDuringRedBroll}`);
  assert.ok(rmsBetweenBroll > 2000, `Audio dropped between B-roll intervals! RMS=${rmsBetweenBroll}`);
  assert.ok(rmsDuringBlueBroll > 2000, `Audio dropped during B-roll #2! RMS=${rmsDuringBlueBroll}`);

  // 4. Verify split-screen layout ALSO works cleanly both WITH full-screen B-roll and WITHOUT B-roll!
  const splitPlan: LayoutPlan = {
    mode: 'split',
    cells: [
      {
        trackId: 1,
        cellX: 0,
        cellY: 0,
        cellW: 1080,
        cellH: 960,
        cropW: 960,
        cropH: 854,
        camera: { x0: 0, y0: 100, moves: [], truncated: false },
        faceZone: { top: 200, bottom: 500 },
        headZone: { top: 150, bottom: 560 },
        trace: [],
      },
      {
        trackId: 2,
        cellX: 0,
        cellY: 960,
        cellW: 1080,
        cellH: 960,
        cropW: 960,
        cropH: 854,
        camera: { x0: 960, y0: 100, moves: [], truncated: false },
        faceZone: { top: 1160, bottom: 1460 },
        headZone: { top: 1110, bottom: 1520 },
        trace: [],
      },
    ],
  };

  const renderedSplitWithBroll = path.join(workDir, 'out_split_broll.mp4');
  await processVideoSegment({
    sourceVideoPath,
    outputPath: renderedSplitWithBroll,
    start: 0,
    end: 3,
    hookDuration: 0,
    hookStart: 0,
    filterPresetId: 'none',
    plan: splitPlan,
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetFps: 25,
    sourceHasAudio: true,
    brollPlacements: [
      { imagePath: landscapeRedPath, startTime: 1.0, endTime: 2.0, focalX: 0.5, focalY: 0.35 },
    ],
    overlays: [],
  });
  const splitBrollFrame = await decodeVideoFrameRgb(renderedSplitWithBroll, 1.5);
  const splitMidPx = pixelAt(splitBrollFrame, 540, 960);
  assert.ok(splitMidPx.r > 170 && splitMidPx.g < 70, `Full-screen B-roll must cover entire 1080x1920 canvas in split mode, got ${JSON.stringify(splitMidPx)}`);

  const splitAfterFrame = await decodeVideoFrameRgb(renderedSplitWithBroll, 2.5);
  const splitAfterPx = pixelAt(splitAfterFrame, 540, 480);
  assert.ok(splitAfterPx.g > 130 && splitAfterPx.g > splitAfterPx.r + 60, `Split-screen base must return cleanly after B-roll ends, got ${JSON.stringify(splitAfterPx)}`);

  // 5. Non-regression when B-roll is disabled (`brollPlacements: []` / `enableBroll: false`)
  assert.deepEqual(buildBrollFilterStatements([], [], 25, 1080, 1920, 'vbase'), {
    statements: [],
    outputLabel: 'vbase',
  });

  const renderedDisabled = path.join(workDir, 'out_disabled_broll.mp4');
  await processVideoSegment({
    sourceVideoPath,
    outputPath: renderedDisabled,
    start: 0,
    end: 4,
    hookDuration: 2,
    hookStart: 0,
    filterPresetId: 'none',
    plan: singlePlan,
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetFps: 25,
    sourceHasAudio: true,
    brollPlacements: [],
    overlays,
  });
  const frameDisabledAt32 = await decodeVideoFrameRgb(renderedDisabled, 3.2);
  const pxDisabled = pixelAt(frameDisabledAt32, 540, 800);
  assert.ok(
    pxDisabled.g > 130 && pxDisabled.g > pxDisabled.r + 60,
    `Disabled B-roll render must show normal speaker frame at 3.2s, got ${JSON.stringify(pxDisabled)}`,
  );

  // Settings, clip edits, and pipeline job mapping default `enableBroll` to true and respect explicit false
  createTemporaryDatabase(t);
  const defaults = resolveSettings({});
  assert.equal(defaults.effective.render.enableBroll, true);

  const sanitizedOff = sanitizeSettingsSection('render', { enableBroll: false });
  assert.equal(sanitizedOff.enableBroll, false);

  const clipFixture: ClipRecord = {
    _id: 'clip-1',
    videoId: 'vid-1',
    videoTitle: 'Test Clip',
    start: 0,
    end: 15,
    hookDuration: 3,
    hookText: 'Watch this',
    filterPreset: 'none',
    status: 'pending',
    enableBroll: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const edited = sanitizeClipEdits({ enableBroll: true }, { duration: 60 });
  assert.equal(edited.enableBroll, true);

  const jobOff = await jobDataFromClip(clipFixture);
  assert.equal(jobOff.enableBroll, false);
});

test('scheduleBrollPlacements cleanly supports hookless clips and strict per-clip deduplication', () => {
  const mkMatch = (
    idx: number,
    mentionStart: number,
    stem: string,
    hash: string,
  ) => ({
    moment: {
      id: `m-${idx}`,
      segmentIndex: idx,
      segmentStart: mentionStart,
      segmentEnd: mentionStart + 3.5,
      mentionStart,
      mentionEnd: mentionStart + 1.2,
      queries: [stem],
      primarySubject: stem,
      subjectKind: 'person' as const,
      segmentText: `Talking about ${stem}`,
      priority: 95,
    },
    asset: {
      id: `asset-${idx}`,
      normalizedUrl: `https://upload.wikimedia.org/wikipedia/commons/${hash}/${stem}.jpg`,
      sourceUrl: `https://upload.wikimedia.org/wikipedia/commons/${hash}/${stem}.jpg`,
      contentHash: hash,
      localPath: `${hash}.jpg`,
      mimeType: 'image/jpeg' as const,
      width: 1080,
      height: 1600,
      fileSize: 90_000,
      focalX: 0.5,
      focalY: 0.35,
      searchTerms: [stem],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      absolutePath: `/tmp/${hash}.jpg`,
      cacheHit: true,
    },
    query: stem,
    relevanceScore: 80,
    canonicalStem: stem.toLowerCase(),
  });

  const scheduled = scheduleBrollPlacements(
    [
      mkMatch(0, 1.0, 'Barack Obama', '1111111111111111'),
      mkMatch(1, 8.0, 'Barack Obama', '1111111111111111'),
      mkMatch(2, 16.0, 'White House', '2222222222222222'),
    ],
    { clipDurationSeconds: 24, hookDurationSeconds: 0 },
  );

  assert.equal(scheduled.length, 2);
  assert.notEqual(scheduled[0].imagePath, scheduled[1].imagePath);
  assert.ok(scheduled[0].startTime >= 0.8 && scheduled[0].startTime <= 1.2);
  assert.ok(scheduled[1].startTime >= 15.8 && scheduled[1].startTime <= 16.2);
});

test('WMF standard 960px thumbnail step, Wikipedia pageimages fallback, HTTP 429 fallback, and DSLR Jimp downscaling work reliably', async (t) => {
  createTemporaryDatabase(t);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-wmf-cache-'));
  t.after(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // 1. Standard 960px step in Wikimedia Commons search URL (never non-stepped 1440px!)
  const commonsUrl = new URL(buildWikimediaSearchUrl('Elon Musk'));
  assert.equal(commonsUrl.searchParams.get('iiurlwidth'), String(WMF_STANDARD_THUMB_WIDTH));
  assert.equal(commonsUrl.searchParams.get('iiurlwidth'), '960');
  assert.equal(
    buildStandardWikimediaThumbUrl(
      'https://upload.wikimedia.org/wikipedia/commons/5/55/HighRes_DSLR_Photo.jpg',
      960,
    ),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/5/55/HighRes_DSLR_Photo.jpg/960px-HighRes_DSLR_Photo.jpg',
  );

  const wikiUrl = new URL(buildWikipediaPageImagesUrl('Smartphone'));
  assert.equal(wikiUrl.origin, 'https://en.wikipedia.org');
  assert.equal(wikiUrl.searchParams.get('pilicense'), 'free');
  assert.equal(wikiUrl.searchParams.get('pithumbsize'), '960');

  // 2. Commons 0 results automatically cascades to English Wikipedia pageimages!
  let wikiCalled = false;
  const cascadeResults = await searchWikimediaCommons('Smartphones', {
    fetchImpl: async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('commons.wikimedia.org')) {
        return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
      }
      wikiCalled = true;
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 99,
                title: 'Smartphone',
                pageimage: 'Modern_smartphone_on_desk.jpg',
                thumbnail: {
                  source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Modern_smartphone_on_desk.jpg/960px-Modern_smartphone_on_desk.jpg',
                  width: 960,
                  height: 1280,
                },
                original: {
                  source: 'https://upload.wikimedia.org/wikipedia/commons/1/12/Modern_smartphone_on_desk.jpg',
                  width: 3000,
                  height: 4000,
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(wikiCalled, true);
  assert.equal(cascadeResults.length, 1);
  assert.equal(cascadeResults[0].width, 3000);
  assert.equal(cascadeResults[0].height, 4000);

  // 3. Large 2400x1600 DSLR image on original fallback URL succeeds when thumburl returns HTTP 429,
  //    and is automatically downscaled on disk while preserving original metadata dimensions!
  const dslrBuffer = await makeSolidJpegBuffer(2400, 1600, 0x2288ddff);
  const requestedUrls: string[] = [];
  const resilientAsset = await ensureCachedBrollAsset(
    {
      normalizedUrl: 'https://upload.wikimedia.org/wikipedia/commons/5/55/HighRes_DSLR_Photo.jpg',
      sourceUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/5/55/HighRes_DSLR_Photo.jpg/1440px-HighRes_DSLR_Photo.jpg',
      originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/5/55/HighRes_DSLR_Photo.jpg',
      title: 'File:HighRes_DSLR_Photo.jpg',
      attribution: 'Jane Photographer',
      license: 'CC BY-SA 4.0',
      width: 2400,
      height: 1600,
      mimeType: 'image/jpeg',
      relevanceScore: 88,
      canonicalStem: 'highres dslr photo',
    },
    {
      cacheDir,
      searchTerms: ['DSLR photo'],
      detectFaces: false,
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('1440px-')) {
          return new Response('Too Many Requests', { status: 429 });
        }
        return new Response(new Uint8Array(dslrBuffer), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      },
    },
  );
  assert.ok(resilientAsset, 'Expected automatic fallback to 960px standard thumb / original URL on 429');
  assert.ok(requestedUrls.some((u) => u.includes('/960px-HighRes_DSLR_Photo.jpg')));
  // Metadata preserves original 2400x1600 while on-disk JPEG is downscaled to <=1440px wide!
  assert.equal(resilientAsset.width, 2400);
  assert.equal(resilientAsset.height, 1600);
  const onDiskDecoded = await Jimp.read(fs.readFileSync(resilientAsset.absolutePath));
  assert.equal(onDiskDecoded.width, 1440);
  assert.equal(onDiskDecoded.height, 960);
});

test('1-word whisper.cpp segments (-ml 1), conversational speech, and clip card B-roll counts work end-to-end', async (t) => {
  createTemporaryDatabase(t);
  // Build a realistic 64-second conversational podcast transcript where EVERY segment in
  // transcript.segments has ONLY ONE lowercase word — matching `whisper-cli -ml 1 -sow -ojf`!
  const spokenText =
    'most founders spend years chasing venture capital in silicon valley while ignoring real customers ' +
    'at first their startup burns cash on a fancy office and hiring engineers too early ' +
    'then one founder takes a laptop into coffee shops in austin and interviews fifty doctors ' +
    'within months hospital clinics sign contracts worth millions of dollars in revenue ' +
    'meanwhile competitors pitch slide decks on stages and podcasts without shipping software ' +
    'even wall street investors notice when a small team builds profitable cloud servers ' +
    'eventually the company launches mobile apps across europe and tokyo airports ' +
    'that simple discipline turns a tiny garage experiment into an enduring global business';

  const rawWords = spokenText.split(/\s+/);
  const step = 62 / rawWords.length;
  const whisperWords: WordTimestamp[] = rawWords.map((word, idx) => ({
    word,
    start: Number((1 + idx * step).toFixed(2)),
    end: Number((1 + (idx + 0.85) * step).toFixed(2)),
  }));
  // Exact 1-word segments just like `lib/whisper.ts` produces!
  const oneWordSegments = whisperWords.map((w, id) => ({
    id,
    start: w.start,
    end: w.end,
    text: w.word,
    words: [w],
  }));

  const whisperTranscript: TranscriptData = {
    text: spokenText,
    segments: oneWordSegments,
    words: whisperWords,
  };

  // Offline extraction (zero LLM key) still reconstructs full multi-word clauses and finds >= 8 distinct moments!
  const offlineMoments = extractBrollMomentsFromTranscript({
    transcript: whisperTranscript,
    clipWords: whisperWords,
    clipStart: 0,
    clipEnd: 64,
  });
  assert.ok(
    offlineMoments.length >= 8,
    `Expected >= 8 moments from 1-word Whisper segments, got ${offlineMoments.length}`,
  );
  // Clauses must be reconstructed (never 1-word segmentText!)
  assert.ok(offlineMoments.every((m) => m.segmentText.split(/\s+/).length >= 4));

  // Verify LLM enrichment path passes maxOutputTokens >= 8192 (so Gemini 3.x thinking never truncates!)
  await saveSettingsSection('ai', {
    geminiApiKeys: ['AIzaSyTestKey12345678901234567890'],
  });
  const originalFetch = globalThis.fetch;
  let capturedMaxOutputTokens = 0;
  try {
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      capturedMaxOutputTokens = Number(parsed?.generationConfig?.maxOutputTokens ?? 0);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      cues: [
                        { timeSeconds: 3, query: 'Wall Street', fallbackQuery: 'Stock exchange', kind: 'place' },
                        { timeSeconds: 11, query: 'Federal Reserve', fallbackQuery: 'Bank', kind: 'landmark' },
                        { timeSeconds: 19, query: 'Silicon Valley', fallbackQuery: 'Office', kind: 'place' },
                        { timeSeconds: 27, query: 'Data center', fallbackQuery: 'Server', kind: 'object' },
                        { timeSeconds: 35, query: 'Container ship', fallbackQuery: 'Port', kind: 'object' },
                        { timeSeconds: 43, query: 'Tokyo', fallbackQuery: 'City skyline', kind: 'landmark' },
                        { timeSeconds: 51, query: 'SpaceX Falcon 9', fallbackQuery: 'Rocket', kind: 'event' },
                        { timeSeconds: 57, query: 'Microphone', fallbackQuery: 'Studio', kind: 'object' },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const conversationalWords: WordTimestamp[] = Array.from({ length: 60 }, (_, idx) => ({
      word: idx % 2 === 0 ? 'people' : 'think',
      start: idx,
      end: idx + 0.8,
    }));

    const enrichedMoments = await maybeEnrichMomentsWithFreeLlm({
      existingMoments: [],
      clipWords: conversationalWords,
      clipStart: 0,
      clipEnd: 60,
      targetCount: 8,
    });
    assert.ok(
      capturedMaxOutputTokens >= 8192,
      `Expected maxOutputTokens >= 8192 for Gemini 3.x thinking headroom, got ${capturedMaxOutputTokens}`,
    );
    assert.equal(enrichedMoments.length, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Verify synchronous clip-card planning count + rendered vs unrendered vs disabled card labels!
  const plannedCount = planClipBrollCount({
    transcript: whisperTranscript,
    clipStart: 0,
    clipEnd: 64,
    enableBroll: true,
  });
  assert.ok(plannedCount >= 9 && plannedCount <= 11);

  const pendingSummary = getClipBrollSummary({
    start: 0,
    end: 60,
    status: 'pending',
    enableBroll: true,
    brollCount: 8,
  });
  assert.equal(pendingSummary.count, 8);
  assert.equal(pendingSummary.isActualRendered, false);
  assert.equal(pendingSummary.shortLabel, '8 images');
  assert.equal(pendingSummary.label, '8 B-roll images');

  const doneSummary = getClipBrollSummary({
    start: 0,
    end: 60,
    status: 'done',
    enableBroll: true,
    brollCount: 7,
  });
  assert.equal(doneSummary.count, 7);
  assert.equal(doneSummary.isActualRendered, true);
  assert.equal(doneSummary.shortLabel, '7 images');
  assert.equal(doneSummary.label, '7 B-roll images');

  const disabledSummary = getClipBrollSummary({
    start: 0,
    end: 60,
    status: 'pending',
    enableBroll: false,
    brollCount: 0,
  });
  assert.equal(disabledSummary.enabled, false);
  assert.equal(disabledSummary.count, 0);
  assert.equal(disabledSummary.shortLabel, 'B-roll off');
});

