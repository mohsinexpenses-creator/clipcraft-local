import type { WordTimestamp } from '../lib/types';

/**
 * Caption-only timing adjustment. Positive values move captions later; negative
 * values move them earlier. Audio/profanity timing must continue to use the
 * unshifted transcript timestamps.
 */
export function getCaptionOffsetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CAPTION_OFFSET_MS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > 10_000) return 0;
  return Math.round(value);
}

export function shiftCaptionWords<T extends WordTimestamp>(words: T[], offsetMs: number): T[] {
  if (!Number.isFinite(offsetMs) || offsetMs === 0) return words.map((word) => ({ ...word }));
  const offsetSeconds = offsetMs / 1000;
  return words.map((word) => ({
    ...word,
    start: word.start + offsetSeconds,
    end: word.end + offsetSeconds,
  }));
}
