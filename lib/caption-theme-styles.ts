import {
  CAPTION_THEME_NAMES,
  type CaptionPreset,
  type CaptionThemeName,
  type OverlayStylePreset,
} from './types';

export interface CaptionThemeDefinition {
  id: CaptionThemeName;
  label: string;
  description: string;
  /** Families installed by remotion/caption-fonts.ts for deterministic local renders. */
  captionFontFamily: string;
  captionPrimaryColor: string;
  captionAccentColor: string;
  /** Conservative vertical reserve for the theme's centered layout. */
  reservedHeightMultiplier: number;
  reservedHeightPadding: number;
  overlayFontFamily: string;
  hook: {
    backgroundColor: string;
    textColor: string;
    borderRadius: number;
    animationStyle: OverlayStylePreset['animationStyle'];
  };
  cta: {
    textColor: string;
    borderRadius: number;
    animationStyle: OverlayStylePreset['animationStyle'];
  };
}

const ADDITIONAL_THEME_DETAILS: Array<{
  id: CaptionThemeName;
  label: string;
  description: string;
  font: string;
  primary: string;
  accent: string;
}> = [
  { id: 'poster-stack', label: 'Poster Stack', description: 'A two-line oversized poster headline with a compact second beat.', font: 'Outfit, sans-serif', primary: '#FFF8E8', accent: '#FF6542' },
  { id: 'news-poster', label: 'News Poster', description: 'A left-ruled editorial headline with a strong newspaper-style measure.', font: 'Montserrat, sans-serif', primary: '#F5F3EE', accent: '#B6E34B' },
  { id: 'cut-poster', label: 'Cut Poster', description: 'Two offset headline slabs with a hard-print shadow and angled cut.', font: 'Outfit, sans-serif', primary: '#FFFDF5', accent: '#F4A340' },
  { id: 'staircase', label: 'Staircase', description: 'Every word takes a descending typographic step with a single central anchor.', font: 'Outfit, sans-serif', primary: '#FFFFFF', accent: '#F08455' },
  { id: 'split-column', label: 'Split Column', description: 'The phrase reads down two balanced columns with a live progress marker.', font: 'Montserrat, sans-serif', primary: '#F4F7F6', accent: '#A8E866' },
  { id: 'editorial-columns', label: 'Editorial Columns', description: 'Two short editorial columns with a bold top rule and wide spacing.', font: 'Outfit, sans-serif', primary: '#FBF5E9', accent: '#E5A74B' },
  { id: 'timestamp-ledger', label: 'Timestamp Ledger', description: 'Transcript words are set against their spoken time in a clean ledger.', font: 'Montserrat, sans-serif', primary: '#F4F7F8', accent: '#55D7CB' },
  { id: 'split-bracket', label: 'Split Bracket', description: 'A moving side marker and corner geometry frame the spoken phrase.', font: 'Rajdhani, sans-serif', primary: '#F7F3EC', accent: '#69C8E9' },
];

const ADDITIONAL_THEME_DEFINITIONS: CaptionThemeDefinition[] =
  ADDITIONAL_THEME_DETAILS.map((theme, index) => ({
    id: theme.id,
    label: theme.label,
    description: theme.description,
    captionFontFamily: theme.font,
    captionPrimaryColor: theme.primary,
    captionAccentColor: theme.accent,
    reservedHeightMultiplier: index >= 4 && index <= 7 ? 4.2 : 3.8,
    reservedHeightPadding: 54,
    overlayFontFamily: theme.font,
    hook: {
      backgroundColor: 'rgba(10, 13, 17, 0.96)',
      textColor: theme.primary,
      borderRadius: 3,
      animationStyle: index % 2 === 0 ? 'slide-up' : 'pop',
    },
    cta: {
      textColor: '#101418',
      borderRadius: 3,
      animationStyle: index % 2 === 0 ? 'slide-up' : 'pop',
    },
  }));

/**
 * Human-facing catalog and the matching Hook/CTA treatment for each upstream theme.
 * The caption accent also drives the Hook border/chip and CTA fill, so changing the
 * selected caption palette stays coherent without coupling the editor to Remotion.
 */
export const CAPTION_THEME_CATALOG: readonly CaptionThemeDefinition[] = [
  {
    id: 'karaoke',
    label: 'Karaoke',
    description: 'A progressive word-fill sweep, synchronized to speech.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FDE047',
    reservedHeightMultiplier: 2.7,
    reservedHeightPadding: 42,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(8, 15, 31, 0.95)', textColor: '#FFFFFF', borderRadius: 10, animationStyle: 'slide-up' },
    cta: { textColor: '#111827', borderRadius: 10, animationStyle: 'slide-up' },
  },
  {
    id: 'kinetic-01',
    label: 'Kinetic 01',
    description: 'Layered kinetic words, with a large focal word and animated side words.',
    captionFontFamily: 'Montserrat, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFD700',
    reservedHeightMultiplier: 3.8,
    reservedHeightPadding: 40,
    overlayFontFamily: 'Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(8, 10, 18, 0.96)', textColor: '#FFFFFF', borderRadius: 8, animationStyle: 'slide-up' },
    cta: { textColor: '#111111', borderRadius: 8, animationStyle: 'slide-up' },
  },
  {
    id: 'grape',
    label: 'Grape',
    description: 'Rounded purple caption blocks with a bright active-word accent.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#7026A8',
    captionAccentColor: '#F0ABFC',
    reservedHeightMultiplier: 2.8,
    reservedHeightPadding: 46,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(44, 13, 74, 0.96)', textColor: '#FFFFFF', borderRadius: 24, animationStyle: 'fade' },
    cta: { textColor: '#281035', borderRadius: 24, animationStyle: 'fade' },
  },
  {
    id: 'poppin',
    label: 'Poppin',
    description: 'Bright Poppins lettering with lively, colorful emphasis.',
    captionFontFamily: 'Poppins, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FF3EA5',
    reservedHeightMultiplier: 2.8,
    reservedHeightPadding: 44,
    overlayFontFamily: 'Poppins, sans-serif',
    hook: { backgroundColor: 'rgba(36, 10, 45, 0.96)', textColor: '#FFFFFF', borderRadius: 999, animationStyle: 'pop' },
    cta: { textColor: '#231027', borderRadius: 999, animationStyle: 'pop' },
  },
  {
    id: 'aarit',
    label: 'Aarit',
    description: 'Letter-by-letter zoom with cinematic highlighted words.',
    captionFontFamily: 'Poppins, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFCA68',
    reservedHeightMultiplier: 3.1,
    reservedHeightPadding: 48,
    overlayFontFamily: 'Poppins, sans-serif',
    hook: { backgroundColor: 'rgba(15, 22, 46, 0.96)', textColor: '#FFFFFF', borderRadius: 10, animationStyle: 'fade' },
    cta: { textColor: '#231A0B', borderRadius: 10, animationStyle: 'fade' },
  },
  {
    id: 'soft-ai',
    label: 'Soft AI',
    description: 'Soft blur-in lettering with a cool, glassy color treatment.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#F4FBFF',
    captionAccentColor: '#8DEBFF',
    reservedHeightMultiplier: 2.8,
    reservedHeightPadding: 46,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'linear-gradient(135deg, rgba(27, 42, 72, 0.94), rgba(26, 80, 112, 0.88))', textColor: '#F4FBFF', borderRadius: 22, animationStyle: 'fade' },
    cta: { textColor: '#08202B', borderRadius: 22, animationStyle: 'fade' },
  },
  {
    id: 'gaming-stream',
    label: 'Gaming Stream',
    description: 'Neon glow, futuristic type and high-energy word scaling.',
    captionFontFamily: 'Rajdhani, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#27FFB4',
    reservedHeightMultiplier: 2.8,
    reservedHeightPadding: 44,
    overlayFontFamily: 'Rajdhani, sans-serif',
    hook: { backgroundColor: 'rgba(5, 17, 29, 0.97)', textColor: '#FFFFFF', borderRadius: 4, animationStyle: 'pop' },
    cta: { textColor: '#041B14', borderRadius: 4, animationStyle: 'pop' },
  },
  {
    id: 'pull-quote',
    label: 'Pull Quote',
    description: 'Magazine-style quote typography with a hanging mark and editorial accent rule.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#F7F7F2',
    captionAccentColor: '#D8FF68',
    reservedHeightMultiplier: 3.1,
    reservedHeightPadding: 56,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(13, 17, 18, 0.96)', textColor: '#F7F7F2', borderRadius: 2, animationStyle: 'slide-up' },
    cta: { textColor: '#151A0A', borderRadius: 2, animationStyle: 'slide-up' },
  },
  {
    id: 'waveform',
    label: 'Waveform',
    description: 'Clean phrase typography paired with a speech-synced waveform meter.',
    captionFontFamily: 'Montserrat, sans-serif',
    captionPrimaryColor: '#F4F7F8',
    captionAccentColor: '#55E3D0',
    reservedHeightMultiplier: 3.2,
    reservedHeightPadding: 54,
    overlayFontFamily: 'Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(7, 18, 23, 0.97)', textColor: '#F4F7F8', borderRadius: 4, animationStyle: 'fade' },
    cta: { textColor: '#071B1B', borderRadius: 4, animationStyle: 'fade' },
  },
  {
    id: 'staggered-stack',
    label: 'Staggered Stack',
    description: 'An asymmetrical typographic stack with staggered entrances and a print-like shadow.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#FFFDF8',
    captionAccentColor: '#FFB45B',
    reservedHeightMultiplier: 3.6,
    reservedHeightPadding: 54,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(19, 15, 12, 0.97)', textColor: '#FFFDF8', borderRadius: 3, animationStyle: 'pop' },
    cta: { textColor: '#211507', borderRadius: 3, animationStyle: 'pop' },
  },
  {
    id: 'focus-dial',
    label: 'Focus Dial',
    description: 'A transparent circular instrument tracks phrase progress around centered type.',
    captionFontFamily: 'Montserrat, sans-serif',
    captionPrimaryColor: '#F5F7F4',
    captionAccentColor: '#9DFF72',
    reservedHeightMultiplier: 6.6,
    reservedHeightPadding: 48,
    overlayFontFamily: 'Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(9, 17, 14, 0.97)', textColor: '#F5F7F4', borderRadius: 3, animationStyle: 'fade' },
    cta: { textColor: '#101A0C', borderRadius: 3, animationStyle: 'fade' },
  },
  {
    id: 'vertical-ticker',
    label: 'Vertical Ticker',
    description: 'The full phrase runs in alternating editorial rows beside a live progress spine.',
    captionFontFamily: 'Rajdhani, sans-serif',
    captionPrimaryColor: '#F7F7F4',
    captionAccentColor: '#FF684A',
    reservedHeightMultiplier: 4.1,
    reservedHeightPadding: 52,
    overlayFontFamily: 'Rajdhani, sans-serif',
    hook: { backgroundColor: 'rgba(20, 13, 12, 0.97)', textColor: '#F7F7F4', borderRadius: 2, animationStyle: 'slide-up' },
    cta: { textColor: '#24100D', borderRadius: 2, animationStyle: 'slide-up' },
  },
  ...ADDITIONAL_THEME_DEFINITIONS,
];

const CAPTION_THEME_MAP = new Map(CAPTION_THEME_CATALOG.map((theme) => [theme.id, theme]));

export function isCaptionThemeName(value: unknown): value is CaptionThemeName {
  return typeof value === 'string' && CAPTION_THEME_NAMES.some((name) => name === value);
}

export function getCaptionThemeDefinition(
  theme: CaptionThemeName | undefined,
): CaptionThemeDefinition | undefined {
  return theme ? CAPTION_THEME_MAP.get(theme) : undefined;
}

function contrastTextColor(background: string, fallback: string): string {
  const normalized = background.trim().replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized;
  if (!/^[\da-f]{6}$/i.test(expanded)) return fallback;

  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? '#111111' : '#FFFFFF';
}

/**
 * Apply the selected caption theme's visual language to Hook or CTA cards while
 * preserving each saved overlay's content, size, badge choice and placement.
 */
export function resolveCaptionThemeOverlayStyle(
  caption: CaptionPreset,
  overlay: OverlayStylePreset,
): OverlayStylePreset {
  if (!caption.captionTheme || caption.matchOverlayTheme === false) return overlay;

  const theme = getCaptionThemeDefinition(caption.captionTheme);
  if (!theme) return overlay;
  const accent = caption.highlightColor || theme.captionAccentColor;
  const fallbackTextColor = overlay.kind === 'hook' ? theme.hook.textColor : theme.cta.textColor;
  const accentText = contrastTextColor(accent, fallbackTextColor);
  const isHook = overlay.kind === 'hook';

  return {
    ...overlay,
    textColor: isHook ? theme.hook.textColor : accentText,
    backgroundColor: isHook ? theme.hook.backgroundColor : accent,
    borderColor: accent,
    borderWidth: isHook ? 2 : 0,
    borderRadius: isHook ? theme.hook.borderRadius : theme.cta.borderRadius,
    textTransform: 'uppercase',
    animationStyle: isHook ? theme.hook.animationStyle : theme.cta.animationStyle,
    ...(isHook
      ? {
          badgeBackgroundColor: accent,
          badgeTextColor: accentText,
        }
      : {}),
  };
}

/** Height (px) reserved around the centered Remotion theme caption group. */
export function captionThemeReservedHeight(preset: CaptionPreset): number {
  const theme = getCaptionThemeDefinition(preset.captionTheme);
  if (!theme) return 0;
  const fontSize = Number.isFinite(preset.fontSize) && preset.fontSize > 0 ? preset.fontSize : 48;
  const estimated = fontSize * theme.reservedHeightMultiplier + theme.reservedHeightPadding;
  return Math.ceil(Math.max(120, Math.min(480, estimated)));
}
