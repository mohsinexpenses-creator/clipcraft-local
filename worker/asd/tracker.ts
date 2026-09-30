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
  /** Normalised full-face motion 0..1 vs the previous sampled frame (thumb diff), or null. */
  motion?: number | null;
}

export interface TrackPoint {
  t: number;
  cx: number;
  cy: number;
  w: number;
  mouthOpen: number | null;
  /** Normalised full-face motion 0..1 vs the previous sampled frame, or null. */
  motion: number | null;
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

export interface TrackerOptions {
  /** How many consecutive missed frames before a track is closed. */
  maxMissed?: number;
  /** Association gate = gateFactor * (track.w + det.w) + jitterTolerance. */
  gateFactor?: number;
  /** Extra absolute tolerance (pixels) so tiny/zoomed faces still associate. */
  jitterTolerance?: number;
}

/**
 * Tightened defaults (2026-09): reject flicker/false-positive tracks.
 *  - maxMissed 3: a track dies after ~0.75s @4fps instead of 2s, so a false
 *    wall-"face" that flickers in/out cannot accumulate 2s of visible time.
 *  - gateFactor 0.5: a detection must sit near the track's predicted position.
 *  - jitterTolerance 30: far-away detections cannot glom onto a track or spawn
 *    new ones as easily.
 */
const DEFAULT_OPTIONS: Required<TrackerOptions> = {
  maxMissed: 3,
  gateFactor: 0.5,
  jitterTolerance: 30,
};

export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private readonly opts: Required<TrackerOptions>;
  /** Last sample time, for dt. */
  private lastSampleT: number | null = null;

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
      track.points.push({ t, cx: det.cx, cy: det.cy, w: det.w, mouthOpen: det.mouthOpen, motion: det.motion ?? null });
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

    track.points.push({ t, cx: det.cx, cy: det.cy, w: det.w, mouthOpen: det.mouthOpen, motion: det.motion ?? null });
    track.visibleTime += dt;
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
