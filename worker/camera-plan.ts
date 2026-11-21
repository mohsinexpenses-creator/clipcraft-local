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
 *                across a cut.
 *   6. CUTAWAYS (opt-in, `SPEAKER_CUTAWAYS=on`) - hold the speaker
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
  CameraMove,
  CameraPath,
  CameraSample,
  HEAD_DOWN,
  HEAD_HALF_WIDTH,
  HEAD_UP,
  FACE_DEADZONE_HYSTERESIS,
  buildLockedCamera,
  filterSamples,
  headInsideSafeZone,
  smoothstep,
  windowFor,
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
  /** Speaker-change glide length. Default 0.1 s. */
  speakerGlideSeconds?: number;
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
}

export const CAMERA_PLAN_DEFAULTS = {
  settleSeconds: 1,
  deadZoneXPct: 0.1,
  deadZoneYPct: 0.08,
  confirmSeconds: 0.4,
  recentreSeconds: 0.35,
  recentreLookbackSeconds: 0.5,
  speakerGlideSeconds: 0.1,
  switchMode: 'glide' as CameraSwitchMode,
  cutaways: false,
  speakerHoldSeconds: 6,
  cutawaySeconds: 2,
  cutawayPick: 'random' as CutawayPickMode,
  cutawayMinSizeRatio: 0.45,
  cutawayMinCoverage: 0.8,
  maxMoves: 400,
};

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
  /** Speaker changes (t, who, how). */
  switches: Array<{ t: number; trackId: number; mode: 'cut' | 'glide' }>;
  cutaways: Array<{ t: number; duration: number; trackId: number; speakerId: number }>;
  /** Cutaways that were considered and rejected, with the reason. */
  skippedCutaways: Array<{ t: number; reason: string }>;
  /** Camera events: every glide plus every hard switch. */
  keyframes: number;
  glides: number;
  cuts: number;
  options: CameraPlanResolvedOptions;
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
  switchMode: CameraSwitchMode;
  cutaways: boolean;
  speakerHoldSeconds: number;
  cutawaySeconds: number;
  cutawayPick: CutawayPickMode;
  cutawaySeed: number;
  cutawayMinSizeRatio: number;
  cutawayMinCoverage: number;
  maxMoves: number;
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
      .map((point) => ({ t: point.t, cx: point.cx, cy: point.cy, w: point.w }))
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
  for (const run of buildSpeakerRuns(segments, opts.cuts)) {
    const track = byId.get(run.trackId);
    if (!track) continue;
    let settled = samplesBetween(track, run.t0, Math.min(run.t1, run.t0 + opts.settleSeconds));
    if (settled.length === 0) settled = samplesBetween(track, run.t0, run.t1);
    if (settled.length === 0) continue;
    const cx = median(settled.map((sample) => sample.cx));
    const cy = median(settled.map((sample) => sample.cy));
    runs.push({
      ...run,
      anchor: windowFor(cx, cy, shape),
      face: { cx, cy },
      settleSamples: settled.length,
    });
  }

  const cutaways: CameraPlan['cutaways'] = [];
  const skippedCutaways: CameraPlan['skippedCutaways'] = [];
  if (opts.cutaways) {
    collectCutaways(runs, byId, opts, cutaways, skippedCutaways);
  }

  const { path, segments: timeline } = planTimeline(runs, cutaways, byId, opts, shape);

  // Real speaker switches only: the cutaway visits have their own counter, so a
  // switch here means "the conversation moved to another person".
  const lockSegments = timeline.filter((segment) => segment.kind === 'lock');
  const switches: CameraPlan['switches'] = [];
  for (let i = 1; i < lockSegments.length; i += 1) {
    const previous = lockSegments[i - 1];
    if (previous.trackId === lockSegments[i].trackId) continue;
    switches.push({
      t: lockSegments[i].start,
      trackId: lockSegments[i].trackId,
      mode: lockSegments[i].entry === 'cut' ? 'cut' : 'glide',
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
    options: opts,
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
  shape: ReturnType<typeof windowShapeOf>
): { path: CameraPath; segments: CameraSegment[] } {
  if (runs.length === 0) {
    return {
      path: {
        x0: Math.max(0, (opts.srcW - opts.cropW) / 2),
        y0: Math.max(0, (opts.srcH - opts.cropH) / 2),
        moves: [],
        truncated: false,
      },
      segments: [],
    };
  }

  const cuts: CameraCut[] = [];
  const moves: CameraMove[] = [];
  const segments: CameraSegment[] = [];
  const x0 = runs[0].anchor.x;
  const y0 = runs[0].anchor.y;
  let busyUntil = -Infinity;
  let moveBudgetHit = false;

  /** Add a window change at `t`; returns how long the window is busy. */
  const enter = (
    t: number,
    pos: { x: number; y: number },
    hard: boolean
  ): { arrive: number; duration: number; entry: CameraSegment['entry'] } => {
    if (hard) {
      cuts.push({ t: round3(t), x: pos.x, y: pos.y });
      busyUntil = Math.max(busyUntil, t);
      return { arrive: t, duration: 0, entry: 'cut' };
    }
    const duration = opts.speakerGlideSeconds;
    if (moves.length + cuts.length >= opts.maxMoves) {
      moveBudgetHit = true;
      return { arrive: t, duration: 0, entry: 'cut' };
    }
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
    if (previous) {
      const shotChanged = previous.shot !== run.shot;
      const speakerChanged = previous.trackId !== run.trackId;
      if (shotChanged) {
        // 5) CUT: the window is already on the new shot's anchor at the cut frame.
        const entered = enter(at, run.anchor, true);
        entry = entered.entry;
        arrive = entered.arrive;
      } else if (speakerChanged) {
        // 4) SWITCH
        const hard = opts.switchMode === 'cut';
        const entered = enter(at, run.anchor, hard);
        entry = entered.entry;
        arrive = entered.arrive;
      } else if (
        // A NEW SHOT always re-anchors, even when the same person keeps talking
        // across the cut (the face moved because the camera angle changed).
        opts.cuts.some((cut) => cut > previous.t1 - 1e-6 && cut <= run.t0 + 1e-6) ||
        Math.abs(run.anchor.x - previous.anchor.x) >= 1 ||
        Math.abs(run.anchor.y - previous.anchor.y) >= 1
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
    const pushLock = (start: number, until: number, pos: { x: number; y: number }, kind: CameraSegment['entry']) => {
      if (until - start <= 1e-6) return;
      segments.push({
        kind: 'lock',
        trackId: run.trackId,
        start: round3(start),
        arrive: round3(kind === 'glide' ? start : start),
        until: round3(until),
        pos: { x: pos.x, y: pos.y },
        entry: kind,
      });
    };

    pushLock(at, runCutaways.length > 0 ? runCutaways[0].t : run.t1, currentPos, entry);

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
    },
    segments,
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
  framesChecked: number;
  edgeLimited: boolean;
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
    return { t: forward.t, cx: forward.cx, cy: forward.cy, w: forward.w };
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
  return { t: best.t, cx: best.cx, cy: best.cy, w: best.w };
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
  let transitions = 0;

  const step = 0.1;
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.t0, options.durationSeconds));
    const to = Math.max(from, Math.min(range.t1, options.durationSeconds));
    for (let t = from; t < to; t += step) {
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
      } else if (
        (canMoveX &&
          (nearest.cx - HEAD_HALF_WIDTH * nearest.w < win.x ||
            nearest.cx + HEAD_HALF_WIDTH * nearest.w > win.x + options.cropW)) ||
        (canMoveY &&
          (nearest.cy - HEAD_UP * nearest.w < win.y ||
            nearest.cy + HEAD_DOWN * nearest.w > win.y + options.cropH))
      ) {
        headOutside += 1;
      }
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
    framesChecked: checked,
    edgeLimited: edgeLimited > 0,
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
