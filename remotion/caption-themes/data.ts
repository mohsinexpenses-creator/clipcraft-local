import type { CaptionChunk } from '../AnimatedWord';
import type { CaptionThemeName, WordTimestamp } from '../../lib/types';

export interface ThemeCaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface ThemeCaptionLine {
  words: ThemeCaptionWord[];
}

export interface ThemeCaptionData {
  lines: ThemeCaptionLine[];
}

export interface SelectedThemeCaption {
  activeChunk: CaptionChunk;
  data: ThemeCaptionData;
}

export const THEME_CAPTION_HOLD_SECONDS = 0.35;
export const THEME_CAPTION_LOOKAHEAD_SECONDS = 0.06;

function toThemeWord(word: WordTimestamp): ThemeCaptionWord {
  return { text: word.word, start: word.start, end: word.end };
}

/**
 * Adapt ClipCraft's final, already-shifted/masked caption chunks to the upstream
 * theme contract (`lines[].words[].text`). Exactly one active chunk is supplied
 * for regular themes; Podcast receives the matching two-line pair it expects.
 */
export function selectThemeCaptionData(
  chunks: CaptionChunk[],
  theme: CaptionThemeName,
  currentTime: number,
): SelectedThemeCaption | null {
  if (!Number.isFinite(currentTime)) return null;

  const activeIndex = chunks.findIndex((chunk) => {
    if (chunk.words.length === 0) return false;
    return (
      currentTime >= chunk.start - THEME_CAPTION_LOOKAHEAD_SECONDS &&
      currentTime <= chunk.end + THEME_CAPTION_HOLD_SECONDS
    );
  });
  const upcomingIndex = activeIndex < 0
    ? chunks.findIndex((chunk) =>
        chunk.words.length > 0 &&
        chunk.start > currentTime &&
        chunk.start - currentTime <= THEME_CAPTION_LOOKAHEAD_SECONDS,
      )
    : -1;
  const selectedIndex = activeIndex >= 0 ? activeIndex : upcomingIndex;
  if (selectedIndex < 0) return null;

  const activeChunk = chunks[selectedIndex];
  const lineStart = theme === 'podcast' ? Math.floor(selectedIndex / 2) * 2 : selectedIndex;
  const lineCount = theme === 'podcast' ? 2 : 1;
  const lines = chunks
    .slice(lineStart, lineStart + lineCount)
    .map((chunk) => ({ words: chunk.words.map(toThemeWord) }))
    .filter((line) => line.words.length > 0);

  if (lines.length === 0) return null;
  return { activeChunk, data: { lines } };
}
