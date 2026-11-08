/**
 * Keep expensive render-overlap experiments opt-in. Values intentionally mirror
 * the project's other boolean environment flags.
 */
export function getParallelBrollAsdEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.RENDER_PARALLEL_BROLL_ASD?.trim() ?? "");
}

/**
 * A parallel B-roll/ASD run must leave CPU/RAM for frame sampling and YuNet.
 * A manual override is allowed, but stays bounded to Remotion's supported range.
 */
export function getParallelBrollAsdConcurrencyCap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.RENDER_PARALLEL_BROLL_CONCURRENCY?.trim());
  if (Number.isFinite(configured) && configured >= 1 && configured <= 32) {
    return Math.floor(configured);
  }
  return 2;
}
