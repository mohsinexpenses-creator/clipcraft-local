/**
 * The built-in presets are seeded with `INSERT OR IGNORE`, so a row that an older build
 * created is never corrected by a later code change. `resetCaptionPresets` /
 * `resetOverlayStylePresets` are the deliberate re-sync the Style presets page exposes,
 * and these are the three properties that make it safe to offer:
 *
 *   1. an edited built-in goes back to the shipped values,
 *   2. rows the user created are not touched - not even their default flag,
 *   3. the result is stable: resetting twice changes nothing more.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDefaultCaptionPreset,
  getCaptionPreset,
  listCaptionPresets,
  resetCaptionPresets,
  resetOverlayStylePresets,
  saveCaptionPreset,
  setDefaultCaptionPreset,
} from '../lib/db';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import type { CaptionPreset } from '../lib/types';
import { createTemporaryDatabase } from './sqlite-test-helpers';

const firstCaptionId = DEFAULT_CAPTION_PRESETS[0]._id;
const shippedDefaultId = DEFAULT_CAPTION_PRESETS.find((preset) => preset.isDefault)?._id;

function captionFrom(id: string): CaptionPreset {
  const preset = DEFAULT_CAPTION_PRESETS.find((candidate) => candidate._id === id);
  if (!preset) throw new Error(`no shipped preset ${id}`);
  return preset;
}

test('reset restores an edited built-in and leaves custom rows alone', async (t) => {
  createTemporaryDatabase(t);

  const builtIn = captionFrom(firstCaptionId);
  const drifted: CaptionPreset = {
    ...builtIn,
    name: 'My old take on the bold one',
    fontSize: 20,
    textColor: '#123456',
    highlightColor: '#654321',
  };
  await saveCaptionPreset(drifted);

  const custom: CaptionPreset = {
    _id: 'user-custom-style',
    name: 'Mine',
    fontFamily: 'Georgia, serif',
    fontSize: 44,
    fontWeight: 'normal',
    textColor: '#EEEEEE',
    highlightColor: '#00FF00',
    strokeColor: '#000000',
    strokeWidth: 1,
    positionY: 33,
    animationStyle: 'static',
    uppercase: false,
  };
  await saveCaptionPreset(custom);
  await setDefaultCaptionPreset(custom._id);

  const driftedBefore = await getCaptionPreset(builtIn._id);
  assert.equal(driftedBefore?.fontSize, 20, 'the drift the test is about to repair');

  const presets = await resetCaptionPresets();

  const restored = presets.find((preset) => preset._id === builtIn._id);
  assert.ok(restored, 'the built-in row is still there');
  assert.equal(restored.name, builtIn.name, 'the shipped name comes back');
  assert.equal(restored.fontSize, builtIn.fontSize);
  assert.equal(restored.textColor, builtIn.textColor);
  assert.equal(restored.highlightColor, builtIn.highlightColor);

  const untouched = presets.find((preset) => preset._id === custom._id);
  assert.ok(untouched, 'the custom row is still there');
  assert.equal(untouched.name, 'Mine');
  assert.equal(untouched.fontSize, 44);
  assert.equal(untouched.textColor, '#EEEEEE');
  assert.equal(untouched.animationStyle, 'static');
  assert.equal(untouched.fontFamily, 'Georgia, serif');

  assert.equal((await getDefaultCaptionPreset())?._id, custom._id, 'the default the user picked survives a reset');
});

test('reset promotes the shipped default only when nothing is marked default', async (t) => {
  assert.ok(shippedDefaultId, 'the shipped catalogue marks one preset as default');
  const { db } = createTemporaryDatabase(t);

  // A database whose built-ins have lost their default flag - the state a half-finished
  // migration or a hand-edited row can leave behind.
  db.prepare('UPDATE caption_presets SET is_default = 0').run();
  assert.equal(await getDefaultCaptionPreset(), null);

  await resetCaptionPresets();
  assert.equal((await getDefaultCaptionPreset())?._id, shippedDefaultId);

  // Idempotent: running it again cannot keep moving the default around.
  const before = await listCaptionPresets();
  await resetCaptionPresets();
  const after = await listCaptionPresets();
  assert.deepEqual(
    after.map((preset) => ({ id: preset._id, name: preset.name, isDefault: preset.isDefault, fontSize: preset.fontSize })),
    before.map((preset) => ({ id: preset._id, name: preset.name, isDefault: preset.isDefault, fontSize: preset.fontSize }))
  );
});

test('reset re-syncs the built-in hook and CTA overlay styles too', async (t) => {
  const { db } = createTemporaryDatabase(t);

  const builtIn = DEFAULT_OVERLAY_STYLE_PRESETS[0];
  db.prepare('UPDATE overlay_style_presets SET name = ?, config_json = ? WHERE id = ?').run(
    'Edited hook style',
    JSON.stringify({ ...builtIn, _id: undefined, kind: undefined, name: undefined, isDefault: undefined }),
    builtIn._id
  );

  const presets = await resetOverlayStylePresets();
  const restored = presets.find((preset) => preset._id === builtIn._id);
  assert.equal(restored?.name, builtIn.name);
  assert.equal(restored?.fontSize, builtIn.fontSize);
  assert.equal(
    presets.filter((preset) => preset.kind === builtIn.kind && preset.isDefault).length,
    1,
    'exactly one default per kind, no matter how often things are reset'
  );
});
