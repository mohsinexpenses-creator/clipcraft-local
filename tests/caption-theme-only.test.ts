import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Player } from '@remotion/player';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { listCaptionPresets } from '../lib/db';
import { DEFAULT_CAPTION_PRESETS } from '../lib/presets';
import { POST, PUT } from '../app/api/caption-presets/route';
import { CaptionThemeOverlay } from '../remotion/caption-themes/CaptionThemeOverlay';

test('fresh database has exactly 13 themes and caption API rejects missing/invalid themes', async (t) => {
  createTemporaryDatabase(t);
  const presets = await listCaptionPresets();
  assert.equal(presets.length, 13); assert.equal(presets[0]._id, 'cc-bold-punch');
  assert.ok(presets.every((preset) => preset.captionTheme));
  for (const captionTheme of [undefined, null, '', 'classic', 'invalid']) {
    for (const handler of [POST, PUT]) {
      const response = await handler(new Request('http://localhost/api/caption-presets', { method: handler === POST ? 'POST' : 'PUT', body: JSON.stringify({ _id: 'cc-bold-punch', captionTheme }), headers: { 'content-type': 'application/json' } }));
      assert.equal(response.status, 400);
    }
  }
});

test('three caption themes mount in the real Player SSR context without classic renderer', () => {
  for (const name of ['kinetic-01', 'pop', 'podcast']) {
    const preset = DEFAULT_CAPTION_PRESETS.find((item) => item.captionTheme === name)!;
    const Theme = () => createElement(CaptionThemeOverlay, { preset, chunks: [{ id: 'sample', start: 0, end: 2, words: [{ word: 'BOOK', start: 0, end: 1 }, { word: 'CLUB', start: 1, end: 2 }] }] });
    const html = renderToStaticMarkup(createElement(Player, {
      component: Theme, inputProps: {},
      durationInFrames: 60, fps: 30, compositionWidth: 1080, compositionHeight: 1920, initialFrame: 15,
    }));
    assert.ok(html.length > 100, name);
  }
});
