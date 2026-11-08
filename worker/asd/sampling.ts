import type { Track, TrackPoint } from "./tracker";

/**
 * The prior ASD profile. It remains the quality retry and explicit rollback
 * path for wide shots, very small faces, and anyone who turns adaptive sampling
 * off while comparing output.
 */
export const ASD_QUALITY_SAMPLE_WIDTH = 960;
export const ASD_QUALITY_MAX_SAMPLE_FPS = 8;
export const ASD_QUALITY_MAX_FRAMES = 480;
export const ASD_QUALITY_JPEG_QUALITY = 3;

/**
 * The ordinary first pass deliberately does half as many detector calls and
 * decodes noticeably smaller JPEGs. Adjacent confident sightings are filled on
 * the quality cadence before speaker/layout planning, never by inventing motion.
 */
export const ASD_FAST_SAMPLE_WIDTH = 640;
export const ASD_FAST_MAX_SAMPLE_FPS = 4;
export const ASD_FAST_MAX_FRAMES = 240;
export const ASD_FAST_JPEG_QUALITY = 5;

export interface AsdSamplingProfile {
  name: "fast" | "quality";
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
 * Adaptive sampling is on by default because a failed quality check retries the
 * old 8fps/960px profile. Set ASD_ADAPTIVE_SAMPLING=0 for an exact legacy
 * sampling comparison or a conservative rollback.
 */
export function getAdaptiveAsdSamplingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isExplicitlyDisabled(env.ASD_ADAPTIVE_SAMPLING);
}

/** Clamp a sampled width exactly like FFmpeg's even-sized scale input. */
export function asdSampleWidth(limit: number, sourceWidth: number): number {
  return Math.max(160, Math.min(limit, Math.floor(sourceWidth / 2) * 2));
}

/**
 * Pick the cheap first pass and the old quality retry. Caller-supplied sampling
 * limits are respected: the fast profile never exceeds them and the quality
 * profile is still their requested ceiling.
 */
export function buildAsdSamplingPlan(options: {
  sourceWidth: number;
  maxSampleFps?: number;
  maxFrames?: number;
  adaptive: boolean;
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

  if (!options.adaptive) {
    return { initial: quality, qualityFallback: null, analysisFps: quality.maxFps };
  }

  const fast: AsdSamplingProfile = {
    name: "fast",
    maxFps: Math.min(ASD_FAST_MAX_SAMPLE_FPS, quality.maxFps),
    maxFrames: Math.min(ASD_FAST_MAX_FRAMES, quality.maxFrames),
    sampleWidth: asdSampleWidth(ASD_FAST_SAMPLE_WIDTH, options.sourceWidth),
    jpegQuality: ASD_FAST_JPEG_QUALITY,
  };
  const differsFromQuality =
    fast.maxFps < quality.maxFps ||
    fast.maxFrames < quality.maxFrames ||
    fast.sampleWidth < quality.sampleWidth ||
    fast.jpegQuality !== quality.jpegQuality;

  return {
    initial: fast,
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
