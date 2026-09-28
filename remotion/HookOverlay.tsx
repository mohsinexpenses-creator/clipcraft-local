import React from 'react';
import { interpolate, spring } from 'remotion';
import { OverlayStylePreset } from '../lib/types';

interface HookOverlayProps {
  hookText: string;
  /** Length of the duplicated hook intro, in seconds. */
  hookDurationInSeconds: number;
  frame: number;
  fps: number;
  /** Visual style preset for the hook card. */
  style?: OverlayStylePreset;
}

function animationTransform(
  animationStyle: OverlayStylePreset['animationStyle'],
  pop: number,
  drift: number
): string {
  switch (animationStyle) {
    case 'slide-up':
      return `translateY(${((1 - pop) * 60 + drift / 2).toFixed(2)}px) scale(${(0.92 + pop * 0.08).toFixed(4)})`;
    case 'fade':
      return 'none';
    case 'none':
      return 'none';
    default:
      return `translateY(${drift.toFixed(2)}px) scale(${(0.86 + pop * 0.14).toFixed(4)})`;
  }
}

function animationOpacity(animationStyle: OverlayStylePreset['animationStyle'], pop: number): number {
  return animationStyle === 'fade' ? Math.max(pop, 0.02) : 1;
}

/**
 * Big "stop scrolling" text shown over the duplicated hook intro (0 -> hookDuration).
 *
 * Frame-driven (interpolate/spring) instead of CSS transitions so the render is
 * deterministic and matches the in-app preview. Styling comes from the hook
 * OverlayStylePreset (font, colors, card, badge, position, animation).
 */
export const HookOverlay: React.FC<HookOverlayProps> = ({
  hookText,
  hookDurationInSeconds,
  frame,
  fps,
  style,
}) => {
  const text = hookText?.trim();
  if (!text || hookDurationInSeconds <= 0) return null;

  const currentTime = frame / fps;
  if (currentTime > hookDurationInSeconds) return null;

  const fadeOutFrames = Math.max(4, Math.round(0.25 * fps));
  const totalFrames = Math.max(fadeOutFrames + 1, Math.round(hookDurationInSeconds * fps));

  const opacity =
    interpolate(frame, [0, 6, totalFrames - fadeOutFrames, totalFrames], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }) * animationOpacity(style?.animationStyle ?? 'pop', 1);
  if (opacity <= 0.01) return null;

  const pop = spring({
    frame,
    fps,
    config: { damping: 11, stiffness: 190, mass: 0.7 },
    durationInFrames: Math.max(8, Math.round(0.35 * fps)),
  });

  const drift = interpolate(frame, [0, totalFrames], [10, -6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fontFamily =
    style?.fontFamily || 'Inter, Impact, Arial Black, system-ui, sans-serif';
  const fontSize = style?.fontSize ?? 38;
  const fontWeight =
    style?.fontWeight === 'normal' ? 400 : style?.fontWeight === 'bold' ? 700 : style?.fontWeight === 'extra-bold' ? 800 : 900;

  return (
    <div
      style={{
        position: 'absolute',
        top: `${style?.positionY ?? 12}%`,
        left: '6%',
        right: '6%',
        zIndex: 30,
        opacity,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transform: animationTransform(style?.animationStyle ?? 'pop', pop, drift),
      }}
    >
      {style?.showBadge !== false && (
        <div
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.95)',
            color: '#FFFFFF',
            fontSize: 14,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 2,
            padding: '4px 14px',
            borderRadius: 20,
            marginBottom: 8,
            boxShadow: '0 4px 12px rgba(239, 68, 68, 0.5)',
            fontFamily,
          }}
        >
          {style?.badgeText || 'Hook Intro'}
        </div>
      )}

      <div
        style={{
          background: style?.backgroundColor || 'rgba(15, 23, 42, 0.92)',
          border: `${style?.borderWidth ?? 2}px solid ${style?.borderColor || 'rgba(255, 230, 0, 0.9)'}`,
          borderRadius: style?.borderRadius ?? 16,
          padding: '20px 24px',
          textAlign: 'center',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.7)',
          maxWidth: '100%',
        }}
      >
        <span
          style={{
            fontFamily,
            fontSize,
            fontWeight,
            color: style?.textColor || '#FFE600',
            lineHeight: 1.2,
            textTransform: style?.textTransform === 'none' ? 'none' : 'uppercase',
            letterSpacing: 1,
            textShadow: '2px 2px 8px rgba(0, 0, 0, 0.9)',
            display: 'block',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
