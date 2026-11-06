import assert from 'node:assert/strict';
import test from 'node:test';
import { findWikipediaImage } from '../lib/broll/providers/wikipedia';
import type { BrollFetch, BrollHttpResponse } from '../lib/broll/http';

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

function summary(title = 'Cristiano Ronaldo', extra: Record<string, unknown> = {}) {
  return {
    type: 'standard',
    title,
    description: 'Portuguese footballer',
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}` } },
    originalimage: {
      source: 'https://upload.wikimedia.org/image/original.jpg',
      width: 4000,
      height: 3000,
    },
    ...extra,
  };
}

function imageInfo(extra: Record<string, unknown> = {}) {
  return {
    query: {
      pages: [{
        imageinfo: [{
          mime: 'image/jpeg',
          thumburl: 'https://upload.wikimedia.org/image/thumb-1600.jpg',
          extmetadata: {
            Artist: { value: '<a href="https://example.test">Jane Doe</a>' },
            Credit: { value: 'Museum archive' },
            LicenseShortName: { value: 'CC BY-SA 4.0' },
            LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
            ...((extra.extmetadata as Record<string, unknown> | undefined) ?? {}),
          },
          ...extra,
        }],
      }],
    },
  };
}

function fakeFetch(handler: (url: string) => BrollHttpResponse): BrollFetch {
  return async (url) => handler(url);
}

test('Wikipedia image includes attribution and prefers the 1600px thumbnail', async () => {
  const result = await findWikipediaImage('Cristiano Ronaldo', {
    fetcher: fakeFetch((url) => url.includes('action=query')
      ? jsonResponse(imageInfo())
      : jsonResponse(summary())),
  });

  assert.ok(result);
  assert.equal(result.provider, 'wikipedia');
  assert.equal(result.providerId, 'Cristiano Ronaldo');
  assert.equal(result.imageUrl, 'https://upload.wikimedia.org/image/thumb-1600.jpg');
  assert.equal(result.thumbUrl, result.imageUrl);
  assert.equal(result.pageUrl, 'https://en.wikipedia.org/wiki/Cristiano_Ronaldo');
  assert.equal(result.author, 'Jane Doe');
  assert.equal(result.license, 'CC BY-SA 4.0');
  assert.equal(result.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
});

test('a summary 404 resolves one OpenSearch result and fetches its summary', async () => {
  const urls: string[] = [];
  const result = await findWikipediaImage('CR7', {
    fetcher: fakeFetch((url) => {
      urls.push(url);
      if (url.includes('/page/summary/CR7')) return jsonResponse({}, 404);
      if (url.includes('action=opensearch')) return jsonResponse(['CR7', ['Cristiano Ronaldo']]);
      if (url.includes('/page/summary/Cristiano_Ronaldo')) return jsonResponse(summary());
      if (url.includes('action=query')) return jsonResponse(imageInfo());
      throw new Error(`Unexpected URL: ${url}`);
    }),
  });

  assert.equal(result?.providerId, 'Cristiano Ronaldo');
  assert.equal(urls.filter((url) => url.includes('/page/summary/')).length, 2);
});

test('a disambiguation result is resolved once, then rejected if still ambiguous', async () => {
  let summaries = 0;
  const result = await findWikipediaImage('Mercury', {
    fetcher: fakeFetch((url) => {
      if (url.includes('/page/summary/')) {
        summaries += 1;
        return jsonResponse({ ...summary(), type: 'disambiguation' });
      }
      if (url.includes('action=opensearch')) return jsonResponse(['Mercury', ['Mercury (planet)']]);
      throw new Error(`Unexpected URL: ${url}`);
    }),
  });

  assert.equal(result, null);
  assert.equal(summaries, 2);
});

test('missing originalimage returns null without querying image metadata', async () => {
  let metadataCalls = 0;
  const result = await findWikipediaImage('No image', {
    fetcher: fakeFetch((url) => {
      if (url.includes('action=query')) metadataCalls += 1;
      return jsonResponse(summary('No image', { originalimage: undefined }));
    }),
  });

  assert.equal(result, null);
  assert.equal(metadataCalls, 0);
});

test('non-free and unsupported MIME images are rejected', async () => {
  for (const info of [
    imageInfo({ extmetadata: { NonFree: { value: 'true' } } }),
    imageInfo({ extmetadata: { NonFree: { value: '1' } } }),
    imageInfo({ mime: 'image/svg+xml' }),
  ]) {
    const result = await findWikipediaImage('Restricted image', {
      fetcher: fakeFetch((url) => url.includes('action=query')
        ? jsonResponse(info)
        : jsonResponse(summary('Restricted image'))),
    });
    assert.equal(result, null);
  }
});

test('missing thumburl downloads the original image URL', async () => {
  const result = await findWikipediaImage('Original fallback', {
    fetcher: fakeFetch((url) => url.includes('action=query')
      ? jsonResponse(imageInfo({ thumburl: undefined }))
      : jsonResponse(summary('Original fallback'))),
  });

  assert.equal(result?.imageUrl, 'https://upload.wikimedia.org/image/original.jpg');
});

test('a REST summary thumbnail resolves the original Commons filename', async () => {
  let metadataUrl = '';
  const source = 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Zendaya-byPhilipRomano.jpg/3840px-Zendaya-byPhilipRomano.jpg?width=3840';
  const result = await findWikipediaImage('Zendaya', {
    fetcher: fakeFetch((url) => {
      if (url.includes('action=query')) {
        metadataUrl = url;
        return jsonResponse(imageInfo());
      }
      return jsonResponse({
        ...summary('Zendaya'),
        originalimage: { source, width: 4024, height: 6048 },
      });
    }),
  });

  assert.ok(result);
  assert.equal(new URL(metadataUrl).searchParams.get('titles'), 'File:Zendaya-byPhilipRomano.jpg');
});