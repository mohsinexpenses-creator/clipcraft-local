/**
 * Per-job settings sync for the worker.
 *
 * The worker is a long-lived process, and `lib/app-settings.ts` is the single place
 * that folds stored settings over `.env.local`. Anything the worker reads once and
 * caches in a local variable (its loop concurrency) therefore belongs to the process
 * start, while anything read per job follows the Settings page immediately.
 *
 * `worker/index.ts` calls this once before the loops start and again before every
 * claimed job, which is why there is deliberately no "only once" latch here.
 */
import os from 'node:os';
import { loadEffectiveSettings } from '../lib/app-settings';
import { setProfanityAudioModeOverride, setProfanityContextPassOverride } from '../lib/profanity';

/**
 * `worker/remotion-renderer.ts` reads `REMOTION_CONCURRENCY` as a logical Chrome
 * tab count. The Settings page stores a portable percentage instead; convert it
 * against the current host's logical-thread count before each job. This means a
 * 50% setting behaves sensibly after moving the database between machines.
 */
export function remotionThreadsFromPercent(
  percent: number,
  logicalThreads = availableLogicalThreads(),
): number {
  const safeThreads = Math.max(1, Math.floor(logicalThreads) || 1);
  const safePercent = Math.max(10, Math.min(100, Math.round(percent / 5) * 5));
  return Math.max(1, Math.min(32, Math.ceil((safeThreads * safePercent) / 100)));
}

function availableLogicalThreads(): number {
  // `availableParallelism` respects cgroup/container limits when Node exposes it;
  // falling back preserves compatibility with older Node releases.
  try {
    return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  } catch {
    return 1;
  }
}

function syncRemotionSlot(percent: number): void {
  const next = String(remotionThreadsFromPercent(percent));
  if ((process.env.REMOTION_CONCURRENCY ?? '') !== next) process.env.REMOTION_CONCURRENCY = next;
}

/**
 * The settings the next job should see, or `null` when they could not be read. A
 * settings read must never fail a render: everything the job needs is in its payload,
 * and the env fallbacks are still in place.
 */
export async function applyStoredRuntimeSettings(): Promise<void> {
  try {
    const { worker, profanity } = await loadEffectiveSettings();
    syncRemotionSlot(worker.remotionConcurrencyPercent);
    setProfanityAudioModeOverride(profanity.audioMode);
    setProfanityContextPassOverride(profanity.contextPassEnabled);
  } catch (error) {
    console.warn(
      `[worker] Could not load stored settings; continuing with .env.local values: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
