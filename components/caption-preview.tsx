'use client';

import React from 'react';
import { Player } from '@remotion/player';
import { CaptionComposition } from '@/remotion/CaptionComposition';
import { CaptionPreset } from '@/lib/types';

interface CaptionPreviewProps {
  preset: CaptionPreset;
  hookText?: string;
}

export const CaptionPreview: React.FC<CaptionPreviewProps> = ({
  preset,
  hookText = 'THE 1 SECRET YOU WERE NEVER TOLD',
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
    <div className="relative w-full max-w-sm aspect-[9/16] rounded-2xl overflow-hidden border-2 border-slate-800 bg-slate-950 shadow-2xl">
      <Player
        component={CaptionComposition as any}
        durationInFrames={30 * 8} // 8 seconds preview
        fps={30}
        compositionWidth={1080}
        compositionHeight={1920}
        controls
        autoPlay
        loop
        style={{
          width: '100%',
          height: '100%',
        }}
        inputProps={{
          hookText,
          hookDuration: 2.5,
          words: sampleWords,
          preset,
        }}
      />
    </div>
  );
};
