import { Track, TrackPoint, effectiveFaceMotion } from './tracker';

/**
 * Active-speaker decision: fuses several INDEPENDENT cues with the audio voice
 * envelope into a per-time "who is speaking" timeline. This is the layer that
 * decides WHO the 9:16 frame follows; `./tracker` only keeps stable person ids.
 *
 * Cues (multi-method on purpose - a handheld mic, mask or hand can cover the
 * mouth and kill any single visual cue):
 *   - **voice-gated motion** (the strongest speaker-specific cue): motion that
 *     happens WHILE the shared audio is loud. The speaker's face moves in
 *     lockstep with their own speech, so their voice-gated motion is high and
 *     reactive; a non-speaker's random gestures land at uncorrelated times and
 *     their voice-gated motion stays low. It is a sum of products (not Pearson
 *     correlation), so it is stable even on the few samples a 0.6 s window
 *     holds at 4-8 fps - where raw correlation is essentially noise.
 *   - audio↔motion correlation (Pearson) - a secondary confirmation cue;
 *   - motion energy of the face region vs the other faces;
 *   - mouth-opening variance (only when a landmark cue exists - YuNet has no
 *     mouth landmarks, so this simply contributes 0 there);
 *   - prominence (face size) and continuity (incumbent keeps the frame).
 *
 * When mouths are covered the correlation and mouth terms flatten toward 0 and
 * the worst-case cues (continuity, prominence, voice-gated motion) decide -
 * which is exactly the desired behaviour. When audio is missing/unvoiced the
 * weights shift to the visual-only mix.
 *
 * Hysteresis + a minimum hold stop two people's scores from trading the label
 * back and forth on borderline windows. One REACTIVE override breaks that
 * stickiness exactly when it must: when the incumbent has clearly stopped
 * moving with the audio and the challenger is clearly moving with it, the
 * label flips on the next held window instead of waiting for the score margin
 * that prominence/continuity biases can eat up (the "frame lingers on the
 * non-speaker after a turn change" bug).
 */

export interface SpeakerSegment {
  /** Clip-relative seconds. */
  t0: number;
  t1: number;
  /** The person who is speaking, or null when no face is on screen. */
  trackId: number | null;
}

export interface SpeakerTimelineInput {
  /** Clip duration in seconds. */
  duration: number;
  /**
   * Source shot cuts (clip-relative seconds). When supplied, the timeline never
   * carries a speaker label across one: the audio says "someone is talking" but a
   * cut changes who is ON SCREEN, so a stale label would make the camera hold a
   * position from the previous camera angle. Default: none.
   */
  shotCuts?: number[];
  /** Sampling fps of `voice` and of the track points. */
  fps: number;
  /** Per-sample-frame voice energy 0..1 (length ≈ duration*fps). */
  voice: number[];
  /** All tracked people (points carry per-frame motion and optional mouthOpen). */
  tracks: Track[];
  /** Source frame width (for normalising face size). */
  frameWidth: number;
  /**
   * Per-analysis-frame motion of the WHOLE scene 0..1 (the sampled frames' own
   * frame-to-frame change). Used only for sightings that came from a person box
   * while the face was lost: those carry no face pixels, so "did this person move
   * with the audio" has to fall back to audio + how much the scene itself moved.
   */
  sceneMotion?: number[];
  /**
   * Optional audio-visual referee for the windows these cues cannot settle (see
   * ./lr-asd and ./index). Omitted = the historical behaviour, exactly.
   */
  referee?: SpeakerReferee;
}

/** One window the cheap cues could not settle - the LR-ASD model's job. */
export interface AmbiguousWindow {
  /** Clip-relative window start/end (the decision window, not the step). */
  t0: number;
  t1: number;
  /** The people in contention (at most two), best cheap score first. */
  trackIds: number[];
  /** Why the window is ambiguous (logged once per clip). */
  reason: 'top-two-close' | 'cues-disagree';
}

/**
 * Optional audio-visual referee for ambiguous windows (see ./lr-asd). Supplied by
 * the caller with its own cost budget; the fusion asks for a verdict only when it
 * genuinely cannot decide.
 *
 * `likelihood(trackId)` returns 0..1 (1 = that person is speaking), or null when
 * the verdict is unavailable (model missing, budget spent, no audio).
 */
export interface SpeakerReferee {
  /**
   * Per-window likelihood lookup: trackId -> 0..1 (1 = definitely speaking).
   *
   * SYNCHRONOUS on purpose. The timeline must stay a pure, deterministic function
   * of its inputs: the caller that owns the (slow, async) model runs is
   * responsible for producing these verdicts before the timeline is built. A
   * referee that has nothing to say returns null and the window behaves exactly
   * as it did before.
   */
  judge: (window: AmbiguousWindow) => Map<number, number> | null;
  /** Weight of the verdict inside a window's score (0..0.5, default 0.25). */
  weight?: number;
}

export interface SpeakerTimelineResult {
  /** Merged runs of (time, active speaker). */
  segments: SpeakerSegment[];
  /** How many distinct people ever became the active speaker. */
  speakerCount: number;
  /** Windows handed to the audio-visual referee, in order. */
  ambiguousWindows: AmbiguousWindow[];
}

/** Windows shorter than this are merged, longer ones split, in the decision. */
const WINDOW_SECONDS = 0.3;
const STEP_SECONDS = 0.1;
/** A window is "voiced" when the mean voice energy is at least this. */
const VOICE_THRESHOLD = 0.18;
/**
 * Voice level below which motion does NOT count as "while talking" for the
 * voice-gated motion cue (speech sits well above this after normalisation).
 */
const VOICE_GATE = 0.15;
/**
 * A challenger must beat the current speaker's score by this factor to take
 * over (anti-flicker hysteresis).
 */
const SWITCH_MARGIN = 1.1;
/** Once a speaker is chosen, they are kept for at least this long. */
const MIN_HOLD_SECONDS = 0.15;
/**
 * Reactive switch: below this normalised voice-gated motion an incumbent has
 * clearly STOPPED talking...
 */
const REACTIVE_INCUMBENT_CEILING = 0.25;
/**
 * ...and above this a challenger has clearly STARTED talking, so the label
 * flips on the next held window even without the full SWITCH_MARGIN.
 */
const REACTIVE_CHALLENGER_FLOOR = 0.45;
/** Mouth-opening std-dev that counts as "clearly articulating". */
const MOUTH_STD_SPEAKING = 0.05;
/** Face width (fraction of frame width) that counts as "maximally prominent". */
const PROMINENT_FACE_FRACTION = 0.28;
/**
 * Weight of the scene-motion proxy for a person-box sighting (face lost). Half of
 * a measured face motion: a body box moving proves the person moved, but says
 * nothing about their lips, so it must never outweigh a face we can actually see.
 */
const PERSON_HOLD_MOTION_WEIGHT = 0.5;
/**
 * The top two cheap scores are "close" when they are within this ratio - the
 * region where prominence/continuity quirks, not evidence, decide the winner.
 */
const AMBIGUOUS_SCORE_RATIO = 1.18;
/**
 * ...or when the audio+visual cues disagree: the leader is much bigger/more
 * continuous but the challenger has clearly MORE voice-gated motion.
 */
const DISAGREE_MOTION_GAP = 0.2;
/**
 * Default weight of the LR-ASD verdict in an ambiguous window's score. It is a
 * tie-breaker, not a replacement: the cheap cues keep 3/4 of the decision, so a
 * model that is wrong on an unusual framing cannot flip a clear case.
 */
const DEFAULT_REFEREE_WEIGHT = 0.25;

interface Candidate {
  trackId: number;
  score: number;
  motion: number;
  /** Voice-gated motion, normalised 0..1 across the candidates of this window. */
  vm: number;
  /** Absolute voice-gated motion before candidate normalisation. */
  rawVm: number;
  prominence: number;
  corr: number;
  mouth: number;
}

/**
 * Std-dev of a track's mouthOpen within a sample range, or null when the track
 * has no landmark cue (caller falls back to the motion/audio cues only).
 */
function mouthStd(track: Track, i0: number, i1: number, fps: number): number | null {
  const t0 = i0 / fps;
  const t1 = (i1 + 1) / fps;
  const values: number[] = [];
  for (const p of track.points) {
    if (p.t >= t0 && p.t <= t1 && p.mouthOpen !== null) values.push(p.mouthOpen);
  }
  if (values.length < 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Motion evidence for one point: the measured (background-relative) face motion,
 * or - for a sighting that came from a person box while the face was lost - a
 * damped share of the scene's own motion. Null when there is neither, so the
 * point contributes nothing at all (exactly as before).
 */
function motionEvidence(
  point: TrackPoint,
  fps: number,
  sceneMotion?: number[],
): number | null {
  const measured = effectiveFaceMotion(point);
  if (measured !== null) return measured;
  if (!point.personHold) return null;
  if (!sceneMotion || sceneMotion.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sceneMotion.length - 1, Math.round(point.t * fps)),
  );
  const value = sceneMotion[index];
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value) * PERSON_HOLD_MOTION_WEIGHT;
}

function meanFaceWidth(track: Track, i0: number, i1: number, fps: number): number | null {
  const t0 = i0 / fps;
  const t1 = (i1 + 1) / fps;
  let sum = 0;
  let n = 0;
  for (const p of track.points) {
    if (p.t >= t0 && p.t <= t1) {
      sum += p.w;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Voice-GATED motion of a track within a sample range: the sum of motion
 * weighted by how loud the voice is at that instant (below `VOICE_GATE` it
 * contributes 0). This is the cue that actually separates speakers: it is high
 * when a face articulates in step with the shared audio, and stays near zero
 * for a silent face no matter how big it is. Sum-of-products on purpose -
 * robust where Pearson correlation on 3-7 samples is not.
 */
function voicedMotion(
  track: Track,
  i0: number,
  i1: number,
  fps: number,
  voice: number[],
  sceneMotion?: number[],
): number {
  const t0 = i0 / fps;
  const t1 = (i1 + 1) / fps;
  let sum = 0;
  for (const p of track.points) {
    // Background-relative motion: rigid content (a poster, a photo on the wall)
    // that only moved because the CAMERA moved contributes nothing here. A
    // person-box sighting falls back to audio + scene motion.
    const motion = motionEvidence(p, fps, sceneMotion);
    if (p.t < t0 || p.t > t1 || motion === null) continue;
    const frameIdx = Math.max(0, Math.min(voice.length - 1, Math.round(p.t * fps)));
    const v = voice[frameIdx] ?? 0;
    if (v > VOICE_GATE) sum += (v - VOICE_GATE) * motion;
  }
  return sum;
}

/**
 * Mean full-face motion of a track within a sample range, plus its Pearson
 * correlation with the voice envelope over the SAME frames (pairs where motion
 * is null are dropped). Returns { mean, corr } with corr clamped to >= 0.
 */
function motionCues(
  track: Track,
  i0: number,
  i1: number,
  fps: number,
  voice: number[],
  sceneMotion?: number[],
): { mean: number; corr: number } {
  const t0 = i0 / fps;
  const t1 = (i1 + 1) / fps;
  const motions: number[] = [];
  const voiceAt: number[] = [];
  for (const p of track.points) {
    const motion = motionEvidence(p, fps, sceneMotion);
    if (p.t < t0 || p.t > t1 || motion === null) continue;
    motions.push(motion);
    const frameIdx = Math.max(0, Math.min(voice.length - 1, Math.round(p.t * fps)));
    voiceAt.push(voice[frameIdx] ?? 0);
  }
  if (motions.length === 0) return { mean: 0, corr: 0 };
  const mean = motions.reduce((a, b) => a + b, 0) / motions.length;

  if (motions.length < 3) return { mean, corr: 0 };
  const mMean = mean;
  const vMean = voiceAt.reduce((a, b) => a + b, 0) / voiceAt.length;
  let cov = 0;
  let mVar = 0;
  let vVar = 0;
  for (let i = 0; i < motions.length; i += 1) {
    const dm = motions[i] - mMean;
    const dv = voiceAt[i] - vMean;
    cov += dm * dv;
    mVar += dm * dm;
    vVar += dv * dv;
  }
  if (mVar <= 1e-9 || vVar <= 1e-9) return { mean, corr: 0 };
  return { mean, corr: Math.max(0, cov / Math.sqrt(mVar * vVar)) };
}

export function buildSpeakerTimeline(input: SpeakerTimelineInput): SpeakerTimelineResult {
  const { duration, fps, voice, tracks, frameWidth, sceneMotion } = input;
  const cuts = [...(input.shotCuts ?? [])]
    .filter((cut) => Number.isFinite(cut) && cut > 1e-6 && cut < duration - 1e-6)
    .sort((a, b) => a - b);
  const visibleTracks = tracks.filter((track) => track.points.length > 0);

  const frameCount = voice.length;
  const segments: SpeakerSegment[] = [];
  // Holder object: `current` is reassigned inside the `push` closure, and
  // TypeScript's flow analysis would otherwise narrow the outer `current` to
  // its initial `null` forever.
  const state: { current: SpeakerSegment | null } = { current: null };

  const push = (t0: number, t1: number, trackId: number | null) => {
    const cur = state.current;
    if (cur && cur.trackId === trackId && Math.abs(cur.t1 - t0) < 1e-6) {
      cur.t1 = t1; // merge with the previous run
    } else {
      state.current = { t0, t1, trackId };
      segments.push(state.current);
    }
  };

  const ambiguousWindows: AmbiguousWindow[] = [];

  if (visibleTracks.length === 0) {
    return {
      segments: duration > 0 ? [{ t0: 0, t1: duration, trackId: null }] : [],
      speakerCount: 0,
      ambiguousWindows,
    };
  }

  for (let i0 = 0; i0 < frameCount; i0 += Math.max(1, Math.round(STEP_SECONDS * fps))) {
    const i1 = Math.min(frameCount, i0 + Math.max(1, Math.round(WINDOW_SECONDS * fps)));
    const t0 = i0 / fps;
    const t1 = Math.min(duration, i1 / fps);
    // Decision cadence: each window OWNS the following STEP interval, so the
    // pushed runs tile the timeline exactly and merge into clean segments
    // (overlapping window spans would break both the merge and the hold timer).
    const nextT = Math.min(duration, (i0 + Math.max(1, Math.round(STEP_SECONDS * fps))) / fps);
    if (t1 <= t0 || nextT <= t0) break;

    // 1) Audio gate: is anyone talking in this window?
    let voiceSum = 0;
    for (let i = i0; i < i1; i += 1) voiceSum += voice[i] ?? 0;
    const voiced = voiceSum / Math.max(1, i1 - i0) >= VOICE_THRESHOLD;

    // 2) Multi-cue candidates: everyone on screen during (or just before/after)
    //    the window.
    const raw: Array<{ track: Track; vm: number; corr: number; mean: number; prominence: number; mouth: number }> = [];
    let maxMotion = 1e-6;
    let maxVm = 1e-9;
    for (const track of visibleTracks) {
      const width = meanFaceWidth(track, i0 - fps, i1 + fps, fps);
      if (width === null) continue;
      const prominence = Math.max(0, Math.min(1, width / (frameWidth * PROMINENT_FACE_FRACTION)));
      const mouthRaw = mouthStd(track, i0 - fps, i1 + fps, fps);
      const mouth = mouthRaw === null ? 0 : Math.max(0, Math.min(1, mouthRaw / MOUTH_STD_SPEAKING));
      const { mean, corr } = motionCues(track, i0 - fps, i1 + fps, fps, voice, sceneMotion);
      const vm = voicedMotion(track, i0 - fps, i1 + fps, fps, voice, sceneMotion);
      maxMotion = Math.max(maxMotion, mean);
      maxVm = Math.max(maxVm, vm);
      raw.push({ track, vm, corr, mean, prominence, mouth });
    }

    const candidates: Candidate[] = raw.map(({ track, vm, corr, mean, prominence, mouth }) => {
      const energy = Math.max(0, Math.min(1, mean / maxMotion));
      const vmNorm = maxVm > 1e-9 ? vm / maxVm : 0;
      const continuity = state.current && state.current.trackId === track.id ? 1 : 0;
      // Voiced: the voice-gated motion dominates - it is the only cue that
      // says "this face moved because the audio is loud". Unvoiced / no-audio:
      // nobody is talking, so size + continuity + plain motion carry the
      // decision (the covered-mic / masked / hand-covered-face case).
      const score = voiced
        ? 0.4 * vmNorm + 0.15 * corr + 0.15 * energy + 0.1 * prominence + 0.15 * continuity + 0.05 * mouth
        : 0.3 * continuity + 0.3 * prominence + 0.2 * energy + 0.15 * vmNorm + 0.05 * corr;
      return { trackId: track.id, score, motion: energy, vm: vmNorm, rawVm: vm, prominence, corr, mouth };
    });

    if (candidates.length === 0) {
      // Nobody on screen at all: no label can be justified. The camera holds the
      // last valid framing for its grace period and then falls back on its own.
      push(t0, nextT, null);
      continue;
    }

    const qualifiedCandidates = candidates.filter((candidate) =>
      voiced
        ? candidate.rawVm >= 0.08 || candidate.mouth >= 0.35
        : candidate.motion >= 0.08 || candidate.mouth >= 0.35,
    );
    if (qualifiedCandidates.length === 0) {
      // Do not promote the least-weak background portrait simply because it
      // ranked first. Hold the incumbent ONLY while they are still visible - a
      // label for a face that is no longer in this shot is what makes the camera
      // keep an outdated position; otherwise the speaker is unknown.
      const incumbentVisible =
        state.current !== null &&
        qualifiedCandidates.some((candidate) => candidate.trackId === state.current!.trackId);
      push(t0, nextT, incumbentVisible ? state.current!.trackId : null);
      continue;
    }

    qualifiedCandidates.sort((a, b) => b.score - a.score);
    const best = qualifiedCandidates[0];
    let prev = state.current
      ? qualifiedCandidates.find((c) => c.trackId === state.current!.trackId)
      : undefined;

    // 3) AMBIGUOUS WINDOWS. Two people qualify and the cheap cues cannot tell
    //    them apart: the scores are within a few percent, or the leader wins on
    //    size/continuity while the challenger clearly has more voice-gated
    //    motion. That is exactly where an audio-visual model helps, so the
    //    caller-supplied referee gets asked - and only there.
    const runnerUp = qualifiedCandidates[1];
    if (input.referee && runnerUp) {
      const ratio = best.score / Math.max(1e-6, runnerUp.score);
      const topTwo = qualifiedCandidates.slice(0, 2);
      const disagreement =
        best.vm + DISAGREE_MOTION_GAP < runnerUp.vm && best.prominence > runnerUp.prominence;
      if (ratio <= AMBIGUOUS_SCORE_RATIO || disagreement) {
        const window: AmbiguousWindow = {
          t0,
          t1,
          trackIds: topTwo.map((candidate) => candidate.trackId),
          reason: ratio <= AMBIGUOUS_SCORE_RATIO ? 'top-two-close' : 'cues-disagree',
        };
        let verdict: Map<number, number> | null = null;
        try {
          verdict = input.referee.judge(window) ?? null;
        } catch {
          verdict = null; // a broken referee must never break the timeline
        }
        if (verdict && verdict.size > 0) {
          ambiguousWindows.push(window);
          const weight = Math.max(0, Math.min(0.5, input.referee.weight ?? DEFAULT_REFEREE_WEIGHT));
          const fused = topTwo.map((candidate) => {
            const likelihood = verdict!.get(candidate.trackId);
            return {
              ...candidate,
              score:
                likelihood === undefined || !Number.isFinite(likelihood)
                  ? candidate.score
                  : (1 - weight) * candidate.score + weight * likelihood,
            };
          });
          // Re-rank only within the contended pair: everybody else was already
          // behind both of them on the cheap cues.
          const order = fused[0].score >= fused[1].score ? fused : [fused[1], fused[0]];
          qualifiedCandidates.splice(0, 2, ...order);
        }
      }
    }

    const decided = qualifiedCandidates[0];
    prev = state.current
      ? qualifiedCandidates.find((c) => c.trackId === state.current!.trackId)
      : undefined;

    let chosen = decided;
    if (prev && prev.trackId !== decided.trackId) {
      const heldEnough = t0 - (state.current?.t0 ?? 0) >= MIN_HOLD_SECONDS;
      const beatsByMargin = decided.score >= prev.score * SWITCH_MARGIN;
      // Reactive turn-change: the incumbent clearly stopped talking and the
      // challenger clearly started - flip without waiting for the margin
      // (prominence + continuity bias the raw scores toward the incumbent).
      const reactive =
        voiced && prev.vm < REACTIVE_INCUMBENT_CEILING && decided.vm >= REACTIVE_CHALLENGER_FLOOR;
      if (!heldEnough || (!beatsByMargin && !reactive)) {
        chosen = prev; // hysteresis: the current speaker keeps the label
      }
    }

    push(t0, nextT, chosen.trackId);
  }

  // Make sure the timeline always spans the whole clip.
  if (segments.length > 0) {
    segments[0].t0 = 0;
    segments[segments.length - 1].t1 = duration;
  } else {
    segments.push({ t0: 0, t1: duration, trackId: null });
  }

  // Never carry a speaker label across a SOURCE SHOT CUT. The window that spans a
  // cut belongs to the shot it starts in; the next shot decides its own speaker
  // from its own, freshly-detected faces. This is what stops the camera (and the
  // speaker overlay) from holding an old angle's decision into a new angle.
  const clipped = cuts.length === 0 ? segments : splitSegmentsAtCuts(segments, cuts);

  const speakerIds = new Set(clipped.map((s) => s.trackId).filter((id): id is number => id !== null));
  return { segments: clipped, speakerCount: speakerIds.size, ambiguousWindows };
}

/** Split speaker runs on every cut, keeping the same label either side. */
function splitSegmentsAtCuts(
  segments: SpeakerSegment[],
  cuts: number[],
): SpeakerSegment[] {
  const output: SpeakerSegment[] = [];
  for (const segment of segments) {
    let from = segment.t0;
    for (const cut of cuts) {
      if (cut <= from + 1e-6) continue;
      if (cut >= segment.t1 - 1e-6) break;
      output.push({ t0: from, t1: cut, trackId: segment.trackId });
      from = cut;
    }
    if (segment.t1 - from > 1e-6) output.push({ t0: from, t1: segment.t1, trackId: segment.trackId });
  }
  return output;
}

/** Convenience: active speaker at an arbitrary clip-relative time. */
export function speakerAtTime(segments: SpeakerSegment[], t: number): number | null {
  for (const seg of segments) {
    if (t >= seg.t0 && t < seg.t1) return seg.trackId;
  }
  return segments.length > 0 ? segments[segments.length - 1].trackId : null;
}
