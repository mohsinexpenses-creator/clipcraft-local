import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import { CaptionPreset, WordTimestamp } from '../lib/types';
import { AnimatedWord, CaptionChunk } from './AnimatedWord';
import { CTAOverlay, getCtaBottomLiftPercent } from './CTAOverlay';
import { HookOverlay } from './HookOverlay';

export interface CaptionCompositionProps {
  /**
   * http(s) URL of the processed clip, served by the worker's throwaway
   * loopback media server during rendering (worker/clip-http-server.ts).
   *
   * Remotion renders in headless Chrome, which cannot read the filesystem:
   * a raw absolute path (or file:// URL) reaches Remotion's asset downloader,
   * which only accepts http(s)/data: URLs, and the render fails.
   *
   * Not supported in the in-app <Player> preview (that runs fully in the
   * browser on the user's machine, where the worker's server does not exist),
   * which is why the preview page simply does not pass this prop and gets the
   * gradient placeholder below instead.
   */
  videoSrc?: string;
  /** Keep the clip's own audio. Always true for real renders. */
  videoHasAudio?: boolean;
  videoWidth?: number;
  videoHeight?: number;
  sourceFps?: number;
  hookText: string;
  /** Length of the duplicated hook intro, in seconds. */
  hookDuration: number;
  ctaText: string;
  ctaDuration: number;
  /** Word timings relative to the START of the source segment (0 = segment start). */
  words: WordTimestamp[];
  preset: CaptionPreset;
}

/** Group the transcript into short readable caption lines (TikTok/Shorts style). */
export function buildCaptionChunks(words: WordTimestamp[], wordsPerChunk = 4): CaptionChunk[] {
  if (!words || words.length === 0) return [];

  const chunks: CaptionChunk[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const slice = words.slice(i, i + wordsPerChunk);
    if (slice.length === 0) continue;

    chunks.push({
      id: `${slice[0].start.toFixed(3)}-${i}`,
      words: slice,
      start: slice[0].start,
      end: slice[slice.length - 1].end,
    });
  }
  return chunks;
}

export const CaptionComposition: React.FC<CaptionCompositionProps> = ({
  videoSrc,
  videoHasAudio = true,
  videoWidth,
  videoHeight,
  hookText,
  hookDuration = 3,
  ctaText,
  ctaDuration = 2.5,
  words = [],
  preset,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const totalDurationInSeconds = durationInFrames / fps;

  /**
   * The rendered clip is [hook intro][full segment], so every transcript word has
   * to move later by exactly hookDuration seconds.
   */
  const shiftedWords: WordTimestamp[] = words.map((w) => ({
    ...w,
    start: w.start + hookDuration,
    end: w.end + hookDuration,
  }));
  const chunks = buildCaptionChunks(shiftedWords);

  const currentTime = frame / fps;
  // Lift the captions while the end CTA card occupies the same bottom area.
  const captionLiftPercent = getCtaBottomLiftPercent(ctaDuration, totalDurationInSeconds, currentTime);

  // Native size, centred: the FFmpeg stage already produced a 9:16 canvas, so this
  // is a 1:1 blit. Falls back to cover-fit when the dimensions are unknown.
  const nativeFit =
    videoWidth && videoHeight ? (
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
        <div style={{ width: videoWidth, height: videoHeight }}>
          <OffthreadVideo
            src={videoSrc as string}
            muted={!videoHasAudio}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      </AbsoluteFill>
    ) : (
      <AbsoluteFill style={{ backgroundColor: '#000' }}>
        <OffthreadVideo
          src={videoSrc as string}
          muted={!videoHasAudio}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
    );

  return (
    <AbsoluteFill style={{ backgroundColor: '#0F172A', overflow: 'hidden' }}>
      {videoSrc ? (
        nativeFit
      ) : (
        <AbsoluteFill
          style={{
            background: 'linear-gradient(180deg, #1E293B 0%, #0F172A 100%)',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748B',
            fontSize: 18,
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              border: '3px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            🎬
          </div>
          <div>9:16 Portrait Caption Preview</div>
        </AbsoluteFill>
      )}

      {hookDuration > 0 ? (
        <HookOverlay hookText={hookText} hookDurationInSeconds={hookDuration} frame={frame} fps={fps} />
      ) : null}

      {preset ? (
        <AnimatedWord
          chunks={chunks}
          frame={frame}
          fps={fps}
          preset={preset}
          bottomLiftPercent={captionLiftPercent}
        />
      ) : null}

      {ctaDuration > 0 ? (
        <CTAOverlay
          ctaText={ctaText}
          ctaDurationInSeconds={ctaDuration}
          totalDurationInSeconds={totalDurationInSeconds}
          frame={frame}
          fps={fps}
        />
      ) : null}
    </AbsoluteFill>
  );
};
