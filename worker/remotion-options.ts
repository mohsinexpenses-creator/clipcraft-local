/**
 * Resolve an explicit Remotion tab count without overriding the Settings page's
 * auto mode. A cap is used only for work intentionally sharing the host with a
 * second CPU-heavy stage (for example B-roll beside active-speaker detection).
 */
export function getRemotionConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { maxConcurrency?: number } = {},
): number | undefined {
  const configured = Number(env.REMOTION_CONCURRENCY?.trim());
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : undefined;
  const cap = options.maxConcurrency;
  if (!Number.isFinite(cap) || !cap || cap <= 0) return requested;
  return Math.min(requested ?? cap, cap);
}

/** Sparse caption rendering is opt-in until it has been benchmarked per host. */
export function getCaptionActiveRangeRenderingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.CAPTION_ACTIVE_RANGE_RENDERING?.trim() ?? "");
}

/**
 * Experimental pixel-saving path: render one conservative full-width vertical
 * band for caption/hook/CTA artwork and place it back on the final canvas in
 * FFmpeg. Default-off until a host records the cropped/full five-frame gate.
 */
export function getCaptionBandCroppedCanvasEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.CAPTION_BAND_CROPPED_CANVAS?.trim() ?? "");
}

/**
 * Experimental equivalent for a landscape B-roll card. Fullscreen B-roll is
 * already the whole canvas and deliberately stays on the legacy full path.
 */
export function getBrollCardCroppedCanvasEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.BROLL_CARD_CROPPED_CANVAS?.trim() ?? "");
}
