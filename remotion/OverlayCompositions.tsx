import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
import { getCtaBottomLiftPercent } from './CTAOverlay';
import { AnimatedWord } from './AnimatedWord';
import { buildFinalCaptionChunks } from './CaptionComposition';
import { getCaptionChunkWordLimit } from '../lib/caption-layout';
import { resolveCaptionThemeOverlayStyle } from '../lib/caption-theme-styles';
import { CaptionThemeOverlay } from './caption-themes/CaptionThemeOverlay';
import { CTAOverlay } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';

/**
 * One transparent, full-duration overlay layer (captions + hook + CTA).
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
  // Rendering hundreds of frames re-runs this component at each frame. Chunks
  // and themed style variants are static for one render, so memoize the work
  // without changing the frame-driven animation values below.
  const chunks = React.useMemo(
    () =>
      buildFinalCaptionChunks(
        words,
        hookStart,
        hookDuration,
        getCaptionChunkWordLimit(preset),
      ).filter((chunk) =>
        transition <= 0 || chunk.end <= transitionStart || chunk.start >= transitionEnd,
      ),
    [
      words,
      hookStart,
      hookDuration,
      preset,
      transition,
      transitionStart,
      transitionEnd,
    ],
  );
  const captionLift =
    getCtaBottomLiftPercent(ctaDuration, totalDuration, currentTime) * Math.max(0, captionLiftScale);
  const [themedHookStyle, themedCtaStyle] = React.useMemo(
    () => [
      hookStyle ? resolveCaptionThemeOverlayStyle(preset, hookStyle) : hookStyle,
      ctaStyle ? resolveCaptionThemeOverlayStyle(preset, ctaStyle) : ctaStyle,
    ],
    [preset, hookStyle, ctaStyle],
  );

  return (
    <AbsoluteFill>
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
