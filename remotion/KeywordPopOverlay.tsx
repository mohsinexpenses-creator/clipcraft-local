import React from 'react';
import { interpolate } from 'remotion';
import type { KeywordPopOverlayItem } from '../lib/types';

 interface KeywordPopOverlayProps {
  items: KeywordPopOverlayItem[];
  frame: number;
  fps: number;
  transitionStart?: number;
  transitionEnd?: number;
}

export const KeywordPopOverlay: React.FC<KeywordPopOverlayProps> = ({
  items,
  frame,
  fps,
  transitionStart = -1,
  transitionEnd = -1,
}) => {
  if (!items || items.length === 0) return null;

  const currentTime = frame / fps;
  if (
    transitionEnd > transitionStart &&
    currentTime >= transitionStart &&
    currentTime <= transitionEnd
  ) {
    return null;
  }

  const active = items.find(
    (item) => currentTime >= item.start && currentTime <= item.end && item.text.trim().length > 0
  );
  if (!active) return null;

  const elapsed = Math.max(0, currentTime - active.start);
  const remaining = Math.max(0, active.end - currentTime);
  const fadeOutWindow = Math.min(0.25, Math.max(0.12, (active.end - active.start) * 0.2));

  const enterOpacity = interpolate(elapsed, [0, 0.14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const exitOpacity = interpolate(remaining, [0, fadeOutWindow], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(enterOpacity, exitOpacity);

  // Overshoot pop / slide-up entrance
  const isSlide = active.animation === 'slide-up';
  const scale = isSlide
    ? interpolate(elapsed, [0, 0.16, 0.24], [0.94, 1.03, 1.0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : interpolate(elapsed, [0, 0.14, 0.22], [0.78, 1.06, 1.0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  const translateY = isSlide
    ? interpolate(elapsed, [0, 0.18, 0.26], [38, -6, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : interpolate(elapsed, [0, 0.14, 0.22], [18, -4, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  return (
    <div
      style={{
        position: 'absolute',
        left: active.x,
        top: active.y,
        width: active.width,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        opacity,
        transform: `translateY(${translateY.toFixed(1)}px) scale(${scale.toFixed(3)})`,
        transformOrigin: 'center center',
      }}
    >
      <div
        style={{
          maxWidth: '100%',
          padding: '22px 32px',
          borderRadius: 24,
          background:
            'linear-gradient(135deg, rgba(12, 14, 22, 0.94) 0%, rgba(24, 28, 44, 0.92) 100%)',
          border: '2px solid rgba(250, 204, 21, 0.78)',
          boxShadow: '0 18px 42px rgba(0, 0, 0, 0.52)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: 'Montserrat, Inter, system-ui, sans-serif',
            fontSize: 44,
            fontWeight: 900,
            lineHeight: 1.12,
            letterSpacing: '-0.02em',
            color: '#FACC15',
            textTransform: 'uppercase',
            textShadow: '0 3px 12px rgba(0, 0, 0, 0.65)',
            wordBreak: 'break-word',
          }}
        >
          {active.text}
        </div>
        {active.subtext ? (
          <div
            style={{
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 25,
              fontWeight: 700,
              lineHeight: 1.24,
              color: '#F8FAFC',
              opacity: 0.94,
              maxWidth: '94%',
            }}
          >
            {active.subtext}
          </div>
        ) : null}
      </div>
    </div>
  );
};
