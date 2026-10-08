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
import { loadEffectiveSettings } from '../lib/app-settings';
import { setProfanityAudioModeOverride } from '../lib/profanity';

/**
 * `worker/remotion-renderer.ts` still reads `process.env.REMOTION_CONCURRENCY` at the
 * moment it hands the render off to Remotion, and the renderer is the one piece of the
 * pipeline this feature does not restructure. So a stored value is pushed into the env
 * slot the renderer already understands, instead of threading a new argument through
 * every render call. Written only when it actually changes, and an unset value restores
 * the empty slot ("let Remotion decide", i.e. half the CPU threads).
 */
function syncRemotionSlot(concurrency: number | null): void {
  const next = concurrency === null ? '' : String(concurrency);
  if ((process.env.REMOTION_CONCURRENCY ?? '') !== next) {
    process.env.REMOTION_CONCURRENCY = next;
  }
}

/**
 * The settings the next job should see, or `null` when they could not be read. A
 * settings read must never fail a render: everything the job needs is in its payload,
 * and the env fallbacks are still in place.
 */
export async function applyStoredRuntimeSettings(): Promise<void> {
  try {
    const { worker, profanity } = await loadEffectiveSettings();
    syncRemotionSlot(worker.remotionConcurrency);
    setProfanityAudioModeOverride(profanity.audioMode);
  } catch (error) {
    console.warn(
      `[worker] Could not load stored settings; continuing with .env.local values: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
