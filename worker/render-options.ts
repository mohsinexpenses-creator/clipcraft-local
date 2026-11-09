/**
 * Speaker-focus B-roll has a fixed anchor and is independent from ASD, so the
 * overlap is the safe default. Set `RENDER_PARALLEL_BROLL_ASD=0` to restore the
 * prior sequential path on a constrained host.
 */
export function getParallelBrollAsdEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !/^(0|false|no|off)$/i.test(env.RENDER_PARALLEL_BROLL_ASD?.trim() ?? "");
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
  // Deliberately unchanged in Phase 4: a representative render host is needed
  // before raising this tab cap can be called a win rather than a CPU/RAM loss.
  return 2;
}

export type BrollAsdParallelLayout = "speaker-focus" | "split-screen";

/**
 * B-roll that does not need ASD-derived face bands can start alongside active
 * speaker detection. Speaker-focus cards retain their established fixed anchor;
 * a split-screen job is also safe when every item is fullscreen. Any landscape
 * card in split screen waits for ASD so its face-safe seam placement is exact.
 */
export function canParallelizeBrollWithAsd(
  layout: BrollAsdParallelLayout,
  items: readonly { kind: "fullscreen" | "landscape" }[] | null | undefined,
): boolean {
  if (!items || items.length === 0) return false;
  return layout === "speaker-focus" || items.every((item) => item.kind === "fullscreen");
}

/**
 * FFmpeg's image2 readers can queue a few PNG frames while the filter graph
 * consumes another. The conservative value remains 2 until a host measures a
 * larger queue as faster; 16 and 32 are supported experiment values.
 */
export function getOverlayThreadQueueSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.FFMPEG_OVERLAY_THREAD_QUEUE_SIZE?.trim());
  if (Number.isFinite(configured) && configured >= 1 && configured <= 64) {
    return Math.floor(configured);
  }
  return 2;
}
