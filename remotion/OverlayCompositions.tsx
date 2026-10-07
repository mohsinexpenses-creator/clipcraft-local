import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
import { getCtaBottomLiftPercent } from './CTAOverlay';
import { AnimatedWord } from './AnimatedWord';
import { buildFinalCaptionChunks } from './CaptionComposition';
import { getCaptionChunkWordLimit } from '../lib/caption-layout';
import { CTAOverlay } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';

/**
 * One transparent, full-duration overlay layer for the Remotion caption engine.
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

  return (
    <AbsoluteFill>
      {hookVisibleDuration > 0.05 && hookText.trim() ? (
        <HookOverlay
          hookText={hookText}
          hookDurationInSeconds={hookVisibleDuration}
          frame={frame}
          fps={fps}
          style={hookStyle}
        />
      ) : null}
      <AnimatedWord
        chunks={chunks}
        frame={frame}
        fps={fps}
        preset={preset}
        bottomLiftPercent={captionLift}
      />
      {ctaDuration > 0 && ctaText.trim() ? (
        <CTAOverlay
          ctaText={ctaText}
          ctaDurationInSeconds={ctaDuration}
          totalDurationInSeconds={totalDuration}
          frame={frame}
          fps={fps}
          style={ctaStyle}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * Transparent hook-only composition used by the native engine. The root paints
 * no background so the rendered PNGs retain alpha and can be composited by FFmpeg.
 */
export const HookOverlayComposition: React.FC<{
  hookText: string;
  hookDuration: number;
  hookStyle?: OverlayStylePreset;
}> = ({ hookText, hookDuration, hookStyle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <HookOverlay
        hookText={hookText}
        hookDurationInSeconds={hookDuration}
        style={hookStyle}
        frame={frame}
        fps={fps}
      />
    </AbsoluteFill>
  );
};

export const CtaOverlayComposition: React.FC<{
  ctaText: string;
  ctaDuration: number;
  ctaStyle?: OverlayStylePreset;
}> = ({ ctaText, ctaDuration, ctaStyle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {/* The card's window covers the whole composition; FFmpeg shifts it to the end. */}
      <CTAOverlay
        ctaText={ctaText}
        ctaDurationInSeconds={ctaDuration}
        totalDurationInSeconds={ctaDuration}
        style={ctaStyle}
        frame={frame}
        fps={fps}
      />
    </AbsoluteFill>
  );
};
