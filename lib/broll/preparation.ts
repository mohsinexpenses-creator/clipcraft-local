import { RenderCancelledError } from "../errors";

/**
 * Jimp processing is CPU- and memory-heavy. Two workers overlap image decode and
 * JPEG encoding without turning a 10–15-image B-roll plan into an unbounded RAM
 * spike. Set BROLL_IMAGE_PREP_CONCURRENCY=1 to restore serial preparation.
 */
export function getBrollImagePreparationConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.BROLL_IMAGE_PREP_CONCURRENCY?.trim());
  if (Number.isFinite(configured) && configured >= 1 && configured <= 4) {
    return Math.floor(configured);
  }
  return 2;
}

/**
 * Ordered, bounded async map. Results retain input order, while a shared worker
 * pool limits CPU/RAM pressure and stops scheduling fresh work after cancellation.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workers = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const work = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw new RenderCancelledError();
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };

  const workerPromises = Array.from({ length: workers }, () => work());
  try {
    await Promise.all(workerPromises);
  } catch (error) {
    // Jimp cannot be interrupted halfway through a decode/encode. Wait until
    // in-flight workers reach their next cancellation check so they cannot keep
    // writing cache frames after the B-roll job has reported cancellation.
    await Promise.allSettled(workerPromises);
    throw error;
  }
  if (signal?.aborted) throw new RenderCancelledError();
  return results;
}
