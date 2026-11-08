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
