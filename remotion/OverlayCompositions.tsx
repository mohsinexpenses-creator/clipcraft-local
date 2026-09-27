import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { CTAOverlay } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';

/**
 * Transparent overlay compositions for the NATIVE caption engine.
 *
 * The native path burns captions with FFmpeg (no Chrome), but the hook text
 * and CTA card keep their Remotion design. To avoid forcing the whole video
 * through headless Chrome again, each overlay is rendered on its OWN as a
 * short transparent PNG sequence (90 frames for a 3s hook, ~75 for a 2.5s CTA
 * - no video decode, so it takes seconds), then FFmpeg overlays the sequence
 * onto the caption-burned clip at the right time.
 *
 * The roots deliberately paint NO background, so the PNGs carry an alpha
 * channel.
 */
export const HookOverlayComposition: React.FC<{
  hookText: string;
  hookDuration: number;
}> = ({ hookText, hookDuration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <HookOverlay
        hookText={hookText}
        hookDurationInSeconds={hookDuration}
        frame={frame}
        fps={fps}
      />
    </AbsoluteFill>
  );
};

export const CtaOverlayComposition: React.FC<{
  ctaText: string;
  ctaDuration: number;
}> = ({ ctaText, ctaDuration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {/*
        Standalone: the card's window covers the whole composition, and the
        worker overlays it at totalDuration - ctaDuration, so timing in the
        final clip matches the main composition exactly.
      */}
      <CTAOverlay
        ctaText={ctaText}
        ctaDurationInSeconds={ctaDuration}
        totalDurationInSeconds={ctaDuration}
        frame={frame}
        fps={fps}
      />
    </AbsoluteFill>
  );
};
