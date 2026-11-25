/**
 * Lightweight multi-face tracker that assigns a STABLE ID to each person
 * across the sampled frames ("Person A", "Person B", ...).
 *
 * This is deliberately NOT face recognition - we never learn who anyone is.
 * It is a constant-velocity nearest-neighbour tracker:
 *
 *   predict each open track's position (x += vx*dt), match detections to
 *   tracks by gated distance, update velocity, and keep a track alive for a
 *   few frames after it is lost.
 *
 * The "keep alive" grace period is what lets a person survive the exact
 * obstructions the mouth cue cannot: a microphone swung in front of the face,
 * a hand covering it, a brief overlap with another person. Their ID and
 * position estimate persist through the gap, so the framing never loses them.
 *
 * Pure logic: no I/O, no models - fully unit-testable with synthetic frames.
 */

export interface FrameDetection {
  /** Face centre X in the frame's own pixel space. */
  cx: number;
  /** Face centre Y in the frame's own pixel space. */
  cy: number;
  /** Face box width (also used as the association gate scale). */
  w: number;
  /** Normalised mouth openness 0..1, or null when no landmark cue exists. */
  mouthOpen: number | null;
  /**
   * Normalised full-face motion 0..1 vs the previous sampled frame (thumb diff),
   * ALREADY relative to the background that surrounds the face.
   *
   * A camera that shakes or zooms moves the whole image, so a printed poster's
   * "face" changes exactly as much as the wall around it - and a raw pixel diff
   * cannot tell that from a person turning their head. `./index` measures a RING
   * of background around the box and subtracts its motion here, so this value is
   * "how much did this face move on its own", not "how much did these pixels
   * change". Null only when no measurement exists at all.
   */
  motion?: number | null;
  /**
   * Raw face-region motion (0..1) before it was made background-relative, and the
   * motion of the surrounding ring it was compared against. Both are optional so
   * every existing producer of a FrameDetection stays valid; `isLikelyLiveTrack`
   * only ever uses them to make a borderline track stricter.
   */
  faceMotion?: number | null;
  backgroundMotion?: number | null;
}

export interface TrackPoint {
  t: number;
  cx: number;
  cy: number;
  w: number;
  mouthOpen: number | null;
  /**
   * Normalised face motion 0..1 that is RELATIVE to the surrounding background
   * (see FrameDetection.motion). Null when no motion could be measured.
   */
  motion: number | null;
  /** Raw face motion before background subtraction (optional, diagnostics). */
  faceMotion?: number | null;
  /** Motion of the background ring around the face at the same instant. */
  backgroundMotion?: number | null;
  /**
   * True when this sighting came from a PERSON (body) box while the face was lost
   * - the person is there but their face pixels were never measured. Speaker
   * fusion uses this to fall back to audio + scene motion instead of pretending
   * the face was still.
   */
  personHold?: boolean;
}

export interface Track {
  /** Stable identity for this person within the clip (1-based). */
  id: number;
  /** Observed positions over time (one per frame the person was visible). */
  points: TrackPoint[];
  /** Total seconds this person was on screen. */
  visibleTime: number;
  /** Mean / max face width across their sightings (source pixels). */
  avgW: number;
  maxW: number;
  /** Last known centre + velocity, used to predict through gaps. */
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  lastT: number;
  /** Consecutive frames without a match (0 = currently visible). */
  missed: number;
}

/**
 * A RIGID image can only produce "liveness" if the face really moves more than
 * its surroundings. Points that carried a background measurement must clear this
 * ratio, otherwise they count as exactly zero motion (a poster under a shaking
 * camera, a zoom onto a framed photo, a pan across a wall).
 *
 * The floor keeps honest motion measurable: on an almost still shot the ring
 * motion is ~0.001, so the ratio would otherwise turn a genuine 0.02 lip movement
 * into noise. Only when the surroundings move MEANINGFULLY do we ask whether this
 * face out-moved them.
 */
const RIGID_FACE_RATIO = 1.5;
const RIGID_BACKGROUND_FLOOR = 0.006;
const RIGID_BACKGROUND_CEILING = 0.05;

/**
 * Effective motion of one point: face motion measured RELATIVE to its background.
 *
 *  - no background measurement (old producers / interpolated points) -> unchanged;
 *  - background almost still -> the face's own motion is real, keep it;
 *  - background moving a lot -> subtract it (rigid content nets out to ~0).
 */
export function effectiveFaceMotion(point: {
  motion: number | null;
  faceMotion?: number | null;
  backgroundMotion?: number | null;
}): number | null {
  const background = point.backgroundMotion;
  if (background === null || background === undefined || !Number.isFinite(background)) {
    return point.motion;
  }
  // Prefer the raw face measurement when the caller kept it; `motion` is already
  // the relative value, so using it here would subtract the ring twice.
  const face =
    point.faceMotion !== null && point.faceMotion !== undefined && Number.isFinite(point.faceMotion)
      ? point.faceMotion
      : point.motion;
  if (face === null || face === undefined || !Number.isFinite(face)) return null;
  if (background <= RIGID_BACKGROUND_FLOOR) return face;
  if (face <= background * RIGID_FACE_RATIO) return 0;
  return Math.max(0, face - background);
}

/** True when this point was measured against a background that really moved. */
function hasRigidBackground(point: {
  backgroundMotion?: number | null;
}): boolean {
  const background = point.backgroundMotion;
  return (
    background !== null &&
    background !== undefined &&
    Number.isFinite(background) &&
    background > RIGID_BACKGROUND_CEILING
  );
}

/**
 * Reject one-frame codec flicker: a live face needs repeated, meaningful change.
 *
 * The motion values are background-relative, so camera shake and zoom cannot
 * promote a printed poster into a "person". A track that spent most of its life
 * on a shot whose whole image moved (a handheld pan across a wall) must also show
 * at least one moment where the face moved on its own - otherwise it is a rigid
 * pattern that happened to follow the camera.
 */
export function isLikelyLiveTrack(track: Track): boolean {
  const points = track.points.filter(
    (point) => point.motion !== null || point.backgroundMotion != null,
  );
  const motion = points
    .map((point) => effectiveFaceMotion(point))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (track.points.length < 5 || motion.length < 4) return false;

  const sorted = [...motion].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMotion =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  const meaningfulFrames = motion.filter((value) => value >= 0.025).length;

  const live =
    medianMotion >= 0.018 &&
    meaningfulFrames >= Math.max(3, Math.ceil(motion.length * 0.3));
  if (!live) return false;

  // Rigid-pattern guard: when the surroundings moved for most of this track, the
  // face itself must at some point have out-moved them.
  const rigidFrames = points.filter(hasRigidBackground).length;
  if (rigidFrames >= Math.max(3, Math.ceil(points.length * 0.5))) {
    return motion.some((value) => value >= 0.025);
  }
  return true;
}

/** Copy a detection into a track point, keeping the optional motion measurements. */
function toTrackPoint(det: FrameDetection, t: number): TrackPoint {
  const point: TrackPoint = {
    t,
    cx: det.cx,
    cy: det.cy,
    w: det.w,
    mouthOpen: det.mouthOpen,
    motion: det.motion ?? null,
  };
  if (det.faceMotion !== undefined) point.faceMotion = det.faceMotion;
  if (det.backgroundMotion !== undefined) point.backgroundMotion = det.backgroundMotion;
  return point;
}

export interface TrackerOptions {
  /** How many consecutive missed frames before a track is closed. */
  maxMissed?: number;
  /** Association gate = gateFactor * (track.w + det.w) + jitterTolerance. */
  gateFactor?: number;
  /** Extra absolute tolerance (pixels) so tiny/zoomed faces still associate. */
  jitterTolerance?: number;
  /**
   * Signal every track association was WRONG: a source shot cut happened at time
   * `t`. Every open track is closed on the spot, so no identity can continue
   * across two camera angles. The next frame's detections all start fresh tracks.
   *
   * This matters because a cut usually re-frames the SAME person elsewhere on
   * screen: without the reset, the constant-velocity prediction happily matches
   * them onto their own old track and the camera's "new shot" anchor inherits a
   * position from the previous shot. Positions must never be carried across a cut.
   */
  signalShotCut?: (t: number) => void;
}

/**
 * Tightened defaults (2026-09): reject flicker/false-positive tracks.
 *  - maxMissed 3: a track dies after ~0.75s @4fps instead of 2s, so a false
 *    wall-"face" that flickers in/out cannot accumulate 2s of visible time.
 *  - gateFactor 0.5: a detection must sit near the track's predicted position.
 *  - jitterTolerance 30: far-away detections cannot glom onto a track or spawn
 *    new ones as easily.
 */
const DEFAULT_OPTIONS = {
  maxMissed: 3,
  gateFactor: 0.5,
  jitterTolerance: 30,
} as const;

type ResolvedTrackerOptions = {
  maxMissed: number;
  gateFactor: number;
  jitterTolerance: number;
};

export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private readonly opts: ResolvedTrackerOptions;
  /** Last sample time, for dt. */
  private lastSampleT: number | null = null;
  /** Cuts already consumed, so one cut resets the tracker exactly once. */
  private readonly consumedCuts = new Set<number>();

  constructor(options: TrackerOptions = {}) {
    this.opts = {
      maxMissed: options.maxMissed ?? DEFAULT_OPTIONS.maxMissed,
      gateFactor: options.gateFactor ?? DEFAULT_OPTIONS.gateFactor,
      jitterTolerance: options.jitterTolerance ?? DEFAULT_OPTIONS.jitterTolerance,
    };
  }

  /**
   * Consume one sampled frame's detections (already scaled to source pixels).
   * Returns the currently OPEN tracks (including those in their grace period).
   */
  update(t: number, dets: FrameDetection[]): Track[] {
    const dt = this.lastSampleT === null ? 0 : Math.max(1e-4, t - this.lastSampleT);
    this.lastSampleT = t;

    const open = this.tracks.filter((track) => track.missed < this.opts.maxMissed);

    // Predict each open track's position at time t.
    const predicted = open.map((track) => {
      const px = track.cx + track.vx * dt;
      const py = track.cy + track.vy * dt;
      return { track, px, py };
    });

    // Build gated (track, detection) cost pairs.
    type Pair = { track: Track; det: FrameDetection; cost: number };
    const pairs: Pair[] = [];
    for (const cand of predicted) {
      for (const det of dets) {
        const gate =
          this.opts.gateFactor * (cand.track.maxW + det.w) + this.opts.jitterTolerance;
        const dist = Math.hypot(det.cx - cand.px, det.cy - cand.py);
        if (dist <= gate) {
          pairs.push({ track: cand.track, det, cost: dist / Math.max(1, gate) });
        }
      }
    }

    // Greedy assignment, cheapest first (1 detection per track, 1 track per det).
    pairs.sort((a, b) => a.cost - b.cost);
    const matchedTrack = new Set<Track>();
    const matchedDet = new Set<FrameDetection>();
    for (const pair of pairs) {
      if (matchedTrack.has(pair.track) || matchedDet.has(pair.det)) continue;
      matchedTrack.add(pair.track);
      matchedDet.add(pair.det);
      this.assign(pair.track, pair.det, t, dt);
    }

    // Unmatched open tracks are entering a (temporary) occlusion.
    for (const track of open) {
      if (!matchedTrack.has(track)) track.missed += 1;
    }

    // Unmatched detections are new people.
    for (const det of dets) {
      if (matchedDet.has(det)) continue;
      const track: Track = {
        id: this.nextId++,
        points: [],
        visibleTime: 0,
        avgW: det.w,
        maxW: det.w,
        cx: det.cx,
        cy: det.cy,
        vx: 0,
        vy: 0,
        lastT: t,
        missed: 0,
      };
      track.points.push(toTrackPoint(det, t));
      track.visibleTime += dt;
      this.tracks.push(track);
    }

    return this.tracks.filter((track) => track.missed < this.opts.maxMissed);
  }

  private assign(track: Track, det: FrameDetection, t: number, dt: number): void {
    // Update velocity with an exponential blend (new motion dominates).
    const nvx = (det.cx - track.cx) / dt;
    const nvy = (det.cy - track.cy) / dt;
    track.vx = 0.35 * track.vx + 0.65 * nvx;
    track.vy = 0.35 * track.vy + 0.65 * nvy;

    track.cx = det.cx;
    track.cy = det.cy;
    track.lastT = t;
    track.missed = 0;
    track.maxW = Math.max(track.maxW, det.w);
    track.avgW = (track.avgW * (track.points.length + 1) - track.avgW + det.w) / (track.points.length + 1);

    track.points.push(toTrackPoint(det, t));
    track.visibleTime += dt;
  }

  /**
   * Keep a track ALIVE through a frame where the face detector found nothing but
   * a person (body) detector still sees the same person: they turned away, looked
   * down, or something covered their face. Without this the track closes after
   * `maxMissed` samples (~0.75 s at 4 fps) and the camera loses its subject.
   *
   * The fallback is only reachable up to `maxMissed` (the tracker's normal grace)
   * - one notch less than that for the body detector's own sampling rate, which
   * is slower than the face pass. After that the track closes exactly as before,
   * so a body cannot keep a person alive indefinitely.
   *
   * The recorded point carries `motion: null` (no face pixels were measured), so
   * it can never manufacture a speaker cue; it only holds the identity and the
   * position estimate.
   */
  holdThroughPersonGap(
    trackId: number,
    t: number,
    face: { cx: number; cy: number; w: number; h: number },
  ): boolean {
    const track = this.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    if (track.missed >= this.opts.maxMissed) return false;

    const dt = this.lastSampleT === null ? 0 : Math.max(1e-4, t - this.lastSampleT);
    if (dt > 0 && track.points.length > 0) {
      const nvx = (face.cx - track.cx) / dt;
      const nvy = (face.cy - track.cy) / dt;
      track.vx = 0.35 * track.vx + 0.65 * nvx;
      track.vy = 0.35 * track.vy + 0.65 * nvy;
    }
    track.cx = face.cx;
    track.cy = face.cy;
    track.lastT = t;
    // A held track is still on screen; the identity must not age out on the same
    // frame the body detector confirmed it.
    track.missed = 0;
    track.points.push({
      t,
      cx: face.cx,
      cy: face.cy,
      w: face.w,
      mouthOpen: null,
      motion: null,
      faceMotion: null,
      backgroundMotion: null,
      personHold: true,
    });
    track.visibleTime += dt;
    return true;
  }

  /**
   * The OPEN tracks right now, as lightweight hints for the person detector's
   * matcher (predicted position + velocity, no point history).
   */
  openTrackHints(): Array<{
    id: number;
    cx: number;
    cy: number;
    w: number;
    vx: number;
    vy: number;
    lastT: number;
  }> {
    return this.tracks
      .filter((track) => track.missed < this.opts.maxMissed && track.points.length > 0)
      .map((track) => ({
        id: track.id,
        cx: track.cx,
        cy: track.cy,
        w: track.maxW,
        vx: track.vx,
        vy: track.vy,
        lastT: track.lastT,
      }));
  }

  /**
   * Close every open track as of `t` because the source cut to a new camera angle.
   *
   * The closed tracks keep their history (the camera still needs to know where
   * people WERE), but nothing in them is eligible to match the post-cut frames, so
   * a new shot always produces genuinely new positions. Idempotent per cut time.
   */
  resetAtShotCut(t: number): void {
    const key = Math.round(t * 1000) / 1000;
    if (this.consumedCuts.has(key)) return;
    this.consumedCuts.add(key);
    for (const track of this.tracks) {
      if (track.missed < this.opts.maxMissed) track.missed = this.opts.maxMissed;
    }
    // A new shot has no meaningful sample interval from the old one.
    this.lastSampleT = null;
  }

  /** All tracks ever opened (open + closed), sorted by id. */
  all(): Track[] {
    return [...this.tracks].sort((a, b) => a.id - b.id);
  }

  /** Tracks with at least one sighting. */
  allVisible(): Track[] {
    return this.all().filter((track) => track.points.length > 0);
  }
}
