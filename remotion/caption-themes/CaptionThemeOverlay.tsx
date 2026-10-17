import { isCaptionThemeName } from '../../lib/caption-theme-styles';
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionPreset } from '../../lib/types';
import { captionReservedBand, OVERLAY_CANVAS_HEIGHT } from '../../lib/overlay-stack';
import type { CaptionChunk } from '../AnimatedWord';
import { useCaptionFonts } from '../caption-fonts';
import { CaptionTheme } from './vendor';
import { selectThemeCaptionData } from './data';

interface CaptionThemeOverlayProps {
  chunks: CaptionChunk[];
  preset: CaptionPreset;
  bottomLiftPercent?: number;
}

/**
 * Shared renderer for in-app preview and final Remotion renders. The upstream
 * theme library centers its captions in the frame, so this wrapper translates
 * that centered group into ClipCraft's safe-area band and hold timing.
 */
export const CaptionThemeOverlay: React.FC<CaptionThemeOverlayProps> = ({
  chunks,
  preset,
  bottomLiftPercent = 0,
}) => {
  useCaptionFonts();
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const theme = isCaptionThemeName(preset.captionTheme) ? preset.captionTheme : 'kinetic-01';
  if (chunks.length === 0) return null;

  const currentTime = frame / fps;
  const selected = selectThemeCaptionData(chunks, theme, currentTime);
  if (!selected) return null;

  const band = captionReservedBand({ ...preset, captionTheme: theme });
  const centerY = (band.top + band.bottom) / 2;
  const canvasScale = height / OVERLAY_CANVAS_HEIGHT;
  const offsetY = (centerY - OVERLAY_CANVAS_HEIGHT / 2) * canvasScale -
    (bottomLiftPercent / 100) * height;

  return (
    <AbsoluteFill style={{ zIndex: 20, pointerEvents: 'none' }}>
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translateY(${offsetY.toFixed(2)}px)`,
        }}
      >
        <CaptionTheme
          data={selected.data}
          theme={theme}
          primaryColor={preset.textColor}
          secondaryColor={preset.highlightColor}
          fontSize={preset.fontSize}
        />
      </div>
    </AbsoluteFill>
  );
};
