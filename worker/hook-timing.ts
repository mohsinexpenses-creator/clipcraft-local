import { AppError } from '../lib/errors';
import { parseTimestamp } from '../lib/viral-response';

/**
 * Used only when viral analysis did not provide a readable hook interval: a clip whose
 * AI data has no usable start+end pair gets an intro of the configured length, and this
 * is what applies when nothing was configured at all.
 */
export const DEFAULT_HOOK_FALLBACK_SECONDS = 3;

export interface HookTimingInput {
  enabled: boolean;
  clipStart: number;
  clipEnd: number;
  hookTimestampStart?: string;
  hookTimestampEnd?: string;
  /**
   * Positive value enables the hook and supplies the fallback length, which the Settings
   * page owns. It is never used when the analysis provided a real interval.
   */
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
 * The prompt's hook interval IS the intro: a valid start->end pair is used at exactly
 * its own length, never shortened or moved. Those timestamps are absolute source-video
 * times and the renderer needs an offset relative to the selected clip, so an interval
 * that does not fit inside the segment fails loudly instead of silently rendering a
 * different or partial moment.
 *
 * `fallbackDuration` - the "Hook intro fallback" on Settings -> Render defaults - only
 * applies to clips with no usable interval (older analysis data, or a prompt that gave a
 * start with no end). It is bounded by half the segment, so an intro can never outgrow
 * the clip it is replaying.
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

  // Whatever was configured is honoured - the Settings page allows up to 30s, and
  // silently rewriting 6 to 3 would make that field a lie. Only the segment bound applies.
  const requestedFallback = Number.isFinite(input.fallbackDuration) && (input.fallbackDuration ?? 0) > 0
    ? (input.fallbackDuration as number)
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
