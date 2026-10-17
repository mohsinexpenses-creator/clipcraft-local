import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeNetworkFailure, verifyDeepgramKey, verifyWikimediaAccess } from '../lib/settings-verify';

/**
 * The Deepgram probe is the one place Settings makes a real outbound call, and the whole
 * point of it is that its answer is trustworthy. These stub `fetch` so the interesting
 * cases - a valid key against an endpoint that cannot see it, a moved endpoint, a dead
 * network - are asserted without needing either a key or the internet.
 */

type Reply = { status: number; body?: unknown };

function withFetch(responder: (url: string) => Reply | Error, run: (urls: () => string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = responder(url);
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async json() {
        return reply.body ?? null;
      },
      async text() {
        return reply.body === undefined ? '' : JSON.stringify(reply.body);
      },
    } as unknown as Response;
  }) as typeof fetch;

  return run(() => calls).finally(() => {
    globalThis.fetch = original;
  });
}

test('deepgram probe authenticates with the documented key check, not a management call', async () => {
  await withFetch(
    () => ({ status: 200, body: { scopes: ['admin:all'] } }),
    async (urls) => {
      const result = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-3');
      assert.deepEqual(urls(), ['https://api.deepgram.com/v1/auth/token'], 'a key without admin scope must not be judged by an endpoint it cannot reach');
      assert.equal(result.status, 'ok');
      assert.match(result.message, /admin:all/, 'the scopes are reported so a member key with no transcription scope is visible');
    }
  );
});

test('deepgram probe reports a key that authenticates but cannot transcribe', async () => {
  await withFetch(
    () => ({ status: 200, body: { scopes: ['usage:read'] } }),
    async () => {
      const result = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-3');
      assert.equal(result.status, 'limited');
      assert.match(result.message, /none of its scopes covers transcription/);
    }
  );
});

test('a 401 from the key check is the only thing that calls a key rejected', async () => {
  await withFetch(
    () => ({ status: 401, body: { error: { message: 'Invalid credentials' } } }),
    async (urls) => {
      const result = await verifyDeepgramKey('nope', 'nova-3');
      assert.equal(result.status, 'rejected');
      assert.equal(urls().length, 1, 'a rejected key needs no second opinion');
    }
  );
});

test('a 404 from the key check falls back instead of blaming a valid key', async () => {
  await withFetch((url) =>
    url.includes('/auth/token')
      ? { status: 404, body: { error: { message: 'Not Found' } } }
      : { status: 200, body: { results: [{ project_id: 'p1' }] } },
    async (urls) => {
      const result = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-2');
      assert.equal(result.status, 'ok', 'the projects call authenticated the key, so the answer is ok');
      assert.equal(urls().length, 2, 'the fallback is only tried after the first endpoint fails');
      assert.match(result.message, /1 project/);
      assert.ok(result.notes?.some((note) => note.includes('/v1/auth/token')), 'the skipped endpoint is admitted out loud');
      assert.doesNotMatch(`${result.message} ${result.notes?.join(' ')}`, /rejected|invalid/i, 'nothing here may imply the key is bad');
    }
  );
});

test('when neither endpoint answers the probe says it cannot judge the key', async () => {
  await withFetch(
    () => ({ status: 503, body: {} }),
    async () => {
      const result = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-3');
      assert.equal(result.status, 'error');
      assert.match(result.message, /not a verdict on your key/);
    }
  );
});

test('a network failure stays a network failure', async () => {
  await withFetch(
    () => new Error('getaddrinfo ENOTFOUND api.deepgram.com'),
    async () => {
      const result = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-3');
      assert.equal(result.status, 'unreachable');
      assert.match(result.message, /api\.deepgram\.com/);
    }
  );
});

test('a wikimedia probe that dies before TLS reports the real cause, not "fetch failed"', async () => {
  // The exact failure Node produces when a firewall/proxy cuts the connection
  // mid-handshake: TypeError: fetch failed, cause.code ECONNRESET.
  const failure = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' }
    ),
  });
  await withFetch(
    () => failure,
    async () => {
      const result = await verifyWikimediaAccess('ClipCraftLocal/1.0 (https://github.com/mohsinexpenses-creator/clipcraft-local; mohsinexpenses@gmail.com)');
      assert.equal(result.status, 'unreachable');
      assert.match(result.message, /Could not reach https:\/\/commons\.wikimedia\.org/);
      assert.match(result.message, /cut during the TLS handshake \(ECONNRESET\)/);
      assert.match(result.message, /firewall, proxy or VPN/);
      assert.doesNotMatch(result.message, /: fetch failed$/, 'the opaque wrapper is never the whole story');
    }
  );
});

test('network failure decoding separates DNS, TLS and blocked connections', async () => {
  const wrapped = (code: string, message: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  assert.match(describeNetworkFailure(wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND api.pexels.com'), 'https://api.pexels.com'), /DNS lookup failed \(ENOTFOUND\) for api\.pexels\.com/);
  assert.match(describeNetworkFailure(wrapped('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'), 'https://api.openverse.org'), /TLS handshake failed .*proxy\/VPN is intercepting/);
  assert.match(describeNetworkFailure(wrapped('ECONNRESET', 'read ECONNRESET'), 'https://commons.wikimedia.org'), /connection failed \(ECONNRESET\) - network or firewall blocked commons\.wikimedia\.org/);
  // A bare error without a cause chain still names the host and the detail.
  assert.match(describeNetworkFailure(new Error('getaddrinfo ENOTFOUND api.deepgram.com'), 'https://api.deepgram.com'), /DNS lookup failed .*api\.deepgram\.com/);
  assert.match(describeNetworkFailure(new Error('boom'), 'https://example.com'), /network error \(boom\)/);
});

test('an unrecognised model id is a note, never a failure', async () => {
  await withFetch(
    () => ({ status: 200, body: { scopes: ['admin:all'] } }),
    async () => {
      const known = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'nova-3-general');
      assert.equal(known.status, 'ok');
      assert.equal(known.notes, undefined, 'a model id Deepgram would accept is not flagged');

      const odd = await verifyDeepgramKey('dgkey-aaaaaaaaaaaaaaaaaaaa', 'not-a-model');
      assert.equal(odd.status, 'ok', 'a typo is a note, never a blocked Test');
      assert.ok(odd.notes?.some((note) => note.includes('not-a-model')));
    }
  );
});
