import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isKnownDeepgramModel,
} from '../lib/settings-verify';
import {
  buildAppSettingsSnapshot,
  isUsableSecret,
  maskSecret,
  parseKeyList,
  resolveSettings,
  sanitizeSettingsSection,
  saveSettingsSection,
  setSettingsStoreForTests,
} from '../lib/app-settings';
import type { AppSettingsSection } from '../lib/types';

/**
 * The settings layer decides what the whole app does when nobody configured
 * anything, so these tests focus on the three things that would be silent,
 * expensive bugs: precedence, clamping, and the "empty is not zero" rule.
 */

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('with nothing stored, the built-in defaults win and nothing is marked as app-configured', () => {
  withEnv({ WORKER_CONCURRENCY: '', VIRAL_CONCURRENCY: '', PROFANITY_AUDIO_MODE: '', GEMINI_API_KEY: '', DEEPGRAM_API_KEY: '', DEEPGRAM_MODEL: '', AUTO_RENDER_CAPTION_ENGINE: '' }, () => {
    const { effective, sources } = resolveSettings({});

    assert.equal(effective.render.captionEngine, 'remotion');
    assert.equal(effective.render.layout, 'speaker-focus');
    assert.equal(effective.render.filterPreset, 'vibrant');
    // The trap: an unset hook duration must NOT become 0, which would delete the hook.
    assert.equal(effective.render.hookDuration, 3);
    assert.equal(effective.render.ctaDuration, 2.5);
    assert.equal(effective.profanity.audioMode, 'mute');
    assert.equal(effective.worker.clipConcurrency, 1);
    assert.equal(effective.worker.viralConcurrency, 1);
    assert.equal(effective.worker.remotionConcurrency, null);
    assert.deepEqual(effective.ai.geminiApiKeys, []);
    assert.equal(effective.ai.deepgramApiKey, '');
    assert.equal(effective.pipeline.autoDetect, true);

    assert.equal(sources.render?.hookDuration, 'default');
    assert.equal(sources.worker?.clipConcurrency, 'default');
    assert.equal(sources.profanity?.audioMode, 'default');
  });
});

test('.env.local is the fallback layer and is labelled as env, not as app settings', () => {
  withEnv(
    { WORKER_CONCURRENCY: '3', VIRAL_CONCURRENCY: '2', REMOTION_CONCURRENCY: '6', PROFANITY_AUDIO_MODE: 'beep', AUTO_RENDER_CAPTION_ENGINE: 'native', GEMINI_API_KEY: 'gemini-key-with-plenty-of-characters', DEEPGRAM_API_KEY: 'deepgram-key-with-plenty-of-chars', DEEPGRAM_MODEL: 'nova-3' },
    () => {
      const { effective, sources } = resolveSettings({});
      assert.equal(effective.worker.clipConcurrency, 3);
      assert.equal(effective.worker.viralConcurrency, 2);
      assert.equal(effective.worker.remotionConcurrency, 6);
      assert.equal(effective.profanity.audioMode, 'beep');
      assert.equal(effective.render.captionEngine, 'native');
      assert.equal(effective.ai.deepgramModel, 'nova-3');
      assert.deepEqual(effective.ai.geminiApiKeys, ['gemini-key-with-plenty-of-characters']);
      assert.equal(sources.worker?.clipConcurrency, 'env');
      assert.equal(sources.render?.captionEngine, 'env');
      assert.equal(sources.ai?.deepgramApiKey, 'env');
      assert.equal(sources.ai?.geminiApiKeys, 'env');
    }
  );
});

test('a stored section overrides both env and defaults, and only for the fields it contains', () => {
  withEnv({ WORKER_CONCURRENCY: '9', VIRAL_CONCURRENCY: '9', PROFANITY_AUDIO_MODE: 'off', DEEPGRAM_MODEL: 'nova-2' }, () => {
    const { effective, sources } = resolveSettings({
      worker: { clipConcurrency: 2 },
      render: { layout: 'split-screen' },
      ai: { deepgramModel: '' },
    });

    assert.equal(effective.worker.clipConcurrency, 2, 'stored value beats the env file');
    assert.equal(effective.worker.viralConcurrency, 8, 'an env value is clamped to the same limits the UI offers');

    assert.equal(sources.worker?.clipConcurrency, 'app');
    assert.equal(sources.worker?.viralConcurrency, 'env');
    assert.equal(effective.render.layout, 'split-screen');
    assert.equal(effective.render.filterPreset, 'vibrant', 'untouched fields keep their default');
    assert.equal(effective.ai.deepgramModel, 'nova-2', 'an empty stored model defers to env');
  });
});

test('an empty field never becomes zero, but an explicit zero is respected', () => {
  const unset = resolveSettings({ render: { hookDuration: undefined, ctaDuration: '' } });
  assert.equal(unset.effective.render.hookDuration, 3);
  assert.equal(unset.effective.render.ctaDuration, 2.5);

  const zero = resolveSettings({ render: { hookDuration: 0, ctaDuration: 0 } });
  assert.equal(zero.effective.render.hookDuration, 0, '0 is a real choice: it disables the hook intro');
  assert.equal(zero.effective.render.ctaDuration, 0);
});

test('a stored null means "decide for me", while a missing row means "whatever env says"', () => {
  withEnv({ REMOTION_CONCURRENCY: '5' }, () => {
    const auto = resolveSettings({ worker: { remotionConcurrency: null } });
    assert.equal(auto.effective.worker.remotionConcurrency, null);
    assert.equal(auto.sources.worker?.remotionConcurrency, 'app', 'null is an explicit choice, so it is not "unset"');

    const fromEnv = resolveSettings({ worker: {} });
    assert.equal(fromEnv.effective.worker.remotionConcurrency, 5);
    assert.equal(fromEnv.sources.worker?.remotionConcurrency, 'env');
  });

  // A `null` caption preset id means "use the preset the preset table marks default".
  const preset = resolveSettings({ render: { captionPresetId: null } });
  assert.equal(preset.effective.render.captionPresetId, null);
  assert.equal(preset.sources.render?.captionPresetId, 'app');
});

test('stored values are clamped on the way in, not silently fixed on read', () => {
  assert.throws(() => sanitizeSettingsSection('worker', { clipConcurrency: 0 }), /between 1 and 8/);
  assert.throws(() => sanitizeSettingsSection('worker', { clipConcurrency: '   ' }), /must be a number/);
  assert.throws(() => sanitizeSettingsSection('worker', { clipConcurrency: 99 }), /must be a number|between 1 and 8/);
  assert.throws(() => sanitizeSettingsSection('render', { captionEngine: 'hand-braked' }), /Unknown Caption engine/);
  assert.throws(() => sanitizeSettingsSection('render', { filterPreset: 'not-a-filter' }), /Unknown Filter preset/);
  assert.throws(() => sanitizeSettingsSection('profanity', { audioMode: 'silence-please' }), /Unknown Profanity audio mode/);
  assert.throws(() => sanitizeSettingsSection('ai', { transcriptionProvider: 'elevenlabs' }), /Unknown Transcription provider/);
  assert.throws(() => sanitizeSettingsSection('nope' as never, {}), /Unknown settings section/);

  // A pipeline document goes through the same clamps as the upload form.
  const pipeline = sanitizeSettingsSection('pipeline', {
    autoRender: false,
    viral: { clipCount: 4000, minClipDuration: 1 },
  }) as { autoRender: boolean; viral: { clipCount: number; minClipDuration: number; maxClipDuration: number } };
  assert.equal(pipeline.autoRender, false);
  assert.equal(pipeline.viral.clipCount, 25);
  assert.equal(pipeline.viral.minClipDuration, 5);
  assert.equal(pipeline.viral.maxClipDuration, 90, 'max clip duration is never taken from a client');

  const worker = sanitizeSettingsSection('worker', { clipConcurrency: '4', viralConcurrency: 2.9, remotionConcurrency: '' });
  assert.equal(worker.clipConcurrency, 4);
  assert.equal(worker.viralConcurrency, 3, 'loop counts become whole numbers (rounded, never 2.9 slots)');
  assert.equal(worker.remotionConcurrency, null, 'empty means "let the renderer choose"');

  const render = sanitizeSettingsSection('render', { hookDuration: 2.34, captionPresetId: '  ' });
  assert.equal(render.hookDuration, 2.3, 'durations are kept to one decimal');
  assert.equal(render.captionPresetId, null, 'blank means the preset table default');
  // Out of range is refused on the way in rather than quietly rewritten - the number
  // fields clamp while editing, so a 40 here is a hand-made request, not a typo.
  assert.throws(() => sanitizeSettingsSection('render', { ctaDuration: 40 }), /between 0 and 30/);
  // Reading, in contrast, stays defensive: a row written by hand or by an older build
  // must never take the app down.
  assert.equal(resolveSettings({ render: { filterPreset: 'does-not-exist' } }).effective.render.filterPreset, 'vibrant');
  assert.equal(resolveSettings({ worker: { clipConcurrency: 999 } }).effective.worker.clipConcurrency, 8);
});

test('secrets are masked, validated, and a masked entry means the key already stored', () => {
  assert.equal(maskSecret('AIzaSyD-aaaaaaaaaaaaaaaaaaaaaaaaaa9f3'), 'AIza…a9f3');
  assert.equal(maskSecret('short'), '••••rt', 'a short secret keeps only its last two characters');
  assert.equal(maskSecret('   '), '');

  assert.equal(isUsableSecret(''), false);
  assert.equal(isUsableSecret('abc'), false, 'too short to be a key');
  assert.equal(isUsableSecret('your_api_key_placeholder'), false, 'the .env.example placeholder is not a key');
  assert.equal(isUsableSecret('two words in a key'), false);
  assert.equal(isUsableSecret('AIzaSyD-reallooking-key-value-1234'), true);

  // A single env var may hold a list; duplicates and placeholders are dropped.
  const parsed = parseKeyList('AIzaSyD-one-key-value-aaaa, AIzaSyD-two-key-value-bbbb;AIzaSyD-one-key-value-aaaa\nyour_api_key');
  assert.deepEqual(parsed, ['AIzaSyD-one-key-value-aaaa', 'AIzaSyD-two-key-value-bbbb']);

  const first = 'AIzaSyD-first-key-value-1111';
  const second = 'AIzaSyD-second-key-value-2222';
  const stored = { geminiApiKeys: [first, second] };

  // The page can only echo masks, and a mask resolves back to the stored key.
  const appended = sanitizeSettingsSection('ai', { geminiApiKeys: [maskSecret(first), 'AIzaSyD-third-key-value-3333'] }, { storedAi: { ...stored } });
  assert.deepEqual(appended.geminiApiKeys, [first, 'AIzaSyD-third-key-value-3333']);

  // Reordering is safe because entries resolve by their mask, not by position.
  const reordered = sanitizeSettingsSection('ai', { geminiApiKeys: [maskSecret(second), maskSecret(first)] }, { storedAi: { ...stored } });
  assert.deepEqual(reordered.geminiApiKeys, [second, first]);

  // A mask that no longer matches anything (key deleted meanwhile) is dropped, not guessed.
  const stale = sanitizeSettingsSection('ai', { geminiApiKeys: ['AIza…zzzz', maskSecret(first)] }, { storedAi: { geminiApiKeys: [first] } });
  assert.deepEqual(stale.geminiApiKeys, [first]);

  // Duplicates collapse; an empty list is a legitimate "clear the pool".
  const deduped = sanitizeSettingsSection('ai', { geminiApiKeys: [first, first, second] }, { storedAi: { geminiApiKeys: [] } });
  assert.deepEqual(deduped.geminiApiKeys, [first, second]);
  assert.deepEqual(sanitizeSettingsSection('ai', { geminiApiKeys: [] }, { storedAi: { ...stored } }).geminiApiKeys, []);

  assert.throws(
    () => sanitizeSettingsSection('ai', { geminiApiKeys: ['nope'] }),
    /does not look like an API key/
  );
});

test('a Deepgram model id is judged leniently: a near-certain typo is flagged, an unusual id is allowed', () => {
  assert.equal(isKnownDeepgramModel('nova-2'), true);
  assert.equal(isKnownDeepgramModel('nova-3:general'), true);
  assert.equal(isKnownDeepgramModel('whisper'), true);
  assert.equal(isKnownDeepgramModel('20240101'), false);
  assert.equal(isKnownDeepgramModel('   '), false);
});

test('env lookups are not mutated by the resolution layer', () => {
  withEnv({ PROFANITY_AUDIO_MODE: 'BEEP  ' }, () => {
    assert.equal(readEnv('PROFANITY_AUDIO_MODE'), 'BEEP');
    assert.equal(resolveSettings({}).effective.profanity.audioMode, 'beep', 'case and spacing are tolerated');
  });
});

/**
 * The one part of the UI that has to tell the truth about a restart: a loop size that
 * still comes from `.env.local` was already read at worker start, so warning about it
 * would be noise - only a stored override can be pending.
 */
test('the snapshot reports a restart only for a loop size the app actually stores', async () => {
  const rows = new Map<AppSettingsSection, Record<string, unknown>>();
  setSettingsStoreForTests({
    read: () => [...rows].map(([key, value]) => ({ key, value })),
    write: (section, value) => {
      if (value === null) rows.delete(section);
      else rows.set(section, value);
      return new Date().toISOString();
    },
  });

  const previous = { ...process.env };
  process.env.WORKER_CONCURRENCY = '3';
  process.env.VIRAL_CONCURRENCY = '2';
  try {
    const fromEnv = await buildAppSettingsSnapshot();
    assert.equal(fromEnv.effective.worker.clipConcurrency, 3);
    assert.equal(fromEnv.sources.worker?.clipConcurrency, 'env');
    assert.deepEqual(fromEnv.restartRequired, [], 'env values cannot be "pending"');

    await saveSettingsSection('worker', { clipConcurrency: 4 });
    const stored = await buildAppSettingsSnapshot();
    assert.equal(stored.effective.worker.clipConcurrency, 4);
    assert.equal(stored.effective.worker.viralConcurrency, 2, 'the field nobody touched keeps its env value');
    assert.deepEqual(stored.restartRequired, ['worker.clipConcurrency']);
    assert.deepEqual(stored.configured, ['worker']);

    await saveSettingsSection('worker', { remotionConcurrency: 3 });
    assert.deepEqual(
      (await buildAppSettingsSnapshot()).restartRequired,
      ['worker.clipConcurrency'],
      'the Remotion tab count is refreshed per job, not at start'
    );
  } finally {
    setSettingsStoreForTests(null);
    for (const key of ['WORKER_CONCURRENCY', 'VIRAL_CONCURRENCY']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
