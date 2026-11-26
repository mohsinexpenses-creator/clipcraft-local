/**
 * Active-speaker SWITCH CONTROL - the part of the pipeline that decides whether a
 * speaker change is real, and when the camera is allowed to act on it.
 *
 * The old fusion decided on every 0.3 s window: a challenger took the label as soon
 * as one window's score beat the incumbent's by 10 % (or immediately, through the
 * "reactive" override, when the incumbent looked quiet). With that rule a single
 * loud laugh, a chair creak, a head turn or one jumpy detector sample was enough to
 * move the camera - and because the next window could just as easily swing back,
 * the camera then had to move again. Those are the 47 switches in 84 seconds the
 * diagnostics reported; the camera was faithfully following a decision that was
 * itself flickering.
 *
 * The controller here makes the DECISION stable, so the camera has less to do:
 *
 *   1. EVIDENCE OVER TIME, not per window. Each decision window votes for a
 *      favourite with a confidence (how far clear of the runner-up it is);
 *      a challenger has to stay ahead for `confirmSeconds` before it may take
 *      over. A single loud window cannot win a turn.
 *   2. STRONGER PROOF FOR A SWITCH than for a hold. A confirmed challenger is
 *      still rejected when the incumbent keeps a clear share of the evidence, so
 *      a marginal lead does not move the camera.
 *   3. ANTI-PING-PONG. A confirmed switch arms a cooldown; the person who just
 *      lost the frame cannot snatch it straight back without much stronger
 *      evidence, and repeating a turn back and forth needs more proof each time.
 *   4. UNCERTAINTY IS KEPT. When the audio or the faces do not clearly say who is
 *      talking, the incumbent keeps the frame (if on screen) and the reason is
 *      recorded for the diagnostics - no new camera event, no random label.
 *
 * Pure logic, no I/O: the whole thing is driven by `decide()` once per window and
 * is therefore unit-testable without video, audio or models.
 */

import type { SpeakerSegment } from './speaker';

export interface SwitchControlSettings {
  /** A challenger must lead for this long before it replaces the incumbent. */
  confirmSeconds: number;
  /** ...and its mean confidence must reach at least this (0..1) while it leads. */
  minConfidence: number;
  /** Once confirmed, the losing speaker cannot win again for this long. */
  cooldownSeconds: number;
  /** While the frame is still held on a challenger, it needs this share of the evidence. */
  holdMargin: number;
  /** Within the cooldown, the previous speaker needs this much stronger evidence. */
  cooldownMargin: number;
}

export const SWITCH_CONTROL_DEFAULTS: SwitchControlSettings = {
  confirmSeconds: 0.9,
  minConfidence: 0.12,
  cooldownSeconds: 1,
  holdMargin: 0.82,
  cooldownMargin: 1.35,
};

/** Why the controller did (or refused to do) something. Logged per confirmed switch. */
export type SwitchReason =
  /** The incumbent is still the best use of the frame. */
  | 'hold'
  /** The incumbent's position is by definition good (no challenger). */
  | 'only'
  /** The challenger needed to take new evidence. */
  | 'confirmed'
  /** `held`: the incumbent is not on screen. `unknown`: nothing qualified at all. */
  | 'no-candidate'
  /** The challenger may take over, but has not been ahead long enough yet. */
  | 'pending'
  /** Challenger's lead is real, but too small while the incumbent still holds it. */
  | 'marginal'
  /** The person who just lost the frame is trying to snatch it back too soon. */
  | 'cooldown'
  /** Audio/faces are not clear enough to move the camera - the incumbent stays. */
  | 'uncertain';

/** One decision window: scores 0..1 per person, at most one confident favourite. */
export interface SpeakerEvidence {
  /** Clip-relative midpoint of the window (seconds). */
  t: number;
  /** How much timeline this window owns (the evidence it is worth, seconds). */
  duration?: number;
  /** True when the audio says someone is talking in this window. */
  voiced: boolean;
  /** False when the best candidate is not clear enough to be worth a switch. */
  confident: boolean;
  /** Best -> worst; only the first two are used for the decision. */
  candidates: Array<{ trackId: number; score: number }>;
}

export interface SwitchDecisionLog {
  /** When the incumbent was given the frame (the minimum-hold timer starts here). */
  since: number;
  /** Confirmed switches inside this control run, for the per-clip summary. */
  switches: number;
  /** Windows where uncertainty kept the previous framing instead of moving. */
  uncertainWindows: number;
  /** Windows where a challenger was ahead but not for long enough / not strongly enough. */
  blockedWindows: number;
  /** Reasons, in order, for the confirmed switches only. */
  confirmed: Array<{ t: number; from: number | null; to: number; reason: SwitchReason }>;
  /** Who lost the frame to the incumbent, and when (cooldown bookkeeping). */
  recentLosses: Array<{ trackId: number; t: number }>;
}

/** Where the controller is right now; carried from window to window. */
export interface SwitchControlState {
  /** The speaker the timeline currently carries (null = nobody known). */
  current: number | null;
  /** When the current speaker started (minimum hold). */
  since: number;
  /** When the current speaker was last CONFIRMED (or first given the frame). */
  confirmedAt: number;
  /** The challenger building up a case, if any. */
  challenger: number | null;
  /** When that challenger started leading. */
  challengerSince: number;
  /**
   * ACCUMULATED seconds of confirmed-lead evidence. A real conversation has
   * pauses: requiring one uninterrupted lead means a turn is never confirmed
   * (the incumbent's silence-window score keeps interrupting the challenge).
   * So a lead ADDS time and a counter-window SUBTRACTS a fraction of it, and the
   * challenge only dies when the evidence is fully spent.
   */
  challengerLead: number;
  /** Running sum / count of the challenger's confidence while it leads. */
  challengerConfidence: number;
  challengerWindows: number;
  /** Set at a confirmed switch: who lost, and when the cooldown expires. */
  lastSwitchAt: number;
  previousSpeaker: number | null;
  /** Track -> when the cooldown that protects the current speaker expires. */
  cooldowns: Map<number, number>;
  /** Track -> how many turns in a row it has been re-instated (anti-oscillation ramp). */
  repeatTurns: Map<number, number>;
  /** Diagnostics collected along the way. */
  log: SwitchDecisionLog;
}

function freshLog(): SwitchDecisionLog {
  return {
    since: 0,
    switches: 0,
    uncertainWindows: 0,
    blockedWindows: 0,
    confirmed: [],
    recentLosses: [],
  };
}

export function createSwitchControl(): SwitchControlState {
  return {
    current: null,
    since: 0,
    confirmedAt: 0,
    challenger: null,
    challengerSince: 0,
    challengerLead: 0,
    challengerConfidence: 0,
    challengerWindows: 0,
    lastSwitchAt: Number.NEGATIVE_INFINITY,
    previousSpeaker: null,
    cooldowns: new Map(),
    repeatTurns: new Map(),
    log: freshLog(),
  };
}

/**
 * How clearly the leader beats the runner-up, as 0..1: 0 for an exact tie, 0.5
 * when the leader scores twice the runner-up, approaching 1 as the margin grows.
 * This is the "how sure are we that this is the speaker" number, and it is what
 * `minConfidence` is compared against - a lead that is real but wafer-thin is not
 * convincing evidence for moving the camera.
 */
export function decisionConfidence(best: number, second: number): number {
  if (!(best > 0)) return 0;
  const ratio = best / Math.max(1e-9, second);
  return Math.max(0, Math.min(1, 1 - 1 / ratio));
}

/**
 * Run one decision window through the controller and return who owns the frame
 * from here on. Mutates `state` (it is the running memory), which is what lets the
 * caller build the timeline segment by segment.
 *
 * `settings` is re-read every window so a caller can vary it (the camera planner
 * passes the same resolved values, the ASD pass the env-resolved ones).
 */
export function decideSpeaker(
  state: SwitchControlState,
  evidence: SpeakerEvidence,
  settings: SwitchControlSettings,
  /** Minimum time the incumbent keeps the frame after a switch (s). */
  minHoldSeconds: number,
): { trackId: number | null; reason: SwitchReason } {
  const top = evidence.candidates[0];
  const runnerUp = evidence.candidates[1];

  if (!top) {
    // Nobody on screen / nobody qualified. Holding the label of a face that is
    // not in this shot is what makes the camera keep an outdated position, so the
    // label is dropped - but the INCUMBENT's identity is remembered, so their
    // return does not count as a new speaker.
    state.challenger = null;
    state.challengerWindows = 0;
    state.challengerConfidence = 0;
    if (state.current === null) return { trackId: null, reason: 'unknown' as SwitchReason };
    return { trackId: null, reason: 'no-candidate' };
  }

  if (state.current === null) {
    // First decision of the clip: adopt the leader, whoever it is.
    state.current = top.trackId;
    state.since = evidence.t;
    state.confirmedAt = evidence.t;
    state.log.since = evidence.t;
    return { trackId: top.trackId, reason: 'only' };
  }

  if (top.trackId === state.current) {
    // The incumbent is the leader again. A pending challenge is not thrown away
    // - a speaker's own name being mentioned, a pause, a laugh: the challenger
    // losing ONE window does not erase the evidence it already built. It decays
    // instead, and only a fully spent case is dropped.
    //
    // A SILENT window is neutral: nobody talking says nothing about WHO talks,
    // so it neither builds nor spends a case. Only a voiced window that favours
    // the incumbent is real counter-evidence.
    spendChallenge(state, evidence.voiced ? evidence.duration ?? 0.1 : 0);
    return { trackId: state.current, reason: 'hold' };
  }

  const incumbent = evidence.candidates.find((candidate) => candidate.trackId === state.current);
  if (!incumbent) {
    // The incumbent is not on screen in this window: there is nothing to hold.
    // This is the only "free" switch - and it is not a turn change, it is the
    // camera having nobody else to follow, so it does not arm the cooldown.
    adopt(state, top.trackId, evidence.t);
    return { trackId: top.trackId, reason: 'no-candidate' };
  }

  const confidence = decisionConfidence(top.score, runnerUp ? runnerUp.score : 0);

  // UNCERTAINTY: the cheap cues cannot separate the top two. Keeping the current
  // framing is a deliberate decision (and it is reported), never a coin flip.
  if (!evidence.confident) {
    // The cues cannot separate the two: keep the current framing and report it.
    // The pending case is neither confirmed nor erased by a tie.
    spendChallenge(state, evidence.voiced ? evidence.duration ?? 0.1 : 0);
    state.log.uncertainWindows += 1;
    return { trackId: state.current, reason: 'uncertain' };
  }

  const held = evidence.t - state.since >= minHoldSeconds - 1e-9;
  const cooldownUntil = state.cooldowns.get(top.trackId) ?? Number.NEGATIVE_INFINITY;
  const inCooldown = evidence.t < cooldownUntil - 1e-9;
  // A speaker who keeps bouncing back needs progressively stronger proof.
  const repeated = state.repeatTurns.get(top.trackId) ?? 0;
  const requiredMargin = inCooldown
    ? settings.cooldownMargin + 0.15 * repeated
    : settings.holdMargin;
  const strongLead = top.score >= incumbent.score * requiredMargin;

  if (!strongLead) {
    // A confirmed challenger may still be ahead, but not by enough to justify
    // moving the camera while the incumbent is right there.
    resetChallenge(state);
    state.log.blockedWindows += 1;
    return { trackId: state.current, reason: 'marginal' };
  }

  if (!held) {
    resetChallenge(state);
    state.log.blockedWindows += 1;
    return { trackId: state.current, reason: 'marginal' };
  }

  // Start / continue the challenge. `windowSeconds` is how much timeline this
  // window owns, which is exactly how much evidence it is worth.
  const windowSeconds = Math.max(1e-3, evidence.duration ?? 0.1);
  if (state.challenger !== top.trackId) {
    state.challenger = top.trackId;
    state.challengerSince = evidence.t;
    state.challengerLead = 0;
    state.challengerWindows = 0;
    state.challengerConfidence = 0;
  }
  state.challengerWindows += 1;
  state.challengerConfidence += confidence;
  state.challengerLead += windowSeconds;
  const meanConfidence = state.challengerConfidence / Math.max(1, state.challengerWindows);

  // The lead must ACCUMULATE to the confirmation period. `+1e-9` keeps exactly
  // 0.9 s of evidence at 0.9 s a confirmation, not a near-miss.
  if (state.challengerLead + 1e-9 < settings.confirmSeconds) {
    state.log.blockedWindows += 1;
    return { trackId: state.current, reason: 'pending' };
  }
  if (meanConfidence + 1e-9 < settings.minConfidence) {
    // Ahead for long enough, but never by enough: a narrow, hesitant lead is
    // exactly the pattern a laughing listener produces.
    state.log.blockedWindows += 1;
    return { trackId: state.current, reason: 'pending' };
  }

  // CONFIRMED. The camera may now make one move to the new speaker.
  const from = state.current;
  const reason: SwitchReason = inCooldown ? 'cooldown' : 'confirmed';
  state.previousSpeaker = from;
  state.lastSwitchAt = evidence.t;
  state.cooldowns.set(from, evidence.t + settings.cooldownSeconds);
  state.repeatTurns.set(top.trackId, repeated + 1);
  state.repeatTurns.set(from, 0);
  state.log.switches += 1;
  state.log.confirmed.push({ t: evidence.t, from, to: top.trackId, reason });
  adopt(state, top.trackId, evidence.t);
  return { trackId: top.trackId, reason };
}

/**
 * A window that did NOT favour the pending challenger: subtract part of the
 * evidence it had accumulated. The challenge survives a dip (a pause, a
 * cross-talk window) but dies once the case is gone.
 */
function spendChallenge(state: SwitchControlState, windowSeconds: number): void {
  if (state.challenger === null || windowSeconds <= 0) return;
  state.challengerLead -= windowSeconds * CHALLENGE_DECAY;
  if (state.challengerLead <= 0) resetChallenge(state);
}

/**
 * How fast accumulated evidence is spent by a window that does not support the
 * challenger. Below 1 so a conversation's pauses (speech is ~40 % silence) do not
 * erase a real turn before it can be confirmed.
 */
const CHALLENGE_DECAY = 0.5;

/** Give the frame to `trackId` from `t` (resets the challenge and the hold timer). */
function adopt(state: SwitchControlState, trackId: number, t: number): void {
  state.current = trackId;
  state.since = t;
  state.confirmedAt = t;
  state.log.since = t;
  resetChallenge(state);
}

function resetChallenge(state: SwitchControlState): void {
  state.challenger = null;
  state.challengerSince = 0;
  state.challengerLead = 0;
  state.challengerConfidence = 0;
  state.challengerWindows = 0;
}

/** Read a knob from an env-like record, clamped, with the documented default. */
export function resolveSwitchControlSettings(
  env: Readonly<Record<string, string | undefined>>,
): SwitchControlSettings {
  const num = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value?.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, value));
  return {
    // 0.9 s: two to three decision windows of continuous lead. Long enough that a
    // laugh, a cough or a single loud window cannot move the camera; short enough
    // that a genuine hand-over is not visibly late.
    confirmSeconds: clamp(
      num(env.SPEAKER_CONFIRM_SECONDS, SWITCH_CONTROL_DEFAULTS.confirmSeconds),
      0,
      5,
    ),
    minConfidence: clamp(
      num(env.SPEAKER_CONFIRM_MIN_CONFIDENCE, SWITCH_CONTROL_DEFAULTS.minConfidence) / 100,
      0,
      1,
    ),
    cooldownSeconds: clamp(
      num(env.SPEAKER_SWITCH_COOLDOWN_SECONDS, SWITCH_CONTROL_DEFAULTS.cooldownSeconds),
      0,
      10,
    ),
    holdMargin: clamp(
      num(env.SPEAKER_HOLD_MARGIN, SWITCH_CONTROL_DEFAULTS.holdMargin),
      0.5,
      3,
    ),
    cooldownMargin: clamp(
      num(env.SPEAKER_COOLDOWN_MARGIN, SWITCH_CONTROL_DEFAULTS.cooldownMargin),
      0.5,
      5,
    ),
  };
}

/**
 * Keep the timeline from carrying a label into a span where nobody is on screen,
 * and collapse consecutive segments of the same speaker. (The camera plan merges
 * runs of the same person anyway, but a timeline full of 1-frame blanks would
 * still make every consumer treat them as separate turns.)
 */
export function mergeSpeakerSegments(
  segments: SpeakerSegment[],
  cuts: number[] = [],
): SpeakerSegment[] {
  const out: SpeakerSegment[] = [];
  const isCut = (t: number): boolean => cuts.some((cut) => Math.abs(cut - t) < 1e-6);
  for (const segment of segments) {
    if (!(segment.t1 > segment.t0 + 1e-9)) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.trackId === segment.trackId &&
      Math.abs(last.t1 - segment.t0) < 1e-6 &&
      // NEVER merge across a source shot cut: the boundary is what tells every
      // consumer that a new camera angle (and a fresh decision) starts here.
      !isCut(segment.t0)
    ) {
      last.t1 = segment.t1;
      continue;
    }
    out.push({ t0: segment.t0, t1: segment.t1, trackId: segment.trackId });
  }
  return out;
}

/**
 * Reverse switches: a turn that is undone within `windowSeconds` (A -> B -> A).
 * A high count is the signature of ping-pong, so it is reported per clip.
 */
export function countReverseSwitches(
  segments: SpeakerSegment[],
  windowSeconds = 1,
): number {
  const labels = segments
    .filter((segment) => segment.trackId !== null)
    .map((segment) => ({ t0: segment.t0, id: segment.trackId as number }));
  let reverses = 0;
  for (let i = 2; i < labels.length; i += 1) {
    const [first, second, third] = [labels[i - 2], labels[i - 1], labels[i]];
    if (first.id === third.id && second.id !== first.id && third.t0 - first.t0 <= windowSeconds) {
      reverses += 1;
    }
  }
  return reverses;
}

/** Per-speaker lock durations (clip-relative seconds), shortest first. */
export function speakerLockDurations(segments: SpeakerSegment[]): {
  average: number;
  minimum: number;
  count: number;
} {
  const runs = segments.filter((segment) => segment.trackId !== null);
  if (runs.length === 0) return { average: 0, minimum: 0, count: 0 };
  const durations = runs.map((segment) => segment.t1 - segment.t0);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    average: Math.round((total / durations.length) * 100) / 100,
    minimum: Math.round(Math.min(...durations) * 100) / 100,
    count: runs.length,
  };
}
