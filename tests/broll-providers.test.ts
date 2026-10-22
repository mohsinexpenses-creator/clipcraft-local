import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommonsSearchUrl,
  parseCommonsResponse,
  rankCommonsCandidates,
  searchCommons,
} from '../lib/broll/providers/commons';
import {
  buildPexelsUrl,
  buildPixabayUrl,
  buildUnsplashUrl,
  parsePexelsResponse,
  parsePixabayResponse,
  parseUnsplashResponse,
  searchStockAcrossProviders,
} from '../lib/broll/providers/stock';
import { attributionFor, cacheKeyFor, isUsableImage, stripHtml } from '../lib/broll/providers/types';
import { ProviderQuotaError } from '../lib/broll/http';
import type { BrollHttpResponse, BrollFetch } from '../lib/broll/http';

/**
 * Provider parsing and the quota-safe chain. Every response below is a fixture:
 * `npm test` never touches the network.
 */

function jsonResponse(body: unknown, status = 200): BrollHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function fakeFetch(handler: (url: string) => BrollHttpResponse | Promise<BrollHttpResponse>): BrollFetch {
  return (url) => Promise.resolve(handler(url));
}

const COMMONS_SAMPLE = {
  query: {
    pages: [
      {
        pageid: 123,
        title: 'File:Elon Musk Royal Society (crop2).jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Elon_Musk.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Elon_Musk.jpg',
            thumburl: 'https://upload.wikimedia.org/thumb/1080px-Elon_Musk.jpg',
            thumbwidth: 1080,
            thumbheight: 1350,
            width: 3000,
            height: 3750,
            mime: 'image/jpeg',
            extmetadata: {
              Artist: { value: '<a href="https://example.org">Royal Society</a>' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
              ImageDescription: { value: 'Elon Musk in 2018' },
              Categories: { value: 'Elon Musk|Portrait photographs' },
            },
          },
        ],
      },
      {
        pageid: 124,
        title: 'File:Diagram of a rocket.svg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/x.svg',
            width: 2000,
            height: 2000,
            mime: 'image/svg+xml',
          },
        ],
      },
      {
        pageid: 125,
        title: 'File:Tiny.jpg',
        imageinfo: [
          { url: 'https://upload.wikimedia.org/tiny.jpg', width: 320, height: 240, mime: 'image/jpeg' },
        ],
      },
    ],
  },
};

test('the Commons URL asks for File-namespace search with a 1080px thumb and metadata', () => {
  const url = new URL(buildCommonsSearchUrl('Elon Musk', 10));
  assert.equal(url.hostname, 'commons.wikimedia.org');
  assert.equal(url.searchParams.get('generator'), 'search');
  assert.equal(url.searchParams.get('gsrnamespace'), '6');
  assert.equal(url.searchParams.get('gsrsearch'), 'Elon Musk');
  assert.equal(url.searchParams.get('iiurlwidth'), '1080');
  assert.match(url.searchParams.get('iiprop') ?? '', /extmetadata/);
});

test('Commons parsing keeps usable photos with full attribution and drops SVG/small files', () => {
  const candidates = parseCommonsResponse(COMMONS_SAMPLE);
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.provider, 'wikimedia');
  assert.equal(candidate.author, 'Royal Society', 'HTML is stripped from Artist');
  assert.equal(candidate.license, 'CC BY-SA 4.0');
  assert.equal(candidate.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(candidate.description, 'Elon Musk in 2018');
  assert.deepEqual(candidate.categories, ['Elon Musk', 'Portrait photographs']);
  assert.equal(candidate.title, 'Elon Musk Royal Society (crop2).jpg');
  assert.equal(candidate.pageUrl, 'https://commons.wikimedia.org/wiki/File:Elon_Musk.jpg');

  const attribution = attributionFor(candidate);
  assert.equal(attribution.sourceUrl, candidate.pageUrl);
  assert.equal(attribution.imageUrl, candidate.imageUrl);
  assert.equal(attribution.license, 'CC BY-SA 4.0');
});

test('Commons accepts both the v2 array and the legacy object page shape', () => {
  const legacy = {
    query: {
      pages: {
        '42': COMMONS_SAMPLE.query.pages[0],
      },
    },
  };
  assert.equal(parseCommonsResponse(legacy).length, 1);
});

test('Commons results are ranked with portrait images first', () => {
  const wide = { provider: 'wikimedia' as const, providerId: 'w', pageUrl: '', imageUrl: '', thumbUrl: '', width: 4000, height: 2000, mime: 'image/jpeg' };
  const tall = { ...wide, providerId: 't', width: 2000, height: 3000 };
  assert.deepEqual(rankCommonsCandidates([wide, tall]).map((item) => item.providerId), ['t', 'w']);
});

test('searchCommons goes through the injected fetcher', async () => {
  let calledUrl = '';
  const candidates = await searchCommons('Eiffel Tower', {
    fetcher: fakeFetch((url) => {
      calledUrl = url;
      return jsonResponse(COMMONS_SAMPLE);
    }),
  });
  assert.match(calledUrl, /Eiffel\+Tower/);
  assert.equal(candidates.length, 1);
});

test('Pexels results are parsed into landscape candidates with a license', () => {
  const parsed = parsePexelsResponse({
    photos: [
      {
        id: 1,
        width: 2000,
        height: 1333,
        url: 'https://www.pexels.com/photo/1/',
        photographer: 'Jane Doe',
        alt: 'City skyline at dusk',
        src: {
          large2x: 'https://images.pexels.com/photos/1/large2x.jpg',
          medium: 'https://images.pexels.com/photos/1/medium.jpg',
          original: 'https://images.pexels.com/photos/1/original.jpg',
        },
      },
      // Not landscape -> rejected (a card needs a wide picture).
      { id: 2, width: 1200, height: 1600, src: { large2x: 'https://images.pexels.com/2.jpg' } },
      // Too small -> rejected.
      { id: 3, width: 900, height: 500, src: { large2x: 'https://images.pexels.com/3.jpg' } },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].provider, 'pexels');
  assert.equal(parsed[0].author, 'Jane Doe');
  assert.equal(parsed[0].license, 'Pexels License');
  assert.equal(parsed[0].imageUrl, 'https://images.pexels.com/photos/1/large2x.jpg');
});

test('Pixabay results keep the tags and the author', () => {
  const parsed = parsePixabayResponse({
    hits: [
      {
        id: 9,
        pageURL: 'https://pixabay.com/photos/9/',
        tags: 'city, skyline, night',
        webformatURL: 'https://cdn.pixabay.com/9_640.jpg',
        largeImageURL: 'https://cdn.pixabay.com/9_1280.jpg',
        imageWidth: 1920,
        imageHeight: 1080,
        user: 'PixUser',
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].author, 'PixUser');
  assert.equal(parsed[0].title, 'city, skyline, night');
  assert.equal(parsed[0].license, 'Pixabay Content License');
});

test('Unsplash results carry the photographer, the link, and the download endpoint', () => {
  const parsed = parseUnsplashResponse({
    results: [
      {
        id: 'abc',
        width: 4000,
        height: 2667,
        alt_description: 'People running in a park',
        urls: { regular: 'https://images.unsplash.com/photo-1?w=1080', small: 'https://images.unsplash.com/photo-1?w=400' },
        links: {
          html: 'https://unsplash.com/photos/abc',
          download_location: 'https://api.unsplash.com/photos/abc/download',
        },
        user: { name: 'Sam Shoot' },
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].author, 'Sam Shoot');
  assert.equal(parsed[0].pageUrl, 'https://unsplash.com/photos/abc');
  assert.equal(parsed[0].license, 'Unsplash License');
  assert.equal(parsed[0].downloadLocation, 'https://api.unsplash.com/photos/abc/download');
});

test('the API URLs carry the landscape filter and the key', () => {
  assert.match(new URL(buildPexelsUrl('city', 8)).searchParams.get('orientation') ?? '', /landscape/);
  const pixabay = new URL(buildPixabayUrl('city', 'secret-key', 8));
  assert.equal(pixabay.searchParams.get('key'), 'secret-key');
  assert.equal(pixabay.searchParams.get('orientation'), 'horizontal');
  assert.match(new URL(buildUnsplashUrl('city', 8)).searchParams.get('orientation') ?? '', /landscape/);
});

test('the stock chain skips providers without keys and falls through on quota', async () => {
  const calls: string[] = [];
  const fetcher = fakeFetch((url) => {
    calls.push(url);
    if (url.startsWith('https://api.pexels.com')) return jsonResponse({ error: 'quota' }, 429);
    if (url.startsWith('https://pixabay.com')) {
      return jsonResponse({
        hits: [
          {
            id: 5,
            pageURL: 'https://pixabay.com/photos/5/',
            largeImageURL: 'https://cdn.pixabay.com/5.jpg',
            webformatURL: 'https://cdn.pixabay.com/5_640.jpg',
            imageWidth: 1600,
            imageHeight: 900,
            user: 'Someone',
          },
        ],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const result = await searchStockAcrossProviders('city skyline', {
    fetcher,
    providerOrder: ['pexels', 'pixabay', 'unsplash'],
    keys: { pexels: 'pe-key', pexelsPixabay: undefined, pixabay: 'pi-key' } as never,
  });

  assert.equal(result.provider, 'pixabay', 'the next provider answers');
  assert.equal(result.candidates.length, 1);
  assert.ok(result.notes.some((note) => /Pexels: .*limited|Pexels: .*quota/i.test(note)), result.notes.join(' | '));
  assert.ok(calls.some((url) => url.startsWith('https://api.pexels.com')));
});

test('the stock chain reports a rejected key as a key problem only', async () => {
  const result = await searchStockAcrossProviders('city', {
    fetcher: fakeFetch(() => jsonResponse({ error: 'unauthorized' }, 401)),
    providerOrder: ['pexels'],
    keys: { pexels: 'bad-key' },
  });
  assert.equal(result.candidates.length, 0);
  assert.match(result.notes.join(' '), /Pexels: .*rejected the API key/i);
});

test('a provider without a key is skipped without a request', async () => {
  let calls = 0;
  const result = await searchStockAcrossProviders('city', {
    fetcher: fakeFetch(() => {
      calls += 1;
      return jsonResponse({});
    }),
    providerOrder: ['unsplash'],
    keys: {},
  });
  assert.equal(calls, 0);
  assert.equal(result.candidates.length, 0);
  assert.match(result.notes.join(' '), /no API key/);
});

test('429 from fetchJson becomes a ProviderQuotaError', async () => {
  await assert.rejects(
    () =>
      searchCommons('anything', {
        fetcher: fakeFetch(() => jsonResponse({ error: 'slow down' }, 429)),
      }),
    (error: unknown) => error instanceof ProviderQuotaError
  );
});

test('image usability rejects SVG/TIFF and small files', () => {
  assert.equal(isUsableImage({ width: 1920, height: 1080, mime: 'image/jpeg' }), true);
  assert.equal(isUsableImage({ width: 1080, height: 1920, mime: 'image/png' }), true);
  assert.equal(isUsableImage({ width: 900, height: 900, mime: 'image/jpeg' }), false);
  assert.equal(isUsableImage({ width: 4000, height: 3000, mime: 'image/svg+xml' }), false);
  assert.equal(isUsableImage({ width: 4000, height: 3000, mime: 'image/tiff' }), false);
  assert.equal(stripHtml('<i>CC</i> BY'), 'CC BY');
  assert.equal(cacheKeyFor('https://x.test/a.jpg').length, 24);
  assert.notEqual(cacheKeyFor('https://x.test/a.jpg'), cacheKeyFor('https://x.test/b.jpg'));
});
