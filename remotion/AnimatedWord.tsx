import React from 'react';
import { CaptionPreset, WordTimestamp } from '../lib/types';

interface AnimatedWordProps {
  words: WordTimestamp[];
  currentTime: number; // in seconds
  preset: CaptionPreset;
}

export const AnimatedWord: React.FC<AnimatedWordProps> = ({
  words,
  currentTime,
  preset,
}) => {
  if (!words || words.length === 0) return null;

  // Group active words to display in small chunks (e.g. 3-5 words per caption line)
  const chunkSize = 4;
  
  // Find current active word index
  const activeWordIdx = words.findIndex(
    (w) => currentTime >= w.start && currentTime <= w.end
  );

  // If no word is currently active, find nearest upcoming or recent word chunk
  let currentChunkIdx = 0;
  if (activeWordIdx >= 0) {
    currentChunkIdx = Math.floor(activeWordIdx / chunkSize);
  } else {
    // Find last word before currentTime
    const lastPastWordIdx = words.findLastIndex((w) => currentTime >= w.end);
    if (lastPastWordIdx >= 0) {
      currentChunkIdx = Math.floor(lastPastWordIdx / chunkSize);
    } else {
      currentChunkIdx = 0;
    }
  }

  const visibleWords = words.slice(
    currentChunkIdx * chunkSize,
    (currentChunkIdx + 1) * chunkSize
  );

  // Check if chunk is within visible window
  const chunkStart = visibleWords[0]?.start ?? 0;
  const chunkEnd = visibleWords[visibleWords.length - 1]?.end ?? 0;

  if (currentTime < chunkStart - 0.2 || currentTime > chunkEnd + 0.8) {
    return null;
  }

  const {
    fontFamily = 'Inter, sans-serif',
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

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: `${positionY}%`,
    left: '5%',
    right: '5%',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '12px',
    textAlign: 'center',
    zIndex: 20,
    padding: '8px 16px',
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: fontWeight === 'black' ? 900 : fontWeight === 'extra-bold' ? 800 : fontWeight === 'bold' ? 700 : 400,
    textTransform: uppercase ? 'uppercase' : 'none',
  };

  return (
    <div style={containerStyle}>
      {visibleWords.map((w, idx) => {
        const isActive = currentTime >= w.start && currentTime <= w.end;
        const isPast = currentTime > w.end;

        let wordColor = textColor;
        let transform = 'scale(1)';
        let opacity = 1;

        if (animationStyle === 'karaoke') {
          wordColor = isActive ? highlightColor : textColor;
          transform = isActive ? 'scale(1.12)' : 'scale(1)';
        } else if (animationStyle === 'word-pop') {
          wordColor = isActive ? highlightColor : isPast ? textColor : 'rgba(255,255,255,0.7)';
          transform = isActive ? 'scale(1.22)' : 'scale(1)';
        } else if (animationStyle === 'fade-in') {
          wordColor = isActive ? highlightColor : textColor;
          opacity = isActive || isPast ? 1 : 0.4;
        }

        const textStrokeStyle = strokeWidth > 0
          ? `${strokeWidth}px ${strokeColor}, -${strokeWidth}px ${strokeColor}, 0 ${strokeWidth}px ${strokeColor}, 0 -${strokeWidth}px ${strokeColor}`
          : 'none';

        return (
          <span
            key={`${w.word}-${w.start}-${idx}`}
            style={{
              color: wordColor,
              opacity,
              transform,
              transition: 'all 0.1s ease-out',
              display: 'inline-block',
              textShadow: textStrokeStyle,
              filter: isActive ? 'drop-shadow(0px 4px 12px rgba(0,0,0,0.6))' : 'none',
              padding: '0 4px',
            }}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
};
