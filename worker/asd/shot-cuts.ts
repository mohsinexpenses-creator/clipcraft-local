/**
 * Source SHOT-CUT detection (a hard cut between two camera angles of the same
 * source video) plus the small "never step across a cut" range helpers.
 *
 * Why it exists: the speaker-focus camera used to interpolate its crop window
 * between face detections that sit on OPPOSITE sides of a cut. The tracker keeps
 * the same person id across the cut (their face is where it was relative to the
 * frame), so nothing stopped the planner from drawing one long glide from "where
 * they were in shot A" to "where they are in shot B" - a 5-second pan across two
 * completely different pictures. At a cut the framing must simply change on that
 * exact frame, so the planner needs the cut times.
 *
 * Detection is one cheap FFmpeg pass over a small grayscale copy of the window
 * (`select='gt(scene,TH)'` + `metadata=print`), so it costs a fraction of the
 * frame extraction that runs beside it. Cut times are the *reported `pts_time`*
 * of the first frame after the cut, i.e. the exact frame the planner switches on.
 *
 * Nothing here can fail a render: if the probe fails, is cancelled late, or the
 * source is not decodable by this path, the caller gets no cuts and keeps the old
 * (interpolating) behaviour.
 */
import { runFfmpeg } from "../../lib/ffmpeg";
import { log } from "../../lib/logger";

export interface ShotCutOptions {
  /** Scene score threshold (0..1). Lower = more (and more false) cuts. Default 0.3. */
  threshold?: number;
  /** Cuts closer together than this are one cut. Default 0.5s. */
  minGapSeconds?: number;
  /** Scene-analysis framerate: cuts are located to 1/fps. Default 12. */
  analysisFps?: number;
  /** Analysis width in px (grayscale). Default 160. */
  width?: number;
  /** Safety cap on the number of cuts kept. Default 120. */
  maxCuts?: number;
  /** Ignore cuts this close to the window edges (nothing to anchor). Default 0.25s. */
  edgeSeconds?: number;
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<ShotCutOptions, "signal">> = {
  threshold: 0.3,
  minGapSeconds: 0.5,
  analysisFps: 12,
  width: 160,
  maxCuts: 120,
  edgeSeconds: 0.25,
};

/** One scene-change hit as FFmpeg reported it. */
export interface SceneCutHit {
  /** Clip-relative time of the first frame AFTER the cut (seconds). */
  t: number;
  score: number;
}

/**
 * Parse the `metadata=print` output that FFmpeg writes to stderr for every frame
 * the `select=gt(scene,…)` filter let through:
 *
 *   frame:41 pts:1640 pts_time:1.64
 *   lavfi.scene_score=0.523
 *
 * Pure so it is unit-testable without FFmpeg.
 */
export function parseSceneMetadata(text: string): SceneCutHit[] {
  const hits: SceneCutHit[] = [];
  const lines = text.split(/\r?\n/);
  let pendingT: number | null = null;
  for (const line of lines) {
    const timeMatch = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (timeMatch) {
      const value = Number(timeMatch[1]);
      pendingT = Number.isFinite(value) ? value : null;
      continue;
    }
    const scoreMatch = /lavfi\.scene_score=(\d+(?:\.\d+)?|nan|inf)/i.exec(line);
    if (scoreMatch && pendingT !== null) {
      const score = Number(scoreMatch[1]);
      if (Number.isFinite(score)) hits.push({ t: pendingT, score });
      pendingT = null;
    }
  }
  return hits;
}

/**
 * Collapse raw scene hits into cut times: drop the window edges, merge hits that
 * belong to the same cut (a flash or a fast pan can trip the detector twice), and
 * cap the total.
 */
export function collateSceneCuts(
  hits: SceneCutHit[],
  windowSeconds: number,
  options: Partial<Omit<ShotCutOptions, "signal">> = {},
): number[] {
  const minGap = options.minGapSeconds ?? DEFAULT_OPTIONS.minGapSeconds;
  const edge = options.edgeSeconds ?? DEFAULT_OPTIONS.edgeSeconds;
  const maxCuts = Math.max(0, options.maxCuts ?? DEFAULT_OPTIONS.maxCuts);
  const upper = Math.max(0, windowSeconds - edge);

  // Every frame is reported now (`select='gte(scene,0)'`), so the threshold is
  // applied here: a scene score below it is ordinary movement, not a cut.
  const threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
  const kept: number[] = [];
  for (const hit of [...hits].sort((a, b) => a.t - b.t)) {
    if (!Number.isFinite(hit.t) || hit.t <= edge || hit.t >= upper) continue;
    if (hit.score < threshold) continue;
    const t = Math.round(hit.t * 1000) / 1000;
    const last = kept[kept.length - 1];
    if (last !== undefined && t - last < minGap) continue;
    kept.push(t);
    if (kept.length >= maxCuts) break;
  }
  return kept;
}

/**
 * Detect shot cuts in `[start, start + duration)` of `videoPath`.
 *
 * Returns clip-relative cut times (seconds, ascending). Any failure returns `[]`
 * and logs a warning - a render must never stop because of a scene probe.
 */
export async function detectShotCuts(
  videoPath: string,
  start: number,
  duration: number,
  options: ShotCutOptions = {},
): Promise<number[]> {
  const threshold = clamp(options.threshold ?? DEFAULT_OPTIONS.threshold, 0.05, 0.95);
  const fps = clamp(options.analysisFps ?? DEFAULT_OPTIONS.analysisFps, 2, 30);
  const width = Math.round(clamp(options.width ?? DEFAULT_OPTIONS.width, 64, 640));
  if (!(duration > 0)) return [];

  // `metadata=mode=print` writes to the FFmpeg log, so no temp file path has to
  // survive filter-argument escaping (Windows backslashes and commas).
  //
  // `gte(scene,0)` passes EVERY frame: the scene score is computed for all of them
  // and the threshold is applied here, in JS. Two reasons this matters:
  //   - a render that found no cuts can now say WHY (the highest scene score it
  //     saw), instead of "0 cuts" being indistinguishable from "the probe never
  //     ran" or "the threshold is too high for this footage";
  //   - the threshold can be changed without re-running FFmpeg.
  const filter =
    `fps=${fps.toFixed(3)},scale=${width}:-2:flags=area,format=gray,` +
    `select='gte(scene,0)',metadata=mode=print`;
  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-ss",
    start.toFixed(3),
    "-t",
    Math.max(0.2, duration).toFixed(3),
    "-i",
    videoPath,
    "-an",
    "-sn",
    "-vf",
    filter,
    "-f",
    "null",
    "-",
  ];

  try {
    const { stderr } = await runFfmpeg(args, {
      label: "shot-cuts",
      signal: options.signal,
    });
    const hits = parseSceneMetadata(stderr);
    const cuts = collateSceneCuts(hits, duration, { ...options, threshold });
    // The strongest scene change the probe actually saw. A hard cut between two
    // camera angles scores far above this; ordinary movement, lighting changes and
    // a speaker walking across frame stay low. Logging it is what makes "no cuts in
    // this window" a measurement rather than a guess.
    const peak = hits.reduce((max, hit) => Math.max(max, hit.score), 0);
    const nearMiss = hits
      .filter((hit) => hit.score >= Math.max(0.1, threshold * 0.6) && !cuts.some((cut) => Math.abs(cut - hit.t) < 0.05))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    log.detail(
      `[SHOT-CUTS] event=detected window=${start.toFixed(3)}+${duration.toFixed(3)}s ` +
        `threshold=${threshold.toFixed(2)} fps=${fps} cuts=${cuts.length} ` +
        `sampled=${hits.length} peak_score=${peak.toFixed(2)}` +
        (cuts.length > 0 ? ` times=${cuts.map((t) => t.toFixed(2)).join(",")}` : "") +
        (cuts.length === 0 && nearMiss.length > 0
          ? ` rejected=${nearMiss.map((hit) => `${hit.t.toFixed(2)}s:${hit.score.toFixed(2)}`).join(",")}`
          : ""),
    );
    return cuts;
  } catch (error) {
    log.warn(
      `[SHOT-CUTS] event=failed window=${start.toFixed(3)}+${duration.toFixed(3)}s ` +
        `reason="${error instanceof Error ? error.message : String(error)}" ` +
        `- continuing without cut boundaries (camera may interpolate across a cut).`,
    );
    return [];
  }
}

/**
 * Split an ordered list of timed points into one group per shot: a point belongs
 * to the shot its own timestamp falls in, so a cut can never sit inside a group
 * and no consumer can interpolate across one.
 */
export function splitTimesAtCuts<T extends { t: number }>(points: T[], cuts: number[]): T[][] {
  if (cuts.length === 0 || points.length === 0) return points.length > 0 ? [points] : [];
  const sorted = [...cuts].sort((a, b) => a - b);
  const groups: T[][] = [];
  let current: T[] = [];
  let shot = 0;
  for (const point of points) {
    while (shot < sorted.length && point.t >= sorted[shot] - 1e-6) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      shot += 1;
    }
    current.push(point);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Split `[t0, t1]` at every cut it contains. Always returns at least one range. */
export function clipRangeToCuts(t0: number, t1: number, cuts: number[]): Array<[number, number]> {
  const inside = cuts
    .filter((cut) => cut > t0 + 1e-6 && cut < t1 - 1e-6)
    .sort((a, b) => a - b);
  if (inside.length === 0) return [[t0, t1]];
  const ranges: Array<[number, number]> = [];
  let from = t0;
  for (const cut of inside) {
    ranges.push([from, cut]);
    from = cut;
  }
  ranges.push([from, t1]);
  return ranges;
}

/** The cut that falls inside `(t0, t1]`, or null. */
export function cutBetween(t0: number, t1: number, cuts: number[]): number | null {
  let found: number | null = null;
  for (const cut of cuts) {
    if (cut > t0 + 1e-6 && cut <= t1 + 1e-6 && (found === null || cut < found)) found = cut;
  }
  return found;
}

/** A cut at (or immediately after) `t`, so the planner can switch on that frame. */
export function cutAt(t: number, cuts: number[], tolerance = 1e-3): number | null {
  for (const cut of cuts) {
    if (Math.abs(cut - t) <= tolerance) return cut;
  }
  return null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
