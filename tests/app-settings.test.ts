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

test('a value that only exists in .env.local is NOT a setting - the page is the whole truth', () => {
  withEnv(
    {
      WORKER_CONCURRENCY: '3',
      VIRAL_CONCURRENCY: '2',
      REMOTION_CONCURRENCY: '6',
      PROFANITY_AUDIO_MODE: 'beep',
      AUTO_RENDER_CAPTION_ENGINE: 'native',
      GEMINI_API_KEY: 'gemini-key-with-plenty-of-characters',
      DEEPGRAM_API_KEY: 'deepgram-key-with-plenty-of-chars',
      DEEPGRAM_MODEL: 'nova-3',
    },
    () => {
      const { effective, sources } = resolveSettings({});

      // Every one of those env variables is set, and every one of them is ignored: with
      // no stored row the answer is the built-in default, which is what the Settings page
      // shows. A half-configured env file can no longer mean a value the user never saw.
      assert.equal(effective.worker.clipConcurrency, 1);
      assert.equal(effective.worker.viralConcurrency, 1);
      assert.equal(effective.worker.remotionConcurrency, null);
      assert.equal(effective.profanity.audioMode, 'mute');
      assert.equal(effective.render.captionEngine, 'remotion');
      assert.equal(effective.ai.deepgramModel, 'nova-2');
      assert.equal(effective.ai.deepgramApiKey, '');
      assert.deepEqual(effective.ai.geminiApiKeys, []);
      assert.deepEqual(Object.values(sources.worker ?? {}), ['default', 'default', 'default']);
      assert.deepEqual(Object.values(sources.ai ?? {}), ['default', 'default', 'default', 'default']);

      // The empty pool has to be reported as unconfigured rather than as a secret that
      // exists but cannot be shown, or the startup check would be lying about readiness.
      assert.equal(sources.ai?.geminiApiKeys, 'default');
    }
  );
});

test('a stored section overrides the defaults, and only for the fields it contains', () => {
  withEnv({ WORKER_CONCURRENCY: '9', VIRAL_CONCURRENCY: '9', PROFANITY_AUDIO_MODE: 'off', DEEPGRAM_MODEL: 'whisper' }, () => {
    const { effective, sources } = resolveSettings({
      worker: { clipConcurrency: 2 },
      render: { layout: 'split-screen' },
      ai: { deepgramModel: '' },
    });

    assert.equal(effective.worker.clipConcurrency, 2, 'what was saved is what runs');
    assert.equal(
      effective.worker.viralConcurrency,
      1,
      'the field nobody saved takes the built-in default, not the env value'
    );

    assert.equal(sources.worker?.clipConcurrency, 'app');
    assert.equal(sources.worker?.viralConcurrency, 'default');
    assert.equal(effective.render.layout, 'split-screen');
    assert.equal(effective.render.filterPreset, 'vibrant', 'untouched fields keep their default');
    assert.equal(effective.ai.deepgramModel, 'nova-2', 'an empty stored model means the shipped model');
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

test('a stored null means "decide for me", and a missing row means the same default', () => {
  withEnv({ REMOTION_CONCURRENCY: '5' }, () => {
    const auto = resolveSettings({ worker: { remotionConcurrency: null } });
    assert.equal(auto.effective.worker.remotionConcurrency, null);
    assert.equal(auto.sources.worker?.remotionConcurrency, 'app', 'null is an explicit choice, so it is not "unset"');

    // Nothing stored: still auto, because REMOTION_CONCURRENCY is not consulted.
    const nothing = resolveSettings({ worker: {} });
    assert.equal(nothing.effective.worker.remotionConcurrency, null);
    assert.equal(nothing.sources.worker?.remotionConcurrency, 'default');

    const stored = resolveSettings({ worker: { remotionConcurrency: 400 } });
    assert.equal(stored.effective.worker.remotionConcurrency, 32, 'a hand-written row is clamped');
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

test('resolving settings never rewrites process.env (env is only ever displayed)', () => {
  withEnv({ PROFANITY_AUDIO_MODE: 'BEEP  ' }, () => {
    assert.equal(readEnv('PROFANITY_AUDIO_MODE'), 'BEEP');
    assert.equal(resolveSettings({}).effective.profanity.audioMode, 'mute', 'the env value is not a setting');
    assert.equal(readEnv('PROFANITY_AUDIO_MODE'), 'BEEP', 'reading settings must leave the env file\'s values alone');

    // Case and spacing are still tolerated - in what the user actually saved.
    assert.equal(
      resolveSettings({ profanity: { audioMode: '  BeeP ' } }).effective.profanity.audioMode,
      'beep',
      'a stored value is normalised, not rejected'
    );
    assert.equal(
      resolveSettings({ profanity: { audioMode: 'shuffle' } }).effective.profanity.audioMode,
      'mute',
      'and an unknown stored value degrades to the default instead of crashing a render'
    );
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
    assert.equal(fromEnv.effective.worker.clipConcurrency, 1, 'the env file is not a source any more');
    assert.equal(fromEnv.sources.worker?.clipConcurrency, 'default');
    assert.deepEqual(fromEnv.restartRequired, [], 'nothing was saved, so nothing is pending');

    await saveSettingsSection('worker', { clipConcurrency: 4 });
    const stored = await buildAppSettingsSnapshot();
    assert.equal(stored.effective.worker.clipConcurrency, 4);
    assert.equal(stored.effective.worker.viralConcurrency, 1, 'the field nobody touched keeps its default');
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
/**
 * The Settings payload is the one place a stored secret can leave the process, and the PUT
 * response echoes back the section it just wrote. Both have to carry masks: the UI needs a
 * tail to recognise a key by, and that same tail is what it resubmits to mean "keep this
 * one" - so a raw key here would be both a leak and a save path that cannot round-trip.
 */
test('the ai section round-trips its keys without ever returning one in full', async () => {
  const rows = new Map<AppSettingsSection, Record<string, unknown>>();
  setSettingsStoreForTests({
    read: () => [...rows].map(([key, value]) => ({ key, value })),
    write: (section, value) => {
      if (value === null) rows.delete(section);
      else rows.set(section, value);
      return new Date().toISOString();
    },
  });

  const gemini = 'AIzaSyD-a-stored-key-0000000001';
  const deepgram = 'deepgram-stored-key-00000002';
  try {
    const saved = await saveSettingsSection('ai', {
      geminiApiKeys: [gemini],
      deepgramApiKey: deepgram,
      deepgramModel: 'nova-3',
    });
    assert.equal(JSON.stringify(saved.saved).includes(gemini), false, 'the PUT response must not carry a raw key');
    assert.equal(JSON.stringify(saved.saved).includes(deepgram), false);

    // The row keeps the real values, or no provider call could ever be made.
    assert.deepEqual(rows.get('ai')?.geminiApiKeys, [gemini]);
    assert.equal(rows.get('ai')?.deepgramApiKey, deepgram);

    const snapshot = await buildAppSettingsSnapshot();
    const payload = JSON.stringify(snapshot);
    assert.equal(payload.includes(gemini), false, 'GET /api/settings is read by the browser, so it carries masks');
    assert.equal(payload.includes(deepgram), false);
    assert.deepEqual(snapshot.effective.ai.geminiApiKeys, [maskSecret(gemini)]);
    assert.equal(snapshot.effective.ai.deepgramApiKey, maskSecret(deepgram), 'the list rows match the verify labels, which is how a per-key result dot finds its row');
    assert.equal(snapshot.sources.ai?.deepgramApiKey, 'app');

    // The Deepgram Save button resubmits what is on screen when only the model changed.
    await saveSettingsSection('ai', { deepgramApiKey: snapshot.effective.ai.deepgramApiKey, deepgramModel: 'nova-2' });
    assert.equal(rows.get('ai')?.deepgramApiKey, deepgram, 'a mask means keep the stored key');

    // Remove in the UI is the same save with an empty value.
    await saveSettingsSection('ai', { deepgramApiKey: '' });
    assert.equal(rows.get('ai')?.deepgramApiKey, '', 'an empty value removes the key');
    assert.equal((await buildAppSettingsSnapshot()).sources.ai?.deepgramApiKey, 'default');

    await assert.rejects(
      () => saveSettingsSection('ai', { deepgramApiKey: 'too-short' }),
      /does not look like a Deepgram API key/,
      'and a paste that got truncated is refused rather than stored'
    );
  } finally {
    setSettingsStoreForTests(null);
  }
});

/**
 * The `paths` section (upload/clips directories + binaries) follows the same
 * precedence rule as everything else, with one twist: the built-in default is
 * "automatic" (empty string), and an empty save means "back to automatic".
 */
test('paths settings: stored values win, empty means automatic, and resolveSettings stays pure', () => {
  const { effective, sources } = resolveSettings({});
  assert.deepEqual(effective.paths, { uploadDir: '', clipsDir: '', ffmpegPath: '', whisperCliPath: '' });
  assert.deepEqual(Object.values(sources.paths ?? {}), ['default', 'default', 'default', 'default']);

  const stored = resolveSettings({
    paths: { clipsDir: '/data/clips', ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe' },
  });
  assert.equal(stored.effective.paths.clipsDir, '/data/clips');
  assert.equal(stored.effective.paths.ffmpegPath, 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  assert.equal(stored.effective.paths.uploadDir, '');
  assert.equal(stored.sources.paths?.clipsDir, 'app');
  assert.equal(stored.sources.paths?.uploadDir, 'default');
});

test('paths settings: sanitize trims, clears on empty/null and rejects control characters', async () => {
  const rows = new Map<AppSettingsSection, Record<string, unknown>>();
  setSettingsStoreForTests({
    read: () => [...rows].map(([key, value]) => ({ key, value })),
    write: (section, value) => {
      if (value === null) rows.delete(section);
      else rows.set(section, value);
      return new Date().toISOString();
    },
  });

  try {
    await saveSettingsSection('paths', { uploadDir: '  /mnt/videos  ', whisperCliPath: '/opt/whisper-cli' });
    assert.equal(rows.get('paths')?.uploadDir, '/mnt/videos', 'paths are trimmed before storage');
    assert.equal(rows.get('paths')?.whisperCliPath, '/opt/whisper-cli');

    // An empty value is the user switching back to the automatic chain.
    await saveSettingsSection('paths', { uploadDir: '' });
    const snapshot = await buildAppSettingsSnapshot();
    assert.equal(snapshot.effective.paths.uploadDir, '');
    assert.equal(snapshot.sources.paths?.uploadDir, 'default');
    assert.equal(snapshot.effective.paths.whisperCliPath, '/opt/whisper-cli', 'untouched fields survive a partial save');

    await assert.rejects(
      () => saveSettingsSection('paths', { ffmpegPath: '/bad\u0000path' }),
      /control characters/,
      'a NUL byte in a path is refused'
    );
  } finally {
    setSettingsStoreForTests(null);
  }
});
