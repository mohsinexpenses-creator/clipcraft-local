/**
 * Speaker-switch stability: the eight scenarios a camera operator has to get
 * right, expressed against the controller that decides them.
 *
 *   A one person speaking            - no switch, ever
 *   B two people talking             - the current speaker keeps the frame until
 *                                      the change is genuinely confirmed
 *   C brief interruptions            - a laugh / cough / bump cannot steal a turn
 *   D rapid genuine turn-taking      - the camera still follows real changes
 *   E ambiguous audio                - the framing is KEPT and the uncertainty
 *                                      is reported
 *   F natural head movement          - see tests/camera-plan.test.ts (no move)
 *   G source-shot change             - a cut is a hard switch, never a pan
 *   H obstructed face                - an unusable face is not a new speaker
 *
 * The controller is pure logic, so these run in milliseconds with no video,
 * audio or model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SWITCH_CONTROL_DEFAULTS,
  SpeakerEvidence,
  SwitchControlSettings,
  countReverseSwitches,
  createSwitchControl,
  decideSpeaker,
  decisionConfidence,
  mergeSpeakerSegments,
  resolveSwitchControlSettings,
  speakerLockDurations,
} from '../worker/asd/switch-control';
import { SpeakerSegment } from '../worker/asd/speaker';

const SETTINGS: SwitchControlSettings = { ...SWITCH_CONTROL_DEFAULTS };
const MIN_HOLD = 0.8;

/** One decision window favouring `trackId` with a clear lead. */
function windowFor(t: number, trackId: number, options: { voiced?: boolean; rival?: number } = {}): SpeakerEvidence {
  return {
    t,
    duration: 0.1,
    voiced: options.voiced ?? true,
    confident: true,
    candidates: [
      { trackId, score: 0.8 },
      { trackId: options.rival ?? trackId + 100, score: 0.2 },
    ],
  };
}

/** Run a sequence of windows through a fresh controller, returning each verdict. */
function run(
  windows: SpeakerEvidence[],
  settings: SwitchControlSettings = SETTINGS,
  minHold = MIN_HOLD,
) {
  const state = createSwitchControl();
  const verdicts = windows.map((evidence) => decideSpeaker(state, evidence, settings, minHold));
  return { state, verdicts };
}

/**
 * A timeline of `seconds` of windows all favouring `trackId`, starting at `from`.
 * Index-based on purpose: accumulating `t += 0.1` loses half of a 0.5 s block to
 * floating-point drift, which would make these tests lie about durations.
 */
function hold(
  trackId: number,
  from: number,
  seconds: number,
  // The natural two-person case: person 1 and person 2 are both on screen, and
  // the one being held is the one with the clear lead.
  rivId = trackId === 1 ? 2 : 1,
): SpeakerEvidence[] {
  const out: SpeakerEvidence[] = [];
  const count = Math.round(seconds / 0.1);
  for (let i = 0; i < count; i += 1) {
    out.push(windowFor(Number((from + i * 0.1).toFixed(2)), trackId, { rival: rivId }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. One person speaking
// ---------------------------------------------------------------------------

test('scenario A: one person speaking never produces a switch', () => {
  const { state, verdicts } = run(hold(1, 0, 20));
  assert.equal(state.log.switches, 0);
  assert.ok(verdicts.every((verdict) => verdict.trackId === 1));
  assert.ok(verdicts.slice(1).every((verdict) => verdict.reason === 'hold'));
});

// ---------------------------------------------------------------------------
// B. Two people: the incumbent keeps the frame until the change is confirmed
// ---------------------------------------------------------------------------

test('scenario B: a confirmed turn takes over after the evidence period, not before', () => {
  const windows = [...hold(1, 0, 5), ...hold(2, 5, 5)];
  const { state, verdicts } = run(windows, SETTINGS, 0.1);

  // The switch happens AFTER the challenger has been convincing for the
  // confirmation period - never on the first window that looks better.
  const switchIndex = windows.findIndex(
    (evidence) => evidence.candidates[0].trackId === 2,
  );
  assert.ok(switchIndex > 0, 'B does get the frame');
  const confirmed = state.log.confirmed[0];
  assert.ok(
    confirmed.t - windows[switchIndex].t >= 0.75,
    `switched ${(confirmed.t - windows[switchIndex].t).toFixed(2)}s after B started talking`,
  );
  assert.equal(state.log.switches, 1, 'exactly one switch');
  assert.equal(confirmed.from, 1);
  assert.equal(confirmed.to, 2);
  assert.equal(confirmed.reason, 'confirmed');
  // B's lead is counted in WINDOWS: 8 x 0.1 s is 0.8 s, and the 9th window (which
  // also reaches the 0.9 s the camera needs) confirms. Nothing confirms earlier.
  assert.ok(
    confirmed.t - windows[switchIndex].t >= 0.75,
    `confirmed after ${(confirmed.t - windows[switchIndex].t).toFixed(2)}s of evidence`,
  );
  assert.ok(
    verdicts.slice(switchIndex).some((verdict) => verdict.trackId === 2),
    'the frame reaches B',
  );
  // And once B has the frame it is never handed back (A never regains evidence).
  const confirmedIndex = windows.findIndex((evidence) => evidence.t >= confirmed.t - 1e-9);
  assert.ok(
    verdicts.slice(confirmedIndex).every((verdict) => verdict.trackId === 2),
    'the frame stays on B for the rest of the clip',
  );
});

test('scenario B: leaving the confirmation period at its default means ~0.9s of evidence', () => {
  assert.equal(SWITCH_CONTROL_DEFAULTS.confirmSeconds, 0.9);
  assert.equal(SWITCH_CONTROL_DEFAULTS.cooldownSeconds, 1);
  // Eight windows of clear lead is 0.8 s: not enough.
  const notYet = run([...hold(1, 0, 3), ...hold(2, 3, 0.8)], SETTINGS, 0.1);
  assert.equal(notYet.state.log.switches, 0, '0.8 s of evidence is not a confirmed turn');
  assert.ok(
    notYet.verdicts.some((verdict) => verdict.reason === 'pending'),
    'the pending challenge is reported, not silently dropped',
  );
  // One more window tips it.
  const enough = run([...hold(1, 0, 3), ...hold(2, 3, 1.0)], SETTINGS, 0.1);
  assert.equal(enough.state.log.switches, 1);
});

// ---------------------------------------------------------------------------
// C. Brief interruptions
// ---------------------------------------------------------------------------

test('scenario C: a single loud window cannot steal the frame', () => {
  // A laughs out loud for one window (0.1 s): its cue spikes, then it is silent.
  const windows = [
    ...hold(1, 0, 3),
    windowFor(3.0, 2, { rival: 1 }),
    ...hold(1, 3.1, 3),
  ];
  const { state, verdicts } = run(windows);
  assert.equal(state.log.switches, 0, 'no switch for a laugh');
  assert.ok(verdicts.every((verdict) => verdict.trackId === 1));
});

test('scenario C: an interruption shorter than the confirmation period never lands', () => {
  // 0.5 s of the other person being louder, then the first speaker resumes.
  const windows = [
    ...hold(1, 0, 4),
    ...hold(2, 4, 0.5),
    ...hold(1, 4.5, 4),
  ];
  const { state } = run(windows, SETTINGS, 0.1);
  assert.equal(state.log.switches, 0, 'a half-second interjection is not a turn change');
});

test('scenario C: speech pauses do not erase a real turn in progress', () => {
  // A hands over; B has the floor but there is a silent window in the middle
  // (speech is ~40% silence). The turn must still be confirmed.
  const windows = [
    ...hold(1, 0, 3),
    windowFor(3.0, 2, { voiced: true, rival: 1 }),
    windowFor(3.1, 2, { voiced: false, rival: 1 }),
    windowFor(3.2, 2, { voiced: true, rival: 1 }),
    windowFor(3.3, 2, { voiced: true, rival: 1 }),
    windowFor(3.4, 2, { voiced: true, rival: 1 }),
    windowFor(3.5, 2, { voiced: true, rival: 1 }),
    windowFor(3.6, 2, { voiced: true, rival: 1 }),
    windowFor(3.7, 2, { voiced: true, rival: 1 }),
    windowFor(3.8, 2, { voiced: true, rival: 1 }),
    windowFor(3.9, 2, { voiced: true, rival: 1 }),
  ];
  const { state } = run(windows, SETTINGS, 0.1);
  assert.equal(state.log.switches, 1, 'a pause mid-turn does not reset the evidence');
});

// ---------------------------------------------------------------------------
// D. Rapid genuine turn-taking
// ---------------------------------------------------------------------------

test('scenario D: genuine rapid turn-taking is still followed', () => {
  // Three clear turns, 2.5 s each: every one of them must be followed.
  const windows = [
    ...hold(1, 0, 2.5),
    ...hold(2, 2.5, 2.5),
    ...hold(1, 5, 2.5),
    ...hold(2, 7.5, 2.5),
  ];
  const { state } = run(windows);
  assert.equal(state.log.switches, 3, `followed all three turns (${state.log.switches})`);
  // `run` uses the default (0.8 s) minimum hold, which this controller measures in
  // windows; 2.5 s turns satisfy it with room to spare.
  assert.deepEqual(state.log.confirmed.map((entry) => entry.to), [2, 1, 2]);
});

test('scenario D: the minimum hold keeps a genuine but very short turn from being framed', () => {
  // A 0.4 s interjection is below the 0.8 s minimum hold: it does not move the
  // camera, even with overwhelming evidence, because the camera cannot complete
  // the move without starting the next one.
  const windows = [...hold(1, 0, 3), ...hold(2, 3, 0.4), ...hold(1, 3.4, 3)];
  const { state } = run(windows);
  assert.equal(state.log.switches, 0);
});

// ---------------------------------------------------------------------------
// E. Ambiguous audio
// ---------------------------------------------------------------------------

test('scenario E: an unclear window keeps the current framing and is reported', () => {
  const ambiguous: SpeakerEvidence = {
    t: 3,
    duration: 0.1,
    voiced: true,
    confident: false,
    candidates: [
      { trackId: 2, score: 0.52 },
      { trackId: 1, score: 0.5 },
    ],
  };
  const { state, verdicts } = run([...hold(1, 0, 3), ambiguous, ...hold(1, 3.1, 2)]);
  assert.equal(state.log.switches, 0, 'nobody moves on a coin flip');
  assert.equal(state.log.uncertainWindows, 1, 'the uncertainty is recorded');
  assert.equal(verdicts[30].reason, 'uncertain');
  assert.equal(verdicts[30].trackId, 1);
});

test('scenario E: nothing qualified keeps the incumbent rather than picking at random', () => {
  // Nobody is clearly moving, but the incumbent is still on screen: the label is
  // retained (as "no candidate"), not reassigned.
  const nothing: SpeakerEvidence = { t: 4, duration: 0.1, voiced: true, confident: true, candidates: [] };
  const { state } = run([...hold(1, 0, 4), nothing]);
  assert.equal(state.log.switches, 0);
});

test('scenario E: a marginal lead is not a switch while the incumbent is on screen', () => {
  const marginal = (t: number): SpeakerEvidence => ({
    t,
    duration: 0.1,
    voiced: true,
    confident: true,
    candidates: [
      { trackId: 2, score: 0.60 },
      { trackId: 1, score: 0.55 },
    ],
  });
  const { state, verdicts } = run([
    ...hold(1, 0, 3),
    ...Array.from({ length: 20 }, (_, index) => marginal(Number((3 + index * 0.1).toFixed(2)))),
  ]);
  assert.equal(state.log.switches, 0, 'a 9% lead never moves the camera');
  assert.ok(verdicts.some((verdict) => verdict.reason === 'marginal'));
});

// ---------------------------------------------------------------------------
// Anti-ping-pong
// ---------------------------------------------------------------------------

test('anti-ping-pong: the speaker who just lost the frame cannot snatch it back at once', () => {
  const windows = [
    ...hold(1, 0, 3),
    ...hold(2, 3, 2), // confirmed turn to 2 at ~3.9 s
    ...hold(1, 4.0, 0.3), // 1 immediately tries to take it back
  ];
  const { state } = run(windows, SETTINGS, 0.1);
  assert.equal(state.log.switches, 1, 'only the one real turn');
  assert.ok(
    state.log.confirmed.every((entry) => entry.to === 2),
    'the cooldown kept the just-confirmed speaker in place',
  );
});

test('anti-ping-pong: a genuine turn back IS honoured once the cooldown has passed', () => {
  const windows = [
    ...hold(1, 0, 3),
    ...hold(2, 3, 3),
    ...hold(1, 6, 3),
  ];
  const { state } = run(windows);
  assert.equal(state.log.switches, 2, 'the conversation really did move back');
  assert.deepEqual(state.log.confirmed.map((entry) => entry.to), [2, 1]);
});

test('anti-ping-pong: alternating near-equal leads settle into a bounded number of switches', () => {
  // 20 s of scores that trade the lead every 0.3 s: a flickering detector.
  const windows: SpeakerEvidence[] = [];
  for (let t = 0; t < 20; t += 0.1) {
    const leader = Math.floor(t / 0.3) % 2 === 0 ? 1 : 2;
    const rival = leader === 1 ? 2 : 1;
    windows.push({
      t,
      duration: 0.1,
      voiced: true,
      confident: true,
      candidates: [
        { trackId: leader, score: 0.6 },
        { trackId: rival, score: 0.55 },
      ],
    });
  }
  const { state } = run(windows);
  assert.ok(state.log.switches <= 4, `bounded switches (${state.log.switches})`);
});

test('anti-ping-pong: countReverseSwitches measures A->B->A inside one second', () => {
  const segments: SpeakerSegment[] = [
    { t0: 0, t1: 5, trackId: 1 },
    { t0: 5, t1: 5.4, trackId: 2 },
    { t0: 5.4, t1: 10, trackId: 1 }, // A -> B -> A inside 0.4 s: a ping-pong
    { t0: 10, t1: 10.2, trackId: 2 },
    { t0: 10.2, t1: 15, trackId: 1 }, // and another one inside 0.2 s
    { t0: 15, t1: 20, trackId: 2 }, // a real turn, not a reverse
  ];
  assert.equal(countReverseSwitches(segments, 1), 2);
  assert.equal(countReverseSwitches(segments, 0.1), 0, 'nothing reverses that fast');
});

// ---------------------------------------------------------------------------
// G. Source-shot change
// ---------------------------------------------------------------------------

test('scenario G: segments are never merged across a source cut', () => {
  const segments: SpeakerSegment[] = [
    { t0: 0, t1: 4, trackId: 1 },
    { t0: 4, t1: 8, trackId: 1 },
  ];
  // Same person, but a cut at 4 s: two shots, two decision runs.
  const kept = mergeSpeakerSegments(segments, [4]);
  assert.equal(kept.length, 2);
  // Without a cut it is one continuous lock.
  assert.equal(mergeSpeakerSegments(segments, []).length, 1);
});

// ---------------------------------------------------------------------------
// H. Obstructed face / missing incumbent
// ---------------------------------------------------------------------------

test('scenario H: when the incumbent is not on screen the frame follows a visible face', () => {
  const windows = [...hold(1, 0, 3)];
  // From 3 s only person 2 is detected at all.
  for (let t = 3; t < 6; t += 0.1) {
    windows.push({
      t: Number(t.toFixed(2)),
      duration: 0.1,
      voiced: true,
      confident: true,
      candidates: [{ trackId: 2, score: 0.7 }],
    });
  }
  const { state, verdicts } = run(windows, SETTINGS, 0.1);
  assert.equal(verdicts[30].trackId, 2, 'an off-screen incumbent is not held');
  // It is not a "turn change" (nobody competed), so no cooldown is armed against 1.
  assert.equal(state.cooldowns.size, 0);
});

test('scenario H: an incumbent who disappears and returns is not a new challenge', () => {
  const windows = [
    ...hold(1, 0, 3),
    // Nobody on screen for a moment (a mic across the face, a look down).
    { t: 3, duration: 0.1, voiced: true, confident: true, candidates: [] } as SpeakerEvidence,
    ...hold(1, 3.1, 3),
  ];
  const { state } = run(windows, SETTINGS, 0.1);
  assert.equal(state.log.switches, 0);
  assert.ok(state.log.confirmed.length === 0);
});

// ---------------------------------------------------------------------------
// Settings and diagnostics
// ---------------------------------------------------------------------------

test('every stability knob is configurable, clamped, and documented by default', () => {
  const defaults = resolveSwitchControlSettings({});
  assert.deepEqual(defaults, {
    confirmSeconds: 0.9,
    minConfidence: 0.12,
    cooldownSeconds: 1,
    holdMargin: 0.82,
    cooldownMargin: 1.35,
  });

  const custom = resolveSwitchControlSettings({
    SPEAKER_CONFIRM_SECONDS: '1.5',
    SPEAKER_CONFIRM_MIN_CONFIDENCE: '25',
    SPEAKER_SWITCH_COOLDOWN_SECONDS: '2',
    SPEAKER_HOLD_MARGIN: '1.1',
    SPEAKER_COOLDOWN_MARGIN: '2',
  });
  assert.equal(custom.confirmSeconds, 1.5);
  assert.equal(custom.minConfidence, 0.25);
  assert.equal(custom.cooldownSeconds, 2);
  assert.equal(custom.holdMargin, 1.1);

  // Nonsense is clamped instead of crashing a render.
  const extreme = resolveSwitchControlSettings({
    SPEAKER_CONFIRM_SECONDS: '99',
    SPEAKER_CONFIRM_MIN_CONFIDENCE: '-5',
    SPEAKER_SWITCH_COOLDOWN_SECONDS: 'abc',
    SPEAKER_HOLD_MARGIN: '0',
    SPEAKER_COOLDOWN_MARGIN: '100',
  });
  assert.equal(extreme.confirmSeconds, 5);
  assert.equal(extreme.minConfidence, 0);
  assert.equal(extreme.cooldownSeconds, 1, 'a non-number falls back to the default');
  assert.equal(extreme.holdMargin, 0.5);
  assert.equal(extreme.cooldownMargin, 5);
});

test('the controller honours a custom confirmation period', () => {
  const strict: SwitchControlSettings = { ...SWITCH_CONTROL_DEFAULTS, confirmSeconds: 2 };
  const windows = [...hold(1, 0, 3), ...hold(2, 3, 1.5)];
  assert.equal(run(windows, strict, 0.1).state.log.switches, 0, '1.5 s is not 2 s');
  const longer = [...hold(1, 0, 3), ...hold(2, 3, 2.1)];
  assert.equal(run(longer, strict, 0.1).state.log.switches, 1);
});

test('decisionConfidence is 0 for a tie and rises with the margin', () => {
  assert.equal(decisionConfidence(0.5, 0.5), 0);
  assert.ok(Math.abs(decisionConfidence(0.6, 0.3) - 0.5) < 1e-9);
  assert.ok(decisionConfidence(0.8, 0.1) > decisionConfidence(0.6, 0.3));
  assert.equal(decisionConfidence(0, 0.5), 0);
});

test('speakerLockDurations reports average and minimum, ignoring unassigned spans', () => {
  const segments: SpeakerSegment[] = [
    { t0: 0, t1: 2, trackId: 1 },
    { t0: 2, t1: 2.5, trackId: null },
    { t0: 2.5, t1: 7.5, trackId: 2 },
  ];
  const stats = speakerLockDurations(segments);
  assert.equal(stats.count, 2);
  assert.equal(stats.average, 3.5);
  assert.equal(stats.minimum, 2);
  assert.deepEqual(speakerLockDurations([{ t0: 0, t1: 3, trackId: null }]), {
    average: 0,
    minimum: 0,
    count: 0,
  });
});
