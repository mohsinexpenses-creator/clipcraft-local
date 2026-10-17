import {
  CAPTION_THEME_NAMES,
  type CaptionPreset,
  type CaptionThemeName,
  type OverlayStylePreset,
} from './types';

 interface CaptionThemeDefinition {
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

/**
 * Human-facing catalog and the matching Hook/CTA treatment for each upstream theme.
 * The caption accent also drives the Hook border/chip and CTA fill, so changing the
 * selected caption palette stays coherent without coupling the editor to Remotion.
 */
export const CAPTION_THEME_CATALOG: readonly CaptionThemeDefinition[] = [
  {
    id: 'pop',
    label: 'Pop',
    description: 'Bouncy word emphasis with bold, high-contrast typography.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFD60A',
    reservedHeightMultiplier: 2.7,
    reservedHeightPadding: 42,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(15, 23, 42, 0.94)', textColor: '#FFFFFF', borderRadius: 18, animationStyle: 'pop' },
    cta: { textColor: '#111827', borderRadius: 999, animationStyle: 'pop' },
  },
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
    id: 'kinetic-02',
    label: 'Kinetic 02',
    description: 'A second kinetic layout with punchy word-by-word motion.',
    captionFontFamily: 'Montserrat, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#00E5FF',
    reservedHeightMultiplier: 3.8,
    reservedHeightPadding: 40,
    overlayFontFamily: 'Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(5, 14, 24, 0.96)', textColor: '#FFFFFF', borderRadius: 4, animationStyle: 'slide-up' },
    cta: { textColor: '#04131B', borderRadius: 4, animationStyle: 'slide-up' },
  },
  {
    id: 'hustle',
    label: 'Hustle',
    description: 'Fast, oversized words with a thick outline and energetic emphasis.',
    captionFontFamily: 'Montserrat, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFEB3B',
    reservedHeightMultiplier: 2.8,
    reservedHeightPadding: 44,
    overlayFontFamily: 'Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(0, 0, 0, 0.96)', textColor: '#FFFFFF', borderRadius: 4, animationStyle: 'pop' },
    cta: { textColor: '#101010', borderRadius: 4, animationStyle: 'pop' },
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
    id: 'beast',
    label: 'Beast',
    description: 'Comic-book lettering, heavy outlines and a vivid active-word pop.',
    captionFontFamily: 'Bangers, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFFF00',
    reservedHeightMultiplier: 2.9,
    reservedHeightPadding: 48,
    overlayFontFamily: 'Bangers, Montserrat, sans-serif',
    hook: { backgroundColor: 'rgba(0, 0, 0, 0.96)', textColor: '#FFFFFF', borderRadius: 12, animationStyle: 'pop' },
    cta: { textColor: '#101010', borderRadius: 12, animationStyle: 'pop' },
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
    id: 'simple-one-word',
    label: 'Simple One Word',
    description: 'A clean focal word at a time, with minimal styling.',
    captionFontFamily: 'Outfit, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FFD60A',
    reservedHeightMultiplier: 1.9,
    reservedHeightPadding: 40,
    overlayFontFamily: 'Outfit, sans-serif',
    hook: { backgroundColor: 'rgba(9, 12, 20, 0.92)', textColor: '#FFFFFF', borderRadius: 6, animationStyle: 'fade' },
    cta: { textColor: '#151515', borderRadius: 6, animationStyle: 'fade' },
  },
  {
    id: 'podcast',
    label: 'Podcast',
    description: 'Two-line speaker-style captions with a contrasting accent line.',
    captionFontFamily: 'Anton, Impact, sans-serif',
    captionPrimaryColor: '#FFFFFF',
    captionAccentColor: '#FF2D6B',
    reservedHeightMultiplier: 3.2,
    reservedHeightPadding: 56,
    overlayFontFamily: 'Anton, Impact, sans-serif',
    hook: { backgroundColor: 'rgba(12, 13, 20, 0.96)', textColor: '#FFFFFF', borderRadius: 8, animationStyle: 'slide-up' },
    cta: { textColor: '#200A12', borderRadius: 8, animationStyle: 'slide-up' },
  },
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
    fontFamily: theme.overlayFontFamily,
    fontWeight: 'black',
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
