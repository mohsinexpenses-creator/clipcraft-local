import test from 'node:test';
import assert from 'node:assert/strict';
import { planVisualFrame } from '../lib/visual-frame';
import { buildOverlayFilterStatements } from '../worker/ffmpeg-pipeline';

test('frame quality uses actual source dimensions: cover portraits, preserve landscape subjects, reject excessive upscale', () => {
  assert.equal(planVisualFrame(1080, 1920).mode, 'cover');
  assert.equal(planVisualFrame(1920, 1080).mode, 'blur-fill');
  assert.match(planVisualFrame(1920, 1080).filter, /boxblur=.*\[fg\]scale=1080:-2/);
  assert.throws(() => planVisualFrame(480, 600), /upscale/);
  assert.throws(() => planVisualFrame(0, 0), /dimensions/);
  assert.doesNotThrow(() => planVisualFrame(720, 1280));
});

for (const hook of [false, true]) for (const debug of [false, true]) {
  test(`filter order: speaker -> full-screen photo -> Remotion (hook=${hook}, debug=${debug})`, () => {
    const base = debug ? 'vforoverlay' : 'vbase';
    const prefix = [hook ? '[hv][bv]concat=n=2:v=1:a=0[vbase]' : '[speaker]null[vbase]'];
    if (debug) prefix.push('[vbase]split=2[vprecap][vforoverlay]');
    const graph = [...prefix, ...buildOverlayFilterStatements(
      [{ name: 'captions-hook-cta-keywords', inputPattern: '/overlay_%05d.png', startAtSeconds: 0 }], [2], base,
      [{ id: 'full', imagePath: '/photo.jpg', width: 1080, height: 1920, x: 0, y: 0, start: 1, end: 4, animation: 'slide-up', border: true }], [3],
    )].join(';');
    assert.ok(graph.indexOf(`[${base}][visimg0]overlay`) < graph.indexOf('[vvis][overlay0]overlay'));
    assert.match(graph, /overlay=x=0:y='0'/);
    assert.doesNotMatch(graph, /pow\(|pad=|boxblur/);
    assert.match(graph, /fade=t=out:st=3\.820:d=0\.180/);
  });
}
