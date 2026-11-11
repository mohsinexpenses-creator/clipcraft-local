/**
 * Browser-backed visual regression gate for the experimental B-roll card crop.
 *
 * It intentionally uses the same one-time composition selection + per-phase
 * resolved-prop override as the worker. For a representative landscape card it
 * paints start/middle/end frames at 1080x1920 and at the guarded physical crop,
 * composites each crop back at its virtual origin, then requires exact RGBA
 * equality or a visual SSIM of at least 0.999.
 *
 *   npm run verify:broll-cropped-canvas
 *
 * The command needs a usable Remotion Chrome installation. It does not require
 * FFmpeg, a database record, provider credentials, or a source video.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderFrames, selectComposition } from "@remotion/renderer";
import { Jimp, JimpMime } from "jimp";
import type { VideoConfig } from "remotion/no-react";
import {
  FULL_OVERLAY_CANVAS,
  getBrollCardCanvasRegion,
  type OverlayCanvasRegion,
} from "../lib/overlay-canvas";
import {
  withBrollPhaseCompositionProps,
  type BrollPhaseInputProps,
} from "../worker/remotion-renderer";

const FPS = 30;
const CARD_DURATION_SECONDS = 2;
const TOTAL_FRAMES = FPS * CARD_DURATION_SECONDS;
const CARD = { x: 162, y: 1111, width: 756, height: 425 };
const CROP = getBrollCardCanvasRegion(CARD);
const FRAME_SAMPLES = [0, Math.floor(TOTAL_FRAMES / 2), TOTAL_FRAMES - 1] as const;
const SSIM_THRESHOLD = 0.999;

interface FrameComparison {
  frame: number;
  exact: boolean;
  differingPixels: number;
  ssim: number;
  hasVisibleCardPixels: boolean;
}

function phaseProps(renderRegion?: OverlayCanvasRegion): BrollPhaseInputProps {
  return {
    items: [
      {
        id: "cropped-canvas-regression-card",
        kind: "landscape",
        start: 0,
        end: CARD_DURATION_SECONDS,
        imageUrl: "",
        card: CARD,
      },
    ],
    captionTextColor: "#ffffff",
    captionBand: { top: 1230, bottom: 1440 },
    renderRegion,
  };
}

async function sampleImageUrl(): Promise<string> {
  const image = new Jimp({ width: 960, height: 540, color: 0x163b73ff });
  const rgba = image.bitmap.data;
  // A deterministic, high-contrast pseudo-photo exercises the CSS crop, image
  // scaling, border radius, box shadow, and alpha edge pixels without requiring
  // a remote provider asset or local media server.
  for (let y = 0; y < image.bitmap.height; y += 1) {
    for (let x = 0; x < image.bitmap.width; x += 1) {
      const offset = (y * image.bitmap.width + x) * 4;
      const diagonal = ((x + y) % 180) < 90;
      rgba[offset] = diagonal ? 24 : 224;
      rgba[offset + 1] = Math.round((y / image.bitmap.height) * 180) + (diagonal ? 35 : 0);
      rgba[offset + 2] = Math.round((x / image.bitmap.width) * 180) + (diagonal ? 30 : 0);
      rgba[offset + 3] = 255;
    }
  }
  const png = await image.getBuffer(JimpMime.png);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function physicalComposition(
  selected: VideoConfig,
  props: BrollPhaseInputProps,
  canvas: OverlayCanvasRegion,
): VideoConfig {
  return {
    ...withBrollPhaseCompositionProps(selected, props),
    id: "BrollTimelineComposition",
    width: canvas.width,
    height: canvas.height,
    fps: FPS,
    durationInFrames: TOTAL_FRAMES,
  };
}

function onePng(outputDir: string): string {
  const files = fs
    .readdirSync(outputDir)
    .filter((file) => file.toLowerCase().endsWith(".png"));
  if (files.length !== 1) {
    throw new Error(`Expected exactly one PNG for one frame in ${outputDir}; found ${files.length}.`);
  }
  return path.join(outputDir, files[0]);
}

async function renderFrame(options: {
  composition: VideoConfig;
  inputProps: BrollPhaseInputProps;
  serveUrl: string;
  browser: Awaited<ReturnType<typeof openBrowser>>;
  frame: number;
  outputDir: string;
}): Promise<string> {
  fs.mkdirSync(options.outputDir, { recursive: true });
  await renderFrames({
    composition: options.composition,
    inputProps: options.inputProps,
    serveUrl: options.serveUrl,
    puppeteerInstance: options.browser,
    outputDir: options.outputDir,
    frames: [options.frame],
    imageFormat: "png",
    concurrency: 1,
    logLevel: "error",
    onStart: () => undefined,
    onFrameUpdate: () => undefined,
  });
  return onePng(options.outputDir);
}

function hasVisiblePixels(image: Awaited<ReturnType<typeof Jimp.read>>): boolean {
  const rgba = image.bitmap.data;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] !== 0) return true;
  }
  return false;
}

/**
 * Global premultiplied-RGBA SSIM. Exact pixels are preferred; this tolerance
 * only permits imperceptible browser rasterization variance while still
 * treating alpha placement as part of the visual result.
 */
function premultipliedRgbaSsim(first: Buffer | Uint8Array, second: Buffer | Uint8Array): number {
  if (first.length !== second.length) return 0;
  const sampleCount = (first.length / 4) * 4;
  if (sampleCount === 0) return 1;

  let sumFirst = 0;
  let sumSecond = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    const firstAlpha = first[offset + 3] / 255;
    const secondAlpha = second[offset + 3] / 255;
    sumFirst += first[offset] * firstAlpha + first[offset + 1] * firstAlpha + first[offset + 2] * firstAlpha + first[offset + 3];
    sumSecond += second[offset] * secondAlpha + second[offset + 1] * secondAlpha + second[offset + 2] * secondAlpha + second[offset + 3];
  }
  const meanFirst = sumFirst / sampleCount;
  const meanSecond = sumSecond / sampleCount;

  let varianceFirst = 0;
  let varianceSecond = 0;
  let covariance = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    const firstAlpha = first[offset + 3] / 255;
    const secondAlpha = second[offset + 3] / 255;
    const firstRed = first[offset] * firstAlpha - meanFirst;
    const firstGreen = first[offset + 1] * firstAlpha - meanFirst;
    const firstBlue = first[offset + 2] * firstAlpha - meanFirst;
    const firstOpacity = first[offset + 3] - meanFirst;
    const secondRed = second[offset] * secondAlpha - meanSecond;
    const secondGreen = second[offset + 1] * secondAlpha - meanSecond;
    const secondBlue = second[offset + 2] * secondAlpha - meanSecond;
    const secondOpacity = second[offset + 3] - meanSecond;
    varianceFirst +=
      firstRed * firstRed +
      firstGreen * firstGreen +
      firstBlue * firstBlue +
      firstOpacity * firstOpacity;
    varianceSecond +=
      secondRed * secondRed +
      secondGreen * secondGreen +
      secondBlue * secondBlue +
      secondOpacity * secondOpacity;
    covariance +=
      firstRed * secondRed +
      firstGreen * secondGreen +
      firstBlue * secondBlue +
      firstOpacity * secondOpacity;
  }
  const denominator = Math.max(1, sampleCount - 1);
  varianceFirst /= denominator;
  varianceSecond /= denominator;
  covariance /= denominator;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * meanFirst * meanSecond + c1) * (2 * covariance + c2)) /
    ((meanFirst ** 2 + meanSecond ** 2 + c1) * (varianceFirst + varianceSecond + c2));
}

async function compareFrame(frame: number, fullPath: string, croppedPath: string): Promise<FrameComparison> {
  const [full, cropped] = await Promise.all([Jimp.read(fullPath), Jimp.read(croppedPath)]);
  if (full.bitmap.width !== FULL_OVERLAY_CANVAS.width || full.bitmap.height !== FULL_OVERLAY_CANVAS.height) {
    throw new Error(`Full-frame output for frame ${frame} was ${full.bitmap.width}x${full.bitmap.height}, not 1080x1920.`);
  }
  if (cropped.bitmap.width !== CROP.width || cropped.bitmap.height !== CROP.height) {
    throw new Error(`Cropped output for frame ${frame} was ${cropped.bitmap.width}x${cropped.bitmap.height}, not ${CROP.width}x${CROP.height}.`);
  }

  const recomposited = new Jimp({
    width: FULL_OVERLAY_CANVAS.width,
    height: FULL_OVERLAY_CANVAS.height,
    color: 0x00000000,
  });
  recomposited.composite(cropped, CROP.x, CROP.y);

  const expected = full.bitmap.data;
  const actual = recomposited.bitmap.data;
  let differingPixels = 0;
  let exact = true;
  for (let offset = 0; offset < expected.length; offset += 4) {
    if (
      expected[offset] !== actual[offset] ||
      expected[offset + 1] !== actual[offset + 1] ||
      expected[offset + 2] !== actual[offset + 2] ||
      expected[offset + 3] !== actual[offset + 3]
    ) {
      exact = false;
      differingPixels += 1;
    }
  }
  const ssim = exact ? 1 : premultipliedRgbaSsim(expected, actual);
  return {
    frame,
    exact,
    differingPixels,
    ssim,
    hasVisibleCardPixels: hasVisiblePixels(full),
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-broll-crop-gate-"));
  let browser: Awaited<ReturnType<typeof openBrowser>> | null = null;
  const startedAt = Date.now();
  try {
    const imageUrl = await sampleImageUrl();
    const fullProps = phaseProps(undefined);
    fullProps.items[0].imageUrl = imageUrl;
    const croppedProps = phaseProps(CROP);
    croppedProps.items[0].imageUrl = imageUrl;

    const entryPoint = path.join(process.cwd(), "remotion", "index.tsx");
    const serveUrl = await bundle({ entryPoint });
    const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
    browser = await openBrowser(
      "chrome",
      browserExecutable ? { browserExecutable } : {},
    );
    const selected = await selectComposition({
      serveUrl,
      id: "BrollTimelineComposition",
      inputProps: fullProps,
      puppeteerInstance: browser,
      logLevel: "error",
    });
    const fullComposition = physicalComposition(selected, fullProps, FULL_OVERLAY_CANVAS);
    const croppedComposition = physicalComposition(selected, croppedProps, CROP);

    const results: FrameComparison[] = [];
    for (const frame of FRAME_SAMPLES) {
      const fullPath = await renderFrame({
        composition: fullComposition,
        inputProps: fullProps,
        serveUrl,
        browser,
        frame,
        outputDir: path.join(root, `full-${frame}`),
      });
      const croppedPath = await renderFrame({
        composition: croppedComposition,
        inputProps: croppedProps,
        serveUrl,
        browser,
        frame,
        outputDir: path.join(root, `cropped-${frame}`),
      });
      results.push(await compareFrame(frame, fullPath, croppedPath));
    }

    const middle = results[1];
    if (!middle.hasVisibleCardPixels) {
      throw new Error("The middle regression frame contained no visible B-roll card pixels.");
    }
    const failures = results.filter((result) => !result.exact && result.ssim < SSIM_THRESHOLD);
    if (failures.length > 0) {
      throw new Error(
        `Cropped B-roll visual gate failed: ${failures
          .map((result) => `frame=${result.frame} ssim=${result.ssim.toFixed(6)} differing_pixels=${result.differingPixels}`)
          .join("; ")}`,
      );
    }

    console.log("B-roll cropped-canvas visual gate PASSED");
    console.log(`  sample card: ${CARD.width}x${CARD.height} at ${CARD.x},${CARD.y}`);
    console.log(`  crop canvas: ${CROP.width}x${CROP.height} at ${CROP.x},${CROP.y}`);
    for (const result of results) {
      console.log(
        `  frame ${String(result.frame).padStart(2, " ")}: ` +
          `exact=${result.exact ? "yes" : "no"} ssim=${result.ssim.toFixed(6)} ` +
          `differing_pixels=${result.differingPixels}`,
      );
    }
    console.log(`  elapsed_ms=${Date.now() - startedAt}`);
  } finally {
    if (browser) await browser.close({ silent: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`B-roll cropped-canvas visual gate did not pass: ${detail}`);
  console.error(
    "A usable Remotion Chrome executable is required. Set REMOTION_BROWSER_EXECUTABLE if automatic browser setup is unavailable, then run the gate again.",
  );
  process.exitCode = 1;
});
