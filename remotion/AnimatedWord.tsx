import React from 'react';
import { interpolate, spring } from 'remotion';
import { CaptionPreset, WordTimestamp } from '../lib/types';

export interface CaptionChunk {
  id: string;
  words: WordTimestamp[];
  /** Seconds, on the FINAL clip timeline (already shifted by hookDuration). */
  start: number;
  /** Seconds, on the FINAL clip timeline. */
  end: number;
}

interface AnimatedWordProps {
  chunks: CaptionChunk[];
  frame: number;
  fps: number;
  preset: CaptionPreset;
  /** Extra space to keep clear at the bottom, in % of the composition height (used by the CTA). */
  bottomLiftPercent?: number;
}

/** 8-direction text outline; a real `-webkit-text-stroke` eats the glyph interiors. */
function buildOutline(color: string, width: number): string {
  if (!width || width <= 0) return 'none';

  const offsets: Array<[number, number]> = [
    [width, 0], [-width, 0], [0, width], [0, -width],
    [width, width], [-width, width], [width, -width], [-width, -width],
  ];
  const shadows = offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`);
  shadows.push(`0 ${Math.round(width * 1.5)}px ${Math.round(width * 3)}px rgba(0,0,0,0.55)`);
  return shadows.join(', ');
}

function fontWeightToCss(weight: CaptionPreset['fontWeight']): number {
  switch (weight) {
    case 'black':
      return 900;
    case 'extra-bold':
      return 800;
    case 'bold':
      return 700;
    default:
      return 400;
  }
}

/**
 * Karaoke / word-pop / fade-in captions.
 *
 * Everything is derived from `useCurrentFrame()` via interpolate()/spring().
 * The previous version used CSS `transition: all 0.1s ease-out`, which Remotion
 * cannot reproduce deterministically: each rendered frame is a fresh screenshot,
 * so a CSS transition either never runs or runs at wall-clock speed, producing
 * inconsistent animation between preview and render.
 */
export const AnimatedWord: React.FC<AnimatedWordProps> = ({
  chunks,
  frame,
  fps,
  preset,
  bottomLiftPercent = 0,
}) => {
  if (!chunks || chunks.length === 0) return null;

  const currentTime = frame / fps;

  // Keep the previous chunk on screen briefly so captions never strobe between words.
  const HOLD_AFTER_SECONDS = 0.35;
  const LOOKAHEAD_SECONDS = 0.06;

  // The FIRST matching chunk wins: the outgoing chunk keeps its 0.35s hold
  // and the next caption only pops in once that hold is over - no strobing
  // between words. (Only ONE chunk is ever rendered, so unlike the native
  // ASS engine there is no risk of two lines sharing the screen.)
  let active: CaptionChunk | null = null;
  for (const chunk of chunks) {
    if (currentTime >= chunk.start - LOOKAHEAD_SECONDS && currentTime <= chunk.end + HOLD_AFTER_SECONDS) {
      active = chunk;
      break;
    }
  }

  // Nothing in range: show the next upcoming chunk slightly early rather than a gap.
  if (!active) {
    const upcoming = chunks.find((chunk) => chunk.start > currentTime);
    if (upcoming && upcoming.start - currentTime <= LOOKAHEAD_SECONDS) active = upcoming;
  }

  if (!active) return null;

  const {
    fontFamily = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    fontSize = 48,
    fontWeight = 'bold',
    textColor = '#FFFFFF',
    highlightColor = '#FFE600',
    strokeColor = '#000000',
    strokeWidth = 3,
    positionY = 25,
    animationStyle = 'karaoke',
    uppercase = true,
  } = preset;

  const chunkDuration = Math.max(0.2, active.end - active.start);
  const localTime = currentTime - active.start;

  const fadeIn = interpolate(localTime, [0, Math.min(0.18, chunkDuration * 0.25)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(
    localTime,
    [chunkDuration, chunkDuration + HOLD_AFTER_SECONDS],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const opacity = Math.min(fadeIn, fadeOut);
  if (opacity <= 0.01) return null;

  const entrance = spring({
    frame: frame - Math.round(active.start * fps),
    fps,
    config: { damping: 14, stiffness: 180, mass: 0.6 },
    durationInFrames: Math.max(6, Math.round(0.22 * fps)),
  });

  const liftPx = (bottomLiftPercent / 100) * 1920;
  const slidePx = interpolate(fadeIn, [0, 1], [14, 0]);

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: `calc(${positionY}% + ${liftPx.toFixed(0)}px)`,
    left: '5%',
    right: '5%',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    textAlign: 'center',
    zIndex: 20,
    padding: '8px 16px',
    fontFamily,
    fontSize,
    fontWeight: fontWeightToCss(fontWeight),
    textTransform: uppercase ? 'uppercase' : 'none',
    opacity,
    transform: `translateY(${(slidePx + (1 - entrance) * 10).toFixed(2)}px) scale(${(0.96 + entrance * 0.04).toFixed(4)})`,
    lineHeight: 1.25,
  };

  return (
    <div style={containerStyle}>
      {active.words.map((word: WordTimestamp, idx: number) => {
        const isActive = currentTime >= word.start && currentTime <= word.end;
        const isPast = currentTime > word.end;

        let color = textColor;
        let scale = 1;
        let wordOpacity = 1;

        if (animationStyle === 'karaoke') {
          // Hard highlight on the spoken word - the classic karaoke look.
          color = isActive ? highlightColor : textColor;
          scale = isActive ? 1.12 : 1;
        } else if (animationStyle === 'word-pop') {
          const pop = isActive
            ? spring({
                frame: frame - Math.round(word.start * fps),
                fps,
                config: { damping: 9, stiffness: 220, mass: 0.4 },
                durationInFrames: Math.max(4, Math.round(0.2 * fps)),
              })
            : 0;
          color = isActive ? highlightColor : textColor;
          scale = 1 + pop * 0.24;
          wordOpacity = isPast || isActive ? 1 : 0.62;
        } else if (animationStyle === 'fade-in') {
          const reveal = interpolate(
            currentTime,
            [word.start - 0.12, word.start + 0.08],
            [0.25, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          );
          color = isActive ? highlightColor : textColor;
          wordOpacity = reveal;
        }
        // 'static' -> no per-word animation at all.

        return (
          <span
            key={`${active.id}-${idx}-${word.word}`}
            style={{
              color,
              opacity: wordOpacity,
              display: 'inline-block',
              transform: `scale(${scale.toFixed(4)})`,
              textShadow: buildOutline(strokeColor, strokeWidth),
              padding: '0 4px',
              whiteSpace: 'pre',
            }}
          >
            {word.word}
          </span>
        );
      })}
    </div>
  );
};
