import type {
  CaptionAnimationStyle,
  CaptionFontWeight,
  CaptionLineStyle,
  CaptionPreset,
  WordTimestamp,
} from './types';

export interface ResolvedCaptionLineStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: CaptionFontWeight;
  textColor: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidth: number;
  italic: boolean;
  uppercase: boolean;
  letterSpacing: number;
  maxWords: number;
  animationStyle: CaptionAnimationStyle;
  lineHeight: number;
}

export interface CaptionVisualLine {
  /** Index in lineStyles; overflow rows reuse the final style. */
  styleIndex: number;
  style: ResolvedCaptionLineStyle;
  words: WordTimestamp[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function lineWordLimit(style: CaptionLineStyle | undefined): number {
  return Math.round(clamp(finiteOr(style?.maxWords, 4), 1, 8));
}

/** Resolve a line override against the legacy preset fields. */
export function resolveCaptionLineStyle(
  preset: CaptionPreset,
  styleIndex: number
): ResolvedCaptionLineStyle {
  const styles = preset.lineStyles ?? [];
  const safeIndex = styles.length ? Math.min(Math.max(0, styleIndex), styles.length - 1) : -1;
  const line = safeIndex >= 0 ? styles[safeIndex] : undefined;
  const globalFontSize = finiteOr(preset.fontSize, 48);
  const fontSize = clamp(finiteOr(line?.fontSize, globalFontSize), 12, 160);
  return {
    fontFamily: line?.fontFamily?.trim() || preset.fontFamily || 'Arial, sans-serif',
    fontSize,
    fontWeight: line?.fontWeight ?? preset.fontWeight ?? 'bold',
    textColor: line?.textColor || preset.textColor || '#FFFFFF',
    highlightColor: line?.highlightColor || preset.highlightColor || '#FFE600',
    strokeColor: line?.strokeColor || preset.strokeColor || '#000000',
    strokeWidth: clamp(finiteOr(line?.strokeWidth, finiteOr(preset.strokeWidth, 3)), 0, 20),
    italic: line?.italic ?? false,
    uppercase: line?.uppercase ?? preset.uppercase ?? true,
    letterSpacing: clamp(finiteOr(line?.letterSpacing, 0), -5, 30),
    maxWords: lineWordLimit(line),
    animationStyle: line?.animationStyle ?? preset.animationStyle ?? 'karaoke',
    lineHeight: clamp(finiteOr(line?.lineHeight, 1.12), 0.75, 2.5),
  };
}

/**
 * Words grouped into one timed caption chunk. Legacy presets retain four-word
 * chunks; rich presets size the chunk to the configured line capacities.
 */
export function getCaptionChunkWordLimit(preset: CaptionPreset): number {
  if (!preset.lineStyles?.length) return 4;
  const total = preset.lineStyles.reduce((sum, style) => sum + lineWordLimit(style), 0);
  return Math.round(clamp(total, 1, 48));
}

/**
 * Distribute transcript words in order over the visual line styles. If the input
 * contains more words than the configured lines can hold, keep wrapping with the
 * last style instead of dropping anything.
 */
export function splitCaptionWordsIntoLines(
  words: WordTimestamp[],
  preset: CaptionPreset
): CaptionVisualLine[] {
  if (words.length === 0) return [];
  const styles = preset.lineStyles;
  if (!styles?.length) {
    return [{ styleIndex: 0, style: resolveCaptionLineStyle(preset, 0), words }];
  }

  const lines: CaptionVisualLine[] = [];
  let cursor = 0;
  let styleIndex = 0;
  while (cursor < words.length) {
    const effectiveStyleIndex = Math.min(styleIndex, styles.length - 1);
    const style = resolveCaptionLineStyle(preset, effectiveStyleIndex);
    const end = Math.min(words.length, cursor + style.maxWords);
    lines.push({
      styleIndex: effectiveStyleIndex,
      style,
      words: words.slice(cursor, end),
    });
    cursor = end;
    styleIndex += 1;
  }
  return lines;
}

/**
 * Conservative text-width estimate shared by the Remotion safe-area renderer.
 * Actual browser metrics vary by installed font; the row still wraps anywhere
 * as a final guard, while this estimate shrinks long text before it can clip.
 */
export function fitCaptionFontSize(
  text: string,
  requestedSize: number,
  maxWidth: number,
  letterSpacing = 0,
  uppercase = false
): number {
  const source = uppercase ? text.toUpperCase() : text;
  let units = 0;
  for (const char of source) {
    if (/\s/.test(char)) units += 0.34;
    else if (/[MW@#%&]/.test(char)) units += 0.86;
    else if (/[ilI.,'!:;|]/.test(char)) units += 0.34;
    else if (/[A-Z0-9]/.test(char)) units += 0.66;
    else units += 0.57;
  }
  const characters = Math.max(1, Array.from(source).length);
  const estimatedAtOnePx = units + (characters - 1) * Math.max(-0.08, letterSpacing / Math.max(1, requestedSize));
  const sizeForWidth = maxWidth / Math.max(0.5, estimatedAtOnePx);
  return Math.max(12, Math.min(requestedSize, Math.floor(sizeForWidth)));
}
