/**
 * B-roll motion, as pure numbers.
 *
 * Full-screen: enter with scale 1.08 -> 1.0, fade in and a small upward push
 * (~0.25 s); then a very slow Ken Burns push (1.0 -> 1.06) with a subtle pan;
 * exit with a fade + slight scale-down (~0.2 s).
 *
 * Landscape card: slide up + scale 0.94 -> 1.0 + fade in (~0.25 s), a slow
 * internal zoom while it is up, and the mirror image on the way out.
 *
 * The Remotion composition consumes these values and nothing else, so the timing
 * is unit-tested without a browser.
 */

export const BROLL_ANIMATION = {
  fullscreen: {
    enterSeconds: 0.25,
    exitSeconds: 0.2,
    enterScaleFrom: 1.08,
    exitScaleTo: 0.98,
    kenBurnsZoom: 0.06,
    kenBurnsPanPx: 16,
    enterSlidePx: 18,
  },
  landscape: {
    enterSeconds: 0.25,
    exitSeconds: 0.25,
    enterScaleFrom: 0.94,
    exitScaleTo: 0.96,
    enterSlidePx: 28,
    kenBurnsZoom: 0.05,
    kenBurnsPanPx: 10,
  },
} as const;

export interface BrollFrameStyle {
  /** Wrapper opacity, 0..1. */
  opacity: number;
  /** Wrapper scale (enter/exit). */
  scale: number;
  /** Wrapper vertical offset in px (enter push / slide). */
  translateY: number;
  /** Extra zoom applied to the image itself (Ken Burns). */
  mediaScale: number;
  /** Horizontal pan of the image inside its frame, px. */
  mediaX: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Ease-out cubic: fast start, settled finish - the "modern editor" feel. */
export function easeOutCubic(value: number): number {
  const t = clamp01(value);
  return 1 - (1 - t) ** 3;
}

function cubicEaseIn(value: number): number {
  const t = clamp01(value);
  return t ** 3;
}

/**
 * The style for one frame of one item. `elapsed` and `duration` are SECONDS since
 * the item appeared; frames are converted by the caller using the composition fps.
 */
export function brollFrameStyle(
  kind: "fullscreen" | "landscape",
  elapsed: number,
  duration: number
): BrollFrameStyle {
  const config = BROLL_ANIMATION[kind];
  const safeDuration = Math.max(0.1, duration);
  const t = Math.min(Math.max(0, elapsed), safeDuration);

  const enter = Math.min(config.enterSeconds, safeDuration / 2);
  const exit = Math.min(config.exitSeconds, safeDuration / 2);
  const holdEnd = Math.max(enter, safeDuration - exit);

  let opacity = 1;
  let scale = 1;
  let translateY = 0;

  if (t < enter) {
    const p = easeOutCubic(enter > 0 ? t / enter : 1);
    opacity = p;
    if (kind === "fullscreen") {
      scale = config.enterScaleFrom + (1 - config.enterScaleFrom) * p;
      translateY = config.enterSlidePx * (1 - p);
    } else {
      scale = config.enterScaleFrom + (1 - config.enterScaleFrom) * p;
      translateY = config.enterSlidePx * (1 - p);
    }
  } else if (t > holdEnd) {
    const p = cubicEaseIn(exit > 0 ? (t - holdEnd) / exit : 1);
    opacity = 1 - p;
    scale = kind === "fullscreen" ? 1 - (1 - config.exitScaleTo) * p : 1 + (config.exitScaleTo - 1) * p;
    translateY = kind === "fullscreen" ? 0 : -config.enterSlidePx * 0.5 * p;
  }

  const progress = clamp01(safeDuration > 0 ? t / safeDuration : 1);
  const mediaScale = 1 + config.kenBurnsZoom * progress;
  const mediaX = -config.kenBurnsPanPx / 2 + config.kenBurnsPanPx * progress;

  return {
    opacity: Number(clamp01(opacity).toFixed(4)),
    scale: Number(scale.toFixed(4)),
    translateY: Number(translateY.toFixed(2)),
    mediaScale: Number(mediaScale.toFixed(4)),
    mediaX: Number(mediaX.toFixed(2)),
  };
}

/**
 * The frames one item needs. Each item is rendered as its OWN short Remotion
 * sequence, so 4 s of B-roll costs 4 s of frames - not the clip's full length.
 */
export function brollSequenceFrames(durationSeconds: number, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(1, Math.round(Math.max(0, durationSeconds) * safeFps));
}
