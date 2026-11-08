/**
 * Keep expensive render-overlap experiments opt-in. Values intentionally mirror
 * the project's other boolean environment flags.
 */
export function getParallelBrollAsdEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.RENDER_PARALLEL_BROLL_ASD?.trim() ?? "");
}
