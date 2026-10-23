import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { brollFrameStyle } from "../lib/broll/animation";
import { captionContrastTreatment } from "../lib/broll/crop";
import type { BrollCardRect } from "../lib/types";

/**
 * One B-roll item, painted on a transparent canvas.
 *
 * FFmpeg composites this PNG sequence directly onto the crop BEFORE the caption
 * sequence, so captions always sit ON TOP of B-roll and stay readable: when a
 * full-screen image is visible the composition paints a bottom scrim (plus a soft
 * pill across the caption band) whose colour is chosen from the caption text's
 * luminance - dark scrim for light text, light scrim for dark text. No caption
 * preset is modified, and with B-roll off this composition is never used.
 */
export interface BrollOverlayCompositionProps extends Record<string, unknown> {
  kind: "fullscreen" | "landscape";
  /** Loopback URL of the prepared image (never a remote URL). */
  imageUrl: string;
  /** Required for landscape: where the card sits on the 1080x1920 canvas. */
  card?: BrollCardRect;
  /** How long this item is on screen (seconds) - matches the sequence length. */
  durationSeconds: number;
  /** Caption colour, so the scrim can guarantee contrast. */
  captionTextColor?: string;
  /** Caption block on the canvas (full-screen scrim + pill placement). */
  captionBand?: { top: number; bottom: number };
}

export const BrollOverlayComposition: React.FC<
  BrollOverlayCompositionProps
> = ({
  kind,
  imageUrl,
  card,
  durationSeconds,
  captionTextColor,
  captionBand,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const elapsed = frame / fps;
  const style = brollFrameStyle(kind, elapsed, durationSeconds);
  const treatment = captionContrastTreatment(captionTextColor);

  if (kind === "landscape" && card) {
    const mediaScale = style.mediaScale;
    return (
      <AbsoluteFill style={{ backgroundColor: "transparent" }}>
        <div
          style={{
            position: "absolute",
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
            opacity: style.opacity,
            transform: `translateY(${style.translateY}px) scale(${style.scale})`,
            borderRadius: Math.round(card.height * 0.055),
            overflow: "hidden",
            border: "2px solid rgba(255,255,255,0.24)",
            boxShadow: "0 10px 26px rgba(0,0,0,0.22)",
          }}
        >
          <Img
            src={imageUrl}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${mediaScale}) translateX(${style.mediaX}px)`,
            }}
          />
          {/* Captions overlap the lower part of the card: a contrast scrim keeps them readable. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(180deg, rgba(0,0,0,0) 45%, ${treatment.scrimColor} 100%)`,
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  // Full screen: the image fills the canvas, the scrim sits under the captions.
  const band = captionBand ?? {
    top: Math.round(height * 0.64),
    bottom: Math.round(height * 0.75),
  };
  const scrimTop = Math.max(0, Math.round(height * 0.42));
  const pillTop = Math.max(0, Math.min(height - 40, band.top + 8));
  const pillHeight = Math.max(
    40,
    Math.min(height - pillTop, band.bottom - band.top + 56),
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <AbsoluteFill
        style={{
          opacity: style.opacity,
          transform: `translateY(${style.translateY}px) scale(${style.scale})`,
        }}
      >
        <Img
          src={imageUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${style.mediaScale}) translateX(${style.mediaX}px)`,
          }}
        />
      </AbsoluteFill>

      {/* Scrim: the caption's own colour decides whether it is dark or light. */}
      <AbsoluteFill
        style={{
          opacity: interpolate(style.opacity, [0, 1], [0, 1], {
            extrapolateRight: "clamp",
          }),
          background: `linear-gradient(180deg, rgba(0,0,0,0) ${Math.round((scrimTop / height) * 100)}%, ${
            treatment.scrimColor
          } 100%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: Math.round(width * 0.04),
          top: pillTop,
          width: Math.round(width * 0.92),
          height: pillHeight,
          borderRadius: Math.round(pillHeight * 0.22),
          backgroundColor: treatment.pillColor,
          opacity: style.opacity * 0.85,
        }}
      />
    </AbsoluteFill>
  );
};
