/**
 * B-roll PNG renderer benchmark: native vs Chromium.
 *
 *   npm run bench:broll-native
 *   npm run bench:broll-native -- --cards 6 --seconds 2.5 --fps 30
 *
 * It renders the same cards (same image, same card rect, same frame ranges) with
 * both renderers and prints one table: frames, wall-clock ms, ms/frame and the
 * speed-up. The Remotion half needs a downloaded Chromium; when that is not
 * available the native numbers are still recorded and the comparison is reported
 * as needs-manual-verification rather than a made-up number.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { renderNativeCardPhase } from "../lib/broll/native";
import { CARD_HEIGHT, CARD_WIDTH } from "../lib/broll/card";
import { FULL_OVERLAY_CANVAS } from "../lib/overlay-canvas";
import { normalizeFps } from "../worker/ffmpeg-pipeline";

const CARD = { x: 162, y: 640, width: CARD_WIDTH, height: CARD_HEIGHT };

function arg(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function makeImage(file: string): Promise<void> {
  const width = 1600;
  const height = 900;
  const image = new Jimp({ width, height, color: 0x4466aaff });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      image.bitmap.data[index] = 60 + ((x / width) * 120) | 0;
      image.bitmap.data[index + 1] = 90 + ((y / height) * 90) | 0;
      image.bitmap.data[index + 2] = 190;
      image.bitmap.data[index + 3] = 255;
    }
  }
  await fs.promises.writeFile(file, await image.getBuffer("image/jpeg", { quality: 92 }));
}

async function main(): Promise<void> {
  // Remotion's bundle can reject asynchronously while fetching remote assets; in
  // an offline sandbox that must not kill the native half of the benchmark.
  const offline: string[] = [];
  process.on("unhandledRejection", (reason) => {
    offline.push(reason instanceof Error ? reason.message : String(reason));
  });
  const argv = process.argv.slice(2);
  const cards = arg(argv, "cards", 6);
  const seconds = arg(argv, "seconds", 2.5);
  const fps = normalizeFps(arg(argv, "fps", 30));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "broll-native-bench-"));
  const source = path.join(workDir, "source.jpg");
  await makeImage(source);
  const framesPerCard = Math.round(seconds * fps);

  console.log("B-roll card renderer benchmark");
  console.log(`  cards=${cards} frames_per_card=${framesPerCard} fps=${fps} canvas=${FULL_OVERLAY_CANVAS.width}x${FULL_OVERLAY_CANVAS.height}`);

  /* ------------------------------- native ------------------------------ */
  let nativeMs = 0;
  for (let card = 0; card < cards; card += 1) {
    const startedAt = Date.now();
    await renderNativeCardPhase({
      item: {
        id: `bench-${card}`,
        kind: "landscape",
        start: card * seconds,
        end: card * seconds + seconds,
        imagePath: source,
        card: CARD,
      },
      canvas: FULL_OVERLAY_CANVAS,
      startFrame: card * framesPerCard,
      endFrame: card * framesPerCard + framesPerCard - 1,
      fps,
      outputDir: path.join(workDir, `native-${card}`),
    });
    nativeMs += Date.now() - startedAt;
  }

  /* ------------------------------ remotion ----------------------------- */
  let remotionMs: number | null = null;
  let remotionNote = "";
  try {
    const { prepareRemotionBrollOverlays } = await import("../worker/remotion-renderer");
    const startedAt = Date.now();
    await prepareRemotionBrollOverlays({
      fps,
      items: Array.from({ length: cards }, (_, card) => ({
        id: `bench-${card}`,
        kind: "landscape" as const,
        start: card * seconds,
        end: card * seconds + seconds,
        imageUrl: `file://${source}`,
        card: CARD,
        cacheIdentity: `bench-${card}`,
        imagePath: source,
      })),
      totalDuration: cards * seconds,
    });
    remotionMs = Date.now() - startedAt;
  } catch (error) {
    remotionNote = `${error instanceof Error ? error.message : String(error)}${offline.length > 0 ? ` (also: ${offline[0]})` : ""}`;
  }

  const totalFrames = cards * framesPerCard;
  console.log("");
  console.log("  renderer    frames      ms   ms/frame");
  console.log(
    `  native    ${String(totalFrames).padStart(6)} ${String(nativeMs).padStart(7)} ${(nativeMs / totalFrames).toFixed(2).padStart(10)}`,
  );
  if (remotionMs === null) {
    console.log(`  remotion  NEEDS MANUAL VERIFICATION (${remotionNote.slice(0, 90)})`);
  } else {
    console.log(
      `  remotion  ${String(totalFrames).padStart(6)} ${String(remotionMs).padStart(7)} ${(remotionMs / totalFrames).toFixed(2).padStart(10)}`,
    );
    console.log(`  speedup: ${(remotionMs / Math.max(1, nativeMs)).toFixed(2)}x`);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
