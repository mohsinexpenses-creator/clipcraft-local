import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BROLL_SFX_FILES,
  BROLL_SFX_EXIT_VOLUME,
  BROLL_SFX_VOLUME,
  buildBrollSfxCues,
  buildSfxMixPlan,
} from '../lib/broll/sfx';
import { buildBrollSfxWav } from '../worker/sfx-mixer';

/**
 * The sound effects are the one part of B-roll that touches audio, which the rest of
 * the pipeline already uses for speech and profanity beeps. These tests pin the two
 * rules that keep it from breaking either: cues stay inside the clip, and the mix
 * never attenuates the voice.
 */

test('one cue enters and one exits per item, and they are ordered by time', () => {
  const cues = buildBrollSfxCues(
    [
      { start: 20, end: 23 },
      { start: 4, end: 7 },
    ],
    { totalDuration: 60, enabled: true }
  );
  assert.deepEqual(
    cues.map((cue) => [cue.atSeconds, cue.kind]),
    [
      [4, 'in'],
      [6.88, 'out'],
      [20, 'in'],
      [22.88, 'out'],
    ]
  );
  assert.ok(cues.every((cue) => cue.file === BROLL_SFX_FILES.enter || cue.file === BROLL_SFX_FILES.exit));
  assert.equal(cues.find((cue) => cue.kind === 'in')?.volume, BROLL_SFX_VOLUME);
  assert.equal(cues.find((cue) => cue.kind === 'out')?.volume, BROLL_SFX_EXIT_VOLUME);
});

test('cues too close together are dropped, so two images 3 s apart do not machine-gun', () => {
  const cues = buildBrollSfxCues(
    [
      { start: 10, end: 13 },
      { start: 13.05, end: 16 },
    ],
    { totalDuration: 60, enabled: true, minSpacing: 0.35 }
  );
  // The second item's in-cue lands 0.17 s after the first item's pop, so it is
  // dropped; the pops themselves are far enough apart to keep.
  assert.equal(cues.filter((cue) => cue.kind === 'in').length, 1);
  assert.deepEqual(cues.map((cue) => cue.kind), ['in', 'out', 'out']);
});

test('nothing is scheduled after the clip ends, and disabling removes every cue', () => {
  const cues = buildBrollSfxCues([{ start: 57, end: 60 }], { totalDuration: 60, enabled: true });
  assert.ok(cues.every((cue) => cue.atSeconds < 60));
  assert.deepEqual(buildBrollSfxCues([{ start: 1, end: 4 }], { totalDuration: 60, enabled: false }), []);
});

test('one pre-mixed effect track is added to the voice without normalising', () => {
  const plan = buildSfxMixPlan({
    baseLabel: '[a]',
    sfxInputIndex: 5,
  });
  assert.deepEqual(plan.statements, [
    '[5:a]aformat=channel_layouts=stereo[sfx]',
    '[a][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]',
  ]);
  const mix = plan.statements[1];
  assert.match(mix, /duration=first/);
  assert.match(mix, /normalize=0/, 'the voice must never be attenuated by the effects');
  assert.equal(plan.label, '[amixed]');
});

test('no cues means no filter statements at all (autoBroll off is byte-identical)', () => {
  const plan = buildSfxMixPlan({ baseLabel: '[a]', sfxInputIndex: null });
  assert.deepEqual(plan.statements, []);
  assert.equal(plan.label, '[a]');
});

test('the bundled effect files exist and are real WAV files', () => {
  for (const file of Object.values(BROLL_SFX_FILES)) {
    const filePath = path.join(process.cwd(), 'public', 'sfx', file);
    assert.ok(fs.existsSync(filePath), `${file} is missing from public/sfx`);
    const header = fs.readFileSync(filePath).subarray(0, 12);
    assert.equal(header.subarray(0, 4).toString(), 'RIFF');
    assert.equal(header.subarray(8, 12).toString(), 'WAVE');
  }
  assert.ok(BROLL_SFX_VOLUME > 0.2 && BROLL_SFX_VOLUME < 0.35, 'the brief pins the effect gain to 0.2-0.35');
});

test('pre-mixes cues into one timed PCM track without allocating delayed silence per cue', () => {
  const filePath = path.join(process.cwd(), 'public', 'sfx', BROLL_SFX_FILES.enter);
  const wav = buildBrollSfxWav([
    { filePath, atSeconds: 0.25, volume: BROLL_SFX_VOLUME },
    { filePath, atSeconds: 0.7, volume: BROLL_SFX_EXIT_VOLUME },
  ], 1);

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt32LE(40), 44100 * 2, 'one second of mono 16-bit PCM');
  assert.ok(wav.subarray(44, 44 + 22050).every((sample) => sample === 0), 'silence before the first cue');
  assert.ok(wav.subarray(44 + 22050, 44 + 44100).some((sample) => sample !== 0), 'cue audio appears at its scheduled time');
});
