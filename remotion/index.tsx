import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { CaptionComposition } from './CaptionComposition';
import { DEFAULT_CAPTION_PRESETS } from '../lib/presets';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CaptionComposition"
        component={CaptionComposition as any}
        durationInFrames={30 * 30}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          hookText: 'THE 1 SECRET YOU WERE NEVER TOLD',
          hookDuration: 3,
          preset: DEFAULT_CAPTION_PRESETS[0],
          words: [
            { word: 'Welcome', start: 0.2, end: 0.7 },
            { word: 'to', start: 0.8, end: 1.0 },
            { word: 'this', start: 1.1, end: 1.3 },
            { word: 'game', start: 1.4, end: 1.8 },
            { word: 'changing', start: 1.9, end: 2.5 },
            { word: 'AI', start: 2.6, end: 2.9 },
            { word: 'clip', start: 3.0, end: 3.4 },
            { word: 'generator', start: 3.5, end: 4.2 },
          ],
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
