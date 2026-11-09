import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_OVERLAY_CANVAS,
  getBrollCardCanvasRegion,
  getCaptionOverlayCanvasRegion,
  isFullOverlayCanvas,
  normalizeOverlayCanvasRegion,
  sameOverlayCanvasRegion,
} from "../lib/overlay-canvas";
import { captionReservedBand } from "../lib/overlay-stack";
import {
  DEFAULT_CAPTION_PRESETS,
  DEFAULT_OVERLAY_STYLE_PRESETS,
} from "../lib/presets";

const caption = DEFAULT_CAPTION_PRESETS.find((preset) => preset._id === "caption-theme-kinetic-01")!;
const hook = DEFAULT_OVERLAY_STYLE_PRESETS.find((preset) => preset._id === "hook-signal-stamp")!;
const cta = DEFAULT_OVERLAY_STYLE_PRESETS.find((preset) => preset._id === "cta-afterglow")!;

test("a landscape B-roll canvas covers the card shadow and its full slide range", () => {
  const region = getBrollCardCanvasRegion({ x: 162, y: 1111, width: 756, height: 425 });
  assert.deepEqual(region, { x: 122, y: 1071, width: 836, height: 537 });
  assert.equal(isFullOverlayCanvas(region), false);

  // The original card rectangle and its max +32px down-slide stay inside the
  // physical crop; FFmpeg restores these local pixels at x=122/y=1071.
  assert.ok(region.x <= 162 && region.y <= 1111);
  assert.ok(region.x + region.width >= 162 + 756);
  assert.ok(region.y + region.height >= 1111 + 425 + 32);
});

test("caption band crop preserves the caption reservation plus hook and CTA cards", () => {
  const region = getCaptionOverlayCanvasRegion({
    preset: caption,
    hookText: "A short hook that still has an entrance shadow",
    hookDuration: 3,
    hookStyle: hook,
    ctaText: "Follow for the complete breakdown",
    ctaDuration: 2.5,
    ctaStyle: cta,
  });
  assert.ok(region, "the normal stacked treatment has removable top/bottom transparency");
  assert.equal(region?.x, 0);
  assert.equal(region?.width, 1080);
  assert.ok((region?.height ?? 1920) < 1920);

  const band = captionReservedBand(caption);
  const hookTop = ((hook.positionY ?? 12) / 100) * 1920;
  const ctaTop = ((cta.positionY ?? 70) / 100) * 1920;
  assert.ok((region?.y ?? 0) <= band.top);
  assert.ok((region?.y ?? 0) <= hookTop);
  assert.ok((region?.y ?? 0) + (region?.height ?? 0) >= band.bottom);
  assert.ok((region?.y ?? 0) + (region?.height ?? 0) >= ctaTop);
});

test("crop geometry clamps malformed or out-of-frame data to a safe legacy canvas", () => {
  assert.deepEqual(normalizeOverlayCanvasRegion(null), FULL_OVERLAY_CANVAS);
  assert.deepEqual(
    normalizeOverlayCanvasRegion({ x: -25.3, y: 1900.4, width: 100, height: 80 }),
    { x: 0, y: 1900, width: 75, height: 20 },
  );
  assert.equal(
    sameOverlayCanvasRegion(undefined, FULL_OVERLAY_CANVAS),
    true,
    "an omitted sequence canvas means the original full-frame overlay",
  );
  assert.equal(
    sameOverlayCanvasRegion({ x: 1, y: 0, width: 1079, height: 1920 }, FULL_OVERLAY_CANVAS),
    false,
  );
});

test("a crop that would span the whole output returns the full-canvas fallback", () => {
  const full = getCaptionOverlayCanvasRegion({
    preset: { ...caption, positionY: 100 },
    hookText: "TOP",
    hookDuration: 3,
    hookStyle: { ...hook, positionY: 0 },
    ctaText: "BOTTOM",
    ctaDuration: 2.5,
    ctaStyle: { ...cta, positionY: 100 },
  });
  assert.equal(full, null);
});
