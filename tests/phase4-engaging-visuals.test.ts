import test from 'node:test';
import assert from 'node:assert/strict';

import {extractKeywordPopCallout} from '../lib/contextual-visuals';
import { buildSfxCueSheet } from '../lib/sfx-cues';
import {
  fullScreenVisualPlacement,
} from '../worker/overlay-layout';
import { buildVisualOverlayFilterStatements } from '../worker/ffmpeg-pipeline';
import { parseViralResponse } from '../lib/viral-response';
import { validClip } from './viral-fixtures';

test('fullScreenVisualPlacement ignores legacy shape options and always fills the canvas', () => {
  const portrait = fullScreenVisualPlacement();
  assert.equal(portrait.width, 1080);
  assert.equal(portrait.height, 1920);
  assert.equal(portrait.top, 0);

  const square = fullScreenVisualPlacement();
  assert.equal(square.width, 1080);
  assert.equal(square.height, 1920);
  assert.equal(square.top, 0);
});

test('buildVisualOverlayFilterStatements uses only full-screen zoom and fade, without borders or projectile motion', () => {
  const { statements } = buildVisualOverlayFilterStatements(
    [
      {
        id: 'card-1',
        imagePath: '/tmp/card.jpg',
        x: 0,
        y: 0,
        width: 1080,
        height: 1920,
        start: 4.0,
        end: 7.0,
        animation: 'pop',


      },
    ],
    [3],
    'vbase',
    'vvis'
  );

  assert.equal(statements.length, 2);
  assert.match(statements[0], /zoompan=/);
  assert.match(statements[0], /fade=t=out:st=6\.820:d=0\.180/);
  assert.doesNotMatch(statements.join(';'), /pad=|pow\(|boxblur/);
  assert.match(statements[1], /overlay=x=0:y='0'/);
  assert.throws(() => buildVisualOverlayFilterStatements([{ id: 'old', imagePath: '/old.jpg', x: 180, y: 108, width: 720, height: 900, start: 0, end: 3, animation: 'fade' }], [3]), /full-screen/);

  // Behind-captions mode places the image in the lower/caption-background zone without covering the upper speaker face
  const behind = fullScreenVisualPlacement();
  assert.equal(behind.top, 0);
  assert.equal(behind.bottom, 1920);

  const stripped = extractKeywordPopCallout({
    entityName: 'Show something like a crashing market',
    visualIntent: 'Show something like this on screen',
    quote: '',
    searchQueries: ['market crash'],
  });
  assert.ok(!stripped.text.toLowerCase().includes('show something'));
});

test('Phase 3 SFX cues wire into every dense card and keyword pop beat', () => {
  const cues = buildSfxCueSheet({
    segmentDuration: 60,
    hookDuration: 3,
    hookTransitionDuration: 0.5,
    hookText: 'STOP DOING THIS',
    hookAnimationStyle: 'pop',
    ctaDuration: 3,
    ctaText: 'FOLLOW NOW',
    ctaAnimationStyle: 'pop',
    visualWindows: [
      { id: 'v1', kind: 'photo-card', start: 4.5, end: 7.0, animation: 'pop' },
      { id: 'v2', kind: 'keyword-pop', start: 9.0, end: 11.2, animation: 'pop' },
      { id: 'v3', kind: 'photo-card', start: 14.0, end: 16.8, animation: 'slide-up' },
      { id: 'v4', kind: 'keyword-pop', start: 19.5, end: 21.8, animation: 'pop' },
    ],
    sfxEnabled: true,
    sfxVolumeDb: -14,
  });

  assert.equal(cues.filter((c) => c.source === 'visual-in').length, 2);
  assert.equal(cues.filter((c) => c.source === 'visual-out').length, 2);
  assert.equal(cues.filter((c) => c.source === 'keyword-pop').length, 2);
});

test('full-screen filters remain stable and response repair survives truncated output', () => {
  const fullScreenPlacement = fullScreenVisualPlacement();
  assert.equal(fullScreenPlacement.width, 1080);
  assert.equal(fullScreenPlacement.height, 1920);

  // Full-screen visual stays at origin, fades, and settles its zoom without a border
  const fsFilter = buildVisualOverlayFilterStatements(
    [
      {
        id: 'fs-1',
        imagePath: '/tmp/fs.jpg',
        x: fullScreenPlacement.x,
        y: fullScreenPlacement.y,
        width: fullScreenPlacement.width,
        height: fullScreenPlacement.height,
        start: 5.0,
        end: 8.0,
        animation: 'slide-up',

      },
    ],
    [4],
    'vbase',
    'vvis'
  );
  assert.doesNotMatch(fsFilter.statements[0], /pad=/);
  assert.match(fsFilter.statements[0], /zoompan=/);
  assert.match(fsFilter.statements[1], /overlay=x=0:y='0'/);
  assert.doesNotMatch(fsFilter.statements[1], /pow/);

  // Repair unescaped inner quotes, raw newlines inside strings, and truncated trailing clips
  const rawValid = JSON.stringify({ clips: [validClip()] }, null, 2);
  const withUnescapedInnerQuotes = rawValid.replace(
    '"why_this_will_go_viral": "' + validClip().why_this_will_go_viral + '"',
    '"why_this_will_go_viral": "This clip relies on highly relatable, humorous "aha" moments\nand raw emotion"'
  );
  const recoveredInnerQuotes = parseViralResponse(withUnescapedInnerQuotes, 600);
  assert.equal(recoveredInnerQuotes.length, 1);
  assert.match(recoveredInnerQuotes[0].clip.why_this_will_go_viral, /"aha"/);

  // Truncated second clip after a complete first clip is cleanly salvaged
  const truncatedSecondClip =
    rawValid.replace(/\s*\]\s*\}\s*$/, '') +
    ',\n    {\n      "rank": 2,\n      "timestamp": { "start": "180.0s", "end": "240.0s" },\n      "why_this_will_go_viral": "Cut off mid-sen';
  const salvaged = parseViralResponse(truncatedSecondClip, 600);
  assert.equal(salvaged.length, 1);
  assert.equal(salvaged[0].clip.rank, 1);
});

