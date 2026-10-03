import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '../lib/presets';
import { CaptionComposition, CaptionCompositionProps } from './CaptionComposition';
import {
  CaptionOverlayComposition,
  type CaptionOverlayCompositionProps,
  CtaOverlayComposition,
  HookOverlayComposition,
} from './OverlayCompositions';

/**
 * fps / durationInFrames here are STUDIO/PREVIEW defaults only. The worker
 * supplies the source-derived FPS and actual overlay duration when it paints
 * transparent frames; the source video is composed later by FFmpeg.
 */
const PREVIEW_FPS = 30;
const PREVIEW_DURATION_SECONDS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CaptionComposition"
        component={CaptionComposition as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={PREVIEW_FPS * PREVIEW_DURATION_SECONDS}
        fps={PREVIEW_FPS}
        width={1080}
        height={1920}
        defaultProps={
          {
            // No videoSrc -> the gradient placeholder renders, which is what the
            // in-app <Player> preview wants (OffthreadVideo needs Node + ffmpeg and
            // cannot read a local file from a browser page).
            videoSrc: undefined,
            videoHasAudio: true,
            videoWidth: undefined,
            videoHeight: undefined,
            sourceFps: PREVIEW_FPS,
            hookText: 'THE 1 SECRET YOU WERE NEVER TOLD',
            hookDuration: 3,
            ctaText: 'FOLLOW FOR MORE CLIPS LIKE THIS',
            ctaDuration: 2.5,
            preset: DEFAULT_CAPTION_PRESETS[0],
            hookStyle: DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'hook'),
            ctaStyle: DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'cta'),
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
          } satisfies CaptionCompositionProps
        }
      />
      <Composition
        id="CaptionOverlayComposition"
        component={CaptionOverlayComposition as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={PREVIEW_FPS * PREVIEW_DURATION_SECONDS}
        fps={PREVIEW_FPS}
        width={1080}
        height={1920}
        defaultProps={
          {
            hookText: 'THE 1 SECRET YOU WERE NEVER TOLD',
            hookDuration: 3,
            hookStart: 0,
            hookTransitionDuration: 0.5,
            ctaText: 'FOLLOW FOR MORE CLIPS LIKE THIS',
            ctaDuration: 2.5,
            totalDuration: PREVIEW_DURATION_SECONDS,
            words: [
              { word: 'Welcome', start: 0.2, end: 0.7 },
              { word: 'to', start: 0.8, end: 1.0 },
              { word: 'this', start: 1.1, end: 1.3 },
              { word: 'game', start: 1.4, end: 1.8 },
            ],
            preset: DEFAULT_CAPTION_PRESETS[0],
            hookStyle: DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'hook'),
            ctaStyle: DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'cta'),
          } satisfies CaptionOverlayCompositionProps
        }
      />
      {/*
        Transparent PNG compositions. The native engine uses the short hook/CTA
        layers plus an ASS-generated caption layer; the Remotion engine renders a
        single full-timeline sequence. FFmpeg composites them with the base crop.
      */}
      <Composition
        id="HookOverlayComposition"
        component={HookOverlayComposition as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={Math.round(3 * PREVIEW_FPS)}
        fps={PREVIEW_FPS}
        width={1080}
        height={1920}
        defaultProps={{ hookText: 'THE 1 SECRET YOU WERE NEVER TOLD', hookDuration: 3 }}
      />
      <Composition
        id="CtaOverlayComposition"
        component={CtaOverlayComposition as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={Math.round(2.5 * PREVIEW_FPS)}
        fps={PREVIEW_FPS}
        width={1080}
        height={1920}
        defaultProps={{ ctaText: 'FOLLOW FOR MORE CLIPS LIKE THIS', ctaDuration: 2.5 }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
