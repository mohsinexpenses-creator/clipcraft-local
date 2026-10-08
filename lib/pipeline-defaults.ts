import {
  DEFAULT_PIPELINE_OPTIONS,
  DEFAULT_VIRAL_OPTIONS,
  PipelineOptions,
  ViralDetectionOptions,
} from './types';

/**
 * The single, dependency-free implementation of "what these options mean".
 *
 * It lives in its own module because BOTH sides need it: the API/worker (a
 * request body or a stored record is never trusted raw) and the browser (the
 * settings panel and the uploader clamp while you type). Keeping it here - with
 * no import of `lib/db` or `lib/ai` - is what makes it importable from a client
 * component without dragging server code into the bundle.
 */

/**
 * Hard UI/API bounds for the per-run viral detection options.
 * maxClipDuration is intentionally NOT user-configurable anymore: it is fixed
 * at DEFAULT_VIRAL_OPTIONS.maxClipDuration (90s - clips are packaged 60-90s);
 * the UI only exposes the minimum.
 */
export const OPTION_LIMITS = {
  clipCount: { min: 1, max: 25 },
  minClipDuration: { min: 5, max: 600 },
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Booleans arrive as real booleans from the UI and as "true"/"false" strings from curl/scripts. */
function readFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Effective options for one detection run: user values with fallbacks, and
 * `maxClipDuration` is always >= `minClipDuration`.
 */
export function resolveViralOptions(
  partial?: Partial<ViralDetectionOptions> | null
): Required<ViralDetectionOptions> {
  const clipCount = Math.round(
    Number.isFinite(Number(partial?.clipCount)) && Number(partial?.clipCount) > 0
      ? Number(partial?.clipCount)
      : DEFAULT_VIRAL_OPTIONS.clipCount
  );
  const minClipDuration = Math.max(
    1,
    Number.isFinite(Number(partial?.minClipDuration)) && Number(partial?.minClipDuration) > 0
      ? Number(partial?.minClipDuration)
      : DEFAULT_VIRAL_OPTIONS.minClipDuration
  );
  const maxClipDuration = Math.max(
    minClipDuration,
    Number.isFinite(Number(partial?.maxClipDuration)) && Number(partial?.maxClipDuration) > 0
      ? Number(partial?.maxClipDuration)
      : DEFAULT_VIRAL_OPTIONS.maxClipDuration
  );
  return {
    clipCount,
    minClipDuration,
    maxClipDuration,
    includeHookText: partial?.includeHookText ?? DEFAULT_VIRAL_OPTIONS.includeHookText,
    includeCta: partial?.includeCta ?? DEFAULT_VIRAL_OPTIONS.includeCta,
  };
}

/**
 * Clamp anything into valid AI clip options. Every field falls back to the
 * shared default, so an empty, half-filled or stale object still produces a
 * valid run.
 */
export function sanitizeViralOptions(input: unknown): Required<ViralDetectionOptions> {
  const unwrapped = isRecord(input) && 'options' in input ? input.options : input;
  const source = isRecord(unwrapped) ? unwrapped : {};

  return resolveViralOptions({
    clipCount: clampNumber(
      source.clipCount,
      DEFAULT_VIRAL_OPTIONS.clipCount,
      OPTION_LIMITS.clipCount.min,
      OPTION_LIMITS.clipCount.max
    ),
    minClipDuration: clampNumber(
      source.minClipDuration,
      DEFAULT_VIRAL_OPTIONS.minClipDuration,
      OPTION_LIMITS.minClipDuration.min,
      OPTION_LIMITS.minClipDuration.max
    ),
    // Fixed internal bound - ignore whatever the client sends (stale
    // localStorage values from an older UI included a max input).
    maxClipDuration: DEFAULT_VIRAL_OPTIONS.maxClipDuration,
    includeHookText: readFlag(source.includeHookText, DEFAULT_VIRAL_OPTIONS.includeHookText),
    includeCta: readFlag(source.includeCta, DEFAULT_VIRAL_OPTIONS.includeCta),
  });
}

/**
 * The automatic pipeline configuration stored on a video (and in the browser's
 * "defaults for the next upload"). `autoDetect` / `autoRender` default to ON -
 * that is the whole point of the upload flow - and either can be turned off to
 * hand that step back to the user.
 */
export function sanitizePipelineOptions(input: unknown): PipelineOptions {
  const body = isRecord(input) ? input : {};
  const nested = isRecord(body.pipeline) ? body.pipeline : body;
  const viralSource = isRecord(nested.viral)
    ? nested.viral
    : isRecord(body.options)
      ? body.options
      : nested;

  return {
    autoDetect: readFlag(nested.autoDetect, DEFAULT_PIPELINE_OPTIONS.autoDetect),
    autoRender: readFlag(nested.autoRender, DEFAULT_PIPELINE_OPTIONS.autoRender),
    viral: sanitizeViralOptions(viralSource),
  };
}

export function isPipelineOptionsEqual(a: PipelineOptions | undefined, b: PipelineOptions | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.autoDetect === b.autoDetect &&
    a.autoRender === b.autoRender &&
    a.viral.clipCount === b.viral.clipCount &&
    a.viral.minClipDuration === b.viral.minClipDuration &&
    a.viral.includeHookText === b.viral.includeHookText &&
    a.viral.includeCta === b.viral.includeCta
  );
}
