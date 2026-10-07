/**
 * Pure ASS (Advanced SubStation Alpha) generation for the NATIVE caption engine.
 *
 * The ASS file is rasterized onto a transparent PNG sequence by FFmpeg, which
 * runs at native speed instead of painting caption pixels in headless Chrome.
 * The final source video and these overlays are composited in one FFmpeg encode.
 * The visual language mirrors remotion/AnimatedWord:
 *
 * - 4-word caption chunks (same buildCaptionChunks logic)
 * - line pop-in / fade-in entrances (ASS \t transforms, per animation style)
 * - karaoke styles get per-word {\k} fill highlighting (highlight colour eats
 *   through the line in sync with speech)
 * - captions lift up while the CTA card is on screen (same CTA window math)
 * - 0.35s hold after a chunk, like the Remotion renderer
 *
 * What ASS cannot do: spring physics (overshoot) and per-word scaling on the
 * active word - the fill/slide approximation is intentional and close.
 */
import { buildFinalCaptionChunks } from '../remotion/CaptionComposition';
import { getCtaBottomLiftPercent } from '../remotion/CTAOverlay';
import {
  fitCaptionFontSize,
  getCaptionChunkWordLimit,
  splitCaptionWordsIntoLines,
  type CaptionVisualLine,
  type ResolvedCaptionLineStyle,
} from '../lib/caption-layout';
import { maskProfanity } from '../lib/profanity';
import type { CaptionPreset, WordTimestamp } from '../lib/types';

export interface AssGenerationInput {
  /** Word timings relative to the START of the source segment (0 = segment start). */
  words: WordTimestamp[];
  preset: CaptionPreset;
  /** Total duration of the PROCESSED clip (hook portion already included). */
  totalDurationSeconds: number;
  /** Length of the duplicated hook intro baked into the processed clip. */
  hookDuration: number;
  /** Where the hook moment was cut from (seconds from clip start). */
  hookStart: number;
  /** CTA card duration at the end (drives the caption lift). */
  ctaDuration: number;
  /**
   * Length (s) of the dip-to-black transition around the hook join. Captions
   * are blanked across [hookDuration - N, hookDuration + N] (the video is
   * fading and the audio is silent there).
   */
  hookTransitionDuration?: number;
  /**
   * Scale of the usual "lift the captions while the CTA card is on screen" (1 =
   * the default 15% lift, 0 = captions never move). The split-screen layout places
   * the CTA clear of the captions (worker/overlay-layout.ts), so it passes 0.
   */
  captionLiftScale?: number;
}

/** Keep in sync with AnimatedWord's HOLD_AFTER_SECONDS. */
const HOLD_AFTER_SECONDS = 0.35;
const PLAY_RES_X = 1080;
const PLAY_RES_Y = 1920;
/**
 * libass glyphs render visually ~15-20% smaller than the browser text at the
 * same nominal px size (no subpixel AA, different hinting, centred outline),
 * so the native engine scales the preset size up to MATCH the Remotion engine
 * on screen. A per-line width guard below keeps long chunks inside the frame.
 */
const ASS_FONT_SCALE = 1.2;
/** Rough bold-uppercase advance width as a fraction of the font size. */
const EST_CHAR_WIDTH_FRACTION = 0.55;

/** #RRGGBB -> ASS &HAABBGGRR& (00 = fully opaque). */
function assColor(hex: string, alphaHex = '00'): string {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return `&H${alphaHex}000000&`;
  const rr = raw.slice(0, 2);
  const gg = raw.slice(2, 4);
  const bb = raw.slice(4, 6);
  return `&H${alphaHex}${bb}${gg}${rr}&`;
}

/** ASS time H:MM:SS.cc (centiseconds). */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * The worker cannot ship web fonts into FFmpeg's libass, so map the preset
 * font stack onto a font that exists on a Windows desktop (the app is local
 * and Windows-first).
 */
function assFontName(fontFamily?: string): string {
  const f = (fontFamily ?? '').toLowerCase();
  if (f.includes('impact')) return 'Impact';
  if (f.includes('arial black')) return 'Arial Black';
  if (f.includes('liberation sans')) return 'Liberation Sans';
  if (f.includes('dejavu sans')) return 'DejaVu Sans';
  if (f.includes('arial')) return 'Arial';
  // Only return known common families; arbitrary CSS/web-font names are not
  // available to libass and can otherwise resolve unpredictably on Windows.
  return 'Segoe UI';
}

/** Escape literal braces/backslashes so transcript text can never break a tag. */
function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Per-style entrance: starting scale and entrance length in centiseconds.
 *
 * Fades use the classic {\fad(inCs, outCs)} tag (relative to the line start/end)
 * instead of a delayed {\t(start>0, ..., \alpha...)}: current libass builds
 * silently drop the whole line when a delayed transform targets alpha, while
 * \fad is supported everywhere.
 */
function entranceFor(style: CaptionPreset['animationStyle']): { scale: number; cs: number } {
  switch (style) {
    case 'word-pop':
      return { scale: 88, cs: 14 };
    case 'fade-in':
      return { scale: 97, cs: 25 };
    case 'karaoke':
    default:
      return { scale: 92, cs: 12 };
  }
}

/** Fade-out length in centiseconds (the tail of the 0.35s hold). */
const EXIT_FADE_CS = 30;

function buildStyleLine(preset: CaptionPreset): string {
  const {
    fontSize = 48,
    fontWeight = 'bold',
    textColor = '#FFFFFF',
    highlightColor = '#FFE600',
    strokeColor = '#000000',
    strokeWidth = 3,
  } = preset;

  const bold = fontWeight === 'black' || fontWeight === 'extra-bold' || fontWeight === 'bold' ? -1 : 0;
  return (
    `Style: Cap,${assFontName(preset.fontFamily)},${Math.round(fontSize * ASS_FONT_SCALE)},` +
    // Primary = karaoke FILL colour (the highlight), Secondary = base text colour.
    `${assColor(highlightColor)},${assColor(textColor)},${assColor(strokeColor)},&H80000000,` +
    `${bold},0,0,0,100,100,0,0,1,${strokeWidth},0,5,60,60,0,1`
  );
}

/** Vertical centre of the caption line for a preset's bottom-% position. */
function baseYFor(positionY: number, fontSize: number): number {
  const bottomEdgeY = PLAY_RES_Y * (1 - positionY / 100);
  return bottomEdgeY - (fontSize * 1.25) / 2;
}

/**
 * Font size for one line: the preset size scaled up (see ASS_FONT_SCALE),
 * but never wider than ~94% of the frame - long 4-word chunks shrink to fit
 * instead of clipping at the edges.
 */
function fontSizeForLine(chunk: { words: WordTimestamp[] }, fontSize: number): number {
  const text = chunk.words.map((w) => w.word).join(' ');
  const scaled = fontSize * ASS_FONT_SCALE;
  const maxForWidth = (PLAY_RES_X * 0.94) / Math.max(1, text.length) / EST_CHAR_WIDTH_FRACTION;
  return Math.max(20, Math.floor(Math.min(scaled, maxForWidth)));
}

function richFontSize(line: CaptionVisualLine): number {
  const text = line.words
    .map((word) => line.style.uppercase ? word.word.toUpperCase() : word.word)
    .join(' ');
  return fitCaptionFontSize(
    text,
    line.style.fontSize,
    PLAY_RES_X * 0.88,
    line.style.letterSpacing,
    line.style.uppercase
  );
}

function assWeight(weight: ResolvedCaptionLineStyle['fontWeight']): string {
  return weight === 'normal' ? '0' : '1';
}

function splitOverlongAssWord(word: string, assFontSize: number, letterSpacing: number): string[] {
  const maxWidth = PLAY_RES_X * 0.88;
  const maxChars = Math.max(
    12,
    Math.floor(maxWidth / Math.max(1, assFontSize * EST_CHAR_WIDTH_FRACTION + letterSpacing))
  );
  const chars = Array.from(word);
  if (chars.length <= maxChars) return [word];
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    pieces.push(chars.slice(i, i + maxChars).join(''));
  }
  return pieces;
}

function richWordText(word: string, line: CaptionVisualLine, assFontSize: number): string {
  const shown = line.style.uppercase ? word.toUpperCase() : word;
  return splitOverlongAssWord(shown, assFontSize, line.style.letterSpacing)
    .map(assEscape)
    .join('\\N');
}

function buildRichDialogues(
  chunk: { words: WordTimestamp[]; start: number; end: number },
  nextStart: number | undefined,
  input: AssGenerationInput
): string[] {
  const { preset, totalDurationSeconds, ctaDuration } = input;
  const { positionY = 25 } = preset;
  const lines = splitCaptionWordsIntoLines(chunk.words, preset);
  if (lines.length === 0) return [];

  const start = Math.max(0, chunk.start);
  const holdEnd = chunk.end + HOLD_AFTER_SECONDS;
  let end = nextStart !== undefined ? Math.min(holdEnd, nextStart - 0.02) : holdEnd;
  const transitionDur = input.hookDuration > 0
    ? Math.max(0, Math.min(input.hookTransitionDuration ?? 0, input.hookDuration / 2))
    : 0;
  if (transitionDur > 0 && start < input.hookDuration - transitionDur) {
    end = Math.min(end, input.hookDuration - transitionDur);
  }
  if (end - start < 0.12) return [];
  const exitCs = Math.max(0, Math.min(EXIT_FADE_CS, Math.round((end - chunk.end) * 100)));

  const chunkCenter = (start + chunk.end) / 2;
  const liftPercent = getCtaBottomLiftPercent(ctaDuration, totalDurationSeconds, chunkCenter)
    * Math.max(0, input.captionLiftScale ?? 1);
  const liftPx = (liftPercent / 100) * PLAY_RES_Y;
  const lineGap = Number.isFinite(preset.lineGap)
    ? Math.max(0, Math.min(80, preset.lineGap ?? 0))
    : 4;
  const sizes = lines.map((line) => Math.round(richFontSize(line) * ASS_FONT_SCALE));
  const wrapCounts = lines.map((line, index) => {
    const maxChars = Math.max(
      12,
      Math.floor((PLAY_RES_X * 0.88) / Math.max(1, sizes[index] * EST_CHAR_WIDTH_FRACTION + line.style.letterSpacing))
    );
    return line.words.reduce((sum, word) => {
      const shown = line.style.uppercase ? word.word.toUpperCase() : word.word;
      return sum + Math.max(1, Math.ceil(Array.from(shown).length / maxChars));
    }, 0);
  });
  const rowHeights = lines.map((line, index) => sizes[index] * line.style.lineHeight * wrapCounts[index]);
  const blockHeight = rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, lines.length - 1) * lineGap;
  const bottomEdge = PLAY_RES_Y * (1 - positionY / 100) - liftPx;
  let lineTop = bottomEdge - blockHeight;

  return lines.map((line, lineIndex) => {
    const style = line.style;
    const fontSize = sizes[lineIndex];
    const thisTop = Math.round(lineTop);
    lineTop += rowHeights[lineIndex] + lineGap;
    const wordsShown = line.words.map((word) => style.uppercase ? word.word.toUpperCase() : word.word);
    const usesKaraoke = style.animationStyle === 'karaoke';
    let body = wordsShown.map((word) => richWordText(word, line, fontSize)).join(' ');
    if (style.animationStyle === 'word-pop') {
      body = line.words.map((word, wordIndex) => {
        const wordStartMs = Math.max(0, Math.round((word.start - chunk.start) * 1000));
        const wordEndMs = Math.max(wordStartMs + 30, Math.round((word.end - chunk.start) * 1000));
        const popEndMs = wordStartMs + 90;
        const settleEndMs = popEndMs + 90;
        const colorInEndMs = wordStartMs + 30;
        const colorOutStartMs = Math.max(wordStartMs + 1, wordEndMs - 30);
        const wordTags =
          `\\1c${assColor(style.textColor)}\\fscx100\\fscy100` +
          `\\t(${wordStartMs},${colorInEndMs},\\1c${assColor(style.highlightColor)})` +
          `\\t(${wordStartMs},${popEndMs},\\fscx124\\fscy124)` +
          `\\t(${popEndMs},${settleEndMs},\\fscx100\\fscy100)` +
          `\\t(${colorOutStartMs},${wordEndMs},\\1c${assColor(style.textColor)})`;
        return `{${wordTags}}${richWordText(wordsShown[wordIndex], line, fontSize)}`;
      }).join(' ');
    } else if (usesKaraoke) {
      const preRollCs = Math.max(0, Math.round((line.words[0].start - chunk.start) * 100));
      const tagged = line.words.map((word, wordIndex) => {
        const duration = Math.max(1, Math.round((word.end - word.start) * 100));
        return `{\\k${duration}}${richWordText(wordsShown[wordIndex], line, fontSize)}`;
      }).join(' ');
      body = (preRollCs > 0 ? `{\\k${preRollCs}}` : '') + tagged;
    }

    const entrance = entranceFor(style.animationStyle);
    const entranceScale = String(entrance.scale);
    const anim = style.animationStyle === 'static'
      ? ''
      : `\\fscx${entranceScale}\\fscy${entranceScale}\\t(0,${entrance.cs},\\fscx100\\fscy100)\\fad(${entrance.cs},${exitCs})`;
    const italic = style.italic ? '1' : '0';
    const spacing = style.letterSpacing.toFixed(2);
    const alignment = preset.lineAlignment ?? 'center';
    const anchor = alignment === 'left' ? 7 : alignment === 'right' ? 9 : 8;
    const x = alignment === 'left' ? 60 : alignment === 'right' ? PLAY_RES_X - 60 : PLAY_RES_X / 2;
    const position = `\\an${anchor}\\pos(${x},${thisTop})`;
    const primaryColor = usesKaraoke ? style.highlightColor : style.textColor;
    const overrides =
      `\\fn${assFontName(style.fontFamily)}` +
      `\\fs${fontSize}` +
      `\\b${assWeight(style.fontWeight)}` +
      `\\i${italic}` +
      `\\1c${assColor(primaryColor)}` +
      `\\2c${assColor(style.textColor)}` +
      `\\3c${assColor(style.strokeColor)}` +
      `\\bord${style.strokeWidth}` +
      `\\fsp${spacing}` +
      `\\q0` + position + anim;
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{${overrides}}${body}`;
  });
}

function buildDialogue(
  chunk: { words: WordTimestamp[]; start: number; end: number },
  /** Start of the NEXT chunk (undefined for the last) - the line must end before it. */
  nextStart: number | undefined,
  input: AssGenerationInput
): string | null {
  const { preset, totalDurationSeconds, ctaDuration } = input;
  const {
    fontSize = 48,
    positionY = 25,
    animationStyle = 'karaoke',
    uppercase = true,
  } = preset;
  const size = fontSizeForLine(chunk, fontSize);

  const start = Math.max(0, chunk.start);
  // NEVER let two caption lines share the screen: the outgoing line ends at
  // the latest 0.35s after its words, but no later than just before the next
  // line starts. (Two overlapping ASS lines at the same \pos is what made the
  // native captions look "glitchy" - next caption arriving before the
  // previous one left.)
  const holdEnd = chunk.end + HOLD_AFTER_SECONDS;
  let end = nextStart !== undefined ? Math.min(holdEnd, nextStart - 0.02) : holdEnd;

  // Never let a line linger INTO the dip-to-black window around the hook join
  // (the hold tail would otherwise draw text over the black).
  const transitionDur =
    input.hookDuration > 0
      ? Math.max(0, Math.min(input.hookTransitionDuration ?? 0, input.hookDuration / 2))
      : 0;
  if (transitionDur > 0) {
    const windowStart = input.hookDuration - transitionDur;
    if (start < windowStart) end = Math.min(end, windowStart);
  }

  if (end - start < 0.12) return null; // too short to be readable - drop it
  const exitCs = Math.max(0, Math.min(EXIT_FADE_CS, Math.round((end - chunk.end) * 100)));

  // Caption lift while the CTA card is on screen (evaluated at the chunk centre).
  const chunkCenter = (start + chunk.end) / 2;
  const liftPercent =
    getCtaBottomLiftPercent(ctaDuration, totalDurationSeconds, chunkCenter) *
    Math.max(0, input.captionLiftScale ?? 1);
  const y = Math.round(baseYFor(positionY, size) - (liftPercent / 100) * PLAY_RES_Y);

  const wordsShown = chunk.words.map((w) => {
    const t = w.word.trim() || ' ';
    return uppercase ? t.toUpperCase() : t;
  });

  // Karaoke fill: one {\kN} per word (centiseconds) so the highlight advances
  // with the speech. A leading empty {\k} delays the fill until the first word
  // actually starts, if the chunk began slightly early.
  let body = wordsShown.map(assEscape).join(' ');
  if (animationStyle === 'karaoke') {
    const preRollCs = Math.max(0, Math.round((chunk.words[0].start - chunk.start) * 100));
    const tagged = chunk.words
      .map((w, i) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${assEscape(wordsShown[i])}`)
      .join(' ');
    body = (preRollCs > 0 ? `{\\k${preRollCs}}` : '') + tagged;
  }

  // The style carries the scaled size; lines that the width guard shrank get
  // a proportional \fscx scale so they still fill exactly `size` px.
  const lineScale = Math.min(100, (size / (fontSize * ASS_FONT_SCALE)) * 100);
  const target = lineScale.toFixed(1);
  const entrance = entranceFor(animationStyle);
  const from = ((lineScale * entrance.scale) / 100).toFixed(1);
  const anim =
    animationStyle === 'static'
      ? (lineScale < 100 ? `\\fscx${target}\\fscy${target}` : '')
      : `\\fscx${from}\\fscy${from}\\t(0,${entrance.cs},\\fscx${target}\\fscy${target})\\fad(${entrance.cs},${exitCs})`;

  const pos = `\\an8\\pos(${PLAY_RES_X / 2},${y})`;
  const tag = `{${pos}${anim}}`;
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${tag}${body}`;
}

export function generateAssFile(input: AssGenerationInput): string {
  const { preset, hookDuration, hookStart } = input;

  // On-screen profanity masking happens at render time only - the stored
  // transcript (and logs) keep the original words.
  const maskedWords = input.words.map((w) => ({ ...w, word: maskProfanity(w.word) }));

  // The dip-to-black window around the hook join: the video fades out/in and
  // the audio is fully silent there, so no caption may be drawn inside it.
  const transitionDur =
    hookDuration > 0
      ? Math.max(0, Math.min(input.hookTransitionDuration ?? 0, hookDuration / 2))
      : 0;
  const windowStart = hookDuration - transitionDur;
  const windowEnd = hookDuration + transitionDur;

  // Same timeline remapping as the Remotion composition: the processed clip is
  // [hook intro][full segment]. Intro (hook moment) chunks and shifted chunks
  // are built separately so a line never mixes words from two moments.
  const allChunks = buildFinalCaptionChunks(
    maskedWords,
    hookStart,
    hookDuration,
    getCaptionChunkWordLimit(preset)
  ).filter((c) => c.end > 0);
  const chunks =
    transitionDur > 0
      ? allChunks.filter((c) => c.end <= windowStart || c.start >= windowEnd)
      : allChunks;

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildStyleLine(preset),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (let i = 0; i < chunks.length; i += 1) {
    if (preset.lineStyles?.length) {
      lines.push(...buildRichDialogues(chunks[i], chunks[i + 1]?.start, input));
      continue;
    }
    const line = buildDialogue(chunks[i], chunks[i + 1]?.start, input);
    if (line) lines.push(line);
  }

  // Blank (\h) dialogue covering the dip window: documents the intentional gap
  // and guarantees nothing renders over the black.
  if (transitionDur > 0) {
    lines.push(`Dialogue: 0,${assTime(windowStart)},${assTime(windowEnd)},Cap,,0,0,0,,{\\h}`);
  }

  return lines.join('\n') + '\n';
}
