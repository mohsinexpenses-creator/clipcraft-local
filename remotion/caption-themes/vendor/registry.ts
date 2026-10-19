import React from "react";
import { InternalThemeProps } from "./types";
import { KaraokeTheme } from "./themes/karaoke";
import { Kinetic01 } from "./themes/kinetic-01";

// Import custom themes
import { GrapeTheme } from "./themes/grape";
import { PoppinTheme } from "./themes/poppin";
import { AaritTheme } from "./themes/aarit";
import { SoftAITheme } from "./themes/soft-ai";
import { GamingStreamTheme } from "./themes/gaming-stream";
import {
  FocusDialTheme,
  PullQuoteTheme,
  StaggeredStackTheme,
  VerticalTickerTheme,
  WaveformTheme,
} from "./themes/modern";
import { ADDITIONAL_THEME_COMPONENTS } from "./themes/additional";

export const themeRegistry: Record<string, React.FC<InternalThemeProps>> = {
  karaoke: KaraokeTheme,
  "kinetic-01": Kinetic01,

  // Custom Themes
  grape: GrapeTheme,
  poppin: PoppinTheme,
  aarit: AaritTheme,
  "soft-ai": SoftAITheme,
  "gaming-stream": GamingStreamTheme,
  "pull-quote": PullQuoteTheme,
  waveform: WaveformTheme,
  "staggered-stack": StaggeredStackTheme,
  "focus-dial": FocusDialTheme,
  "vertical-ticker": VerticalTickerTheme,
  ...ADDITIONAL_THEME_COMPONENTS,
} as const;

export type ThemeName = keyof typeof themeRegistry;
