import type { Track, TrackPoint } from "./tracker";

/**
 * The established high-evidence profile. It remains the explicit quality
 * setting and the adaptive retry path for clips with weak face evidence.
 */
export const ASD_QUALITY_SAMPLE_WIDTH = 960;
export const ASD_QUALITY_MAX_SAMPLE_FPS = 8;
export const ASD_QUALITY_MAX_FRAMES = 480;
export const ASD_QUALITY_JPEG_QUALITY = 3;

/**
 * The Phase 1 default: enough horizontal detail for a podcast wide shot, while
 * retaining the former fast pass's bounded four-fps / 240-frame detector load.
 */
export const ASD_BALANCED_SAMPLE_WIDTH = 960;
export const ASD_BALANCED_MAX_SAMPLE_FPS = 4;
export const ASD_BALANCED_MAX_FRAMES = 240;
export const ASD_BALANCED_JPEG_QUALITY = 3;

/**
 * The previous adaptive first pass. It is intentionally retained behind
 * `ASD_INITIAL_PROFILE=legacy-fast` for an exact sampling rollback.
 */
export const ASD_FAST_SAMPLE_WIDTH = 640;
export const ASD_FAST_MAX_SAMPLE_FPS = 4;
export const ASD_FAST_MAX_FRAMES = 240;
export const ASD_FAST_JPEG_QUALITY = 5;

export type AsdInitialProfile = "balanced" | "legacy-fast" | "quality";

export interface AsdSamplingProfile {
  name: "fast" | "balanced" | "quality";
  maxFps: number;
  maxFrames: number;
  sampleWidth: number;
  jpegQuality: number;
}

export interface AsdSamplingPlan {
  initial: AsdSamplingProfile;
  /** Retry this higher-quality profile only if the initial face evidence is weak. */
  qualityFallback: AsdSamplingProfile | null;
  /** The cadence used by speaker fusion after interpolating adjacent sightings. */
  analysisFps: number;
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? "");
}

/**
 * Adaptive sampling remains available as a safe quality-only rollback. Set
 * `ASD_ADAPTIVE_SAMPLING=0` to begin and remain on the 8fps/480-frame profile.
 */
export function getAdaptiveAsdSamplingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isExplicitlyDisabled(env.ASD_ADAPTIVE_SAMPLING);
}

/**
 * `balanced` is the default Phase 1 profile. `legacy-fast` restores the prior
 * 640px JPEG first pass; `quality` is the direct no-downsampling comparison.
 */
export function getAsdInitialProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AsdInitialProfile {
  switch (env.ASD_INITIAL_PROFILE?.trim().toLowerCase()) {
    case "legacy-fast":
    case "fast":
      return "legacy-fast";
    case "quality":
      return "quality";
    default:
      return "balanced";
  }
}

/**
 * Bound concurrent JPEG decode + YuNet passes. Tracker and speaker fusion stay
 * sequential so identity and speech decisions preserve input-frame order.
 */
export function getAsdDetectionConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.ASD_DETECTION_CONCURRENCY?.trim());
  if (Number.isFinite(configured) && configured >= 1 && configured <= 3) {
    return Math.floor(configured);
  }
  return 2;
}

/**
 * Once several recent wide-shot samples contain only small faces, tile scans
 * provide the useful evidence and the letterboxed full-frame pass is redundant.
 * Set to 0 to retain the exact previous per-frame detector passes.
 */
export function getAsdSkipFullFrameOnWideShotsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isExplicitlyDisabled(env.ASD_SKIP_FULL_FRAME_ON_WIDE_SHOTS);
}

/** Clamp a sampled width exactly like FFmpeg's even-sized scale input. */
export function asdSampleWidth(limit: number, sourceWidth: number): number {
  return Math.max(160, Math.min(limit, Math.floor(sourceWidth / 2) * 2));
}

/**
 * Pick a bounded initial profile and preserve the established quality pass as a
 * fallback. Caller-supplied ceilings are always respected.
 */
export function buildAsdSamplingPlan(options: {
  sourceWidth: number;
  maxSampleFps?: number;
  maxFrames?: number;
  adaptive: boolean;
  initialProfile?: AsdInitialProfile;
}): AsdSamplingPlan {
  const qualityMaxFps = options.maxSampleFps ?? ASD_QUALITY_MAX_SAMPLE_FPS;
  const qualityMaxFrames = options.maxFrames ?? ASD_QUALITY_MAX_FRAMES;
  const quality: AsdSamplingProfile = {
    name: "quality",
    maxFps: qualityMaxFps,
    maxFrames: qualityMaxFrames,
    sampleWidth: asdSampleWidth(ASD_QUALITY_SAMPLE_WIDTH, options.sourceWidth),
    jpegQuality: ASD_QUALITY_JPEG_QUALITY,
  };

  const requestedInitial = options.initialProfile ?? "balanced";
  if (!options.adaptive || requestedInitial === "quality") {
    return { initial: quality, qualityFallback: null, analysisFps: quality.maxFps };
  }

  const fast: AsdSamplingProfile = {
    name: "fast",
    maxFps: Math.min(ASD_FAST_MAX_SAMPLE_FPS, quality.maxFps),
    maxFrames: Math.min(ASD_FAST_MAX_FRAMES, quality.maxFrames),
    sampleWidth: asdSampleWidth(ASD_FAST_SAMPLE_WIDTH, options.sourceWidth),
    jpegQuality: ASD_FAST_JPEG_QUALITY,
  };
  const balanced: AsdSamplingProfile = {
    name: "balanced",
    maxFps: Math.min(ASD_BALANCED_MAX_SAMPLE_FPS, quality.maxFps),
    maxFrames: Math.min(ASD_BALANCED_MAX_FRAMES, quality.maxFrames),
    sampleWidth: asdSampleWidth(ASD_BALANCED_SAMPLE_WIDTH, options.sourceWidth),
    jpegQuality: ASD_BALANCED_JPEG_QUALITY,
  };
  const initial = requestedInitial === "legacy-fast" ? fast : balanced;
  const differsFromQuality =
    initial.maxFps < quality.maxFps ||
    initial.maxFrames < quality.maxFrames ||
    initial.sampleWidth < quality.sampleWidth ||
    initial.jpegQuality !== quality.jpegQuality;

  return {
    initial,
    qualityFallback: differsFromQuality ? quality : null,
    analysisFps: quality.maxFps,
  };
}

export interface AsdSampleQuality {
  framesTotal: number;
  framesWithFaces: number;
  tracks: number;
  /** Face width in the decoded sample, before projection back to source pixels. */
  medianSampleFaceWidth: number;
}

/**
 * The cheap pass only wins when it has comfortably usable evidence. A retry is
 * intentionally conservative: we preserve the established high-resolution path
 * rather than emitting a weaker crop when faces are absent, fleeting, or tiny.
 */
export function getAsdQualityFallbackReason(quality: AsdSampleQuality): string | null {
  if (quality.tracks === 0 || quality.framesWithFaces === 0) {
    return "no faces were tracked";
  }
  const faceCoverage = quality.framesWithFaces / Math.max(1, quality.framesTotal);
  if (quality.framesTotal >= 8 && faceCoverage < 0.25) {
    return `faces appeared in only ${Math.round(faceCoverage * 100)}% of samples`;
  }
  // At 640px a 36px box is close to the edge where JPEG/downscale detail can
  // erase lip motion or a second participant. The old 960px sample gets a
  // chance before layout/speaker planning commits to this evidence.
  if (quality.medianSampleFaceWidth > 0 && quality.medianSampleFaceWidth < 36) {
    return `median sampled face was only ${Math.round(quality.medianSampleFaceWidth)}px`;
  }
  return null;
}

function between(a: number, b: number, fraction: number): number {
  return a + (b - a) * fraction;
}

/**
 * Fill only the gaps between CONSECUTIVE sightings of the same track onto a
 * denser analysis grid. Synthesized points are deliberately motionless: visual
 * speech evidence still comes solely from measured frames, so interpolation
 * smooths camera/layout continuity without fabricating a talking cue.
 */
export function interpolateTracksForAnalysis(
  tracks: Track[],
  sampledFps: number,
  analysisFps: number,
): Track[] {
  if (
    !Number.isFinite(sampledFps) ||
    !Number.isFinite(analysisFps) ||
    sampledFps <= 0 ||
    analysisFps <= sampledFps + 1e-6
  ) {
    return tracks;
  }

  // A gap wider than one normal sampling interval means YuNet missed the face
  // or it left the frame. Never draw a synthetic person through that absence.
  const maximumInterpolatedGap = 1.25 / sampledFps;
  const epsilon = 1e-6;

  return tracks.map((track) => {
    if (track.points.length < 2) return track;
    const measured = [...track.points].sort((a, b) => a.t - b.t);
    const points: TrackPoint[] = [];

    for (let index = 0; index < measured.length; index += 1) {
      const current = measured[index];
      points.push(current);
      const next = measured[index + 1];
      if (!next) continue;
      const gap = next.t - current.t;
      if (gap <= epsilon || gap > maximumInterpolatedGap) continue;

      const firstGridIndex = Math.floor((current.t + epsilon) * analysisFps) + 1;
      for (let gridIndex = firstGridIndex; ; gridIndex += 1) {
        const t = gridIndex / analysisFps;
        if (t >= next.t - epsilon) break;
        const fraction = (t - current.t) / gap;
        if (fraction <= epsilon || fraction >= 1 - epsilon) continue;
        points.push({
          t,
          cx: between(current.cx, next.cx, fraction),
          cy: between(current.cy, next.cy, fraction),
          w: between(current.w, next.w, fraction),
          mouthOpen: null,
          motion: null,
        });
      }
    }

    return points.length === track.points.length
      ? track
      : { ...track, points: points.sort((a, b) => a.t - b.t) };
  });
}
