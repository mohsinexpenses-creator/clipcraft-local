import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
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
  /**
   * Length (s) of the dip-to-black transition around the hook join. The FFmpeg
   * stage fades the last N seconds of the hook to black and the first N
   * seconds of the base clip in from black; nothing (captions, hook overlay)
   * may be drawn during that window, so both are blanked here.
   */
  hookTransitionDuration?: number;
  /**
   * Where in the clip (seconds from the clip start) the duplicated hook intro
   * was cut from. 0 (or unset) = the intro shows the first N seconds (legacy
   * behaviour); any other value = the intro replays that moment, and its
   * transcript words are captioned during the intro as a preview.
   */
  hookStart?: number;
  ctaText: string;
  ctaDuration: number;
  /** Word timings relative to the START of the source segment (0 = segment start). */
  words: WordTimestamp[];
  preset: CaptionPreset;
  /** Visual style of the hook intro overlay (style preset). */
  hookStyle?: OverlayStylePreset;
  /** Visual style of the end-of-clip CTA overlay (style preset). */
  ctaStyle?: OverlayStylePreset;
  /**
   * Scale of the usual caption lift while the CTA card is on screen (1 = default,
   * 0 = captions stay put). The split-screen layout places the CTA clear of the
   * captions, so it passes 0.
   */
  captionLiftScale?: number;
}

/**
 * The rendered clip is [hook intro][full segment], so the transcript has to be
 * remapped onto that timeline:
 *
 * - During the intro (0..hookDuration) the video replays the HOOK MOMENT - the
 *   words around `hookStart` - so caption them as a preview, re-based to start
 *   at 0. With hookStart=0 the window is simply the start of the clip.
 * - After the intro, every word of the full segment moves later by exactly
 *   hookDuration seconds.
 *
 * Words overlapping both lists appear twice on purpose: once as the preview,
 * once when the clip reaches that moment for real.
 */
export function buildRenderedWords(
  words: WordTimestamp[],
  hookStart: number,
  hookDuration: number
): WordTimestamp[] {
  const shifted: WordTimestamp[] = words.map((w) => ({
    ...w,
    start: w.start + hookDuration,
    end: w.end + hookDuration,
  }));

  const intro: WordTimestamp[] =
    hookDuration > 0
      ? words
          .filter((w) => w.end > hookStart && w.start < hookStart + hookDuration)
          .map((w) => ({
            ...w,
            start: Math.max(0, w.start - hookStart),
            end: Math.min(w.end - hookStart, hookDuration),
          }))
      : [];

  return [...intro, ...shifted];
}

/**
 * Caption chunks on the FINAL clip timeline, built the way the video is cut:
 *
 *   [hook intro 0..hookDuration]   words of the hook moment (preview)
 *   [segment  hookDuration..end]   ALL words, shifted later by hookDuration
 *
 * The intro and the shifted words are chunked SEPARATELY. Concatenating the
 * two word lists first (the old behaviour) glued the last intro chunk's words
 * to the first shifted words in one chunk - a single caption line whose words
 * belong to two different moments of the video. During the hook that line
 * showed the wrong text, which is why hook clips got "galat captions".
 */
export function buildFinalCaptionChunks(
  words: WordTimestamp[],
  hookStart: number,
  hookDuration: number,
  wordsPerChunk = 4
): CaptionChunk[] {
  const shifted: WordTimestamp[] = words.map((w) => ({
    ...w,
    start: w.start + hookDuration,
    end: w.end + hookDuration,
  }));
  const mainChunks = buildCaptionChunks(shifted, wordsPerChunk);

  if (hookDuration <= 0) return mainChunks;

  const intro: WordTimestamp[] = words
    .filter((w) => w.end > hookStart && w.start < hookStart + hookDuration)
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start - hookStart),
      end: Math.min(w.end - hookStart, hookDuration),
    }));
  const introChunks = buildCaptionChunks(intro, wordsPerChunk).filter((c) => c.end > 0);

  return [...introChunks, ...mainChunks];
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
  // videoWidth/videoHeight are still passed (useful in logs/debugging) but the
  // clip now always fills the frame, so layout no longer branches on them.
  hookText,
  hookDuration = 3,
  hookTransitionDuration = 0,
  hookStart = 0,
  ctaText,
  ctaDuration = 2.5,
  words = [],
  preset,
  hookStyle,
  ctaStyle,
  captionLiftScale = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const totalDurationInSeconds = durationInFrames / fps;

  /**
   * The rendered clip is [hook intro][full segment].
   *
   * - After the intro, every transcript word moves later by exactly
   *   hookDuration seconds.
   * - During the intro the video replays the HOOK MOMENT (the words around
   *   `hookStart`), so caption those words as a preview at 0..hookDuration.
   *   With hookStart=0 the window is simply the start of the clip.
   *
   * The dip-to-black transition (FFmpeg) covers
   * [hookDuration - transitionDur, hookDuration + transitionDur]: the video is
   * fading out/in and the audio is fully silent there, so NO captions and NO
   * hook/CTA overlay may be drawn inside that window.
   */
  const transitionDur =
    hookDuration > 0
      ? Math.max(0, Math.min(hookTransitionDuration, hookDuration / 2))
      : 0;
  const hookWindowStart = hookDuration - transitionDur;
  const hookWindowEnd = hookDuration + transitionDur;

  const chunks = buildFinalCaptionChunks(words, hookStart, hookDuration).filter(
    (chunk) => {
      if (transitionDur <= 0) return true;
      return chunk.end <= hookWindowStart || chunk.start >= hookWindowEnd;
    }
  );

  const currentTime = frame / fps;
  // Lift the captions while the end CTA card occupies the same bottom area.
  const captionLiftPercent =
    getCtaBottomLiftPercent(ctaDuration, totalDurationInSeconds, currentTime) * Math.max(0, captionLiftScale);

  // The FFmpeg stage outputs the processed clip at exactly the composition canvas
  // (1080x1920), so the video FILLS the frame - no black bars, and the hook/CTA/
  // captions overlay directly on top of the video. objectFit: cover stays as a
  // safety net for any future aspect drift.
  const fullFrame = (
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
        fullFrame
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

      {/* The hook card stops at the dip-to-black window: it fades out by
          hookDuration - transitionDur, so no overlay text sits on the black. */}
      {hookDuration > 0 && hookWindowStart > 0.05 ? (
        <HookOverlay
          hookText={hookText}
          hookDurationInSeconds={hookWindowStart}
          frame={frame}
          fps={fps}
          style={hookStyle}
        />
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
          style={ctaStyle}
        />
      ) : null}
    </AbsoluteFill>
  );
};
