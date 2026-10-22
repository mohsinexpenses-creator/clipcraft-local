import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVisionPrompt,
  parseVisionVerdict,
  verdictAccepts,
  verdictRejectionReason,
  verifyEntityImage,
  VISION_MIN_CONFIDENCE,
} from '../lib/broll/vision';
import type { BrollHttpResponse, BrollFetch } from '../lib/broll/http';

/**
 * The verdict gate. A full-screen image is only shown when the model says, in
 * so many words, that it is the named entity and that it is safe to show.
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

const images = [
  { index: 0, data: 'aGVsbG8=', mime: 'image/jpeg' },
  { index: 1, data: 'd29ybGQ=', mime: 'image/jpeg' },
];

test('a clean verdict is accepted', () => {
  const verdict = parseVisionVerdict(
    '{"pickIndex":0,"confidence":0.91,"reason":"It is Elon Musk.","hasTextOrWatermark":false,"isSafe":true}',
    2
  );
  assert.equal(verdict.pickIndex, 0);
  assert.equal(verdict.confidence, 0.91);
  assert.equal(verdictAccepts(verdict), true);
});

test('a JSON code fence is tolerated, garbage is not', () => {
  const fenced = parseVisionVerdict(
    '```json\n{"pickIndex":1,"confidence":0.8,"reason":"ok","hasTextOrWatermark":false,"isSafe":true}\n```',
    2
  );
  assert.equal(fenced.pickIndex, 1);

  const garbage = parseVisionVerdict('I think image 2 is best', 2);
  assert.equal(garbage.pickIndex, null);
  assert.equal(verdictAccepts(garbage), false);
});

test('an out-of-range pick, missing confidence or a text flag rejects the image', () => {
  assert.equal(verdictAccepts(parseVisionVerdict('{"pickIndex":7,"confidence":0.9}', 2)), false);
  assert.equal(verdictAccepts(parseVisionVerdict('{"pickIndex":0}', 2)), false);
  assert.equal(
    verdictAccepts(parseVisionVerdict('{"pickIndex":0,"confidence":0.95,"hasTextOrWatermark":true}', 2)),
    false
  );
  assert.equal(verdictAccepts(parseVisionVerdict('{"pickIndex":0,"confidence":0.95,"isSafe":false}', 2)), false);
});

test('percent-style confidence is normalised', () => {
  const verdict = parseVisionVerdict('{"pickIndex":0,"confidence":85,"reason":"match"}', 2);
  assert.equal(verdict.confidence, 0.85);
  assert.equal(verdictAccepts(verdict), true);
});

test('the rejection reason says exactly why', () => {
  const low = parseVisionVerdict('{"pickIndex":0,"confidence":0.2,"reason":"maybe"}', 2);
  assert.match(verdictRejectionReason(low), /Not confident enough/);
  const unsafe = parseVisionVerdict('{"pickIndex":0,"confidence":0.9,"isSafe":false,"reason":"gore"}', 2);
  assert.match(verdictRejectionReason(unsafe), /Unsafe/);
  const none = parseVisionVerdict('{"pickIndex":null,"reason":"different person"}', 2);
  assert.match(verdictRejectionReason(none), /different person/);
});

test('the threshold constant is the brief’s 0.6 and is enforced', () => {
  assert.equal(VISION_MIN_CONFIDENCE, 0.6);
  assert.equal(
    verdictAccepts(parseVisionVerdict('{"pickIndex":0,"confidence":0.59,"reason":"x"}', 2)),
    false
  );
});

test('the prompt names the entity, the context and the JSON contract', () => {
  const prompt = buildVisionPrompt({
    entityName: 'Eiffel Tower',
    entityType: 'place',
    context: 'we went straight to the Eiffel Tower that night',
    commonsTitle: 'Tour Eiffel Wikimedia Commons.jpg',
    commonsDescription: 'The Eiffel Tower seen from the Champ de Mars',
    commonsCategories: ['Eiffel Tower', 'Paris'],
    images,
  });
  assert.match(prompt, /Eiffel Tower/);
  assert.match(prompt, /we went straight to the Eiffel Tower/);
  assert.match(prompt, /pickIndex/);
  assert.match(prompt, /hasTextOrWatermark/);
  assert.match(prompt, /Paris/);
  assert.match(prompt, /null/);
});

test('verify sends the images with the key in the header, never the URL', async () => {
  let seenUrl = '';
  let seenInit: { headers?: Record<string, string>; body?: string } | undefined;
  const fetcher: BrollFetch = (url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: '{"pickIndex":0,"confidence":0.93,"reason":"yes","hasTextOrWatermark":false,"isSafe":true}' },
              ],
            },
          },
        ],
      })
    );
  };

  const verdict = await verifyEntityImage(
    { entityName: 'Tokyo', entityType: 'place', context: 'Tokyo at night', images },
    { fetcher, keys: ['key-1'] }
  );
  assert.equal(verdict.pickIndex, 0);
  assert.doesNotMatch(seenUrl, /key-1/, 'the key must not be in the URL');
  assert.equal(seenInit?.headers?.['x-goog-api-key'], 'key-1');
  const body = JSON.parse(seenInit?.body ?? '{}');
  assert.equal(body.contents[0].parts.length, 3, 'prompt + 2 images');
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
});

test('a rejected key rotates to the next key, and an exhausted pool throws', async () => {
  const keysSeen: string[] = [];
  const fetcher: BrollFetch = (_url, init) => {
    const key = init?.headers?.['x-goog-api-key'] ?? '';
    keysSeen.push(key);
    return Promise.resolve(
      key === 'bad'
        ? jsonResponse({ error: 'bad key' }, 403)
        : jsonResponse({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"pickIndex":1,"confidence":0.7,"reason":"ok","isSafe":true}' }],
                },
              },
            ],
          })
    );
  };
  const verdict = await verifyEntityImage(
    { entityName: 'X', entityType: 'person', context: 'x', images },
    { fetcher, keys: ['bad', 'good'] }
  );
  assert.deepEqual(keysSeen, ['bad', 'good']);
  assert.equal(verdict.pickIndex, 1);

  await assert.rejects(
    () =>
      verifyEntityImage(
        { entityName: 'X', entityType: 'person', context: 'x', images },
        { fetcher, keys: ['bad'] }
      ),
    /could not verify/
  );
});

test('no configured key is a clear, actionable error', async () => {
  await assert.rejects(
    () => verifyEntityImage({ entityName: 'X', entityType: 'person', context: 'x', images }, { keys: [] }),
    /No Gemini key is configured/
  );
});
