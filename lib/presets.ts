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
 * Modern caption styles: tighter strokes, cleaner type, and a single accent
 * color per preset so highlighted words read instantly on mobile.
 */
export const DEFAULT_CAPTION_PRESETS: CaptionPreset[] = [
  {
    _id: "caption-creator-green",
    name: "Creator Green",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 52,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#22E55E",
    strokeColor: "#000000",
    strokeWidth: 5,
    positionY: 28,
    animationStyle: "karaoke",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-electric-violet",
    name: "Electric Violet",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 48,
    fontWeight: "extra-bold",
    textColor: "#FFFFFF",
    highlightColor: "#A78BFA",
    strokeColor: "#0B0B14",
    strokeWidth: 4,
    positionY: 30,
    animationStyle: "word-pop",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-sunburst",
    name: "Sunburst Pop",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 54,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#FFB800",
    strokeColor: "#000000",
    strokeWidth: 5,
    positionY: 26,
    animationStyle: "word-pop",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-clean-studio",
    name: "Clean Studio",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 44,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#60A5FA",
    strokeColor: "#000000",
    strokeWidth: 2,
    positionY: 22,
    animationStyle: "fade-in",
    uppercase: false,
    isDefault: false,
  },
  {
    _id: "caption-coral-flow",
    name: "Coral Flow",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 46,
    fontWeight: "extra-bold",
    textColor: "#FFF7F5",
    highlightColor: "#FF6B6B",
    strokeColor: "#1A0B0B",
    strokeWidth: 3,
    positionY: 24,
    animationStyle: "karaoke",
    uppercase: false,
    isDefault: false,
  },
  {
    _id: "preset-rich-dual-beat",
    name: "Dual Beat Highlight",
    fontFamily: "Arial Black, Impact, sans-serif",
    fontSize: 48,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#FFE600",
    strokeColor: "#0F172A",
    strokeWidth: 4,
    positionY: 28,
    animationStyle: "karaoke",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontSize: 58,
        fontWeight: "black",
        textColor: "#FFFFFF",
        highlightColor: "#FFE600",
        strokeColor: "#0F172A",
        strokeWidth: 4,
        uppercase: true,
        animationStyle: "karaoke",
        lineHeight: 1.06,
      },
      {
        maxWords: 3,
        fontSize: 46,
        fontWeight: "extra-bold",
        textColor: "#E2E8F0",
        highlightColor: "#38BDF8",
        strokeColor: "#0F172A",
        strokeWidth: 3,
        uppercase: true,
        animationStyle: "karaoke",
        lineHeight: 1.12,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
    isDefault: true,
  },
  {
    _id: "preset-rich-editorial",
    name: "Editorial Italic Stack",
    fontFamily: "Arial, sans-serif",
    fontSize: 44,
    fontWeight: "normal",
    textColor: "#F8FAFC",
    highlightColor: "#F97316",
    strokeColor: "#111827",
    strokeWidth: 2,
    positionY: 24,
    animationStyle: "fade-in",
    uppercase: false,
    lineStyles: [
      {
        maxWords: 3,
        fontSize: 46,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#FB923C",
        strokeWidth: 2,
        uppercase: false,
        italic: true,
        letterSpacing: 0.2,
        animationStyle: "fade-in",
        lineHeight: 1.15,
      },
      {
        maxWords: 4,
        fontSize: 38,
        fontWeight: "normal",
        textColor: "#FED7AA",
        highlightColor: "#FDBA74",
        strokeWidth: 1,
        uppercase: false,
        italic: false,
        letterSpacing: 0.4,
        animationStyle: "fade-in",
        lineHeight: 1.2,
      },
    ],
    lineGap: 4,
    lineAlignment: "center",
    isDefault: false,
  },
  {
    _id: "preset-rich-neon-pop",
    name: "Neon Word Pop",
    fontFamily: "Impact, Arial Black, sans-serif",
    fontSize: 52,
    fontWeight: "black",
    textColor: "#E0F2FE",
    highlightColor: "#22D3EE",
    strokeColor: "#082F49",
    strokeWidth: 4,
    positionY: 27,
    animationStyle: "word-pop",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontSize: 56,
        fontWeight: "black",
        textColor: "#FFFFFF",
        highlightColor: "#67E8F9",
        strokeColor: "#083344",
        strokeWidth: 5,
        uppercase: true,
        animationStyle: "word-pop",
        lineHeight: 1.05,
      },
      {
        maxWords: 3,
        fontSize: 45,
        fontWeight: "extra-bold",
        textColor: "#A5F3FC",
        highlightColor: "#22D3EE",
        strokeColor: "#083344",
        strokeWidth: 3,
        uppercase: true,
        animationStyle: "word-pop",
        lineHeight: 1.1,
      },
    ],
    lineGap: 8,
    lineAlignment: "center",
    isDefault: false,
  },
  {
    _id: "preset-rich-clean-subtitles",
    name: "Clean Subtitle Pair",
    fontFamily: "Arial, sans-serif",
    fontSize: 42,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#A7F3D0",
    strokeColor: "#000000",
    strokeWidth: 2,
    positionY: 20,
    animationStyle: "fade-in",
    uppercase: false,
    lineStyles: [
      {
        maxWords: 4,
        fontSize: 42,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#A7F3D0",
        strokeWidth: 2,
        uppercase: false,
        animationStyle: "fade-in",
        lineHeight: 1.2,
      },
      {
        maxWords: 4,
        fontSize: 36,
        fontWeight: "normal",
        textColor: "#D1FAE5",
        highlightColor: "#6EE7B7",
        strokeWidth: 1,
        uppercase: false,
        italic: true,
        animationStyle: "fade-in",
        lineHeight: 1.22,
      },
    ],
    lineGap: 2,
    lineAlignment: "left",
    isDefault: false,
  },
  {
    _id: "preset-rich-color-ladder",
    name: "Color Ladder Karaoke",
    fontFamily: "Arial Black, sans-serif",
    fontSize: 50,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#FB7185",
    strokeColor: "#1F2937",
    strokeWidth: 4,
    positionY: 29,
    animationStyle: "karaoke",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontSize: 60,
        fontWeight: "black",
        textColor: "#FDE68A",
        highlightColor: "#FFFFFF",
        strokeWidth: 4,
        uppercase: true,
        animationStyle: "karaoke",
        lineHeight: 1.05,
      },
      {
        maxWords: 2,
        fontSize: 48,
        fontWeight: "extra-bold",
        textColor: "#FBCFE8",
        highlightColor: "#F472B6",
        strokeWidth: 3,
        uppercase: true,
        animationStyle: "karaoke",
        lineHeight: 1.1,
      },
      {
        maxWords: 3,
        fontSize: 40,
        fontWeight: "bold",
        textColor: "#DBEAFE",
        highlightColor: "#60A5FA",
        strokeWidth: 2,
        uppercase: true,
        animationStyle: "karaoke",
        lineHeight: 1.14,
      },
    ],
    lineGap: 5,
    lineAlignment: "center",
    isDefault: false,
  },
  {
    _id: "preset-rich-static-focus",
    name: "Static Focus Stack",
    fontFamily: "Arial, sans-serif",
    fontSize: 46,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#FACC15",
    strokeColor: "#111827",
    strokeWidth: 3,
    positionY: 25,
    animationStyle: "static",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 1,
        fontSize: 66,
        fontWeight: "black",
        textColor: "#FACC15",
        highlightColor: "#FFFFFF",
        strokeWidth: 4,
        uppercase: true,
        animationStyle: "static",
        lineHeight: 1.0,
      },
      {
        maxWords: 3,
        fontSize: 42,
        fontWeight: "bold",
        textColor: "#FFFFFF",
        highlightColor: "#FACC15",
        strokeWidth: 2,
        uppercase: true,
        letterSpacing: 0.5,
        animationStyle: "static",
        lineHeight: 1.12,
      },
    ],
    lineGap: 7,
    lineAlignment: "center",
    isDefault: false,
  },

  // ── Premium / luxury collection ─────────────────────────────
  // The look paid editors ship: restrained type, one expensive-feeling accent
  // color per preset, serif faces for "money" topics and glass-clean sans for
  // corporate content.
  {
    _id: "caption-luxe-gold",
    name: "Luxe Gold Serif",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 48,
    fontWeight: "black",
    textColor: "#FFF8E7",
    highlightColor: "#F5C542",
    strokeColor: "#1C1917",
    strokeWidth: 4,
    positionY: 26,
    animationStyle: "karaoke",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-executive-clean",
    name: "Executive Clean",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 42,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#7DD3FC",
    strokeColor: "#0F172A",
    strokeWidth: 2,
    positionY: 22,
    animationStyle: "fade-in",
    uppercase: false,
    isDefault: false,
  },
  {
    _id: "caption-rose-gold-editorial",
    name: "Rose Gold Editorial",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 44,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#F7A8B8",
    strokeColor: "#2B1B1E",
    strokeWidth: 2,
    positionY: 24,
    animationStyle: "fade-in",
    uppercase: false,
    isDefault: false,
  },
  {
    _id: "caption-platinum-minimal",
    name: "Platinum Minimal",
    fontFamily: "Arial, Helvetica, sans-serif",
    fontSize: 40,
    fontWeight: "bold",
    textColor: "#F8FAFC",
    highlightColor: "#CBD5E1",
    strokeColor: "#334155",
    strokeWidth: 1,
    positionY: 21,
    animationStyle: "static",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-royal-emerald",
    name: "Royal Emerald",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 50,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#10B981",
    strokeColor: "#052E1C",
    strokeWidth: 5,
    positionY: 27,
    animationStyle: "word-pop",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "preset-rich-gold-stack",
    name: "Golden Hour Stack",
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 48,
    fontWeight: "black",
    textColor: "#FFF8E7",
    highlightColor: "#F5C542",
    strokeColor: "#1C1917",
    strokeWidth: 4,
    positionY: 27,
    animationStyle: "karaoke",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontSize: 58,
        fontWeight: "black",
        textColor: "#FFFDF5",
        highlightColor: "#F5C542",
        strokeColor: "#1C1917",
        strokeWidth: 4,
        uppercase: true,
        animationStyle: "karaoke",
        letterSpacing: 0.5,
        lineHeight: 1.06,
      },
      {
        maxWords: 3,
        fontSize: 42,
        fontWeight: "bold",
        textColor: "#FDE68A",
        highlightColor: "#FFFFFF",
        strokeColor: "#1C1917",
        strokeWidth: 3,
        uppercase: true,
        italic: true,
        animationStyle: "karaoke",
        lineHeight: 1.12,
      },
    ],
    lineGap: 6,
    lineAlignment: "center",
    isDefault: false,
  },
  {
    _id: "preset-rich-noir-contrast",
    name: "Noir Contrast Stack",
    fontFamily: "Arial Black, Impact, sans-serif",
    fontSize: 50,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#EF4444",
    strokeColor: "#050505",
    strokeWidth: 5,
    positionY: 28,
    animationStyle: "word-pop",
    uppercase: true,
    lineStyles: [
      {
        maxWords: 2,
        fontSize: 60,
        fontWeight: "black",
        textColor: "#FFFFFF",
        highlightColor: "#EF4444",
        strokeColor: "#050505",
        strokeWidth: 5,
        uppercase: true,
        animationStyle: "word-pop",
        lineHeight: 1.04,
      },
      {
        maxWords: 3,
        fontSize: 44,
        fontWeight: "extra-bold",
        textColor: "#FCA5A5",
        highlightColor: "#FFFFFF",
        strokeColor: "#050505",
        strokeWidth: 3,
        uppercase: true,
        letterSpacing: 1,
        animationStyle: "word-pop",
        lineHeight: 1.1,
      },
    ],
    lineGap: 7,
    lineAlignment: "center",
    isDefault: false,
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
    description: "Slate-glass pill with a hairline border - calm, corporate close",
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
    description: "Black card, cyan outline - the energy carries into the follow ask",
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
