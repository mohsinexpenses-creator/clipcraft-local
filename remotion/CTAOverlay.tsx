import React from 'react';
import { interpolate, spring } from 'remotion';

interface CTAOverlayProps {
  ctaText: string;
  ctaDurationInSeconds: number;
  totalDurationInSeconds: number;
  frame: number;
  fps: number;
}

export interface CtaWindow {
  startSeconds: number;
  endSeconds: number;
  active: boolean;
}

/** When the end-of-clip CTA is on screen, in seconds. */
export function getCtaWindow(
  ctaDurationInSeconds: number,
  totalDurationInSeconds: number,
  currentTime: number
): CtaWindow {
  const duration = Math.max(0, ctaDurationInSeconds);
  const startSeconds = Math.max(0, totalDurationInSeconds - duration);
  return {
    startSeconds,
    endSeconds: totalDurationInSeconds,
    active: duration > 0 && currentTime >= startSeconds && currentTime <= totalDurationInSeconds,
  };
}

/**
 * How far the captions should move up while the CTA card is on screen, in % of the
 * composition height. Caption presets sit at 22-30% from the bottom and the CTA card
 * occupies roughly 12-30%, so without this lift they overlap.
 */
export function getCtaBottomLiftPercent(
  ctaDurationInSeconds: number,
  totalDurationInSeconds: number,
  currentTime: number
): number {
  const window = getCtaWindow(ctaDurationInSeconds, totalDurationInSeconds, currentTime);
  if (!window.active) return 0;

  const rampSeconds = 0.25;
  const inProgress = interpolate(
    currentTime,
    [window.startSeconds, window.startSeconds + rampSeconds],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const outProgress = interpolate(
    currentTime,
    [window.endSeconds - rampSeconds, window.endSeconds],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return Math.min(inProgress, outProgress) * 15;
}

/** End-of-clip call to action. Frame-driven so preview and render always match. */
export const CTAOverlay: React.FC<CTAOverlayProps> = ({
  ctaText,
  ctaDurationInSeconds,
  totalDurationInSeconds,
  frame,
  fps,
}) => {
  const text = ctaText?.trim();
  if (!text || ctaDurationInSeconds <= 0) return null;

  const currentTime = frame / fps;
  const window = getCtaWindow(ctaDurationInSeconds, totalDurationInSeconds, currentTime);
  if (!window.active) return null;

  const startFrame = Math.round(window.startSeconds * fps);
  const endFrame = Math.max(startFrame + 1, Math.round(window.endSeconds * fps));
  const fadeOutFrames = Math.max(4, Math.round(0.3 * fps));

  const opacity = interpolate(
    frame,
    [startFrame, startFrame + Math.round(0.2 * fps), endFrame - fadeOutFrames, endFrame],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  if (opacity <= 0.01) return null;

  const pop = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 12, stiffness: 170, mass: 0.8 },
    durationInFrames: Math.max(8, Math.round(0.4 * fps)),
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        right: '7%',
        bottom: '12%',
        zIndex: 35,
        opacity,
        transform: `translateY(${((1 - pop) * 40).toFixed(2)}px) scale(${(0.94 + pop * 0.06).toFixed(4)})`,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 880,
          borderRadius: 24,
          padding: '18px 22px',
          background: 'linear-gradient(135deg, rgba(34,197,94,0.94), rgba(14,165,233,0.94))',
          boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
          border: '2px solid rgba(255,255,255,0.2)',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 34,
            lineHeight: 1.2,
            fontWeight: 900,
            color: '#FFFFFF',
            textTransform: 'uppercase',
            textShadow: '0 3px 12px rgba(0, 0, 0, 0.35)',
            fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
};
