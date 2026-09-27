/**
 * Speaker decision: fuse the visual cues (per-track mouth movement, face
 * prominence) with the audio voice envelope into a per-time "who is speaking"
 * timeline.
 *
 * Why this design (and not lip/mouth-only detection):
 *   - A microphone, hand, beard or side profile can hide the mouth. The AUDIO
 *     envelope still says "someone is talking" during those frames, and the
 *     TRACKER keeps the person's position, so the frame never jumps off them.
 *   - A listener nodding or leaning in moves their face but NOT their mouth.
 *     Mouth-OPENING variance (not position motion) is the visual discriminator,
 *     and it is only trusted inside voiced windows.
 *   - Hysteresis + a minimum hold stop two people's scores from trading the
 *     label every few frames (the classic ASD flicker).
 *
 * Pure logic - fully unit-testable with synthetic tracks + envelopes.
 */

import { Track } from './tracker';

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
  /** All tracked people (points carry per-frame mouthOpen when available). */
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
const WINDOW_SECONDS = 1.0;
const STEP_SECONDS = 0.5;
/** A window is "voiced" when the mean voice energy is at least this. */
const VOICE_THRESHOLD = 0.18;
/**
 * A challenger must beat the current speaker's score by this factor to take
 * over (anti-flicker hysteresis).
 */
const SWITCH_MARGIN = 1.3;
/** Once a speaker is chosen, they are kept for at least this long. */
const MIN_HOLD_SECONDS = 0.8;
/** Mouth-opening std-dev that counts as "clearly articulating". */
const MOUTH_STD_SPEAKING = 0.05;
/** Face width (fraction of frame width) that counts as "maximally prominent". */
const PROMINENT_FACE_FRACTION = 0.28;

interface Candidate {
  trackId: number;
  score: number;
  motion: number;
  prominence: number;
}

/**
 * Std-dev of a track's mouthOpen within a sample range, or null when the track
 * has no landmark cue (caller falls back to prominence-only scoring).
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

  for (let i0 = 0; i0 < frameCount; i0 += Math.round(STEP_SECONDS * fps)) {
    const i1 = Math.min(frameCount, i0 + Math.round(WINDOW_SECONDS * fps));
    const t0 = i0 / fps;
    const t1 = Math.min(duration, i1 / fps);
    if (t1 <= t0) break;

    // 1) Audio gate: is anyone talking in this window?
    let voiceSum = 0;
    for (let i = i0; i < i1; i += 1) voiceSum += voice[i] ?? 0;
    const voiced = voiceSum / Math.max(1, i1 - i0) >= VOICE_THRESHOLD;

    // 2) Visual candidates: everyone on screen during (or just before/after)
    //    the window.
    const candidates: Candidate[] = [];
    for (const track of visibleTracks) {
      const width = meanFaceWidth(track, i0 - fps, i1 + fps, fps);
      if (width === null) continue;
      const prominence = Math.max(0, Math.min(1, width / (frameWidth * PROMINENT_FACE_FRACTION)));
      const std = mouthStd(track, i0 - fps, i1 + fps, fps);
      const motion = std === null ? 0.5 : Math.max(0, Math.min(1, std / MOUTH_STD_SPEAKING));
      const score = voiced ? 0.7 * motion + 0.3 * prominence : 0.4 * prominence + 0.1 * motion;
      candidates.push({ trackId: track.id, score, motion, prominence });
    }

    if (candidates.length === 0) {
      // Nobody on screen: hold the last speaker (speaker-focus keeps framing
      // them) or stay null.
      push(t0, t1, state.current ? state.current.trackId : null);
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

    push(t0, t1, chosen.trackId);
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
