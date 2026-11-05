import React from "react";
import {
  AbsoluteFill,
  Img,
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
 * full-screen image is visible the composition paints a subtle bottom scrim whose
 * colour is chosen from the caption text's luminance - dark scrim for light text,
 * light scrim for dark text. No caption preset is modified, and with B-roll off
 * this composition is never used.
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
  /** Caption band on the canvas, used only for readable scrim placement. */
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
  const { fps } = useVideoConfig();
  const elapsed = frame / fps;
  const style = brollFrameStyle(kind, elapsed, durationSeconds);
  const treatment = captionContrastTreatment(captionTextColor);
  void captionBand;

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
            boxSizing: "border-box",
            borderRadius: 28,
            overflow: "hidden",
            border: "10px solid #ffffff",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
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
        </div>
      </AbsoluteFill>
    );
  }

  // Full screen: the image fills the canvas, the scrim sits under the captions.
  const gradientScrim = treatment.textIsLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.4)";

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <AbsoluteFill
        style={{
          opacity: style.opacity,
          transform: `scale(${style.scale})`,
          transformOrigin: "center center",
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
        {/* Keep the caption area readable without the oversized dark pill behind the text. */}
        <AbsoluteFill
          style={{
            background: `linear-gradient(180deg, rgba(0,0,0,0) 0%, ${gradientScrim} 100%)`,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
