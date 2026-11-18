import type { WordTimestamp } from './types';

/** Convert an absolute source word into a bounded clip-relative timestamp. */
export function wordWithinClip(
  word: WordTimestamp,
  clipStart: number,
  clipEnd: number,
): WordTimestamp | null {
  const duration = Math.max(0, clipEnd - clipStart);
  if (duration === 0 || word.end <= clipStart || word.start >= clipEnd) return null;

  const start = Math.max(0, Math.min(duration, word.start - clipStart));
  const end = Math.max(0, Math.min(duration, word.end - clipStart));
  if (end <= start) return null;
  return { ...word, start, end };
}