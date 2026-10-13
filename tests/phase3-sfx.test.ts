import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildSfxCueSheet,
  dbToLinearGain,
  filterPlayableSfxCues,
  resolveSfxFilePath,
  TYPEWRITER_MAX_TICKS,
} from '../lib/sfx-cues';
import { buildSfxAudioFilterStatements } from '../worker/ffmpeg-pipeline';

test('public/sfx manifest and all 5 generated WAV assets exist on disk', () => {
  const manifestPath = path.join(process.cwd(), 'public', 'sfx', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'public/sfx/manifest.json must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedIds = ['whoosh', 'pop', 'click', 'typewriter-tick', 'ding'] as const;
  assert.equal(manifest.assets.length, expectedIds.length);

  for (const id of expectedIds) {
    const wavPath = resolveSfxFilePath(id);
    assert.ok(fs.existsSync(wavPath), `${id}.wav should exist at ${wavPath}`);
    const header = fs.readFileSync(wavPath).subarray(0, 12);
    assert.equal(header.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(header.subarray(8, 12).toString('ascii'), 'WAVE');
  }
});

test('buildSfxCueSheet places hook entrance, typewriter ticks, transition, visual cards, keyword pops, and CTA on the output timeline', () => {
  // Segment = 30s, Hook = 4s -> Total output duration = 34s
  const cues = buildSfxCueSheet({
    segmentDuration: 30,
    hookDuration: 4,
    hookTransitionDuration: 0.5,
    hookText: 'WHY 99% OF CREATORS FAIL AT THIS ONE STEP',
    hookAnimationStyle: 'typewriter',
    hookSfxChoice: 'default',
    ctaDuration: 4,
    ctaText: 'FOLLOW FOR PART 2',
    ctaAnimationStyle: 'slide-up',
    ctaSfxChoice: 'default',
    visualWindows: [
      {
        id: 'vis-card-1',
        kind: 'photo-card',
        start: 9,
        end: 12,
        animation: 'pop',
      },
      {
        id: 'vis-kw-1',
        kind: 'keyword-pop',
        start: 16,
        end: 18,
        animation: 'pop',
      },
    ],
    sfxEnabled: true,
    sfxVolumeDb: -14,
  });

  assert.ok(cues.length > 0);
  // Sorted monotonically by timestamp
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].t >= cues[i - 1].t, `Cues must be sorted: ${cues[i - 1].t} <= ${cues[i].t}`);
  }

  // 1. Hook entrance at ~0.04s
  const hookEntrance = cues.find((c) => c.source === 'hook-entrance');
  assert.ok(hookEntrance);
  assert.equal(hookEntrance.sfx, 'pop');
  assert.ok(Math.abs(hookEntrance.t - 0.04) < 0.01);

  // 2. Typewriter ticks during hook (1 tick per ~2 chars, capped at TYPEWRITER_MAX_TICKS)
  const ticks = cues.filter((c) => c.source === 'hook-typewriter');
  assert.ok(ticks.length >= 5 && ticks.length <= TYPEWRITER_MAX_TICKS);
  assert.ok(ticks.every((c) => c.sfx === 'typewriter-tick' && c.t > 0.05 && c.t <= 3.5));

  // 3. Hook -> main transition whoosh around hookDuration - transition * 0.5 = 3.75s
  const hookTransition = cues.find((c) => c.source === 'hook-transition');
  assert.ok(hookTransition);
  assert.equal(hookTransition.sfx, 'whoosh');
  assert.ok(Math.abs(hookTransition.t - 3.75) < 0.02);

  // 4. Visual card at output t=9.0s in and ~11.82s out
  const cardIn = cues.find((c) => c.source === 'visual-in');
  const cardOut = cues.find((c) => c.source === 'visual-out');
  assert.ok(cardIn);
  assert.ok(cardOut);
  assert.equal(cardIn.sfx, 'pop');
  assert.ok(Math.abs(cardIn.t - 9.0) < 0.01);
  assert.equal(cardOut.sfx, 'whoosh');
  assert.ok(Math.abs(cardOut.t - 11.82) < 0.02);

  // 5. Keyword pop at output t=16.0s (no exit cue)
  const kwPop = cues.find((c) => c.source === 'keyword-pop');
  assert.ok(kwPop);
  assert.equal(kwPop.sfx, 'pop');
  assert.ok(Math.abs(kwPop.t - 16.0) < 0.01);

  // 6. CTA entrance at totalDuration - ctaDuration = 34 - 4 = 30.0s
  const ctaEntrance = cues.find((c) => c.source === 'cta-entrance');
  assert.ok(ctaEntrance);
  assert.equal(ctaEntrance.sfx, 'whoosh');
  assert.ok(Math.abs(ctaEntrance.t - 30.0) < 0.01);
});

test('buildSfxCueSheet respects sfxEnabled=false and per-element sfxChoice overrides', () => {
  const disabled = buildSfxCueSheet({
    segmentDuration: 20,
    hookDuration: 3,
    hookText: 'TEST HOOK',
    hookAnimationStyle: 'pop',
    ctaDuration: 3,
    ctaText: 'FOLLOW',
    ctaAnimationStyle: 'pop',
    sfxEnabled: false,
  });
  assert.equal(disabled.length, 0);

  const customChoices = buildSfxCueSheet({
    segmentDuration: 20,
    hookDuration: 3,
    hookText: 'TEST HOOK',
    hookAnimationStyle: 'typewriter',
    hookSfxChoice: 'none',
    ctaDuration: 3,
    ctaText: 'FOLLOW',
    ctaAnimationStyle: 'pop',
    ctaSfxChoice: 'ding',
    sfxEnabled: true,
    sfxVolumeDb: -12,
  });
  assert.equal(customChoices.find((c) => c.source === 'hook-entrance'), undefined);
  assert.equal(customChoices.filter((c) => c.source === 'hook-typewriter').length, 0);
  const ctaCue = customChoices.find((c) => c.source === 'cta-entrance');
  assert.ok(ctaCue);
  assert.equal(ctaCue.sfx, 'ding');
  assert.ok(dbToLinearGain(-12) > dbToLinearGain(-18));
});

test('buildSfxAudioFilterStatements deduplicates SFX inputs, applies adelay+volume, and preserves profanity audio label', () => {
  const rawCues = buildSfxCueSheet({
    segmentDuration: 25,
    hookDuration: 3,
    hookText: 'HOOK TEXT',
    hookAnimationStyle: 'pop',
    ctaDuration: 3,
    ctaText: 'CTA TEXT',
    ctaAnimationStyle: 'pop',
    sfxEnabled: true,
    sfxVolumeDb: -14,
  });
  const playable = filterPlayableSfxCues(rawCues);
  assert.equal(playable.length, 3); // hook-entrance (pop), hook-transition (whoosh), cta-entrance (click)

  const plan = buildSfxAudioFilterStatements(
    playable,
    4, // e.g. after hook, main, overlay, and profanity tone inputs
    '[pa]', // preserves profanity-masked audio stream label
    28,
    '[asfx]'
  );

  // 3 unique files (pop.wav, whoosh.wav, click.wav) added via -i
  assert.equal(plan.extraArgs.length, 6);
  assert.equal(plan.audioLabel, '[asfx]');
  assert.equal(plan.filters.length, 4); // 3 adelay cue chains + 1 amix chain
  assert.ok(plan.filters[0].includes('[4:a]aformat=sample_rates=48000:channel_layouts=stereo,volume='));
  assert.ok(plan.filters[1].includes('[5:a]aformat=sample_rates=48000:channel_layouts=stereo,volume='));
  assert.ok(plan.filters[2].includes('[6:a]aformat=sample_rates=48000:channel_layouts=stereo,volume='));
  assert.ok(
    plan.filters[3].startsWith(
      '[pa][sfx_0][sfx_1][sfx_2]amix=inputs=4:duration=first:dropout_transition=0:normalize=0,volume=0.96[asfx]'
    )
  );
});
