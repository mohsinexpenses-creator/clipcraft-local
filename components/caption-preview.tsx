'use client';

import React, { ComponentType } from 'react';
import { Player } from '@remotion/player';
import { cn } from 'cn';
import { CaptionComposition } from '@/remotion/CaptionComposition';
import { CaptionPreset, OverlayStylePreset } from '@/lib/types';

interface CaptionPreviewProps {
  preset: CaptionPreset;
  hookText?: string;
  ctaText?: string;
  hookStyle?: OverlayStylePreset;
  ctaStyle?: OverlayStylePreset;
  /** Extra classes for the outer 9:16 frame (e.g. sticky-panel sizing). */
  className?: string;
}

export const CaptionPreview: React.FC<CaptionPreviewProps> = ({
  preset,
  hookText = 'THE 1 SECRET YOU WERE NEVER TOLD',
  ctaText = 'FOLLOW FOR MORE BREAKDOWNS',
  hookStyle,
  ctaStyle,
  className,
}) => {
  const sampleWords = [
    { word: 'Welcome', start: 0.2, end: 0.6 },
    { word: 'to', start: 0.7, end: 0.9 },
    { word: 'this', start: 1.0, end: 1.2 },
    { word: 'viral', start: 1.3, end: 1.7 },
    { word: 'clip', start: 1.8, end: 2.1 },
    { word: 'generator', start: 2.2, end: 2.8 },
    { word: 'with', start: 2.9, end: 3.2 },
    { word: 'styled', start: 3.3, end: 3.6 },
    { word: 'animated', start: 3.7, end: 4.2 },
    { word: 'captions', start: 4.3, end: 5.0 },
  ];

  return (
    // Height-first sizing: the 9:16 frame derives its width from the height, so
    // the preview always fits the viewport (a sticky side panel) instead of
    // pushing the page taller than the screen.
    <div
      className={cn(
        'relative mx-auto aspect-[9/16] h-[min(52dvh,520px)] max-w-full overflow-hidden rounded-xl border bg-muted shadow-sm',
        className
      )}
    >
      <Player
        component={CaptionComposition as unknown as ComponentType<Record<string, unknown>>}
        durationInFrames={30 * 8}
        fps={30}
        compositionWidth={1080}
        compositionHeight={1920}
        controls
        autoPlay
        loop
        acknowledgeRemotionLicense
        style={{
          width: '100%',
          height: '100%',
        }}
        inputProps={{
          hookText,
          hookDuration: 2.5,
          ctaText,
          ctaDuration: 2.2,
          words: sampleWords,
          preset,
          hookStyle,
          ctaStyle,
        }}
      />
    </div>
  );
};
