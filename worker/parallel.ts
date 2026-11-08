import { RenderCancelledError } from "../lib/errors";

/**
 * Run two independent render branches with one derived cancellation signal.
 *
 * If either branch rejects, the sibling receives an abort immediately and this
 * helper waits for both promises to settle before propagating the original
 * failure. That prevents a detached Chromium/FFmpeg task from writing files
 * after the main clip job has already failed or been cancelled.
 */
export async function runParallelRenderBranches<T, U>(
  parentSignal: AbortSignal | undefined,
  first: (signal: AbortSignal) => Promise<T>,
  second: (signal: AbortSignal) => Promise<U>,
): Promise<[T, U]> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const invoke = <V>(branch: (branchSignal: AbortSignal) => Promise<V>): Promise<V> =>
    Promise.resolve().then(() => branch(signal));
  const firstPromise = invoke(first);
  const secondPromise = invoke(second);

  try {
    const result = await Promise.all([firstPromise, secondPromise]);
    if (parentSignal?.aborted) throw new RenderCancelledError();
    return result;
  } catch (error) {
    controller.abort();
    await Promise.allSettled([firstPromise, secondPromise]);
    if (parentSignal?.aborted) throw new RenderCancelledError();
    throw error;
  }
}
