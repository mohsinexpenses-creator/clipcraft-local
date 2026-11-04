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
    enterSeconds: 0.2,
    exitSeconds: 0.2,
    enterScaleFrom: 0.75,
    enterScalePeak: 1.05,
    exitScaleTo: 0.75,
    exitScalePeak: 0.7,
    kenBurnsZoom: 0.06,
    kenBurnsPanPx: 16,
    enterSlidePx: 0,
  },
  landscape: {
    enterSeconds: 0.15,
    exitSeconds: 0.15,
    enterScaleFrom: 0,
    exitScaleTo: 0,
    enterSlidePx: 0,
    kenBurnsZoom: 0,
    kenBurnsPanPx: 0,
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

export interface BrollFramePhase {
  name: "enter" | "hold" | "exit";
  format: "png" | "jpeg";
  startFrame: number;
  endFrame: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Ease-out cubic: fast start, settled finish - the "modern editor" feel. */
export function easeOutCubic(value: number): number {
  const t = clamp01(value);
  return 1 - (1 - t) ** 3;
}

/** Overshoots ~10% then settles: the "bounce" of a sticker pop-in. */
export function easeOutBack(value: number): number {
  const t = clamp01(value);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
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
  duration: number,
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
  let mediaScale = 1;
  let mediaX = 0;

  if (t < enter) {
    const linear = enter > 0 ? t / enter : 1;
    if (kind === "fullscreen") {
      const bounceProgress = clamp01(linear / 0.72);
      const settleProgress = clamp01((linear - 0.72) / 0.28);
      scale =
        linear < 0.72
          ? BROLL_ANIMATION.fullscreen.enterScaleFrom +
            (BROLL_ANIMATION.fullscreen.enterScalePeak -
              BROLL_ANIMATION.fullscreen.enterScaleFrom) *
              easeOutCubic(bounceProgress)
          : BROLL_ANIMATION.fullscreen.enterScalePeak +
            (1 - BROLL_ANIMATION.fullscreen.enterScalePeak) *
              easeOutCubic(settleProgress);
      translateY = config.enterSlidePx * (1 - easeOutCubic(linear));
    } else {
      const p = easeOutCubic(linear);
      opacity = p;
      // Sticker: pops in place with a bounce (0 -> ~1.1 -> 1), no slide.
      scale = easeOutBack(linear);
    }
  } else if (t > holdEnd) {
    const linear = clamp01(exit > 0 ? (t - holdEnd) / exit : 1);
    const p = cubicEaseIn(linear);
    opacity = 1 - p;
    if (kind === "fullscreen") {
      const exitBounceProgress = clamp01(linear / 0.72);
      const exitSettleProgress = clamp01((linear - 0.72) / 0.28);
      scale =
        linear < 0.72
          ? 1 + config.kenBurnsZoom +
            (BROLL_ANIMATION.fullscreen.exitScalePeak -
              (1 + config.kenBurnsZoom)) *
              easeOutCubic(exitBounceProgress)
          : BROLL_ANIMATION.fullscreen.exitScalePeak +
            (BROLL_ANIMATION.fullscreen.exitScaleTo -
              BROLL_ANIMATION.fullscreen.exitScalePeak) *
              easeOutCubic(exitSettleProgress);
    } else {
      scale = 1 - p;
    }
  }

  if (kind === "fullscreen") {
    const holdDuration = Math.max(0.001, holdEnd - enter);
    const holdProgress = clamp01((t - enter) / holdDuration);
    mediaScale = 1 + config.kenBurnsZoom * holdProgress;
    mediaX = -config.kenBurnsPanPx / 2 + config.kenBurnsPanPx * holdProgress;
  } else {
    const progress = clamp01(safeDuration > 0 ? t / safeDuration : 1);
    mediaScale = 1 + config.kenBurnsZoom * progress;
    mediaX = -config.kenBurnsPanPx / 2 + config.kenBurnsPanPx * progress;
  }

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
export function brollSequenceFrames(
  durationSeconds: number,
  fps: number,
): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(1, Math.round(Math.max(0, durationSeconds) * safeFps));
}

/** Inclusive frame ranges for the transparent bounce edges and opaque hold. */
export function brollFramePhases(
  durationInFrames: number,
  fps: number,
): BrollFramePhase[] {
  const frameCount = Math.max(1, Math.floor(durationInFrames));
  if (frameCount === 1)
    return [{ name: "enter", format: "png", startFrame: 0, endFrame: 0 }];

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const edgeFrames = Math.min(
    Math.max(1, Math.round(0.2 * safeFps)),
    Math.floor(frameCount / 2),
  );
  const holdStart = edgeFrames;
  const exitStart = frameCount - edgeFrames;
  const phases: BrollFramePhase[] = [
    { name: "enter", format: "png", startFrame: 0, endFrame: holdStart - 1 },
  ];
  if (exitStart > holdStart)
    phases.push({
      name: "hold",
      format: "jpeg",
      startFrame: holdStart,
      endFrame: exitStart - 1,
    });
  phases.push({
    name: "exit",
    format: "png",
    startFrame: exitStart,
    endFrame: frameCount - 1,
  });
  return phases;
}
