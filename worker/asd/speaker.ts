import { Track } from './tracker';

/**
 * Active-speaker decision: fuses several INDEPENDENT cues with the audio voice
 * envelope into a per-time "who is speaking" timeline. This is the layer that
 * decides WHO the 9:16 frame follows; `./tracker` only keeps stable person ids.
 *
 * Cues (multi-method on purpose - a handheld mic, mask or hand can cover the
 * mouth and kill any single visual cue):
 *   - audio↔motion correlation: whoever is talking moves when the voice
 *     envelope rises (mouth, jaw, cheek, whole-face motion - region-agnostic);
 *   - motion energy of the face region vs the other faces;
 *   - mouth-opening variance (only when a landmark cue exists - YuNet has no
 *     mouth landmarks, so this simply contributes 0 there);
 *   - prominence (face size) and continuity (incumbent keeps the frame).
 *
 * When mouths are covered the correlation and mouth terms flatten toward 0 and
 * the worst-case cues (continuity, prominence, full-face motion) decide - which
 * is exactly the desired behaviour. When audio is missing/unvoiced the weights
 * shift to the visual-only mix.
 *
 * Hysteresis + a minimum hold stop two people's scores from trading the label
 * back and forth on borderline windows.
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
  /** Sampling fps of `voice` and of the track points. */
  fps: number;
  /** Per-sample-frame voice energy 0..1 (length ≈ duration*fps). */
  voice: number[];
  /** All tracked people (points carry per-frame motion and optional mouthOpen). */
  tracks: Track[];
  /** Source frame width (for normalising face size). */
  frameWidth: number;
}

export interface SpeakerTimelineResult {
  /** Merged runs of (time, active speaker). */
  segments: SpeakerSegment[];
  /** How many distinct people ever became the active speaker. */
  speakerCount: number;
}

/** Windows shorter than this are merged, longer ones split, in the decision. */
const WINDOW_SECONDS = 0.6;
const STEP_SECONDS = 0.25;
/** A window is "voiced" when the mean voice energy is at least this. */
const VOICE_THRESHOLD = 0.18;
/**
 * A challenger must beat the current speaker's score by this factor to take
 * over (anti-flicker hysteresis).
 */
const SWITCH_MARGIN = 1.15;
/** Once a speaker is chosen, they are kept for at least this long. */
const MIN_HOLD_SECONDS = 0.4;
/** Mouth-opening std-dev that counts as "clearly articulating". */
const MOUTH_STD_SPEAKING = 0.05;
/** Face width (fraction of frame width) that counts as "maximally prominent". */
const PROMINENT_FACE_FRACTION = 0.28;

interface Candidate {
  trackId: number;
  score: number;
  motion: number;
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
 * Mean full-face motion of a track within a sample range, plus its Pearson
 * correlation with the voice envelope over the SAME frames (pairs where motion
 * is null are dropped). Returns { mean, corr } with corr clamped to >= 0.
 */
function motionCues(
  track: Track,
  i0: number,
  i1: number,
  fps: number,
  voice: number[]
): { mean: number; corr: number } {
  const t0 = i0 / fps;
  const t1 = (i1 + 1) / fps;
  const motions: number[] = [];
  const voiceAt: number[] = [];
  for (const p of track.points) {
    if (p.t < t0 || p.t > t1 || p.motion === null) continue;
    motions.push(p.motion);
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
  const { duration, fps, voice, tracks, frameWidth } = input;
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

  if (visibleTracks.length === 0) {
    return { segments: duration > 0 ? [{ t0: 0, t1: duration, trackId: null }] : [], speakerCount: 0 };
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
    const raw: Array<{ track: Track; corr: number; mean: number; prominence: number; mouth: number }> = [];
    let maxMotion = 1e-6;
    for (const track of visibleTracks) {
      const width = meanFaceWidth(track, i0 - fps, i1 + fps, fps);
      if (width === null) continue;
      const prominence = Math.max(0, Math.min(1, width / (frameWidth * PROMINENT_FACE_FRACTION)));
      const mouthRaw = mouthStd(track, i0 - fps, i1 + fps, fps);
      const mouth = mouthRaw === null ? 0 : Math.max(0, Math.min(1, mouthRaw / MOUTH_STD_SPEAKING));
      const { mean, corr } = motionCues(track, i0 - fps, i1 + fps, fps, voice);
      maxMotion = Math.max(maxMotion, mean);
      raw.push({ track, corr, mean, prominence, mouth });
    }

    const candidates: Candidate[] = raw.map(({ track, corr, mean, prominence, mouth }) => {
      const energy = Math.max(0, Math.min(1, mean / maxMotion));
      const continuity = state.current && state.current.trackId === track.id ? 1 : 0;
      // Voiced: the talking face moves WITH the audio. Unvoiced / no-audio: the
      // correlation is meaningless, so size + continuity + plain motion carry it
      // (the covered-mic / masked / hand-covered-face case).
      const score = voiced
        ? 0.4 * corr + 0.25 * energy + 0.1 * mouth + 0.15 * prominence + 0.1 * continuity
        : 0.45 * prominence + 0.25 * energy + 0.1 * mouth + 0.2 * continuity;
      return { trackId: track.id, score, motion: energy, prominence, corr, mouth };
    });

    if (candidates.length === 0) {
      // Nobody on screen: hold the last speaker (speaker-focus keeps framing
      // them) or stay null.
      push(t0, nextT, state.current ? state.current.trackId : null);
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const prev = state.current
      ? candidates.find((c) => c.trackId === state.current!.trackId)
      : undefined;

    let chosen = best;
    if (prev && prev.trackId !== best.trackId) {
      const heldEnough = t0 - (state.current?.t0 ?? 0) >= MIN_HOLD_SECONDS;
      const beatsByMargin = best.score >= prev.score * SWITCH_MARGIN;
      if (!heldEnough || !beatsByMargin) {
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

  const speakerIds = new Set(segments.map((s) => s.trackId).filter((id): id is number => id !== null));
  return { segments, speakerCount: speakerIds.size };
}

/** Convenience: active speaker at an arbitrary clip-relative time. */
export function speakerAtTime(segments: SpeakerSegment[], t: number): number | null {
  for (const seg of segments) {
    if (t >= seg.t0 && t < seg.t1) return seg.trackId;
  }
  return segments.length > 0 ? segments[segments.length - 1].trackId : null;
}
