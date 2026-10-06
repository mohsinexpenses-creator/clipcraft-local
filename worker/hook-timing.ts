import { AppError } from '../lib/errors';
import { parseTimestamp } from '../lib/viral-response';

/** Used only when viral analysis did not provide a readable hook interval. */
export const DEFAULT_HOOK_FALLBACK_SECONDS = 3;

export interface HookTimingInput {
  enabled: boolean;
  clipStart: number;
  clipEnd: number;
  hookTimestampStart?: string;
  hookTimestampEnd?: string;
  /** Positive value enables the hook and supplies a legacy fallback duration. */
  fallbackDuration?: number;
}

export interface ResolvedHookTiming {
  /** Hook start relative to the beginning of the selected clip segment. */
  start: number;
  /** Exact detected range when available; otherwise a bounded legacy fallback. */
  duration: number;
  source: 'disabled' | 'timestamps' | 'fallback';
  startAbsolute?: number;
  endAbsolute?: number;
}

/**
 * Resolve the duplicated intro from the viral-analysis timestamps.
 *
 * Hook timestamps are absolute source-video times; the renderer needs an offset
 * relative to the selected clip. A valid AI interval is never shortened or
 * moved: if it does not fit inside the selected segment, fail clearly rather
 * than silently rendering a different/partial moment. Older clips without a
 * usable interval keep the former first-seconds fallback.
 */
export function resolveHookTiming(input: HookTimingInput): ResolvedHookTiming {
  if (!input.enabled) return { start: 0, duration: 0, source: 'disabled' };

  const segmentDuration = Math.max(0, input.clipEnd - input.clipStart);
  const hookStartAbsolute = parseTimestamp(input.hookTimestampStart ?? '');
  const hookEndAbsolute = parseTimestamp(input.hookTimestampEnd ?? '');

  if (
    hookStartAbsolute !== null &&
    hookEndAbsolute !== null &&
    hookEndAbsolute > hookStartAbsolute
  ) {
    if (hookStartAbsolute < input.clipStart || hookEndAbsolute > input.clipEnd) {
      throw new AppError('The detected hook interval is outside the selected clip window.', {
        status: 400,
        details:
          `hook=${hookStartAbsolute.toFixed(3)}s-${hookEndAbsolute.toFixed(3)}s, ` +
          `clip=${input.clipStart.toFixed(3)}s-${input.clipEnd.toFixed(3)}s`,
        resolution:
          'Adjust the clip start/end so the complete detected hook is inside the clip, then render again. ' +
          'ClipCraft will not silently shorten or shift a valid hook interval.',
      });
    }

    return {
      start: hookStartAbsolute - input.clipStart,
      duration: hookEndAbsolute - hookStartAbsolute,
      source: 'timestamps',
      startAbsolute: hookStartAbsolute,
      endAbsolute: hookEndAbsolute,
    };
  }

  const requestedFallback = Number.isFinite(input.fallbackDuration) && (input.fallbackDuration ?? 0) > 0
    ? Math.min(input.fallbackDuration as number, DEFAULT_HOOK_FALLBACK_SECONDS)
    : DEFAULT_HOOK_FALLBACK_SECONDS;
  const duration = Math.min(requestedFallback, segmentDuration / 2);
  const maxStart = Math.max(0, segmentDuration - duration);
  const startFromTimestamp = hookStartAbsolute === null
    ? 0
    : hookStartAbsolute - input.clipStart;

  return {
    start: Math.max(0, Math.min(startFromTimestamp, maxStart)),
    duration,
    source: 'fallback',
  };
}
