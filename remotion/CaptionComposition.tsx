import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { WordTimestamp, CaptionPreset } from '../lib/types';
import { AnimatedWord } from './AnimatedWord';
import { CTAOverlay } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';

export interface CaptionCompositionProps {
  videoUrl?: string;
  hookText: string;
  hookDuration: number; // in seconds
  ctaText: string;
  ctaDuration: number; // in seconds
  words: WordTimestamp[];
  preset: CaptionPreset;
  videoWidth?: number;
  videoHeight?: number;
}

export const CaptionComposition: React.FC<CaptionCompositionProps> = ({
  videoUrl,
  hookText,
  hookDuration = 3,
  ctaText,
  ctaDuration = 2.5,
  words = [],
  preset,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const currentTime = frame / fps;
  const totalDurationInSeconds = durationInFrames / fps;

  const shiftedWords: WordTimestamp[] = words.map((w) => ({
    ...w,
    start: w.start + hookDuration,
    end: w.end + hookDuration,
  }));

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#0F172A',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {videoUrl ? (
        <video
          src={videoUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          muted
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, #1E293B 0%, #0F172A 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748B',
            fontSize: '18px',
          }}
        >
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              border: '3px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
            }}
          >
            🎬
          </div>
          <div>9:16 Portrait Caption Preview</div>
        </div>
      )}

      {hookDuration > 0 && (
        <HookOverlay
          hookText={hookText}
          durationInSeconds={hookDuration}
          currentTime={currentTime}
        />
      )}

      {preset && (
        <AnimatedWord
          words={shiftedWords}
          currentTime={currentTime}
          preset={preset}
        />
      )}

      {ctaDuration > 0 && (
        <CTAOverlay
          ctaText={ctaText}
          ctaDurationInSeconds={ctaDuration}
          currentTime={currentTime}
          totalDurationInSeconds={totalDurationInSeconds}
        />
      )}
    </div>
  );
};
