import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  CaptionPreset,
  KeywordPopOverlayItem,
  OverlayStylePreset,
  WordTimestamp,
} from '../lib/types';
import { getCtaBottomLiftPercent } from './CTAOverlay';
import { AnimatedWord } from './AnimatedWord';
import { buildFinalCaptionChunks } from './CaptionComposition';
import { getCaptionChunkWordLimit } from '../lib/caption-layout';
import { resolveCaptionThemeOverlayStyle } from '../lib/caption-theme-styles';
import { CaptionThemeOverlay } from './caption-themes/CaptionThemeOverlay';
import { CTAOverlay } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';
import { KeywordPopOverlay } from './KeywordPopOverlay';

/**
 * One transparent, full-duration overlay layer (captions + hook + CTA + keyword pops).
 * The base video and audio are deliberately absent: FFmpeg composites this PNG
 * sequence with the source crop and performs the only final video encode.
 */
export interface CaptionOverlayCompositionProps extends Record<string, unknown> {
  hookText: string;
  hookDuration: number;
  hookStart: number;
  hookTransitionDuration: number;
  ctaText: string;
  ctaDuration: number;
  totalDuration: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  hookStyle?: OverlayStylePreset;
  ctaStyle?: OverlayStylePreset;
  captionLiftScale?: number;
  keywordPops?: KeywordPopOverlayItem[];
}

export const CaptionOverlayComposition: React.FC<CaptionOverlayCompositionProps> = ({
  hookText,
  hookDuration,
  hookStart,
  hookTransitionDuration,
  ctaText,
  ctaDuration,
  totalDuration,
  words,
  preset,
  hookStyle,
  ctaStyle,
  captionLiftScale = 1,
  keywordPops = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;
  const transition = hookDuration > 0
    ? Math.max(0, Math.min(hookTransitionDuration, hookDuration / 2))
    : 0;
  const hookVisibleDuration = Math.max(0, hookDuration - transition);
  const transitionStart = hookDuration - transition;
  const transitionEnd = hookDuration + transition;
  const chunks = buildFinalCaptionChunks(
    words,
    hookStart,
    hookDuration,
    getCaptionChunkWordLimit(preset)
  ).filter((chunk) =>
    transition <= 0 || chunk.end <= transitionStart || chunk.start >= transitionEnd
  );
  const captionLift =
    getCtaBottomLiftPercent(ctaDuration, totalDuration, currentTime) * Math.max(0, captionLiftScale);
  const themedHookStyle = hookStyle
    ? resolveCaptionThemeOverlayStyle(preset, hookStyle)
    : hookStyle;
  const themedCtaStyle = ctaStyle
    ? resolveCaptionThemeOverlayStyle(preset, ctaStyle)
    : ctaStyle;

  return (
    <AbsoluteFill>
      {keywordPops.length > 0 ? (
        <KeywordPopOverlay
          items={keywordPops}
          frame={frame}
          fps={fps}
          transitionStart={transition > 0 ? transitionStart : -1}
          transitionEnd={transition > 0 ? transitionEnd : -1}
        />
      ) : null}
      {hookVisibleDuration > 0.05 && hookText.trim() ? (
        <HookOverlay
          hookText={hookText}
          hookDurationInSeconds={hookVisibleDuration}
          frame={frame}
          fps={fps}
          style={themedHookStyle}
        />
      ) : null}
      {preset.captionTheme ? (
        <CaptionThemeOverlay
          chunks={chunks}
          preset={preset}
          bottomLiftPercent={captionLift}
        />
      ) : (
        <AnimatedWord
          chunks={chunks}
          frame={frame}
          fps={fps}
          preset={preset}
          bottomLiftPercent={captionLift}
        />
      )}
      {ctaDuration > 0 && ctaText.trim() ? (
        <CTAOverlay
          ctaText={ctaText}
          ctaDurationInSeconds={ctaDuration}
          totalDurationInSeconds={totalDuration}
          frame={frame}
          fps={fps}
          style={themedCtaStyle}
        />
      ) : null}
    </AbsoluteFill>
  );
};
