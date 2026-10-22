import {
  BrollOptions,
  BrollProviderId,
  DEFAULT_BROLL_OPTIONS,
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
  /** Images per 60 s of clip (the UI label; the worker scales them per clip). */
  brollImages: { min: 1, max: 30 },
} as const;

/** Stock providers a landscape card may come from, in the default order. */
export const STOCK_BROLL_PROVIDERS = ['pexels', 'pixabay', 'unsplash'] as const;

const STOCK_PROVIDER_SET = new Set<string>(STOCK_BROLL_PROVIDERS);

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
/**
 * B-roll automation for one video. The provider order is filtered to the stock
 * providers (Wikimedia is entity-only and needs no key), then de-duplicated; an
 * empty result falls back to the shipped order so a landscape card can still be
 * fetched when someone saves `[]`.
 */
export function resolveBrollOptions(partial?: unknown): BrollOptions {
  const source = isRecord(partial) ? partial : {};
  const minImages = Math.round(
    clampNumber(
      source.minImages,
      DEFAULT_BROLL_OPTIONS.minImages,
      OPTION_LIMITS.brollImages.min,
      OPTION_LIMITS.brollImages.max
    )
  );
  const maxImages = Math.max(
    minImages,
    Math.round(
      clampNumber(
        source.maxImages,
        DEFAULT_BROLL_OPTIONS.maxImages,
        OPTION_LIMITS.brollImages.min,
        OPTION_LIMITS.brollImages.max
      )
    )
  );
  const requestedOrder = Array.isArray(source.providerOrder)
    ? source.providerOrder.filter(
        (entry): entry is BrollProviderId =>
          typeof entry === 'string' && STOCK_PROVIDER_SET.has(entry)
      )
    : [];
  const providerOrder = [...new Set(requestedOrder)];

  return {
    autoBroll: readFlag(source.autoBroll, DEFAULT_BROLL_OPTIONS.autoBroll),
    enableFullscreen: readFlag(source.enableFullscreen, DEFAULT_BROLL_OPTIONS.enableFullscreen),
    enableLandscape: readFlag(source.enableLandscape, DEFAULT_BROLL_OPTIONS.enableLandscape),
    minImages,
    maxImages,
    sfx: readFlag(source.sfx, DEFAULT_BROLL_OPTIONS.sfx),
    providerOrder: providerOrder.length
      ? providerOrder
      : [...DEFAULT_BROLL_OPTIONS.providerOrder],
  };
}

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
    // A legacy pipeline document (uploaded before B-roll existed) has no
    // `broll` key and gets the shipped defaults - sane by construction.
    broll: resolveBrollOptions(isRecord(nested.broll) ? nested.broll : null),
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
    a.viral.includeCta === b.viral.includeCta &&
    a.broll.autoBroll === b.broll.autoBroll &&
    a.broll.enableFullscreen === b.broll.enableFullscreen &&
    a.broll.enableLandscape === b.broll.enableLandscape &&
    a.broll.minImages === b.broll.minImages &&
    a.broll.maxImages === b.broll.maxImages &&
    a.broll.sfx === b.broll.sfx &&
    a.broll.providerOrder.join(',') === b.broll.providerOrder.join(',')
  );
}
