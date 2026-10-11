import {
  FilterPreset,
  CaptionPreset,
  OverlayStylePreset,
  PromptTemplate,
} from "./types";

export const DEFAULT_FILTER_PRESETS: FilterPreset[] = [
  {
    id: "none",
    name: "Original",
    description: "No color filtering applied",
    ffmpegFilter: "null",
  },
  {
    id: "vibrant",
    name: "Vibrant Boost",
    description: "Boosts saturation and contrast for pop",
    ffmpegFilter: "eq=saturation=1.35:contrast=1.08:brightness=0.02",
  },
  {
    id: "warm",
    name: "Warm Sunset",
    description: "Warm golden tones with enhanced contrast",
    ffmpegFilter:
      "eq=saturation=1.2:contrast=1.05,colorbalance=rs=0.1:gs=0.05:bs=-0.1",
  },
  {
    id: "cinematic",
    name: "Cinematic Mood",
    description: "Rich contrast with slightly muted filmic saturation",
    ffmpegFilter:
      "eq=saturation=0.88:contrast=1.25,colorbalance=rs=-0.05:gs=0.02:bs=0.1",
  },
  {
    id: "cool",
    name: "Crisp Cool",
    description: "Clean cool tones with vibrant pop",
    ffmpegFilter:
      "eq=saturation=1.15:contrast=1.1,colorbalance=rs=-0.1:bs=0.15",
  },
  {
    id: "dramatic",
    name: "High Impact",
    description: "High contrast punch for maximum eye-catch",
    ffmpegFilter: "eq=contrast=1.35:saturation=1.1:brightness=-0.02",
  },
];

/**
 * Ids of the built-in caption presets from before the "cc-" redesign. seedDefaults() deletes
 * these rows from existing databases (see retireOldCaptionPresets in lib/db.ts). Never reuse them.
 */
export const RETIRED_CAPTION_PRESET_IDS: readonly string[] = [
  "caption-creator-green",
  "caption-electric-violet",
  "caption-sunburst",
  "caption-clean-studio",
  "caption-coral-flow",
  "preset-rich-dual-beat",
  "preset-rich-editorial",
  "preset-rich-neon-pop",
  "preset-rich-clean-subtitles",
  "preset-rich-color-ladder",
  "preset-rich-static-focus",
  "caption-luxe-gold",
  "caption-executive-clean",
  "caption-rose-gold-editorial",
  "caption-platinum-minimal",
  "caption-royal-emerald",
  "preset-rich-gold-stack",
  "preset-rich-noir-contrast",
  "preset-rich-kinetic-crown",
  "preset-rich-gold-rush",
  "preset-rich-velocity-neon",
  "preset-rich-obsidian-pulse",
  "preset-rich-ivory-suite",
  "preset-rich-titan-ladder",
  "caption-kinetic-ultra",
  "caption-kinetic-chrome",
];

/**
 * Built-in caption styles. Every style is a plain CaptionPreset, so the Remotion engine
 * (remotion/AnimatedWord.tsx) and the native ASS engine (worker/captions-ass.ts) render
 * the same data. Fonts come from public/fonts (see lib/caption-fonts.ts).
 * NOTE: the first entry must stay the default, with positionY 28 (tests/overlay-layout.test.ts).
 */
export const DEFAULT_CAPTION_PRESETS: CaptionPreset[] = [
  {
    _id: "cc-bold-punch",
    name: "Bold Punch",
    fontFamily: "Poppins, Arial, sans-serif",
    fontSize: 64,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#FFD60A",
    strokeColor: "#000000",
    strokeWidth: 6,
    positionY: 28,
    animationStyle: "word-pop",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 3,
        fontFamily: "Poppins, Arial, sans-serif",
        fontSize: 64,
        fontWeight: "black",
        textColor: "#FFFFFF",
        highlightColor: "#FFD60A",
        strokeColor: "#000000",
        strokeWidth: 6,
        uppercase: true,
        letterSpacing: 0,
        animationStyle: "word-pop",
        lineHeight: 1.1,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
    isDefault: true,
  },
  {
    _id: "cc-spotlight",
    name: "Spotlight",
    fontFamily: "Poppins, Arial, sans-serif",
    fontSize: 58,
    fontWeight: "extra-bold",
    textColor: "#9A9A9F",
    highlightColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 4,
    positionY: 26,
    animationStyle: "karaoke",
    uppercase: false,
    lineStyles: [
      {
        maxWords: 4,
        fontFamily: "Poppins, Arial, sans-serif",
        fontSize: 58,
        fontWeight: "extra-bold",
        textColor: "#9A9A9F",
        highlightColor: "#FFFFFF",
        strokeColor: "#000000",
        strokeWidth: 4,
        uppercase: false,
        letterSpacing: 0,
        animationStyle: "karaoke",
        lineHeight: 1.15,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
  },
  {
    _id: "cc-storyteller",
    name: "Storyteller",
    fontFamily: "DM Serif Display, Georgia, serif",
    fontSize: 58,
    fontWeight: "normal",
    textColor: "#FFFFFF",
    highlightColor: "#FFC857",
    strokeColor: "#000000",
    strokeWidth: 3,
    positionY: 24,
    animationStyle: "fade-in",
    uppercase: false,
    lineStyles: [
      {
        maxWords: 5,
        fontFamily: "DM Serif Display, Georgia, serif",
        fontSize: 58,
        fontWeight: "normal",
        textColor: "#FFFFFF",
        highlightColor: "#FFC857",
        strokeColor: "#000000",
        strokeWidth: 3,
        uppercase: false,
        letterSpacing: 0.5,
        animationStyle: "fade-in",
        lineHeight: 1.2,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
  },
  {
    _id: "cc-authority",
    name: "Authority",
    fontFamily: "Poppins, Arial, sans-serif",
    fontSize: 52,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#38BDF8",
    strokeColor: "#000000",
    strokeWidth: 3,
    positionY: 26,
    animationStyle: "karaoke",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 4,
        fontFamily: "Poppins, Arial, sans-serif",
        fontSize: 52,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#38BDF8",
        strokeColor: "#000000",
        strokeWidth: 3,
        uppercase: true,
        letterSpacing: 1,
        animationStyle: "karaoke",
        lineHeight: 1.15,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
  },
  {
    _id: "cc-composite",
    name: "Composite",
    fontFamily: "Archivo Black, Arial Black, sans-serif",
    fontSize: 72,
    fontWeight: "normal",
    textColor: "#FFFFFF",
    highlightColor: "#FFE066",
    strokeColor: "#000000",
    strokeWidth: 6,
    positionY: 27,
    animationStyle: "word-pop",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontFamily: "Archivo Black, Arial Black, sans-serif",
        fontSize: 72,
        fontWeight: "normal",
        textColor: "#FFFFFF",
        highlightColor: "#FFE066",
        strokeColor: "#000000",
        strokeWidth: 6,
        uppercase: true,
        letterSpacing: 0,
        animationStyle: "word-pop",
        lineHeight: 1.05,
      },
      {
        maxWords: 3,
        fontFamily: "Poppins, Arial, sans-serif",
        fontSize: 46,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#FFE066",
        strokeColor: "#000000",
        strokeWidth: 4,
        uppercase: false,
        letterSpacing: 0,
        animationStyle: "karaoke",
        lineHeight: 1.15,
      },
    ],
    lineGap: 8,
    lineAlignment: "center",
  },
  {
    _id: "cc-minimalist",
    name: "Minimalist",
    fontFamily: "Poppins, Arial, sans-serif",
    fontSize: 42,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 2,
    positionY: 18,
    animationStyle: "fade-in",
    uppercase: false,
    lineStyles: [
      {
        maxWords: 6,
        fontFamily: "Poppins, Arial, sans-serif",
        fontSize: 42,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#FFFFFF",
        strokeColor: "#000000",
        strokeWidth: 2,
        uppercase: false,
        letterSpacing: 0,
        animationStyle: "fade-in",
        lineHeight: 1.2,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
  },
  {
    _id: "cc-kinetic",
    name: "Kinetic",
    fontFamily: "Anton, Impact, sans-serif",
    fontSize: 88,
    fontWeight: "normal",
    textColor: "#FFFFFF",
    highlightColor: "#00F5A0",
    strokeColor: "#000000",
    strokeWidth: 6,
    positionY: 30,
    animationStyle: "word-pop",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontFamily: "Anton, Impact, sans-serif",
        fontSize: 88,
        fontWeight: "normal",
        textColor: "#FFFFFF",
        highlightColor: "#00F5A0",
        strokeColor: "#000000",
        strokeWidth: 6,
        uppercase: true,
        letterSpacing: 1,
        animationStyle: "word-pop",
        lineHeight: 1.05,
      },
    ],
    lineGap: 4,
    lineAlignment: "center",
  },
  {
    _id: "cc-cinematic",
    name: "Cinematic",
    fontFamily: "Bebas Neue, Impact, sans-serif",
    fontSize: 66,
    fontWeight: "normal",
    textColor: "#F5F5F5",
    highlightColor: "#FFB020",
    strokeColor: "#000000",
    strokeWidth: 3,
    positionY: 14,
    animationStyle: "fade-in",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 4,
        fontFamily: "Bebas Neue, Impact, sans-serif",
        fontSize: 66,
        fontWeight: "normal",
        textColor: "#F5F5F5",
        highlightColor: "#FFB020",
        strokeColor: "#000000",
        strokeWidth: 3,
        uppercase: true,
        letterSpacing: 6,
        animationStyle: "fade-in",
        lineHeight: 1.1,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
  },
];

/**
 * Modern overlay styles for the intro hook and end CTA. Dark glass cards,
 * solid accent blocks, and pills with restrained borders instead of heavy chrome.
 */
export const DEFAULT_OVERLAY_STYLE_PRESETS: OverlayStylePreset[] = [
  // ── Hook styles ──────────────────────────────────────────────
  {
    _id: "hook-aurora-gradient",
    kind: "hook",
    name: "Aurora Gradient",
    description: "White hook on a violet-to-blue gradient card",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    backgroundColor:
      "linear-gradient(135deg, rgba(124,58,237,0.96), rgba(37,99,235,0.96))",
    borderColor: "rgba(255, 255, 255, 0.18)",
    borderWidth: 1,
    borderRadius: 24,
    textTransform: "uppercase",
    positionY: 55,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Wait For End",
    isDefault: true,
  },
  {
    _id: "hook-midnight-glass",
    kind: "hook",
    name: "Midnight Glass",
    description:
      "White bold text on a dark translucent card with a subtle accent chip",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 38,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(10, 10, 15, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderWidth: 1,
    borderRadius: 20,
    textTransform: "uppercase",
    positionY: 12,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Watch This",
    isDefault: false,
  },
  {
    _id: "hook-volt-yellow",
    kind: "hook",
    name: "Volt Yellow",
    description:
      "Black text on a solid yellow block that slides up for instant contrast",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#0A0A0F",
    backgroundColor: "rgba(255, 224, 0, 0.98)",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
    borderRadius: 14,
    textTransform: "uppercase",
    positionY: 13,
    animationStyle: "slide-up",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-crimson-alert",
    kind: "hook",
    name: "Crimson Alert",
    description:
      "White text on a deep red card with a clean border for high-tension hooks",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(225, 29, 72, 0.95)",
    borderColor: "rgba(255, 255, 255, 0.22)",
    borderWidth: 1,
    borderRadius: 16,
    textTransform: "uppercase",
    positionY: 14,
    animationStyle: "slide-up",
    showBadge: true,
    badgeText: "Wait For It",
    isDefault: false,
  },
  {
    _id: "hook-soft-light",
    kind: "hook",
    name: "Soft Light",
    description: "Dark text on a frosted white card, calm and editorial",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 36,
    fontWeight: "extra-bold",
    textColor: "#0F172A",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderColor: "rgba(15, 23, 42, 0.08)",
    borderWidth: 1,
    borderRadius: 22,
    textTransform: "none",
    positionY: 12,
    animationStyle: "pop",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-gold-leaf",
    kind: "hook",
    name: "Gold Leaf Luxe",
    description:
      "Warm serif text on a near-black card with a hand-drawn gold border - the finance/luxury look",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 36,
    fontWeight: "bold",
    textColor: "#FFF8E7",
    backgroundColor: "rgba(12, 10, 8, 0.92)",
    borderColor: "rgba(245, 197, 66, 0.55)",
    borderWidth: 2,
    borderRadius: 18,
    textTransform: "none",
    positionY: 12,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Worth Every Second",
    isDefault: false,
  },
  {
    _id: "hook-executive-slate",
    kind: "hook",
    name: "Executive Slate",
    description:
      "Cool slate glass with a hairline border - boardroom-clean for business and tech content",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 36,
    fontWeight: "extra-bold",
    textColor: "#F1F5F9",
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderColor: "rgba(148, 163, 184, 0.35)",
    borderWidth: 1,
    borderRadius: 16,
    textTransform: "none",
    positionY: 13,
    animationStyle: "slide-up",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-neon-noir",
    kind: "hook",
    name: "Neon Noir",
    description:
      "Near-black card outlined in electric cyan - the late-night, high-energy aesthetic",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 38,
    fontWeight: "black",
    textColor: "#E0FBFF",
    backgroundColor: "rgba(5, 5, 8, 0.92)",
    borderColor: "rgba(34, 211, 238, 0.6)",
    borderWidth: 2,
    borderRadius: 20,
    textTransform: "uppercase",
    positionY: 13,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Don't Scroll",
    isDefault: false,
  },
  {
    _id: "hook-champagne-silk",
    kind: "hook",
    name: "Champagne Silk",
    description:
      "Soft cream card with dark serif text and a whisper of gold - quiet luxury",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 34,
    fontWeight: "bold",
    textColor: "#4A3B22",
    backgroundColor: "rgba(250, 245, 235, 0.96)",
    borderColor: "rgba(212, 175, 55, 0.45)",
    borderWidth: 1,
    borderRadius: 22,
    textTransform: "none",
    positionY: 12,
    animationStyle: "fade",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-emerald-elite",
    kind: "hook",
    name: "Emerald Elite",
    description:
      "Deep emerald glass with a gold hairline - old-money confidence for money content",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 36,
    fontWeight: "bold",
    textColor: "#F0FDF4",
    backgroundColor: "rgba(6, 58, 36, 0.92)",
    borderColor: "rgba(245, 197, 66, 0.5)",
    borderWidth: 1,
    borderRadius: 18,
    textTransform: "none",
    positionY: 14,
    animationStyle: "slide-up",
    showBadge: true,
    badgeText: "Money Move",
    isDefault: false,
  },

  // ── CTA styles ───────────────────────────────────────────────
  {
    _id: "cta-aurora-gradient",
    kind: "cta",
    name: "Aurora Gradient",
    description: "White CTA on a violet-to-blue gradient card",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor:
      "linear-gradient(135deg, rgba(124,58,237,0.96), rgba(37,99,235,0.96))",
    borderColor: "rgba(255, 255, 255, 0.18)",
    borderWidth: 1,
    borderRadius: 24,
    textTransform: "uppercase",
    positionY: 64,
    animationStyle: "pop",
    isDefault: true,
  },
  {
    _id: "cta-mono-pill",
    kind: "cta",
    name: "Mono Pill",
    description: "Dark text on a clean white pill with a soft fade",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 32,
    fontWeight: "extra-bold",
    textColor: "#0A0A0F",
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderColor: "rgba(10, 10, 15, 0.08)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "none",
    positionY: 66,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-night-outline",
    kind: "cta",
    name: "Night Outline",
    description: "White text on a dark glass pill with a light outline",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 32,
    fontWeight: "extra-bold",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(10, 10, 15, 0.8)",
    borderColor: "rgba(255, 255, 255, 0.25)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "uppercase",
    positionY: 65,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-mint-solid",
    kind: "cta",
    name: "Mint Solid",
    description: "Dark text on a solid mint block that pops in",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "black",
    textColor: "#04130B",
    backgroundColor: "rgba(52, 245, 142, 0.98)",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
    borderRadius: 18,
    textTransform: "uppercase",
    positionY: 64,
    animationStyle: "pop",
    isDefault: false,
  },
  {
    _id: "cta-gold-leaf",
    kind: "cta",
    name: "Gold Leaf Luxe",
    description: "The matching gold-on-black card for a premium sign-off",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 32,
    fontWeight: "bold",
    textColor: "#FFF8E7",
    backgroundColor: "rgba(12, 10, 8, 0.92)",
    borderColor: "rgba(245, 197, 66, 0.55)",
    borderWidth: 2,
    borderRadius: 20,
    textTransform: "none",
    positionY: 64,
    animationStyle: "pop",
    isDefault: false,
  },
  {
    _id: "cta-executive-slate",
    kind: "cta",
    name: "Executive Slate",
    description:
      "Slate-glass pill with a hairline border - calm, corporate close",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 30,
    fontWeight: "extra-bold",
    textColor: "#F1F5F9",
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderColor: "rgba(148, 163, 184, 0.35)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "none",
    positionY: 65,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-neon-noir",
    kind: "cta",
    name: "Neon Noir",
    description:
      "Black card, cyan outline - the energy carries into the follow ask",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 32,
    fontWeight: "black",
    textColor: "#E0FBFF",
    backgroundColor: "rgba(5, 5, 8, 0.92)",
    borderColor: "rgba(34, 211, 238, 0.6)",
    borderWidth: 2,
    borderRadius: 20,
    textTransform: "uppercase",
    positionY: 64,
    animationStyle: "pop",
    isDefault: false,
  },
  {
    _id: "cta-champagne-silk",
    kind: "cta",
    name: "Champagne Silk",
    description: "Cream card, dark serif - a soft, expensive-looking ending",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 30,
    fontWeight: "bold",
    textColor: "#4A3B22",
    backgroundColor: "rgba(250, 245, 235, 0.96)",
    borderColor: "rgba(212, 175, 55, 0.45)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "none",
    positionY: 65,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-emerald-elite",
    kind: "cta",
    name: "Emerald Elite",
    description: "Deep emerald with a gold hairline - closes like a vault door",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 32,
    fontWeight: "bold",
    textColor: "#F0FDF4",
    backgroundColor: "rgba(6, 58, 36, 0.92)",
    borderColor: "rgba(245, 197, 66, 0.5)",
    borderWidth: 1,
    borderRadius: 20,
    textTransform: "none",
    positionY: 64,
    animationStyle: "pop",
    isDefault: false,
  },
  // ── Kinetic collection: bold modern cards built to sit right above the captions ──
  {
    _id: "hook-kinetic-aurum",
    kind: "hook",
    name: "Aurum Frame",
    description:
      "Near-black card ringed in molten gold - stops the scroll like a headline",
    fontFamily: "'Arial Black', Impact, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#FFF6DC",
    backgroundColor: "rgba(12, 9, 4, 0.95)",
    borderColor: "rgba(255, 215, 94, 0.9)",
    borderWidth: 3,
    borderRadius: 20,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Wait For It",
    isDefault: false,
  },
  {
    _id: "hook-kinetic-slate-run",
    kind: "hook",
    name: "Slate Motion",
    description:
      "Cool slate glass with a cyan hairline that glides up into place",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 38,
    fontWeight: "extra-bold",
    textColor: "#F8FAFC",
    backgroundColor: "rgba(15, 23, 42, 0.88)",
    borderColor: "rgba(34, 211, 238, 0.55)",
    borderWidth: 2,
    borderRadius: 16,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "slide-up",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-kinetic-royal-velvet",
    kind: "hook",
    name: "Royal Velvet",
    description:
      "Deep violet velvet with serif lettering and a gold frame - old-money drama",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 38,
    fontWeight: "bold",
    textColor: "#FDF3E3",
    backgroundColor:
      "linear-gradient(150deg, rgba(49, 18, 74, 0.96), rgba(24, 7, 40, 0.96))",
    borderColor: "rgba(233, 196, 106, 0.75)",
    borderWidth: 2,
    borderRadius: 18,
    textTransform: "none",
    positionY: 50,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "The Secret",
    isDefault: false,
  },
  {
    _id: "hook-kinetic-chrome-flash",
    kind: "hook",
    name: "Chrome Flash",
    description:
      "Liquid-chrome panel with dark cut-out type - motorsport energy",
    fontFamily: "'Arial Black', Impact, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#0B1220",
    backgroundColor: "linear-gradient(120deg, #F8FAFC, #C7D2E0 55%, #94A3B8)",
    borderColor: "rgba(255, 255, 255, 0.85)",
    borderWidth: 2,
    borderRadius: 14,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "slide-up",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-kinetic-ember-noir",
    kind: "hook",
    name: "Ember Noir",
    description:
      "Charcoal noir outlined in live ember - late-night storytelling heat",
    fontFamily: "Impact, 'Arial Black', sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#FFE8D6",
    backgroundColor: "rgba(16, 10, 7, 0.95)",
    borderColor: "rgba(255, 107, 53, 0.8)",
    borderWidth: 2,
    borderRadius: 22,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Don't Skip",
    isDefault: false,
  },
  {
    _id: "cta-kinetic-aurum",
    kind: "cta",
    name: "Aurum Close",
    description: "Molten-gold gradient slab - the premium end card",
    fontFamily: "'Arial Black', Impact, sans-serif",
    fontSize: 36,
    fontWeight: "black",
    textColor: "#241703",
    backgroundColor: "linear-gradient(135deg, #FFE9A8, #D6A436 55%, #8A5E10)",
    borderColor: "rgba(255, 246, 220, 0.9)",
    borderWidth: 2,
    borderRadius: 22,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "pop",
    isDefault: false,
  },
  {
    _id: "cta-kinetic-slate-run",
    kind: "cta",
    name: "Slate Close",
    description: "Slate glass with a cyan edge - the clean tech sign-off",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "extra-bold",
    textColor: "#F8FAFC",
    backgroundColor: "rgba(15, 23, 42, 0.9)",
    borderColor: "rgba(56, 189, 248, 0.55)",
    borderWidth: 2,
    borderRadius: 16,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "slide-up",
    isDefault: false,
  },
  {
    _id: "cta-kinetic-royal-velvet",
    kind: "cta",
    name: "Velvet Close",
    description:
      "Violet velvet with gold serif type - the invitation-card ending",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 34,
    fontWeight: "bold",
    textColor: "#FDF3E3",
    backgroundColor:
      "linear-gradient(150deg, rgba(49, 18, 74, 0.96), rgba(24, 7, 40, 0.96))",
    borderColor: "rgba(233, 196, 106, 0.75)",
    borderWidth: 2,
    borderRadius: 18,
    textTransform: "none",
    positionY: 50,
    animationStyle: "pop",
    isDefault: false,
  },
  {
    _id: "cta-kinetic-chrome-flash",
    kind: "cta",
    name: "Chrome Close",
    description: "Chrome panel with dark type - the checkered-flag finish",
    fontFamily: "'Arial Black', Impact, sans-serif",
    fontSize: 36,
    fontWeight: "black",
    textColor: "#0B1220",
    backgroundColor: "linear-gradient(120deg, #F8FAFC, #C7D2E0 55%, #94A3B8)",
    borderColor: "rgba(255, 255, 255, 0.85)",
    borderWidth: 2,
    borderRadius: 14,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "slide-up",
    isDefault: false,
  },
  {
    _id: "cta-kinetic-ember-noir",
    kind: "cta",
    name: "Ember Close",
    description: "Charcoal card with an ember rim - the last word by firelight",
    fontFamily: "Impact, 'Arial Black', sans-serif",
    fontSize: 34,
    fontWeight: "black",
    textColor: "#FFE8D6",
    backgroundColor: "rgba(16, 10, 7, 0.95)",
    borderColor: "rgba(255, 107, 53, 0.8)",
    borderWidth: 2,
    borderRadius: 22,
    textTransform: "uppercase",
    positionY: 50,
    animationStyle: "pop",
    isDefault: false,
  },
];

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    _id: "prompt-viral-detection",
    type: "viral_detection",
    name: "Viral Short Segments Detection",
    description:
      "Expert social-strategy prompt: ranks transcript moments by viral potential and returns full clip packaging (hook, CTA, title, hashtags, safety, scores) as JSON",
    systemPrompt:
      "You are an expert Social Media Strategist and professional Short-Form Content Clipper for platforms like TikTok, Instagram Reels, and YouTube Shorts. You deeply analyze entire video conversations and extract the TOP most viral moments that can be turned into short-form clips. You always follow every strict rule exactly, you never invent timestamps, and you always return strict, valid JSON.",
    template: `IMPORTANT STRICT RULES (MUST FOLLOW):

- Every selected clip MUST be between {{minClipDuration}}–{{maxClipDuration}} seconds long.
- NEVER create clips shorter than {{minClipDuration}} seconds.
- Follow all instructions exactly as written.
- Use ONLY timestamps directly supported by the transcript. Do not invent or estimate timestamps.
- Do not skip any required section.
- Do not give generic answers.
- Carefully verify timestamps before selecting clips.
- Start clips as close as possible to the emotional trigger or curiosity point. Remove unnecessary setup unless it increases retention.
- Prioritize clips that create immediate emotional tension within the first 1–3 seconds.
- Use relevant emojis throughout the response to improve readability, visual organization, and emotional understanding.
- DO NOT number clips based on the order they appear in the transcript.
- First analyze all possible viral moments, then rank them by highest viral potential.
- Clip #1 MUST be the MOST viral clip.
- Clip #2 MUST be the second most viral clip.
- Continue numbering strictly based on viral ranking, not transcript order.

When selecting clips, focus on:

- High Emotion: anger, excitement, intense laughter, tension, or sadness.
- Controversy / Hot Takes: strong opinions or statements that can trigger debate in the comments.
- Storytelling: engaging stories with a strong setup and payoff.
- High Value: powerful advice, insights, lessons, or mindset shifts.

For each clip, provide the information in the exact format below:

Clip #[Number]

Timestamp: [Exact Start Time – Exact End Time]
Clip Duration: [Total duration in minutes and seconds]

Why This Will Go Viral:
[Explain the psychology behind why viewers will keep watching, comment, and share it]

Carefully analyze the transcript using verified timestamps and select only highly viral moments. (Lock)

Do not create clips with overlapping timestamps. Every clip must have completely different timings. (Lock)

Now, for each clip, perform these tasks separately:

1. Hook Line Analysis

Carefully read the clip and identify the single strongest line that can be used as a cold open hook at the start of the edited video.

Also provide:

- Exact hook timestamp (start and end)
- Why this hook works psychologically
- Whether the hook should be placed before the actual clip starts for retention

(Lock)

2. Retention Analysis

For every clip, explain:

- What creates curiosity in the first 3 seconds
- Where the payoff happens
- Whether the clip has an "open loop"
- Whether the viewer is likely to watch till the end
- Predicted retention strength: Weak / Medium / Strong / Extreme

(Lock)

3. Psychological Trigger Analysis

Identify the dominant psychological trigger:

- Curiosity
- Anger
- Inspiration
- Shock
- Validation
- Fear
- Controversy
- Humor

Explain why this trigger increases engagement.

(Lock)

4. TikTok / Shorts Safety & Eligibility Analysis

Carefully analyze the clip, including:

- Spoken words
- Captions/subtitles shown on screen
- Potential policy-sensitive wording

Check whether:

- The clip could become "Ineligible For You Feed"
- Any words may reduce reach, monetization, or distribution
- Any wording could trigger moderation or disqualification
- Check for monetization risk, reused-content risk, and algorithm suppression risk

Clearly mention:

- Risk Level: Low / Medium / High
- Exact risky words or phrases
- Which words should be censored, replaced, muted, or removed from captions/voice
- NEVER use hidden/censored references like "f-word", "s-word", "n-word", etc.
- Always write the exact risky word or phrase clearly so there is no confusion.
- If needed, also provide a safer replacement version beside it.

Mention this separately for every clip. (Lock)

5. Viral Packaging

After analyzing the clip, provide:

A. Hook Text On Video
A highly engaging text line for the first seconds of the video that makes viewers stop scrolling.

B. Video Title
A curiosity-driven, high-retention title optimized for TikTok/Reels/Shorts.

[Catchy and engaging title]

C. CTA Text (End Screen)
A short CTA text for the end of the clip that encourages comments, arguments, or engagement. Slightly controversial/questionable CTAs are preferred if they remain platform-safe.

D. Hashtags:
[3–5 highly relevant viral potential hashtags]

Also mention separately:

- Whether the wording is fully platform-safe
- Whether any text could affect eligibility or reach
- Any words that should be changed in captions or voiceover

(Lock)

6. Viral Scoring System

For every clip, provide:

- Viral Score: /10
- Retention Score: /10
- Controversy Score: /10
- Shareability Score: /10

(Lock)

Rank all clips based on viral potential, with the highest viral probability first.

For every clip, keep the same structure:

- Clip Number
- Timestamp
- Title
- Hook
- Viral Analysis
- Retention Analysis
- Psychological Trigger Analysis
- Safety Analysis
- Viral Packaging
- Viral Scores

Make the final output clean, highly organized, professional, and strictly follow every instruction above.

OUTPUT FORMAT (OVERRIDES ALL FORMATTING ABOVE):

Return ONLY a single valid JSON object. No markdown, no code fences, no explanations, no text before or after the JSON.

- All the sections, rules, and analysis above still apply in full. Only the output format changes: the "Clip #" text layout is replaced by the JSON schema below.
- Emojis are allowed ONLY inside string values.
- Use double quotes, escape internal quotes and newlines properly, and use no trailing commas.
- The "clips" array MUST be sorted by viral ranking (rank 1 = most viral), not by transcript order.
- Timestamps must be strings in the same format as the transcript (for example "125.5s"). Durations must be calculated from them.
- "rank", every "duration" value and the four "scores" are plain numbers (scores from 0 to 10, no "/10"). Every other value is a string, a boolean (true or false) or an array, exactly as in the schema.
- Where the schema lists options separated by "|" (predicted_retention, dominant_trigger, risk_level, action), output exactly ONE of those options, spelled exactly as shown - never the whole list.
- Never output null. Use "" or [] if something is not applicable.

JSON SCHEMA:
{
  "clips": [
    {
      "rank": 1,
      "timestamp": { "start": "", "end": "" },
      "duration": { "minutes": 0, "seconds": 0, "total_seconds": 0 },
      "why_this_will_go_viral": "",
      "hook_line_analysis": {
        "hook_line": "",
        "hook_timestamp": { "start": "", "end": "" },
        "why_it_works": "",
        "place_before_clip": true
      },
      "retention_analysis": {
        "curiosity_first_3_seconds": "",
        "payoff_location": "",
        "open_loop": true,
        "likely_to_watch_till_end": true,
        "predicted_retention": "Weak | Medium | Strong | Extreme"
      },
      "psychological_trigger": {
        "dominant_trigger": "Curiosity | Anger | Inspiration | Shock | Validation | Fear | Controversy | Humor",
        "explanation": ""
      },
      "safety_analysis": {
        "risk_level": "Low | Medium | High",
        "monetization_risk": "",
        "reused_content_risk": "",
        "algorithm_suppression_risk": "",
        "ineligible_for_fyf_risk": "",
        "risky_words": [
          { "word_or_phrase": "", "action": "censor | replace | mute | remove", "safer_replacement": "" }
        ]
      },
      "viral_packaging": {
        "hook_text_on_video": "",
        "video_title": "",
        "cta_text": "",
        "hashtags": ["", "", ""],
        "platform_safe": true,
        "eligibility_or_reach_concerns": "",
        "words_to_change": []
      },
      "scores": {
        "viral_score": 0,
        "retention_score": 0,
        "controversy_score": 0,
        "shareability_score": 0
      }
    }
  ]
}

The "clips" array must contain exactly {{clipCount}} items. Output the JSON object and nothing else.

TRANSCRIPT:
{{transcript}}`,
    updatedAt: new Date().toISOString(),
  },
];
