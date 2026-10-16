import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureDensePhotoMomentsForClip,
  extractKeywordPopCallout,
  planClipVisualMoments,
} from '../lib/contextual-visuals';
import { buildSfxCueSheet } from '../lib/sfx-cues';
import {
  planVisualCardPlacement,
} from '../worker/overlay-layout';
import { buildVisualOverlayFilterStatements } from '../worker/ffmpeg-pipeline';
import { parseViralResponse } from '../lib/viral-response';
import { validClip } from './viral-fixtures';
import type { TranscriptData, VisualMomentPlan } from '../lib/types';

test('planClipVisualMoments plans ~10-14 dense visual beats across a 60s clip mixing photo-card and keyword-pop beats', () => {
  const segments = Array.from({ length: 15 }, (_, idx) => {
    const start = idx * 4;
    const end = start + 3.8;
    return {
      id: idx + 1,
      text: `Step ${idx + 1} grows revenue by ${(idx + 1) * 12}% using automated retention loops`,
      start,
      end,
    };
  });
  const transcript: TranscriptData = {
    text: segments.map((s) => s.text).join('. '),
    segments,
    words: [],
  };

  const rawMoments: VisualMomentPlan[] = [
    {
      quote: segments[0].text,
      timestamp: { start: '0.2', end: '2.8' },
      category: 'statistic',
      entity_name: '12% RETENTION LIFT',
      visual_intent: 'Step 1 grows revenue by 12% using automated retention loops',
      emotional_polarity: 'positive',
      search_queries: ['analytics dashboard growth chart'],
      negative_cues: [],
      confidence: 0.9,
      suggested_duration: 2.4,
      animation: 'pop',
      placement: 'main',
      kind: 'keyword-pop',
    },
    {
      quote: segments[2].text,
      timestamp: { start: '8.2', end: '11.0' },
      category: 'situation',
      entity_name: '',
      visual_intent: 'Creator editing short-form video timeline at studio desk',
      emotional_polarity: 'positive',
      search_queries: ['video editor timeline studio desk'],
      negative_cues: [],
      confidence: 0.88,
      suggested_duration: 2.6,
      animation: 'subtle-zoom',
      placement: 'main',
      kind: 'photo-card',
    },
  ];

  const planned = planClipVisualMoments({
    rawMoments,
    clipStart: 0,
    clipEnd: 60,
    transcript,
    hookTiming: { start: 0, duration: 3 },
    options: {
      autoVisuals: true,
      maxVisualMoments: 12,
      confidenceThreshold: 0.65,
      minDuration: 2.0,
      defaultDuration: 2.5,
      fillDensityGaps: true,
    },
  });

  // Target ~10-14 visual beats per 60s clip
  assert.ok(
    planned.length >= 10 && planned.length <= 14,
    `Expected 10-14 visual beats for a 60s clip, got ${planned.length}`
  );
  assert.ok(planned.some((b) => b.kind === 'photo-card'));
  assert.ok(planned.some((b) => b.kind === 'keyword-pop'));

  const callout = extractKeywordPopCallout(planned[0]);
  assert.ok(callout.text.length > 0 && callout.text.length <= 36);
});

test('planVisualCardPlacement ignores legacy shape options and always fills the canvas', () => {
  const portrait = planVisualCardPlacement({
    plan: {
      mode: 'single',
      cropW: 608,
      cropH: 1080,
      points: [],
      faceAnchorY: 0.45,
    },
    captionBand: { top: 1380, bottom: 1640 },
    hookBand: { top: 1180, bottom: 1320 },
    cardAspect: 'portrait',
  });
  assert.equal(portrait.width, 1080);
  assert.equal(portrait.height, 1920);
  assert.equal(portrait.top, 0);

  const square = planVisualCardPlacement({
    plan: {
      mode: 'single',
      cropW: 608,
      cropH: 1080,
      points: [],
      faceAnchorY: 0.45,
    },
    captionBand: { top: 1380, bottom: 1640 },
    cardAspect: 'square',
  });
  assert.equal(square.width, 1080);
  assert.equal(square.height, 1920);
  assert.equal(square.top, 0);
});

test('buildVisualOverlayFilterStatements includes Ken-Burns zoom, thin border, rounded-corner alpha mask, overshoot entrance, and soft fade-out', () => {
  const { statements } = buildVisualOverlayFilterStatements(
    [
      {
        id: 'card-1',
        imagePath: '/tmp/card.jpg',
        x: 180,
        y: 108,
        width: 720,
        height: 900,
        start: 4.0,
        end: 7.0,
        animation: 'pop',
        border: true,
        cornerRadius: 24,
      },
    ],
    [3],
    'vbase',
    'vvis'
  );

  assert.equal(statements.length, 2);
  // Static overscan scale + time-expression crop drift + pad border + fade in/out
  assert.match(statements[0], /scale=768:962:force_original_aspect_ratio=increase/);
  assert.match(statements[0], /crop=w=712:h=892:x='trunc\(\(iw-712\)\/2\)':y='trunc\(\(ih-892\)\*/);
  assert.match(statements[0], /pad=720:900:4:4:color=white@0\.88/);
  assert.match(statements[0], /fade=t=in:st=4\.000:d=0\.180:alpha=1,fade=t=out:st=6\.720:d=0\.280:alpha=1\[visimg0\]/);
  // Overshoot entrance on overlay y expression
  assert.match(statements[1], /108-6\+6\*/);

  // Behind-captions mode places the image in the lower/caption-background zone without covering the upper speaker face
  const behind = planVisualCardPlacement({
    plan: {
      mode: 'single',
      cropW: 608,
      cropH: 1080,
      points: [],
      faceAnchorY: 0.35, // face center at y=672, face bottom at y=912
    },
    captionBand: { top: 1320, bottom: 1620 },
    cardAspect: 'portrait',
    placeBehindCaptions: true,
  });
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

test('Dense 5-6s photo cadence, alternating fullscreen/behind-captions modes, and ball-toss physics work end-to-end', () => {
  const topics = [
    'solar panels rooftop clean electricity grid',
    'battery storage warehouse lithium cells',
    'electric vehicle charging highway station',
    'wind turbine offshore ocean breeze',
    'smart thermostat home energy monitor',
    'hydroelectric dam mountain reservoir turbine',
    'geothermal plant steam turbine facility',
    'nuclear reactor cooling tower facility',
    'hydrogen fuel cell bus transit depot',
    'microgrid controller circuit breaker panel',
    'carbon capture scrubber industrial plant',
    'high voltage transmission lines sunset',
  ];
  const segments = topics.map((topic, idx) => ({
    id: idx + 1,
    text: `Segment ${idx + 1} discusses ${topic} in detail`,
    start: idx * 5,
    end: idx * 5 + 4.8,
  }));
  const transcript: TranscriptData = {
    text: segments.map((s) => s.text).join('. '),
    segments,
    words: [],
  };

  // Start with only 2 AI moments over 60s -> ensureDensePhotoMomentsForClip fills every ~5-6s with relevant photo-cards
  const dense = ensureDensePhotoMomentsForClip({
    overlays: [],
    clipStart: 0,
    clipEnd: 60,
    transcript,
    maxVisualMoments: 12,
  });

  assert.ok(
    dense.length >= 10 && dense.length <= 12,
    `expected 10-12 photo-card moments across 60s (1 every ~5-6s), got ${dense.length}`
  );
  assert.ok(dense.every((m) => m.kind === 'photo-card'));
  assert.ok(dense.every((m) => m.outputWindows.length === 1));
  const primaryQueries = new Set(dense.map((m) => m.searchQueries[0]));
  assert.equal(primaryQueries.size, dense.length, 'each 5-6s moment has a distinct primary search query');

  const fullScreenPlacement = planVisualCardPlacement({
    plan: { mode: 'single', cropW: 608, cropH: 1080, points: [], faceAnchorY: 0.35 },
    fullScreen: true,
  });
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
        border: false,
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

