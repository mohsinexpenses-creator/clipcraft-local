import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import {
  FULL_OVERLAY_CANVAS,
  isFullOverlayCanvas,
  normalizeOverlayCanvasRegion,
  type OverlayCanvasRegion,
} from "../lib/overlay-canvas";

/**
 * Paint the existing 1080x1920 overlay layout into a smaller physical Remotion
 * canvas. The nested Sequence keeps `useVideoConfig()` at the virtual full size,
 * so caption themes and percentage card placement make the exact same pixels as
 * the legacy full frame. FFmpeg later places this cropped PNG at `region.x/y`.
 */
export const CroppedOverlayCanvas: React.FC<{
  region?: OverlayCanvasRegion;
  children: React.ReactNode;
}> = ({ region, children }) => {
  if (!region || isFullOverlayCanvas(region)) return <>{children}</>;
  const normalized = normalizeOverlayCanvasRegion(region);

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Sequence
        width={FULL_OVERLAY_CANVAS.width}
        height={FULL_OVERLAY_CANVAS.height}
        style={{
          right: "auto",
          bottom: "auto",
          transform: `translate(${-normalized.x}px, ${-normalized.y}px)`,
        }}
      >
        {children}
      </Sequence>
    </AbsoluteFill>
  );
};
