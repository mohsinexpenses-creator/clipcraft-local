/**
 * Speaker-focus CAMERA PLANNER (`CAMERA_MODE=locked`, the default).
 *
 * The old speaker path (`CAMERA_MODE=legacy`, kept as a rollback) chased the raw
 * face track: an 8 px dead zone per sample, the WHOLE track decimated to 24
 * keyframes before it was sliced into speaker segments (so keyframes were
 * seconds apart and FFmpeg's smoothstep turned them into 5-14 s pans), a point at
 * every segment's MEDIAN at the segment end (the window crept toward the average
 * face position while the speaker stood still), and interpolation right across
 * source shot cuts. A real render logged 31 keyframes, glides of 13.6 s / 8.75 s
 * / 1.9 s, and a hook window that moved about once a second.
 *
 * This planner is EVENT-based instead - a handful of keyframes per minute:
 *
 *   1. LOCK    - one anchor per speaker run (and per source SHOT): the median of
 *                the first <= `settleSeconds` of face detections after the run /
 *                shot start.
 *   2. HOLD    - the window does not move at all while the face CENTRE stays
 *                inside a `deadZoneXPct` x `deadZoneYPct` box in the middle of the
 *                crop (10% x 8% by default). No per-sample following.
 *   3. RE-CENTRE - only after the centre has been outside for `confirmSeconds`
 *                (0.4 s): ONE eased `recentreSeconds` (0.35 s) glide to the median
 *                of the last `recentreLookbackSeconds` (0.5 s) of detections. No
 *                look-ahead, no distance-dependent duration, and no point at the
 *                run's end - the last locked position is kept.
 *   4. SWITCH  - a speaker change glides in `speakerGlideSeconds` (0.1 s), or is
 *                instant when `switchMode === 'cut'`.
 *   5. CUTS    - source shot cuts are hard switches on the cut's exact frame,
 *                anchored on the face visible AFTER the cut. Nothing interpolates
 *                across a cut. If the new shot has no detection yet, the cut still
 *                moves to a supported position (a visible face, else the clamped
 *                default) and the run re-anchors on the subject when they appear -
 *                the window never keeps the previous angle's framing.
 *   6. OPENING - the first frame is framed on a validated position: the subject
 *                when visible in frame one, else a visible face, else the default.
 *                Never on an anchor for a face that is only there later.
 *   7. LOST    - a disappeared face holds for `faceLostHoldSeconds` (1.5 s), then
 *                ONE deterministic move to the biggest face on screen (or the
 *                default), then re-locks on the subject's return. A gap under
 *                `gapToleranceSeconds` (0.6 s) is one missed sample: no move.
 *   8. CUTAWAYS (opt-in, `SPEAKER_CUTAWAYS=on`) - hold the speaker
 *                `speakerHoldSeconds` (6 s), then show a listener for
 *                `cutawaySeconds` (2 s). A listener is only used when it is live
 *                and comparably sized, is detected on screen in >= 80% of the
 *                cutaway, is co-visible with the speaker in the same shot, and
 *                can be centred; otherwise the cutaway is skipped and the reason
 *                is logged.
 *
 * The result is a `CameraPath` (start position + a few eased glides + hard cut
 * switches) ready for `cameraExpressions`, plus the full plan for the
 * `[CAMERA-PLAN]` log, `[CAMERA-QA]` measurement and the unit tests.
 *
 * Pure logic: no I/O, no FFmpeg. Every threshold is a parameter with the
 * documented default.
 */
import { Track } from './asd/tracker';
import {
  CameraCut,
  CameraHole,
  CameraMove,
  CameraPath,
  CameraSample,
  FACE_DEADZONE_HYSTERESIS,
  buildLockedCamera,
  faceBoxInsideWindow,
  filterSamples,
  HEAD_SAFETY_MARGIN,
  headExtent,
  headInsideSafeZone,
  smoothstep,
  windowFor,
  windowForHead,
} from './camera-lock';

/** `locked` = this planner (default). `legacy` = the previous continuous follow. */
export type CameraMode = 'locked' | 'legacy';
/** How a speaker change (or a cutaway return) moves the window. */
export type CameraSwitchMode = 'glide' | 'cut';
/** Who a listener cutaway shows. */
export type CutawayPickMode = 'random' | 'prominent';

export interface CameraPlanOptions {
  /** Source size in (mirrored) pixels. */
  srcW: number;
  srcH: number;
  /** 9:16 crop window. */
  cropW: number;
  cropH: number;
  /** Where the face centre sits vertically inside the window (0..1). */
  anchorY: number;
  /** Source shot cuts, clip-relative seconds (the first frame after the cut). */
  cuts?: number[];
  /** Seconds of detections the initial anchor is taken from. Default 1. */
  settleSeconds?: number;
  /** Dead zone, fraction of the crop WIDTH. Default 0.10. */
  deadZoneXPct?: number;
  /** Dead zone, fraction of the crop HEIGHT. Default 0.08. */
  deadZoneYPct?: number;
  /** How long the face centre must stay outside the dead zone. Default 0.4 s. */
  confirmSeconds?: number;
  /** Length of one re-centre glide. Default 0.35 s. */
  recentreSeconds?: number;
  /** Detections the re-centre target is taken from. Default 0.5 s. */
  recentreLookbackSeconds?: number;
  /** Speaker-change glide length. Default 0.55 s. */
  speakerGlideSeconds?: number;
  /**
   * Glide length for a CONFIRMED conversational turn (the speaker timeline just
   * changed and the camera has to follow it). Default 0.35 s: quicker than a
   * neutral move because the conversation is moving, but never the 0.1 s snap
   * that read as a jump.
   */
  turnGlideSeconds?: number;
  /**
   * Ignore a target that is closer than this fraction of the crop to where the
   * window already is (resolution-aware, so it means the same on 720p and 4K).
   * Default 0.035 (3.5 % of the crop): the difference such a move makes is
   * invisible, and every one of them costs a camera event.
   */
  minMovePct?: number;
  /** `glide` (default) or `cut` (instant). */
  switchMode?: CameraSwitchMode;
  /**
   * Listener cutaways. Off by default; `on` restores the old 6 s speaker hold +
   * 2 s listener cadence.
   */
  cutaways?: boolean;
  /** Seconds of speaker before each cutaway. Default 6. */
  speakerHoldSeconds?: number;
  /** Cutaway length. Default 2. */
  cutawaySeconds?: number;
  /** `random` (default) or `prominent`. */
  cutawayPick?: CutawayPickMode;
  /** Deterministic seed for `cutawayPick: 'random'` (tests pass a fixed one). */
  cutawaySeed?: number;
  /** A listener must be at least this fraction of the speaker's face width. Default 0.45. */
  cutawayMinSizeRatio?: number;
  /** A listener must be detected in at least this share of the cutaway. Default 0.8. */
  cutawayMinCoverage?: number;
  /** Hard safety cap on planned moves. Default 400. */
  maxMoves?: number;
  /**
   * How long the previous framing stays valid when the followed face stops being
   * detected (a blink, a mic across the mouth, one missed sample). After this the
   * window falls back deterministically instead of holding a stale crop. Default
   * 1.5 s. `0` disables the fallback entirely (always hold).
   */
  faceLostHoldSeconds?: number;
  /**
   * How long a silence between two detections is still "the same continuous
   * presence". Should be a little above the detector's sampling interval so one
   * missed sample is absorbed; the default 0.6 s covers a 4 fps sample (0.25 s)
   * and its double, while a real absence is still detected. Default 0.6 s.
   */
  gapToleranceSeconds?: number;
  /**
   * Length of the clip (clip-relative seconds). Needed to know that the camera is
   * still holding a framing AFTER the last run ends, which is where a disappeared
   * speaker used to leave a stale crop. Defaults to the last run's end.
   */
  durationSeconds?: number;
  /**
   * How long the SAME framing may be held when a face was lost but a PERSON box
   * kept the identity alive (they turned away / looked down / covered their face).
   *
   * This is deliberately much longer than `faceLostHoldSeconds`: the person is
   * demonstrably still sitting in that spot - the camera simply has no face to
   * re-centre on, and moving away from them is exactly the reported failure.
   * The timeline has no body-box points, so the hold can never drag the window to
   * a new position; it only stops the "lost face" fallback from firing. Default
   * 0 = off (today's behaviour).
   */
  personHoldSeconds?: number;
}

export const CAMERA_PLAN_DEFAULTS = {
  settleSeconds: 1,
  deadZoneXPct: 0.1,
  deadZoneYPct: 0.08,
  confirmSeconds: 0.4,
  recentreSeconds: 0.35,
  recentreLookbackSeconds: 0.5,
  speakerGlideSeconds: 0.55,
  turnGlideSeconds: 0.35,
  minMovePct: 0.035,
  switchMode: 'glide' as CameraSwitchMode,
  cutaways: false,
  speakerHoldSeconds: 6,
  cutawaySeconds: 2,
  cutawayPick: 'random' as CutawayPickMode,
  cutawayMinSizeRatio: 0.45,
  cutawayMinCoverage: 0.8,
  maxMoves: 400,
  faceLostHoldSeconds: 1.5,
  gapToleranceSeconds: 0.6,
  personHoldSeconds: 0,
};

/**
 * Detection tolerance used only when deciding WHO a timeline span belongs to. It
 * follows the detector's cadence closely; a real absence still exceeds it.
 */
const GAP_TOLERANCE_FOR_FALLBACKS = 0.4;

/** A speaker glide grows this fraction of the travel distance... */
const SPEAKER_GLIDE_DISTANCE_FACTOR = 1 / 1200;
/** ...up to this much extra time (a long travel gets 0.15 s more, no more). */
const MAX_GLIDE_GROWTH = 0.15;

/** A speaker run after clipping to shots and merging continuations. */
export interface SpeakerLockRun {
  trackId: number;
  /** Inclusive start, exclusive end (clip-relative seconds). */
  t0: number;
  t1: number;
  /** Index of the source shot this run plays in. */
  shot: number;
  /** True when a source shot cut starts this run. */
  startsAtCut: boolean;
  /** The single anchor of this run: window top-left (clamped inside the frame). */
  anchor: { x: number; y: number };
  /** The median face centre the anchor was taken from. */
  face: { cx: number; cy: number };
  /** Detections used for the anchor. */
  settleSamples: number;
  /**
   * When this run's subject was FIRST detected inside the run. > `t0` means the
   * speaker timeline opened before the face was visible (a lead-in), so the
   * opening framing needs a visibility-aware decision instead of a guess.
   */
  firstDetectionAt: number;
}

/** One segment of the planned timeline: a lock on the speaker, or a listener cutaway. */
export interface CameraSegment {
  kind: 'lock' | 'cutaway';
  trackId: number;
  /** When this shot becomes the one the window should show. */
  start: number;
  /** When the window has finished moving there (== `start` for a hard switch). */
  arrive: number;
  /** When the next segment takes over (clip end for the last one). */
  until: number;
  /** Window top-left while this segment is active. */
  pos: { x: number; y: number };
  /** How the window got here. */
  entry: 'start' | 'glide' | 'cut';
  /** The speaker a cutaway works around. */
  speakerId?: number;
}

export interface CameraPlan {
  mode: CameraMode;
  /** Ready for `cameraExpressions` (empty path = static crop). */
  path: CameraPath;
  runs: SpeakerLockRun[];
  segments: CameraSegment[];
  /** Eased re-centres inside a lock (t = when the glide starts). */
  recentres: Array<{ t: number; duration: number; to: { x: number; y: number } }>;
  /** Speaker changes (t, who, how, and the target it moved to). */
  switches: Array<{
    t: number;
    trackId: number;
    mode: 'cut' | 'glide';
    /** Window top-left the camera moved to. */
    to: { x: number; y: number };
    /** How long the move takes (0 for a hard switch). */
    duration: number;
    /** Why: a confirmed turn, a source cut, or entering/exiting a cutaway. */
    reason: 'speaker-change' | 'source-cut' | 'cutaway' | 'reanchor';
  }>;
  cutaways: Array<{ t: number; duration: number; trackId: number; speakerId: number }>;
  /** Cutaways that were considered and rejected, with the reason. */
  skippedCutaways: Array<{ t: number; reason: string }>;
  /** Camera events: every glide plus every hard switch. */
  keyframes: number;
  glides: number;
  cuts: number;
  /** How the clip's FIRST frame was validated (the initial-framing diagnostic). */
  initial: CameraInitialFraming | null;
  /** Spans where the followed face was not detected (clip-relative seconds). */
  holes: CameraHole[];
  /** Source cuts whose new shot needed a fallback jump (no subject detection yet). */
  reanchorCuts: number;
  /** Per-cut detail for the `[CAMERA-FACE]` diagnostic. */
  fallbackCuts: Array<{ t: number; source: 'visible-face' | 'default'; trackId: number }>;
  /** Missing-face fallbacks the plan activated, with what they moved to. */
  fallbackHoles: Array<{ t: number; source: 'visible-face' | 'default'; trackId: number }>;
  options: CameraPlanResolvedOptions;
}

/** Initial-framing validation: where the clip opens and whether a face is there. */
export interface CameraInitialFraming {
  /** The person the opening framing locks onto. */
  trackId: number;
  /** Window top-left of the opening framing. */
  anchor: { x: number; y: number };
  /** When that person was FIRST detected in the clip (0 = visible immediately). */
  firstFaceAt: number;
  /** True when the face is inside the opening window at t = 0. */
  faceVisibleFromStart: boolean;
  /** Seconds of framing held before the first detection (a lead-in). */
  leadSeconds: number;
}

export interface CameraPlanResolvedOptions {
  srcW: number;
  srcH: number;
  cropW: number;
  cropH: number;
  anchorY: number;
  cuts: number[];
  settleSeconds: number;
  deadZoneXPct: number;
  deadZoneYPct: number;
  confirmSeconds: number;
  recentreSeconds: number;
  recentreLookbackSeconds: number;
  speakerGlideSeconds: number;
  turnGlideSeconds: number;
  minMovePct: number;
  switchMode: CameraSwitchMode;
  cutaways: boolean;
  speakerHoldSeconds: number;
  cutawaySeconds: number;
  cutawayPick: CutawayPickMode;
  cutawaySeed: number;
  cutawayMinSizeRatio: number;
  cutawayMinCoverage: number;
  maxMoves: number;
  faceLostHoldSeconds: number;
  gapToleranceSeconds: number;
  durationSeconds: number;
  personHoldSeconds: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function resolveOptions(options: CameraPlanOptions): CameraPlanResolvedOptions {
  return {
    srcW: options.srcW,
    srcH: options.srcH,
    cropW: options.cropW,
    cropH: options.cropH,
    anchorY: options.anchorY,
    cuts: [...(options.cuts ?? [])].sort((a, b) => a - b),
    settleSeconds: options.settleSeconds ?? CAMERA_PLAN_DEFAULTS.settleSeconds,
    deadZoneXPct: options.deadZoneXPct ?? CAMERA_PLAN_DEFAULTS.deadZoneXPct,
    deadZoneYPct: options.deadZoneYPct ?? CAMERA_PLAN_DEFAULTS.deadZoneYPct,
    confirmSeconds: options.confirmSeconds ?? CAMERA_PLAN_DEFAULTS.confirmSeconds,
    recentreSeconds: options.recentreSeconds ?? CAMERA_PLAN_DEFAULTS.recentreSeconds,
    recentreLookbackSeconds:
      options.recentreLookbackSeconds ?? CAMERA_PLAN_DEFAULTS.recentreLookbackSeconds,
    speakerGlideSeconds: options.speakerGlideSeconds ?? CAMERA_PLAN_DEFAULTS.speakerGlideSeconds,
    turnGlideSeconds: Math.max(
      0.1,
      options.turnGlideSeconds ?? CAMERA_PLAN_DEFAULTS.turnGlideSeconds,
    ),
    minMovePct: Math.max(0, options.minMovePct ?? CAMERA_PLAN_DEFAULTS.minMovePct),
    switchMode: options.switchMode ?? CAMERA_PLAN_DEFAULTS.switchMode,
    cutaways: options.cutaways ?? CAMERA_PLAN_DEFAULTS.cutaways,
    speakerHoldSeconds: options.speakerHoldSeconds ?? CAMERA_PLAN_DEFAULTS.speakerHoldSeconds,
    cutawaySeconds: options.cutawaySeconds ?? CAMERA_PLAN_DEFAULTS.cutawaySeconds,
    cutawayPick: options.cutawayPick ?? CAMERA_PLAN_DEFAULTS.cutawayPick,
    cutawaySeed: options.cutawaySeed ?? 1,
    cutawayMinSizeRatio:
      options.cutawayMinSizeRatio ?? CAMERA_PLAN_DEFAULTS.cutawayMinSizeRatio,
    cutawayMinCoverage: options.cutawayMinCoverage ?? CAMERA_PLAN_DEFAULTS.cutawayMinCoverage,
    maxMoves: options.maxMoves ?? CAMERA_PLAN_DEFAULTS.maxMoves,
    faceLostHoldSeconds: Math.max(
      0,
      options.faceLostHoldSeconds ?? CAMERA_PLAN_DEFAULTS.faceLostHoldSeconds,
    ),
    gapToleranceSeconds: Math.max(
      0.05,
      options.gapToleranceSeconds ?? CAMERA_PLAN_DEFAULTS.gapToleranceSeconds,
    ),
    durationSeconds: Math.max(0, options.durationSeconds ?? 0),
    personHoldSeconds: Math.max(
      0,
      options.personHoldSeconds ?? CAMERA_PLAN_DEFAULTS.personHoldSeconds,
    ),
  };
}

function windowShapeOf(opts: Pick<CameraPlanResolvedOptions, 'srcW' | 'srcH' | 'cropW' | 'cropH' | 'anchorY'>) {
  return {
    srcW: opts.srcW,
    srcH: opts.srcH,
    cropW: opts.cropW,
    cropH: opts.cropH,
    anchorX: 0.5,
    anchorY: opts.anchorY,
  };
}

/** That person's detections inside `[t0, t1]`, as median-filtered camera samples. */
function samplesBetween(track: Track, t0: number, t1: number): CameraSample[] {
  return filterSamples(
    track.points
      .filter((point) => point.t >= t0 - 1e-6 && point.t <= t1 + 1e-6)
      .map((point) => ({
        t: point.t,
        cx: point.cx,
        cy: point.cy,
        w: point.w,
        ...(point.h !== undefined ? { h: point.h } : {}),
      }))
  );
}

/** Face width of `track` closest to `t` (or its average). */
function faceWidthAt(track: Track, t: number): number {
  let bestT = Number.POSITIVE_INFINITY;
  let width = track.avgW;
  for (const point of track.points) {
    const distance = Math.abs(point.t - t);
    if (distance < bestT) {
      bestT = distance;
      width = point.w;
    }
  }
  return width;
}

/**
 * Share of the time `[t0, t1]` in which the track was actually on screen, sampled
 * on a 0.1 s grid (a sighting counts for `0.3 s`).
 */
export function onScreenShare(track: Track, t0: number, t1: number, step = 0.1): number {
  if (!(t1 > t0)) return 0;
  let total = 0;
  let seen = 0;
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    total += 1;
    if (track.points.some((point) => Math.abs(point.t - t) <= Math.max(step, 0.3))) seen += 1;
  }
  return total === 0 ? 0 : seen / total;
}

/** Do `a` and `b` both have a sighting at (almost) the same moment in `[t0, t1]`? */
export function coVisible(
  a: Track,
  b: Track,
  t0: number,
  t1: number,
  cuts: number[],
  eps = 0.3
): boolean {
  const inside = (points: Track['points']) => points.filter((p) => p.t >= t0 - 1e-6 && p.t <= t1 + 1e-6);
  const pa = inside(a.points);
  const pb = inside(b.points);
  for (const left of pa) {
    for (const right of pb) {
      if (Math.abs(left.t - right.t) > eps) continue;
      const mid = Math.min(left.t, right.t);
      const end = Math.max(left.t, right.t);
      if (cuts.some((cut) => cut > mid + 1e-6 && cut <= end + 1e-6)) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Speaker runs and shot boundaries
// ---------------------------------------------------------------------------

export interface SpeakerRunInput {
  trackId: number | null;
  t0: number;
  t1: number;
}

/**
 * Turn the speaker timeline into LOCK RUNS: clip each segment at every source shot
 * cut it spans (a new shot means a new anchor) and merge adjacent runs of the same
 * speaker inside one shot, so a one-sample wobble in the speaker timeline cannot
 * add a pointless glide.
 */
export function buildSpeakerRuns(
  segments: SpeakerRunInput[],
  cuts: number[]
): Array<{ trackId: number; t0: number; t1: number; shot: number; startsAtCut: boolean }> {
  const orderedCuts = [...cuts].sort((a, b) => a - b);
  const shotIndexAt = (t: number): number => {
    let index = 0;
    for (const cut of orderedCuts) if (t >= cut - 1e-9) index += 1;
    return index;
  };
  const pieces: Array<{
    trackId: number;
    t0: number;
    t1: number;
    shot: number;
    startsAtCut: boolean;
  }> = [];
  for (const segment of segments) {
    if (segment.trackId === null || !(segment.t1 > segment.t0)) continue;
    const boundaries = [
      segment.t0,
      ...orderedCuts.filter((cut) => cut > segment.t0 + 1e-6 && cut < segment.t1 - 1e-6),
      segment.t1,
    ];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const t0 = boundaries[i];
      const t1 = boundaries[i + 1];
      if (t1 - t0 < 1e-6) continue;
      pieces.push({ trackId: segment.trackId, t0, t1, shot: shotIndexAt(t0), startsAtCut: i > 0 });
    }
  }
  pieces.sort((a, b) => a.t0 - b.t0);
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.trackId === piece.trackId &&
      last.shot === piece.shot &&
      piece.t0 - last.t1 <= 1e-6
    ) {
      last.t1 = piece.t1;
      continue;
    }
    merged.push({ ...piece });
  }
  return merged;
}

/**
 * A speaker run is clipped at every source cut. When the SAME person is detected
 * again right after the cut (the usual "wide shot cuts to a close-up of the person
 * still talking"), the piece starting at the cut has no speaker label of its own
 * until the next timeline decision - and a run that ends exactly on a cut used to
 * leave the new shot with nothing to plan. The camera then either kept the old
 * angle's framing or, worse, fell outside the plan entirely.
 *
 * So: if the run's subject is detected within a sampling interval or two AFTER the
 * cut, the run is extended to that sighting. It stays a new shot (different anchor,
 * hard switch); this only makes sure the new shot HAS a run to plan.
 */
function extendRunsAcrossCuts(
  segments: SpeakerRunInput[],
  tracks: Track[],
  opts: CameraPlanResolvedOptions,
): SpeakerRunInput[] {
  if (opts.cuts.length === 0) return segments;
  const byId = new Map<number, Track>();
  for (const track of tracks) byId.set(track.id, track);
  // A new shot can open on a wide angle before the person is recognisable again,
  // so the horizon is generous - the run still starts at the cut and is anchored on
  // the face that is actually visible on the new angle.
  const horizon = Math.max(opts.gapToleranceSeconds * 4, 2.5);
  return segments.map((segment, index) => {
    // ONLY a real continuation. If the timeline hands the next span to a different
    // (labelled) speaker, that person owns the new shot - extending this run would
    // frame the new angle on the PREVIOUS speaker's position, which is exactly the
    // "crop stays on the old angle" bug.
    const after = segments[index + 1];
    if (after && after.trackId !== null && after.trackId !== segment.trackId) return segment;
    if (segment.trackId === null) return segment;
    const cut = opts.cuts.find(
      (time) => Math.abs(time - segment.t1) <= 0.02 || (time > segment.t1 - 1e-6 && time < segment.t1 + 0.02),
    );
    if (cut === undefined) return segment;
    const track = byId.get(segment.trackId);
    if (!track) return segment;
    const nextSighting = track.points.reduce<number | null>((best, point) => {
      if (point.t < cut - 1e-6 || point.t > cut + horizon) return best;
      return best === null || point.t < best ? point.t : best;
    }, null);
    if (nextSighting === null) return segment;
    return { ...segment, t1: Math.max(segment.t1, nextSighting + 1e-3) };
  });
}

/** Use a tracked live face when speaker fusion has no visible speaker for a span. */
function fillVisibleFaceFallbacks(
  tracks: Track[],
  segments: SpeakerRunInput[],
  maxDetectionGap = 0.4,
): SpeakerRunInput[] {
  const observations = tracks.flatMap((track) =>
    track.points.map((point) => ({ t: point.t, trackId: track.id, width: point.w })),
  );
  const output: SpeakerRunInput[] = [];

  for (const segment of segments) {
    if (!(segment.t1 > segment.t0)) continue;
    const nearby = observations
      .filter((point) => point.t >= segment.t0 - maxDetectionGap && point.t <= segment.t1 + maxDetectionGap)
      .sort((a, b) => a.t - b.t);
    const times = [...new Set(nearby.map((point) => point.t))];
    const boundaries = [
      segment.t0,
      ...times.slice(1).map((time, index) => (times[index] + time) / 2)
        .filter((time) => time > segment.t0 && time < segment.t1),
      segment.t1,
    ].sort((a, b) => a - b);

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const t0 = boundaries[index];
      const t1 = boundaries[index + 1];
      if (t1 - t0 < 1e-6) continue;
      const at = (t0 + t1) / 2;
      const nearestFor = (trackId: number) => nearby
        .filter((point) => point.trackId === trackId)
        .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0];
      const preferred = segment.trackId === null ? undefined : nearestFor(segment.trackId);
      const selected = preferred && Math.abs(preferred.t - at) <= maxDetectionGap
        ? preferred
        : [...nearby]
          .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at) || b.width - a.width)
          .find((point) => Math.abs(point.t - at) <= maxDetectionGap);
      const trackId = selected?.trackId ?? null;
      const previous = output[output.length - 1];
      if (previous && previous.trackId === trackId && Math.abs(previous.t1 - t0) < 1e-6) {
        previous.t1 = t1;
      } else {
        output.push({ trackId, t0, t1 });
      }
    }
  }

  return output;
}

/**
 * Does `anchor` frame the whole head for the detections of this run (the way the
 * quality report measures it), at least as often as the plain centre anchor?
 *
 * The head-aware anchor is preferred, but only when it does not actually make
 * things worse: for a small, off-centre face the safety margin can push the window
 * against a frame edge in the wrong direction. Asking the real detections keeps the
 * choice honest instead of trusting the geometry in isolation.
 */
function anchorKeepsRunHeadInside(
  anchor: { x: number; y: number },
  samples: CameraSample[],
  shape: ReturnType<typeof windowShapeOf>,
): boolean {
  if (samples.length === 0) return true;
  const centre = windowFor(
    median(samples.map((sample) => sample.cx)),
    median(samples.map((sample) => sample.cy)),
    shape,
  );
  const inside = (pos: { x: number; y: number }): number =>
    samples.filter((sample) =>
      faceBoxInsideWindow(sample, pos, { cropW: shape.cropW, cropH: shape.cropH }),
    ).length;
  return inside(anchor) >= inside(centre);
}

// ---------------------------------------------------------------------------
// Face visibility: gaps, fallbacks and post-cut re-anchoring
// ---------------------------------------------------------------------------

/**
 * The spans in which the followed track had NO detection at all.
 *
 * `gapSeconds` is the tolerance for "this is still the same continuous presence":
 * one missed sample in a 4 fps detector is 0.25 s, so the default 0.4 s absorbs a
 * single miss without ever treating it as the person leaving. Anything larger is a
 * hole the camera must reason about.
 */
export function detectionGaps(
  track: Pick<Track, 'points'>,
  t0: number,
  t1: number,
  gapSeconds = 0.4,
): Array<{ start: number; end: number }> {
  const times = [...new Set(
    track.points
      .map((point) => point.t)
      .filter((t) => t >= t0 - 1e-6 && t <= t1 + 1e-6)
      .sort((a, b) => a - b),
  )];
  const holes: Array<{ start: number; end: number }> = [];
  if (times.length === 0) {
    return t1 > t0 ? [{ start: t0, end: t1 }] : [];
  }
  // Leading hole: the run started before this person was ever visible.
  if (times[0] - t0 > gapSeconds + 1e-6) holes.push({ start: t0, end: times[0] });
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] - times[i - 1] > gapSeconds + 1e-6) {
      holes.push({ start: times[i - 1], end: times[i] });
    }
  }
  // Trailing hole: they left before the run ended.
  const last = times[times.length - 1];
  if (t1 - last > gapSeconds + 1e-6) holes.push({ start: last, end: t1 });
  return holes;
}

/** The detection that best describes `track` at `t`, or null when it is not there. */
function faceNear(
  track: Track,
  t: number,
  tolerance: number,
): { t: number; cx: number; cy: number; w: number } | null {
  let best: Track['points'][number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of track.points) {
    const distance = Math.abs(point.t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > tolerance) return null;
  return toSample(best);
}

/** The first detection of `track` at or after `t` (within `horizonSeconds`). */
function firstFaceAfter(
  track: Track,
  t: number,
  horizonSeconds: number,
): { t: number; cx: number; cy: number; w: number } | null {
  let best: Track['points'][number] | null = null;
  for (const point of track.points) {
    if (point.t < t - 1e-6) continue;
    if (best === null || point.t < best.t) best = point;
  }
  if (!best || best.t - t > horizonSeconds) return null;
  return { t: best.t, cx: best.cx, cy: best.cy, w: best.w };
}

/**
 * The window for a moment where the FOLLOWED person is not visible: the biggest
 * face actually on screen at that instant (anyone else in the shot), else the
 * clamped default. Never the middle of a microphone: a position is only returned
 * when a real detection supports it.
 */
function fallbackWindow(
  others: Track[],
  t: number,
  tolerance: number,
  shape: ReturnType<typeof windowShapeOf>,
): { x: number; y: number; source: 'visible-face' | 'default' } | null {
  let best: CameraSample | null = null;
  for (const track of others) {
    const face = faceNear(track, t, tolerance);
    if (!face) continue;
    if (best === null || face.w > best.w) best = face;
  }
  if (best) return { ...windowForHead(best, shape), source: 'visible-face' };
  return null;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/**
 * Build the locked speaker camera.
 *
 * `segments` is the speaker timeline (one entry per run, `trackId: null` for "no
 * face on screen"); `tracks` are the people it refers to. `plan.path` is directly
 * usable in `cameraExpressions`.
 */
export function buildLockedSpeakerCamera(
  tracks: Track[],
  segments: SpeakerRunInput[],
  options: CameraPlanOptions
): CameraPlan {
  const opts = resolveOptions(options);
  const shape = windowShapeOf(opts);
  const byId = new Map<number, Track>();
  for (const track of tracks) byId.set(track.id, track);

  const runs: SpeakerLockRun[] = [];
  const framedSegments = fillVisibleFaceFallbacks(
    tracks,
    extendRunsAcrossCuts(segments, tracks, opts),
    GAP_TOLERANCE_FOR_FALLBACKS,
  );
  let reanchorAfterCut = 0;

  for (const run of buildSpeakerRuns(framedSegments, opts.cuts)) {
    const track = byId.get(run.trackId);
    if (!track) continue;

    // Anchor on the FIRST RELIABLE sighting of the run - not on the run's start.
    // The speaker timeline and the face track are sampled independently, so a run
    // routinely opens before (or just after) the first detection in that shot. The
    // old code then medianed an EMPTY settle window and dropped the run, which is
    // exactly how the opening frames ended up on a microphone or an empty chair.
    const firstFace = firstFaceAfter(track, run.t0, Math.max(opts.settleSeconds, 0.5));
    // A new SHOT can open on a wide angle, a reaction cut or a slow re-frame in
    // which this person is only recognisable a second or two later. The anchor is
    // still the median of the first `settleSeconds` of real detections in the shot
    // - the SEARCH for those detections is what has to reach past the cut.
    const anchorHorizon = run.startsAtCut || run.shot > 0
      ? Math.max(run.t1 - run.t0, 0)
      : Math.max(opts.settleSeconds, 0.5);
    const firstFaceInShot = firstFaceAfter(track, run.t0, anchorHorizon);
    let settled = samplesBetween(track, run.t0, Math.min(run.t1, run.t0 + opts.settleSeconds));
    if (settled.length === 0 && firstFaceInShot) {
      // Detections exist but not inside the settle window: settle on what is
      // actually there, from the first real sighting.
      settled = samplesBetween(
        track,
        firstFaceInShot.t,
        Math.min(run.t1, firstFaceInShot.t + opts.settleSeconds),
      );
    }
    void firstFace;
    if (settled.length === 0) {

      // Nothing to anchor on at all inside this run. Do NOT invent a position: the
      // hole/fallback machinery in the timeline takes over.
      continue;
    }
    const cx = median(settled.map((sample) => sample.cx));
    const cy = median(settled.map((sample) => sample.cy));
    const widths = settled.map((sample) => sample.w).sort((a, b) => a - b);
    const heights = settled
      .map((sample) => sample.h)
      .filter((value): value is number => value !== undefined && Number.isFinite(value))
      .sort((a, b) => a - b);
    const anchorSample: CameraSample = {
      t: settled[0].t,
      cx,
      cy,
      w: widths[Math.floor(widths.length / 2)] ?? 0,
      ...(heights.length > 0 ? { h: heights[Math.floor(heights.length / 2)] } : {}),
    };
    // ANCHOR, head-aware. `windowForHead` also has to break ties between "face at
    // the configured headroom" and "whole head inside the crop"; near the left or
    // right edge of the source those disagree, and keeping the head intact wins.
    let anchor = windowForHead(anchorSample, shape);
    if (!anchorKeepsRunHeadInside(anchor, settled, shape)) {
      // The head-aware framing is worse for the detections this run actually has
      // (a thin face close to an edge): keep the classic centre anchor, which is
      // what every recorded plan and fixture was built with.
      anchor = windowFor(anchorSample.cx, anchorSample.cy, shape);
    }
    runs.push({
      ...run,
      anchor,
      face: { cx, cy },
      settleSamples: settled.length,
      firstDetectionAt: settled[0].t,
    });

  }

  // A cut whose new shot has no detection of the followed person yet: the window
  // must not keep the previous shot's framing. Plan a deterministic jump at the
  // cut (the new shot's only visible face, else the clamped default window) and
  // re-anchor on the person the moment they are seen again.
  const firstRunByShot = new Map<number, SpeakerLockRun>();
  for (const run of runs) if (!firstRunByShot.has(run.shot)) firstRunByShot.set(run.shot, run);
  reanchorAfterCut = opts.cuts.filter((cut, index) => {
    const run = firstRunByShot.get(index + 1);
    return run !== undefined && run.t0 - cut > 0.4;
  }).length;

  const cutaways: CameraPlan['cutaways'] = [];
  const skippedCutaways: CameraPlan['skippedCutaways'] = [];
  if (opts.cutaways) {
    collectCutaways(runs, byId, opts, cutaways, skippedCutaways);
  }

  const timelineEnd = segments.reduce((max, segment) => Math.max(max, segment.t1), 0);
  const timelineResult = planTimeline(runs, cutaways, byId, opts, shape, timelineEnd);
  const { path, segments: timeline } = timelineResult;
  const initial = describeInitialFraming(runs, path, byId, opts);

  // Real speaker switches only: the cutaway visits have their own counter, so a
  // switch here means "the conversation moved to another person".
  const lockSegments = timeline.filter((segment) => segment.kind === 'lock');
  const switches: CameraPlan['switches'] = [];
  for (let i = 1; i < lockSegments.length; i += 1) {
    const previous = lockSegments[i - 1];
    if (previous.trackId === lockSegments[i].trackId) continue;
    const startsAtSourceCut = opts.cuts.some(
      (cut) => Math.abs(cut - lockSegments[i].start) < 0.02,
    );
    const reanchored = timelineResult.fallbackCuts.some(
      (entry) => Math.abs(entry.t - lockSegments[i].start) < 0.02,
    );
    switches.push({
      t: lockSegments[i].start,
      trackId: lockSegments[i].trackId,
      mode: lockSegments[i].entry === 'cut' ? 'cut' : 'glide',
      to: { x: lockSegments[i].pos.x, y: lockSegments[i].pos.y },
      duration: Math.max(0, lockSegments[i].arrive - lockSegments[i].start),
      reason: reanchored
        ? 'reanchor'
        : startsAtSourceCut
          ? 'source-cut'
          : 'speaker-change',
    });
  }

  // A RE-CENTRE is a move that keeps the same subject: speaker switches, cut
  // agreements and cutaway entries/exits are counted on their own lines, never
  // as re-centres (otherwise the log claims the camera re-centred on every turn).
  const isSwitchOrEdge = (move: { t: number }): boolean => {
    if (switches.some((swap) => Math.abs(swap.t - move.t) < 1e-6)) return true;
    if ((path.cuts ?? []).some((cut) => Math.abs(cut.t - move.t) < 1e-6)) return true;
    return timeline.some(
      (segment) =>
        segment.kind === 'cutaway' &&
        (Math.abs(segment.start - move.t) < 1e-6 || Math.abs(segment.until - move.t) < 1e-6)
    );
  };
  const recentres = path.moves
    .filter((move) => !isSwitchOrEdge(move))
    .map((move) => ({ t: move.t, duration: move.duration, to: { x: move.x, y: move.y } }));

  return {
    mode: 'locked',
    path,
    runs,
    segments: timeline,
    recentres,
    switches,
    cutaways,
    skippedCutaways,
    keyframes: path.moves.length + (path.cuts?.length ?? 0),
    glides: path.moves.length,
    cuts: path.cuts?.length ?? 0,
    initial,
    holes: path.holes ?? [],
    reanchorCuts: reanchorAfterCut,
    fallbackCuts: timelineResult.fallbackCuts,
    fallbackHoles: timelineResult.fallbackHoles,
    options: opts,
  };
}

/**
 * The initial-framing diagnostic for `[CAMERA-FACE]`: where the first frame points,
 * who it is about, when they were first actually seen, and whether a face is really
 * inside that opening window at t = 0. Measured against the finished path, so it
 * describes what will be rendered - not what the planner intended.
 */
function describeInitialFraming(
  runs: SpeakerLockRun[],
  path: CameraPath,
  byId: Map<number, Track>,
  opts: CameraPlanResolvedOptions,
): CameraInitialFraming | null {
  if (runs.length === 0) return null;
  const first = runs[0];
  const open = positionAtPath(path, 0);
  const track = byId.get(first.trackId);
  // The first detection of the OPENING subject anywhere in the clip.
  const firstFaceAt = track && track.points.length > 0
    ? Math.min(...track.points.map((point) => point.t))
    : first.firstDetectionAt;
  const sample = track ? faceNear(track, Math.max(firstFaceAt, 0), 0.4) : null;
  return {
    trackId: first.trackId,
    anchor: { x: open.x, y: open.y },
    firstFaceAt: round3(firstFaceAt),
    faceVisibleFromStart:
      sample !== null
        ? faceBoxInsideWindow(sample, open, { cropW: opts.cropW, cropH: opts.cropH })
        : false,
    leadSeconds: round3(Math.max(0, firstFaceAt)),
  };
}

/**
 * The framing the FIRST frame of the clip should show.
 *
 * Three cases, in order of preference:
 *
 *   1. The subject is already visible at t = 0 -> their own anchor (unchanged).
 *   2. The subject is not visible yet but someone else is -> that visible face.
 *   3. Nobody is visible -> the clamped default window (face anchor, frame centre).
 *
 * Case 2/3 also schedules ONE short glide to the subject's anchor when they first
 * appear, so the opening never sits on the wrong subject and the hand-over is a
 * controlled transition instead of a jump. A source cut before that moment keeps
 * priority: the cut is a hard switch and the glide is dropped.
 */
function planOpeningFraming(
  first: SpeakerLockRun,
  byId: Map<number, Track>,
  opts: CameraPlanResolvedOptions,
  shape: ReturnType<typeof windowShapeOf>,
): {
  pos: { x: number; y: number };
  source: 'subject' | 'visible-face' | 'default';
  glideTo: number | null;
  /**
   * The source cut between the opening framing and the subject's first sighting,
   * when there is one. It must remain a hard switch: the window cannot glide
   * across two camera angles, and it cannot sit on the opening angle's framing
   * into the new one either.
   */
  cutBeforeFirstSighting: number | null;
} {
  const subjectVisible =
    first.firstDetectionAt <= first.t0 + 1e-6 || first.firstDetectionAt <= 0.001;
  if (subjectVisible) {
    return { pos: first.anchor, source: 'subject', glideTo: null, cutBeforeFirstSighting: null };
  }

  const others = [...byId.values()].filter((track) => track.id !== first.trackId);
  const visible = fallbackWindow(others, 0, 0.4, shape);
  // Is any cut between t=0 and the subject's first sighting? Then the cut owns the
  // switch: a hard jump on the cut frame, never a glide across two shots.
  const cutBeforeSubject =
    opts.cuts.find((cut) => cut > 1e-6 && cut < first.firstDetectionAt - 1e-6) ?? null;
  return {
    pos: visible ?? {
      x: Math.max(0, Math.min(0.5 * opts.cropW, opts.srcW - opts.cropW)),
      y: Math.max(
        0,
        Math.min(opts.anchorY * opts.cropH, opts.srcH - opts.cropH),
      ),
    },
    source: visible ? 'visible-face' : 'default',
    glideTo: cutBeforeSubject ? null : first.firstDetectionAt,
    cutBeforeFirstSighting: cutBeforeSubject,
  };
}

/**
 * Find the listener cutaways: hold the speaker `speakerHoldSeconds`, then show a
 * listener for `cutawaySeconds`. A listener must pass a strong live/size test, be
 * on screen for `cutawayMinCoverage` of the whole cutaway, be co-visible with the
 * speaker in the same shot, and be centerable. Otherwise the slot is skipped and
 * the reason recorded.
 */
function collectCutaways(
  runs: SpeakerLockRun[],
  byId: Map<number, Track>,
  opts: CameraPlanResolvedOptions,
  out: CameraPlan['cutaways'],
  skipped: CameraPlan['skippedCutaways']
): void {
  for (const run of runs) {
    const speaker = byId.get(run.trackId);
    if (!speaker) continue;
    const cadence = opts.speakerHoldSeconds + opts.cutawaySeconds;
    const shape = windowShapeOf(opts);
    for (
      let start = run.t0 + opts.speakerHoldSeconds;
      start + opts.cutawaySeconds <= run.t1 - 0.05;
      start += cadence
    ) {
      const end = start + opts.cutawaySeconds;
      const speakerWidth = faceWidthAt(speaker, start);
      const candidates: Array<{ track: Track; pos: { x: number; y: number }; score: number }> = [];
      let reason = 'no other live face on screen in this shot';

      for (const candidate of byId.values()) {
        if (candidate.id === speaker.id) continue;
        const coverage = onScreenShare(candidate, start, end);
        if (coverage < opts.cutawayMinCoverage) {
          if (coverage > 0) reason = `listener ${candidate.id} on screen in only ${Math.round(coverage * 100)}% of the cutaway (needs ${Math.round(opts.cutawayMinCoverage * 100)}%)`;
          continue;
        }
        const width = faceWidthAt(candidate, start);
        if (speakerWidth > 0 && width < speakerWidth * opts.cutawayMinSizeRatio) {
          reason = `listener ${candidate.id} face is ${Math.round((width / speakerWidth) * 100)}% of the speaker's (needs ${Math.round(opts.cutawayMinSizeRatio * 100)}%)`;
          continue;
        }
        if (!coVisible(speaker, candidate, start, end, opts.cuts)) {
          reason = `listener ${candidate.id} is never on screen together with the speaker in this shot`;
          continue;
        }
        const inner = samplesBetween(candidate, start, end);
        if (inner.length === 0) {
          reason = `listener ${candidate.id} has no detections inside the cutaway`;
          continue;
        }
        const pos = windowFor(
          median(inner.map((sample) => sample.cx)),
          median(inner.map((sample) => sample.cy)),
          shape
        );
        if (!headInsideSafeZone(
          {
            t: start,
            cx: median(inner.map((sample) => sample.cx)),
            cy: median(inner.map((sample) => sample.cy)),
            w: Math.max(...inner.map((sample) => sample.w)),
          },
          pos,
          { cropW: opts.cropW, cropH: opts.cropH, marginFraction: 0.04 }
        )) {
          reason = `listener ${candidate.id} cannot be framed inside the crop`;
          continue;
        }
        const centreDistance = Math.hypot(
          pos.x + opts.cropW / 2 - median(inner.map((sample) => sample.cx)),
          pos.y + opts.cropH * opts.anchorY - median(inner.map((sample) => sample.cy))
        );
        if (centreDistance > opts.cropW * 0.5) {
          reason = `listener ${candidate.id} sits at the frame edge (cannot be centred)`;
          continue;
        }
        candidates.push({
          track: candidate,
          pos,
          score: candidate.visibleTime * candidate.avgW,
        });
      }

      if (candidates.length === 0) {
        skipped.push({ t: Math.round(start * 1000) / 1000, reason });
        continue;
      }
      const pick =
        opts.cutawayPick === 'prominent'
          ? [...candidates].sort((a, b) => b.score - a.score)[0]
          : candidates[pseudoRandomIndex(opts.cutawaySeed + Math.round(start * 10), candidates.length)];
      out.push({
        t: Math.round(start * 1000) / 1000,
        duration: opts.cutawaySeconds,
        trackId: pick.track.id,
        speakerId: speaker.id,
      });
    }
  }
}

/** Deterministic index in `[0, count)` (stable across renders, no Math.random). */
function pseudoRandomIndex(seed: number, count: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.min(count - 1, Math.max(0, Math.floor(Math.abs(value - Math.floor(value)) * count)));
}

/**
 * Turn the lock runs (plus any cutaways) into the rendered camera timeline.
 *
 * Entry rules: a new source SHOT is always a hard switch on its cut frame; a
 * speaker change is a `speakerGlideSeconds` glide, or instant when
 * `switchMode === 'cut'`; inside a lock the only movement is the locked camera's
 * own short re-centres.
 */
function planTimeline(
  runs: SpeakerLockRun[],
  cutaways: CameraPlan['cutaways'],
  byId: Map<number, Track>,
  opts: CameraPlanResolvedOptions,
  shape: ReturnType<typeof windowShapeOf>,
  timelineEnd = 0,
): {
  path: CameraPath;
  segments: CameraSegment[];
  holes: CameraHole[];
  fallbackCuts: NonNullable<CameraPlan['fallbackCuts']>;
  fallbackHoles: NonNullable<CameraPlan['fallbackHoles']>;
} {
  if (runs.length === 0) {
    return {
      path: {
        x0: Math.max(0, (opts.srcW - opts.cropW) / 2),
        y0: Math.max(0, (opts.srcH - opts.cropH) / 2),
        moves: [],
        truncated: false,
      },
      segments: [],
      holes: [],
      fallbackCuts: [],
      fallbackHoles: [],
    };
  }

  const cuts: CameraCut[] = [];
  const moves: CameraMove[] = [];
  const segments: CameraSegment[] = [];
  const holes: CameraHole[] = [];
  const fallbackCuts: NonNullable<CameraPlan['fallbackCuts']> = [];
  const fallbackHoles: NonNullable<CameraPlan['fallbackHoles']> = [];
  // OPENING FRAMING. The old code always started the window on `runs[0].anchor`,
  // i.e. where the first speaker's face is somewhere LATER in the shot. When the
  // clip opens on the same shot before that face is visible (a microphone, an
  // empty chair, a wide establishing angle) that pretends a face was seen: the
  // first frames then show whatever happens to sit at that position. Instead the
  // window opens on a position that is actually SUPPORTED at t = 0 - a visible face
  // in the opening shot, else the clamped default - and glides to the real anchor
  // only when the subject appears.
  const opening = planOpeningFraming(runs[0], byId, opts, shape);
  const x0 = opening.pos.x;
  const y0 = opening.pos.y;
  let busyUntil = -Infinity;
  let moveBudgetHit = false;

  /** Add a window change at `t`; returns how long the window is busy. */
  /**
   * How long the window takes to travel `distance` px.
   *
   * A short hop stays on the neutral `speakerGlideSeconds`; a move across the
   * picture gets a little more time, because a big travel at a fixed duration
   * reads as a whip. A CONFIRMED turn change passes `turn` and is allowed to be
   * quicker - the conversation is visibly moving on, so waiting is worse than
   * moving - but never below the floor, so it stays a move and not a jump.
   *
   * The duration is a target, not a promise: `enter` shortens it if the next
   * evidence arrives mid-move (see the retarget below).
   */
  const glideSecondsFor = (distance: number, turn: boolean): number => {
    const base = turn ? opts.turnGlideSeconds : opts.speakerGlideSeconds;
    const grown = base + Math.min(MAX_GLIDE_GROWTH, distance * SPEAKER_GLIDE_DISTANCE_FACTOR);
    return Math.max(0.1, Math.min(1.5, grown));
  };

  /** Where the window is at `t` given every move pushed so far. */
  const positionAt = (t: number): { x: number; y: number } => {
    let prev = { x: x0, y: y0 };
    for (const move of cuts) {
      if (move.t <= t + 1e-9) prev = { x: move.x, y: move.y };
    }
    for (const move of moves) {
      if (move.t <= 0) continue;
      if (t <= move.t) return prev;
      if (t < move.t + move.duration) {
        const u = smoothstep((t - move.t) / move.duration);
        return { x: prev.x + (move.x - prev.x) * u, y: prev.y + (move.y - prev.y) * u };
      }
      prev = { x: move.x, y: move.y };
    }
    return prev;
  };

  /**
   * The minimum move that is worth a camera event. Scaled by the crop, so the
   * same number means the same thing on any source resolution.
   */
  const minMovePx = Math.max(1, Math.round(Math.min(opts.cropW, opts.cropH) * opts.minMovePct));

  const enter = (
    t: number,
    pos: { x: number; y: number },
    hard: boolean,
    turn = false,
  ): { arrive: number; duration: number; entry: CameraSegment['entry'] } => {
    if (hard) {
      cuts.push({ t: round3(t), x: pos.x, y: pos.y });
      busyUntil = Math.max(busyUntil, t);
      return { arrive: t, duration: 0, entry: 'cut' };
    }
    const distance = Math.hypot(pos.x - positionAt(t).x, pos.y - positionAt(t).y);
    // A move that would not visibly change the framing is not a camera event.
    if (distance < minMovePx) {
      return { arrive: t, duration: 0, entry: 'start' };
    }
    if (moves.length + cuts.length >= opts.maxMoves) {
      moveBudgetHit = true;
      return { arrive: t, duration: 0, entry: 'cut' };
    }
    // RETARGET, don't stack. If another decision lands while the window is still
    // travelling, this move takes over from where the window actually is at that
    // instant and the previous one is shortened to end here. Two overlapping
    // glides fighting each other is what an oscillating camera is made of.
    let from = { x: x0, y: y0 };
    const previous = moves[moves.length - 1];
    if (previous) {
      from = { x: previous.x, y: previous.y };
      if (t < previous.t + previous.duration - 1e-6) {
        const travelled = positionAt(t);
        // Finish the old move early, at the spot the window has actually reached.
        previous.duration = Math.max(0.05, round3(t - previous.t));
        previous.x = travelled.x;
        previous.y = travelled.y;
        from = travelled;
      }
    }
    const duration = glideSecondsFor(
      Math.hypot(pos.x - from.x, pos.y - from.y),
      turn,
    );
    moves.push({ t: round3(t), duration: round3(duration), x: pos.x, y: pos.y });
    busyUntil = Math.max(busyUntil, t + duration);
    return { arrive: t + duration, duration, entry: 'glide' };
  };

  /** Every lock time (enter + exit) in the plan, so cutaway slots can be checked. */
  const cutawayByRun = new Map<number, CameraPlan['cutaways']>();
  for (const cutaway of cutaways) {
    const list = cutawayByRun.get(cutaway.speakerId) ?? [];
    list.push(cutaway);
    cutawayByRun.set(cutaway.speakerId, list);
  }

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const previous = index > 0 ? runs[index - 1] : null;
    const at = previous ? Math.max(run.t0, previous.t1) : run.t0;

    let entry: CameraSegment['entry'] = 'start';
    let arrive = at;
    if (!previous && opening.cutBeforeFirstSighting !== null) {
      // The clip opens on one angle and the source cuts before this subject is
      // visible. The cut is a HARD switch on its own frame - the window never
      // glides between two camera angles and never keeps the old angle's framing.
      const cutTime = opening.cutBeforeFirstSighting;
      const sourceCut = opts.cuts.indexOf(cutTime);
      const cutRun = runs.find((candidate) => candidate.shot === sourceCut + 1 && candidate.startsAtCut);
      const target =
        cutRun && cutRun.firstDetectionAt <= run.t0 + 1e-6
          ? cutRun.anchor
          : fallbackWindow(
              [...byId.values()].filter((track) => track.id !== run.trackId),
              cutTime,
              0.4,
              shape,
            ) ?? run.anchor;
      cuts.push({
        t: round3(cutTime),
        x: Math.round(target.x),
        y: Math.round(target.y),
        reanchor: !(cutRun && cutRun.firstDetectionAt <= run.t0 + 1e-6),
      });
      if (!(cutRun && cutRun.firstDetectionAt <= run.t0 + 1e-6)) {
        fallbackCuts.push({ t: round3(cutTime), source: 'default', trackId: run.trackId });
      }
      busyUntil = Math.max(busyUntil, cutTime);
      if (run.firstDetectionAt > cutTime + 1e-6) {
        const entered = enter(run.firstDetectionAt, run.anchor, false);
        entry = entered.entry;
        arrive = entered.arrive;
      } else {
        entry = 'start';
        arrive = at;
      }
    } else if (!previous && opening.glideTo !== null) {
      // The clip opened on a visible face / the default before this person appeared:
      // one short controlled glide to their anchor on the first sighting, never a
      // cut (nothing about the SOURCE changed) and never a stale crop.
      const entered = enter(Math.max(0, opening.glideTo), run.anchor, false);
      entry = entered.entry;
      arrive = entered.arrive;
    } else if (previous) {
      const shotChanged = previous.shot !== run.shot;
      const speakerChanged = previous.trackId !== run.trackId;
      if (shotChanged) {
        // 5) CUT: the window is already on the new shot's anchor at the cut frame.
        // When the subject is NOT yet visible on the new shot, the cut still has
        // to move the window - keeping the previous shot's framing would leave the
        // camera pointing at a microphone or an empty chair until the first
        // detection. The jump target is the new shot's only visible face, else the
        // clamped default; the run then re-anchors as soon as the subject appears.
        const cutTime = opts.cuts.filter((cut) => cut > previous.t1 - 1e-6 && cut <= run.t0 + 1e-6)[0];
        const needsFallback = cutTime !== undefined && run.t0 - cutTime > 0.4;
        if (needsFallback) {
          const fallback =
            fallbackWindow(
              [...byId.values()].filter((track) => track.id !== run.trackId),
              cutTime,
              0.4,
              shape,
            ) ?? {
              ...windowFor(run.face.cx, run.face.cy, shape),
              source: 'default' as const,
            };
          cuts.push({ t: round3(cutTime), x: fallback.x, y: fallback.y, reanchor: true });
          busyUntil = Math.max(busyUntil, cutTime);
          entry = 'cut';
          arrive = cutTime;
          fallbackCuts.push({ t: round3(cutTime), source: fallback.source, trackId: run.trackId });
        } else {
          const entered = enter(at, run.anchor, true);
          entry = entered.entry;
          arrive = entered.arrive;
        }
      } else if (speakerChanged) {
        // 4) SWITCH - a confirmed turn. The conversation is visibly moving on, so
        // this is the one case where the camera may move quicker.
        const hard = opts.switchMode === 'cut';
        const entered = enter(at, run.anchor, hard, true);
        entry = entered.entry;
        arrive = entered.arrive;
      } else if (
        // A NEW SHOT always re-anchors, even when the same person keeps talking
        // across the cut (the face moved because the camera angle changed).
        opts.cuts.some((cut) => cut > previous.t1 - 1e-6 && cut <= run.t0 + 1e-6) ||
        Math.abs(run.anchor.x - previous.anchor.x) >= minMovePx ||
        Math.abs(run.anchor.y - previous.anchor.y) >= minMovePx
      ) {
        // Same speaker, but a new shot (cut) or a re-locked anchor: switch on the
        // cut frame / glide to the new anchor. Never left pointing at the old spot.
        const onCut = opts.cuts.some((cut) => cut > previous.t1 - 1e-6 && cut <= run.t0 + 1e-6);
        const entered = enter(at, run.anchor, onCut);
        entry = entered.entry;
        arrive = entered.arrive;
      } else {
        entry = 'start';
      }
    } else if (opts.cuts.some((cut) => cut <= run.t0 + 1e-6)) {
      cuts.push({ t: 0, x: run.anchor.x, y: run.anchor.y });
    }

    const runCutaways = (cutawayByRun.get(run.trackId) ?? [])
      .filter((cutaway) => cutaway.t >= arrive && cutaway.t + cutaway.duration <= run.t1)
      .sort((a, b) => a.t - b.t);

    // 1-3) The locked camera of this run (dead zone + short re-centres).
    const track = byId.get(run.trackId);
    const samples = track ? samplesBetween(track, run.t0, run.t1) : [];
    const runCamera =
      samples.length > 0
        ? buildLockedCamera(samples, {
            ...shape,
            deadZoneMode: 'face',
            deadZoneXPct: opts.deadZoneXPct,
            deadZoneYPct: opts.deadZoneYPct,
            confirmSeconds: opts.confirmSeconds,
            recentreSeconds: opts.recentreSeconds,
            recentreLookbackSeconds: opts.recentreLookbackSeconds,
            settleSeconds: opts.settleSeconds,
            anticipationSeconds: 0,
            minMovePx: 4,
            maxMoves: Math.max(0, opts.maxMoves - moves.length - cuts.length),
          })
        : null;

    // Walk the run's own timeline: lock → (cutaway → lock)*
    let cursor = at;
    const currentPos = run.anchor;
    const pushLock = (
      start: number,
      until: number,
      pos: { x: number; y: number },
      kind: CameraSegment['entry'],
      /** When the window has finished travelling there (== start for a cut). */
      arrived = start,
    ) => {
      if (until - start <= 1e-6) return;
      segments.push({
        kind: 'lock',
        trackId: run.trackId,
        start: round3(start),
        arrive: round3(Math.max(start, arrived)),
        until: round3(until),
        pos: { x: pos.x, y: pos.y },
        entry: kind,
      });
    };

    pushLock(at, runCutaways.length > 0 ? runCutaways[0].t : run.t1, currentPos, entry, arrive);

    for (let c = 0; c < runCutaways.length; c += 1) {
      const cutaway = runCutaways[c];
      const listener = byId.get(cutaway.trackId);
      if (!listener) continue;
      const inner = samplesBetween(listener, cutaway.t, cutaway.t + cutaway.duration);
      if (inner.length === 0) continue;
      const pos = windowFor(
        median(inner.map((sample) => sample.cx)),
        median(inner.map((sample) => sample.cy)),
        shape
      );
      const entered = enter(cutaway.t, pos, opts.switchMode === 'cut');
      segments.push({
        kind: 'cutaway',
        trackId: cutaway.trackId,
        speakerId: run.trackId,
        start: round3(cutaway.t),
        arrive: round3(entered.arrive),
        until: round3(cutaway.t + cutaway.duration),
        pos,
        entry: entered.entry,
      });
      // Back to the speaker.
      const back = enter(cutaway.t + cutaway.duration, run.anchor, opts.switchMode === 'cut');
      const nextStart = c + 1 < runCutaways.length ? runCutaways[c + 1].t : run.t1;
      if (nextStart - (cutaway.t + cutaway.duration) > 1e-6) {
        segments.push({
          kind: 'lock',
          trackId: run.trackId,
          start: round3(cutaway.t + cutaway.duration),
          arrive: round3(back.arrive),
          until: round3(nextStart),
          pos: run.anchor,
          entry: back.entry,
        });
      }
      cursor = Math.max(cursor, nextStart);
    }

    // The run's own re-centres, minus the ones that fall inside a cutaway.
    if (runCamera) {
      // The inner planner stops silently once it runs out of its own budget; if it
      // wanted more moves than the PLAN can still hold, the path is truncated.
      if (runCamera.truncated) moveBudgetHit = true;
      for (const move of runCamera.moves) {
        if (move.t < cursor - run.t1 + 1e-6) continue;
        const insideCutaway = runCutaways.some(
          (cutaway) => move.t >= cutaway.t - 1e-6 && move.t < cutaway.t + cutaway.duration
        );
        if (insideCutaway) continue;
        if (move.t < busyUntil) continue;
        if (moves.length + cuts.length >= opts.maxMoves) {
          moveBudgetHit = true;
          break;
        }
        moves.push({ t: round3(move.t), duration: move.duration, x: move.x, y: move.y });
        busyUntil = Math.max(busyUntil, move.t + move.duration);
      }
    }
  }

  // 7) MISSING FACE. The window holds its last VALID framing for
  // `faceLostHoldSeconds` (a blink, a mic swinging across the mouth, a missed
  // sample), then moves ONCE - deterministically - to the biggest face actually on
  // screen, or to the clamped default when nobody is visible. It never drifts,
  // never guesses a position from a microphone or a chair, and re-locks on the
  // subject the moment they are seen again (the next run's own entry).
  //
  // The holes come from the RUN timeline, not from raw detections: a span with no
  // run is exactly a span in which the camera has nobody to follow, which is the
  // case that used to leave a stale crop forever. Internal detection gaps are
  // reported too, so a flickering detector is visible in the log.
  if (opts.faceLostHoldSeconds > 0) {
    const followEnd = Math.max(
      0,
      opts.durationSeconds,
      segments.length > 0 ? Math.max(...segments.map((segment) => segment.until)) : 0,
      ...runs.map((run) => run.t1),
      // The speaker timeline spans the whole clip and ends with a "no visible
      // speaker" span when the subject left early. `fillVisibleFaceFallbacks` can
      // shorten that span to the last sighting, so the ORIGINAL timeline's end is
      // what says how long the camera must keep working. Without it the planner
      // thinks the clip ends with the last detection - precisely how a stale crop
      // survived to the end of a rendered clip.
      timelineEnd,
    );
    const covered = segments
      .filter((segment) => segment.kind === 'lock')
      .map((segment) => ({ start: segment.start, end: segment.until }))
      .sort((a, b) => a.start - b.start);
    const spans: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const span of covered) {
      if (span.start > cursor + 1e-6) spans.push({ start: cursor, end: span.start });
      cursor = Math.max(cursor, span.end);
    }
    if (followEnd > cursor + 1e-6) spans.push({ start: cursor, end: followEnd });

    for (const span of spans) {
      do {
        // A source cut inside the span owns the framing on the new shot; that is a
        // shot change, not a lost face.
        if (opts.cuts.some((cut) => cut > span.start + 1e-6 && cut < span.end - 1e-6)) break;
        const length = span.end - span.start;
        // The subject's face was lost, but a person detected them still sitting
        // there: hold their framing instead of moving to somebody else.
        const holdSeconds = Math.max(
          opts.faceLostHoldSeconds,
          opts.personHoldSeconds,
        );
        const hold = Math.min(holdSeconds, length);
        holes.push({ start: round3(span.start), end: round3(span.end), holdSeconds: round3(hold) });
        const fallbackAt = span.start + hold;
        // A hole shorter than the grace period is a blink: the camera must not move.
        if (fallbackAt >= span.end - 1e-6) break;
        // If the span ENDS because another run (or one still to come) takes over very
        // shortly, the camera is already going to move there. Two moves a few frames
        // apart is exactly the unnecessary jitter this must avoid.
        if (span.end - fallbackAt < 1.5) break;
        if (fallbackAt + opts.recentreSeconds > span.end - 1e-6) break;
        if (moves.length + cuts.length >= opts.maxMoves) {
          moveBudgetHit = true;
          break;
        }
        const subjectId = runs.find((run) => Math.abs(run.t1 - span.start) < 0.3)?.trackId ?? null;
        const others = [...byId.values()].filter((track) => track.id !== subjectId);
        const fallback = fallbackWindow(others, fallbackAt, 0.4, shape);
        const pos = fallback ?? {
          x: Math.max(0, (opts.srcW - opts.cropW) / 2),
          y: Math.max(0, Math.min(opts.anchorY * opts.cropH, opts.srcH - opts.cropH)),
        };
        moves.push({
          t: round3(fallbackAt),
          duration: round3(opts.recentreSeconds),
          x: Math.round(pos.x),
          y: Math.round(pos.y),
        });
        busyUntil = Math.max(busyUntil, fallbackAt + opts.recentreSeconds);
        fallbackHoles.push({
          t: round3(fallbackAt),
          source: fallback ? 'visible-face' : 'default',
          trackId: subjectId ?? 0,
        });
      } while (false);
    }
  }

  const orderedMoves = moves
    .filter((move) => !cuts.some((cut) => Math.abs(cut.t - move.t) < 1e-6))
    .sort((a, b) => a.t - b.t);
  const orderedCuts = dedupeCuts(cuts);

  return {
    path: {
      x0,
      y0,
      moves: orderedMoves,
      truncated: moveBudgetHit,
      ...(orderedCuts.length > 0 ? { cuts: orderedCuts } : {}),
      ...(holes.length > 0 ? { holes } : {}),
    },
    segments,
    holes,
    fallbackCuts,
    fallbackHoles,
  };
}

function dedupeCuts(cuts: CameraCut[]): CameraCut[] {
  const out: CameraCut[] = [];
  for (const cut of [...cuts].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - cut.t) < 1e-6) {
      out[out.length - 1] = cut;
      continue;
    }
    out.push(cut);
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

export interface CameraQaOptions {
  /** The camera path that will be rendered (`plan.path`). */
  path: CameraPath;
  /** Where the followed person really is (clip-relative detections). */
  samples: CameraSample[];
  srcW: number;
  srcH: number;
  cropW: number;
  cropH: number;
  anchorY: number;
  deadZoneXPct?: number;
  deadZoneYPct?: number;
  /** Clip length (per-minute rates). */
  durationSeconds: number;
  /** Max gap (s) between detections that still counts as the same person. Default 0.5. */
  presenceToleranceSeconds?: number;
}

export interface CameraQaReport {
  /** Share of SETTLED frames (no glide in progress) with the face inside the dead zone. */
  pctFramesInDeadzone: number;
  /**
   * Share of settled frames inside the planner's STABILISED band (dead zone × the
   * face hysteresis). The planner deliberately ignores a small overshoot so a
   * swaying head does not trigger a re-centre; frames in that band are held still,
   * which is the intended behaviour - this is the number to compare against 100 %.
   */
  pctFramesInStableBand: number;
  /** Share of ALL measured frames inside the dead zone, transitions included. */
  pctFramesInDeadzoneAll: number;
  /** Worst distance (px) of the face centre from where the dead zone expects it. */
  maxOffsetPx: number;
  /** Worst offset among SETTLED frames - the framing the viewer actually sits on. */
  maxSettledOffsetPx: number;
  /** Frames spent inside a glide or a cut (the camera is allowed to be off-centre). */
  transitionFrames: number;
  /** Camera events (glides + hard switches) per minute. */
  motionEventsPerMinute: number;
  /** Longest single eased glide (s). */
  longestGlideSeconds: number;
  /** Glides longer than the 0.5 s acceptance bound. */
  glidesOverHalfSecond: number;
  /** Frames where the frame edge made the dead zone unreachable. */
  edgeLimitedFrames: number;
  /** Frames where the head could not fit inside the crop at all. */
  framesWithHeadOutsideCrop: number;
  /** The subset above that is NOT mid-glide: a real framing defect, not travel. */
  framesWithHeadOutsideCropSettled: number;
  framesChecked: number;
  edgeLimited: boolean;
  /**
   * Share of measured frames where the COMPLETE HEAD (hair above the box, jaw
   * below, sides of the head - not just the face centre) is inside the crop.
   * This is the framing quality number: a face centre can sit comfortably in the
   * dead zone while the top of the head is already cut off.
   */
  pctFramesHeadInsideCrop: number;
  /**
   * Share of measured frames where the head is inside the crop minus the safety
   * margin (`HEAD_SAFETY_MARGIN` of the crop on each side) - "not touching the
   * edge", the framing a viewer reads as intentional.
   */
  pctFramesHeadSafelyFramed: number;
  /**
   * Worst offset (px) between the window position the plan used and what the
   * plan itself encodes after 1 s. They must be identical; a non-zero value means
   * the rendered crop drifts away from the plan, which is what a large
   * "maximum crop displacement" reading usually is.
   */
  maxPathDriftPx: number;
  /**
   * Frames where the head could not fit the crop ANYWHERE in the source (pinned
   * against the frame edge on both sides). Counted as framed, and reported so a
   * reviewer knows why the safe-framing number is not 100%.
   */
  framesWithHeadUnfittable: number;
}

/**
 * Measure a planned camera against the detections it was planned from: how still
 * the framing really is, and how often the face is where the dead zone wants it.
 * This is the `[CAMERA-QA]` line.
 *
 * Frames are checked on a 0.1 s grid over `[0, durationSeconds)`; a frame counts
 * when the person was detected within `presenceToleranceSeconds`.
 */
export function measureCameraQa(options: CameraQaOptions): CameraQaReport {
  return measureRanges(options, [{ trackId: null, t0: Number.NEGATIVE_INFINITY, t1: Number.POSITIVE_INFINITY }], null);
}

/**
 * QA for a WHOLE PLAN: at every moment the camera is chasing whoever that segment
 * is about (the speaker, or the listener during a cutaway). This is what a render
 * reports, so "the face is inside the dead zone in 100% of frames" means the face
 * the viewer is looking at - not every face in the source.
 */
export function measureCameraPlanQa(
  plan: CameraPlan,
  tracks: Track[],
  options: Omit<CameraQaOptions, 'path' | 'samples'>,
): CameraQaReport {
  const byId = new Map<number, Track>();
  for (const track of tracks) byId.set(track.id, track);
  // A segment owns the screen from `start`, but during its entry glide the frames
  // still show (most of) the PREVIOUS framing - attribute those frames to the
  // previous subject, exactly as a viewer would see them.
  const ranges: Array<{ trackId: number | null; t0: number; t1: number }> = [];
  if (plan.segments.length === 0) {
    ranges.push({ trackId: plan.runs[0]?.trackId ?? null, t0: 0, t1: options.durationSeconds });
  } else {
    // Everything before the first segment is the opening framing: measure it
    // against the first subject, otherwise those frames are simply not counted.
    const first = plan.segments[0];
    if (first.start > 1e-6) {
      ranges.push({ trackId: first.trackId, t0: 0, t1: first.start });
    }
    plan.segments.forEach((segment, index) => {
      const previous = index > 0 ? plan.segments[index - 1] : null;
      const until = segment.until > segment.start ? segment.until : segment.until + 1e-3;
      // A hard switch (source cut) owns its frame immediately - there is no
      // overlap to attribute to the previous shot. Only an eased glide overlaps.
      const arrivingUntil =
        segment.entry === 'cut'
          ? segment.start
          : Math.min(until, Math.max(segment.start, segment.arrive));
      if (previous && arrivingUntil > segment.start + 1e-9) {
        ranges.push({ trackId: previous.trackId, t0: segment.start, t1: arrivingUntil });
      }
      ranges.push({
        trackId: segment.trackId,
        t0: Math.max(segment.start, arrivingUntil),
        t1: index === plan.segments.length - 1
          ? Math.max(until, options.durationSeconds)
          : until,
      });
    });
  }
  return measureRanges(
    {
      ...options,
      path: plan.path,
      samples: [],
    },
    ranges,
    (t, trackId) => {
      const track = trackId === null ? null : byId.get(trackId);
      if (!track) return null;
      return nearestDetection(track, t, options.presenceToleranceSeconds ?? 0.5);
    }
  );
}

/**
 * The detection that describes the window whose FIRST FRAME is `t`: the nearest
 * sighting at or after `t` when one is close enough, otherwise (the clip ends
 * between two samples) the nearest sighting anywhere inside the tolerance.
 *
 * "After" matters: a 0.1 s glide that starts exactly when a new speaker/segment
 * starts has only reached ~50 % at the first frame whose timestamp is that start,
 * so the frame after the switch is identical to the frame before it. The
 * GENERATED EXPRESSION is unaffected - after the ~3 frames of a 0.1 s move the
 * camera sits on the new anchor - but QA must not blame the plan for that overlap.
 */
function nearestDetection(track: Track, t: number, tolerance: number): CameraSample | null {
  let forward: Track['points'][number] | null = null;
  for (const point of track.points) {
    if (point.t < t - 1e-6) continue;
    if (forward === null || point.t < forward.t) forward = point;
  }
  if (forward && forward.t - t <= tolerance) {
    return toSample(forward);
  }
  return nearestAnyDetection(track, t, tolerance);
}

/** The track's detection closest to `t`, if one is within `tolerance` seconds. */
function nearestAnyDetection(track: Track, t: number, tolerance: number): CameraSample | null {
  let best: Track['points'][number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of track.points) {
    const distance = Math.abs(point.t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > tolerance) return null;
  return toSample(best);
}

/** A track point as a camera sample, keeping the detected box height when present. */
function toSample(point: Track['points'][number]): CameraSample {
  return {
    t: point.t,
    cx: point.cx,
    cy: point.cy,
    w: point.w,
    ...(point.h !== undefined ? { h: point.h } : {}),
  };
}

/**
 * The measurement itself: walk `[0, duration)` on a 0.1 s grid and check where the
 * relevant detection sits inside the crop. Frames where the crop edge (not the
 * plan) limits the framing are counted separately.
 */
function measureRanges(
  options: CameraQaOptions,
  ranges: Array<{ trackId: number | null; t0: number; t1: number }>,
  lookup: ((t: number, trackId: number | null) => CameraSample | null) | null
): CameraQaReport {
  // Same geometry as the planner's dead zone (worker/camera-lock.ts): each side
  // is `deadZoneXPct` of the crop width / `deadZoneYPct` of its height.
  const halfX = options.cropW * (options.deadZoneXPct ?? CAMERA_PLAN_DEFAULTS.deadZoneXPct);
  const halfY = options.cropH * (options.deadZoneYPct ?? CAMERA_PLAN_DEFAULTS.deadZoneYPct);
  const maxX = Math.max(0, options.srcW - options.cropW);
  const maxY = Math.max(0, options.srcH - options.cropH);
  // A FULL-HEIGHT crop (9:16 out of 16:9) cannot move vertically: the face's
  // vertical position is then the source's business, not the camera's.
  const canMoveY = maxY > 1;
  const canMoveX = maxX > 1;
  const tolerance = options.presenceToleranceSeconds ?? 0.5;
  // Same band the planner uses to decide whether the face has really left (see
  // FACE_DEADZONE_HYSTERESIS in worker/camera-lock.ts).
  const bandX = halfX * FACE_DEADZONE_HYSTERESIS;
  const bandY = halfY * FACE_DEADZONE_HYSTERESIS;
  const samples = [...options.samples].sort((a, b) => a.t - b.t);

  let inside = 0;
  let insideSettled = 0;
  let insideBand = 0;
  let settled = 0;
  let checked = 0;
  let maxOffset = 0;
  let maxSettledOffset = 0;
  let edgeLimited = 0;
  let headOutside = 0;
  let headOutsideSettled = 0;
  let headUnfittable = 0;
  let insideHead = 0;
  let insideSafeHead = 0;
  let transitions = 0;

  const step = 0.1;
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.t0, options.durationSeconds));
    const to = Math.max(from, Math.min(range.t1, options.durationSeconds));
    // Integer-stepped grid: `t += 0.1` drifts (4.999999...) and a probe epsilon
    // past a segment boundary answers "who is speaking?" with the previous
    // speaker, which then reads as a framing defect on a settled frame.
    const steps = Math.ceil((to - from) / step - 1e-9);
    for (let index = 0; index < steps; index += 1) {
      const t = from + index * step;
      let nearest: CameraSample | null = null;
      if (lookup) {
        nearest = lookup(t, range.trackId);
      } else {
        for (const sample of samples) {
          if (Math.abs(sample.t - t) > tolerance) continue;
          if (nearest === null || Math.abs(sample.t - t) < Math.abs(nearest.t - t)) nearest = sample;
        }
      }
      if (!nearest) continue;
      const win = positionAtPath(options.path, t);
      const centreX = win.x + options.cropW / 2;
      const centreY = win.y + options.cropH * options.anchorY;
      const offsetX = Math.abs(nearest.cx - centreX);
      const offsetY = canMoveY ? Math.abs(nearest.cy - centreY) : 0;
      // Only axes the crop can actually move on are measured: a 9:16 window over a
      // 16:9 source is FULL height, so its vertical framing is fixed by the source.
      if (canMoveX) maxOffset = Math.max(maxOffset, offsetX);
      if (canMoveY) maxOffset = Math.max(maxOffset, offsetY);
      checked += 1;
      const inZone = offsetX <= halfX && offsetY <= halfY;
      if (inZone) inside += 1;
      // A frame is "settled" when no glide covers it: it is exactly the framing the
      // plan wants the viewer to sit on. Mid-glide frames are legitimately off-centre.
      if (isTransition(options.path, t)) {
        transitions += 1;
      } else {
        settled += 1;
        if (inZone) insideSettled += 1;
        if (offsetX <= bandX && offsetY <= bandY) insideBand += 1;
        if (canMoveX) maxSettledOffset = Math.max(maxSettledOffset, offsetX);
        if (canMoveY) maxSettledOffset = Math.max(maxSettledOffset, offsetY);
      }

      // "Edge limited": the face is outside the dead zone on an axis that COULD
      // move, and the window is already clamped against the frame edge there - the
      // camera did everything it could.
      const clampedX = (win.x <= 1e-6 && nearest.cx < centreX) || (win.x >= maxX - 1e-6 && nearest.cx > centreX);
      const clampedY = (win.y <= 1e-6 && nearest.cy < centreY) || (win.y >= maxY - 1e-6 && nearest.cy > centreY);
      const limitedX = canMoveX && offsetX > halfX && clampedX;
      const limitedY = canMoveY && offsetY > halfY && clampedY;
      if (limitedX || limitedY) {
        // The crop cannot move any further towards this person: the framing is as
        // good as the source allows, and that is NOT a camera defect.
        edgeLimited += 1;
      }
      // The COMPLETE HEAD against the crop, never the face centre: a centre can
      // be well inside a dead zone while the side of the head is already
      // clipped. Measured on EVERY checked frame (an edge-limited frame still
      // has a head in it, and dropping it from the denominator is how the old
      // numbers ended up claiming 100% coverage while the head was cut). Only
      // the axes the crop can actually move on are judged - a full-height 9:16
      // window cannot fix a vertical problem in the source.
      const head = headExtent(nearest);
      const cutLeft = canMoveX && nearest.cx - head.halfW < win.x;
      const cutRight = canMoveX && nearest.cx + head.halfW > win.x + options.cropW;
      const cutTop = canMoveY && nearest.cy - head.up < win.y;
      const cutBottom = canMoveY && nearest.cy + head.down > win.y + options.cropH;
      // A head that cannot fit ANYWHERE in the source (clamped against the frame
      // edge on both sides) is not a framing defect - the source has no such shot.
      // It is counted as framed and reported separately, so the percentage stays
      // honest instead of being deflated by an impossible requirement.
      // A head the SOURCE FRAME itself cuts (someone at the edge of the picture)
      // cannot be framed by any crop; neither can a head wider than the crop.
      const outsideSource =
        (canMoveX &&
          (nearest.cx - head.halfW < 0 || nearest.cx + head.halfW > options.srcW)) ||
        (canMoveY && (nearest.cy - head.up < 0 || nearest.cy + head.down > options.srcH)) ||
        (canMoveX && head.halfW * 2 > options.cropW) ||
        (canMoveY && head.up + head.down > options.cropH);
      const unfittable = outsideSource || (cutLeft && cutRight) || (cutTop && cutBottom);

      if (unfittable) {
        headUnfittable += 1;
        insideHead += 1;
        insideSafeHead += 1;
      } else if (cutLeft || cutRight || cutTop || cutBottom) {
        headOutside += 1;
        // Settled frames are the ones a viewer actually sits on; mid-glide frames
        // are on their way, so the split is what separates a framing defect from
        // the unavoidable cost of easing into the new framing.
        if (!isTransition(options.path, t)) headOutsideSettled += 1;
      } else {
        insideHead += 1;
        const marginX = HEAD_SAFETY_MARGIN * options.cropW;
        const marginY = HEAD_SAFETY_MARGIN * options.cropH;
        const tightLeft = canMoveX && nearest.cx - head.halfW < win.x + marginX;
        const tightRight = canMoveX && nearest.cx + head.halfW > win.x + options.cropW - marginX;
        const tightTop = canMoveY && nearest.cy - head.up < win.y + marginY;
        const tightBottom = canMoveY && nearest.cy + head.down > win.y + options.cropH - marginY;
        if (!tightLeft && !tightRight && !tightTop && !tightBottom) {
          insideSafeHead += 1;
        }
      }
    }
  }

  // The plan and its own encoder must agree. `positionAtPath` is the maths the
  // FFmpeg expression is generated from, so a disagreement means a glide was
  // dropped, a cut was overridden, or two moves overlap - the class of bug that
  // shows up as a huge "maximum crop displacement" in a render even though the
  // plan looks fine. Checked once per move boundary (cheap, and where drift starts).
  let maxPathDrift = 0;
  for (const move of options.path.moves) {
    for (const t of [move.t, move.t + move.duration / 2, move.t + move.duration]) {
      const at = positionAtPath(options.path, t);
      const expectedX = Math.max(0, Math.min(at.x, Math.max(0, options.srcW - options.cropW)));
      const expectedY = Math.max(0, Math.min(at.y, Math.max(0, options.srcH - options.cropH)));
      maxPathDrift = Math.max(
        maxPathDrift,
        Math.abs(at.x - expectedX),
        Math.abs(at.y - expectedY),
      );
    }
  }

  const events = options.path.moves.length + (options.path.cuts?.length ?? 0);
  const minutes = Math.max(1 / 60, options.durationSeconds / 60);
  const longest = options.path.moves.reduce((max, move) => Math.max(max, move.duration), 0);

  return {
    pctFramesInDeadzone: settled === 0 ? 100 : Math.round((insideSettled / settled) * 1000) / 10,
    pctFramesInStableBand: settled === 0 ? 100 : Math.round((insideBand / settled) * 1000) / 10,
    pctFramesInDeadzoneAll: checked === 0 ? 100 : Math.round((inside / checked) * 1000) / 10,
    maxOffsetPx: Math.round(maxOffset * 10) / 10,
    maxSettledOffsetPx: Math.round(maxSettledOffset * 10) / 10,
    transitionFrames: transitions,
    motionEventsPerMinute: Math.round((events / minutes) * 10) / 10,
    longestGlideSeconds: Math.round(longest * 1000) / 1000,
    glidesOverHalfSecond: options.path.moves.filter((move) => move.duration > 0.5).length,
    edgeLimitedFrames: edgeLimited,
    framesWithHeadOutsideCrop: headOutside,
    framesWithHeadOutsideCropSettled: headOutsideSettled,
    framesChecked: checked,
    edgeLimited: edgeLimited > 0,
    pctFramesHeadInsideCrop:
      checked === 0 ? 100 : Math.round((insideHead / checked) * 1000) / 10,
    pctFramesHeadSafelyFramed:
      checked === 0 ? 100 : Math.round((insideSafeHead / checked) * 1000) / 10,
    maxPathDriftPx: Math.round(maxPathDrift * 10) / 10,
    framesWithHeadUnfittable: headUnfittable,
  };
}

/**
 * True when the crop is inside a glide at `t` (or a cut lands on that exact frame).
 * During those frames the camera is *supposed* to be off-centre.
 */
export function isTransition(path: CameraPath, t: number): boolean {
  for (const move of path.moves) {
    if (t >= move.t - 1e-9 && t < move.t + move.duration - 1e-9) return true;
  }
  for (const cut of path.cuts ?? []) {
    if (Math.abs(t - cut.t) < 0.05) return true;
  }
  return false;
}

/** Window top-left at `t` for a path (cut-aware). Same maths the FFmpeg expression encodes. */
export function positionAtPath(path: CameraPath, t: number): { x: number; y: number } {
  const cuts = path.cuts ?? [];
  let base = { x: path.x0, y: path.y0 };
  let cutIndex = 0;
  let afterCut = Number.NEGATIVE_INFINITY;
  while (cutIndex < cuts.length && cuts[cutIndex].t <= t + 1e-9) {
    base = { x: cuts[cutIndex].x, y: cuts[cutIndex].y };
    afterCut = cuts[cutIndex].t;
    cutIndex += 1;
  }
  let prev = base;
  for (const move of path.moves) {
    // Moves from BEFORE the last cut belong to the previous shot: the hard cut
    // overrides them (that is what makes a cut a cut).
    if (move.t <= afterCut + 1e-9) continue;
    if (t <= move.t) return prev;
    if (t < move.t + move.duration) {
      const s = smoothstep((t - move.t) / move.duration);
      return { x: prev.x + (move.x - prev.x) * s, y: prev.y + (move.y - prev.y) * s };
    }
    prev = { x: move.x, y: move.y };
  }
  return prev;
}
