import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveSettingsSection } from '../lib/app-settings';
import {
  customFontFacesForRender,
  customFontFilesForRender,
  customFontFilePath,
  normalizeCustomFontFamily,
  registerCustomFont,
  removeCustomFont,
  validateCustomFontUpload,
} from '../lib/custom-fonts';
import { listCustomFonts } from '../lib/db';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import { startMediaServer } from '../worker/clip-http-server';
import { createTemporaryDatabase } from './sqlite-test-helpers';

const ttfBytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00]);

test('custom font uploads are signature checked, registered once, loopback-served for render, and safely deleted', async (t) => {
  createTemporaryDatabase(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-custom-font-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await saveSettingsSection('paths', { fontDir: root });

  const font = await registerCustomFont({
    originalName: 'LocalDisplay.ttf',
    family: 'Local Display',
    weight: 'bold',
    bytes: ttfBytes,
  });
  assert.equal(font.family, 'Local Display');
  assert.equal(font.directory, root);
  assert.ok(fs.existsSync(customFontFilePath(font)));
  assert.equal((await listCustomFonts()).length, 1);

  await assert.rejects(
    registerCustomFont({
      originalName: 'Copy.ttf',
      family: 'Local Display',
      weight: 'bold',
      bytes: ttfBytes,
    }),
    /already registered/,
    'the registry prevents both duplicate bytes and an ambiguous family/weight picker entry',
  );

  const caption = { ...DEFAULT_CAPTION_PRESETS[0], captionTheme: undefined, fontFamily: "'Local Display', sans-serif" };
  const hook = { ...DEFAULT_OVERLAY_STYLE_PRESETS.find((preset) => preset.kind === 'hook')!, fontFamily: "'Local Display', sans-serif" };
  const cta = DEFAULT_OVERLAY_STYLE_PRESETS.find((preset) => preset.kind === 'cta')!;
  const faces = await customFontFacesForRender(caption, hook, cta);
  assert.equal(faces.length, 1);
  assert.equal(faces[0].family, 'Local Display');
  assert.match(faces[0].source, /^data:font\/ttf;base64,/);

  const files = await customFontFilesForRender(caption, hook, cta);
  assert.equal(files.length, 1);
  const server = await startMediaServer([{ route: `fonts/${files[0].id}.${files[0].format}`, filePath: files[0].filePath }]);
  try {
    const served = await fetch(`${server.baseUrl}/fonts/${files[0].id}.${files[0].format}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'font/ttf');
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), ttfBytes);
  } finally {
    await server.close();
  }

  const deleted = await removeCustomFont(font.id);
  assert.equal(deleted?.id, font.id);
  assert.equal((await listCustomFonts()).length, 0);
  assert.ok(!fs.existsSync(customFontFilePath(font)));
  assert.deepEqual(await customFontFacesForRender(caption, hook, cta), []);
});

test('custom font validation rejects mismatched signatures and unsafe family CSS', () => {
  assert.throws(
    () => validateCustomFontUpload('not-a-font.ttf', new Uint8Array([1, 2, 3, 4])),
    /signature/i,
  );
  assert.throws(
    () => validateCustomFontUpload('../escape.ttf', ttfBytes),
    /plain font file name/i,
  );
  assert.equal(normalizeCustomFontFamily('', 'My_Font-Black.otf'), 'My Font Black');
  assert.throws(() => normalizeCustomFontFamily("Nice'; color:red"), /family names/i);
});
