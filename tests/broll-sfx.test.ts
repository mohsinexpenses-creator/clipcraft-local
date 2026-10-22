import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BROLL_SFX_FILES,
  BROLL_SFX_VOLUME,
  buildBrollSfxCues,
  buildSfxMixPlan,
  buildSfxStreamStatement,
} from '../lib/broll/sfx';

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

test('each effect is delayed to its own timestamp and padded, then mixed without normalising', () => {
  const statement = buildSfxStreamStatement({
    cue: { atSeconds: 12.5, inputIndex: 5 },
    totalDuration: 63,
    volume: 0.28,
    index: 0,
  });
  assert.match(statement, /^\[5:a\]aformat=channel_layouts=stereo,adelay=12500:all=1,volume=0\.28/);
  assert.match(statement, /apad=whole_dur=63\.000/);
  assert.match(statement, /\[sfx0\]$/);

  const plan = buildSfxMixPlan({
    baseLabel: '[a]',
    cueInputIndices: [5, 6],
    cues: [{ atSeconds: 3 }, { atSeconds: 9 }],
    totalDuration: 63,
  });
  assert.equal(plan.statements.length, 3);
  const mix = plan.statements[2];
  assert.match(mix, /\[a\]\[sfx0\]\[sfx1\]amix=inputs=3/);
  assert.match(mix, /duration=first/);
  assert.match(mix, /normalize=0/, 'the voice must never be attenuated by the effects');
  assert.equal(plan.label, '[amixed]');
});

test('no cues means no filter statements at all (autoBroll off is byte-identical)', () => {
  const plan = buildSfxMixPlan({ baseLabel: '[a]', cueInputIndices: [], cues: [], totalDuration: 30 });
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
