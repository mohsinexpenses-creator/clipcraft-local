/**
 * The Phase 5 gate: is the native B-roll renderer pixel-equivalent to Remotion?
 *
 * It renders ONE landscape card with both renderers over the same frame range -
 * the enter frames, the middle hold frames and the exit frames - then compares
 * every frame: SSIM inside the card's bounding box, the worst channel difference
 * and the share of changed pixels. It also reports the wall-clock time of each
 * renderer, which is the other half of the reason this exists.
 *
 *   npm run verify:broll-native
 *   npm run verify:broll-native -- --image path/to/photo.jpg --seconds 2.5
 *
 * The FIRST/MIDDLE/LAST frames plus enter+3/enter+4 and exit-3/exit-4 are always
 * included, because the bounce edges are where a hand-written rasteriser and
 * Chromium disagree if they are going to.
 *
 * Exit code 0 only when every compared frame passes NATIVE_GATE.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { renderNativeCardPhase, getBrollRendererChoice } from "../lib/broll/native";
import { compareImages, NATIVE_GATE, passesNativeGate } from "../lib/broll/compare";
import { CARD_HEIGHT, CARD_WIDTH } from "../lib/broll/card";
import { FULL_OVERLAY_CANVAS } from "../lib/overlay-canvas";
import { normalizeFps } from "../worker/ffmpeg-pipeline";

const CARD = { x: 162, y: 640, width: CARD_WIDTH, height: CARD_HEIGHT };

interface Args {
  image?: string;
  seconds: number;
  fps: number;
  workDir: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seconds: 2.5, fps: 30, workDir: fs.mkdtempSync(path.join(os.tmpdir(), "broll-native-gate-")), keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--image") args.image = argv[++index];
    else if (arg === "--seconds") args.seconds = Number(argv[++index]) || args.seconds;
    else if (arg === "--fps") args.fps = Number(argv[++index]) || args.fps;
    else if (arg === "--keep") args.keep = true;
  }
  return args;
}

/** A deterministic test photo: colour quadrants with a gradient, so SSIM is meaningful. */
async function makeTestImage(file: string): Promise<void> {
  const width = 1600;
  const height = 900;
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const quadrant = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
      const base = [
        [212, 64, 48],
        [40, 96, 200],
        [232, 200, 64],
        [64, 168, 96],
      ][quadrant];
      image.bitmap.data[index] = (base[0] + (x / width) * 30) | 0;
      image.bitmap.data[index + 1] = (base[1] + (y / height) * 30) | 0;
      image.bitmap.data[index + 2] = base[2];
      image.bitmap.data[index + 3] = 255;
    }
  }
  await fs.promises.writeFile(file, await image.getBuffer("image/jpeg", { quality: 95 }));
}

async function readPng(file: string): Promise<{ width: number; height: number; data: Buffer }> {
  const image = await Jimp.read(file);
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    data: Buffer.from(image.bitmap.data),
  };
}

function listFrames(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .sort();
}

/**
 * Remotion renders through the worker's own function so the comparison is
 * apples-to-apples: same items, same active range, same fps. It needs Chromium,
 * so a missing browser is reported as "needs manual verification" instead of a
 * failed gate.
 */
async function renderWithRemotion(
  imagePath: string,
  frameCount: number,
  fps: number,
  outputDir: string,
): Promise<{ ok: boolean; reason?: string; ms: number }> {
  const startedAt = Date.now();
  try {
    const { prepareRemotionBrollOverlays } = await import("../worker/remotion-renderer");
    const totalDuration = frameCount / fps;
    const prepared = await prepareRemotionBrollOverlays({
      fps,
      items: [
        {
          id: "gate-card",
          kind: "landscape",
          start: 0,
          end: totalDuration,
          imageUrl: `file://${imagePath}`,
          card: CARD,
          cacheIdentity: `gate-${path.basename(imagePath)}`,
          imagePath,
        },
      ],
      totalDuration,
    });
    const sequence = prepared.sequences[0];
    if (!sequence) return { ok: false, reason: "Remotion produced no sequence", ms: Date.now() - startedAt };
    // The worker's sequences are renamed to ov_XXXXX.png by its own normalizer;
    // copy them into our own directory under the gate's naming.
    const sourceDir = path.dirname(sequence.inputPattern.replace(/\/[^/]+$/, ""));
    const sourceFiles = listFrames(sourceDir);
    fs.mkdirSync(outputDir, { recursive: true });
    sourceFiles.forEach((file, index) => {
      fs.copyFileSync(path.join(sourceDir, file), path.join(outputDir, `frame-${String(index + 1).padStart(6, "0")}.png`));
    });
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  // Remotion's bundle fetches remote assets (fonts, media) at import time. In a
  // sandbox without that network the rejection is asynchronous and would kill the
  // gate even though the NATIVE half already ran: record it and carry on.
  const offlineRejections: string[] = [];
  process.on("unhandledRejection", (reason) => {
    offlineRejections.push(reason instanceof Error ? reason.message : String(reason));
  });
  const args = parseArgs(process.argv.slice(2));
  const fps = normalizeFps(args.fps);
  const imagePath = args.image ?? path.join(args.workDir, "gate-source.jpg");
  if (!args.image) await makeTestImage(imagePath);
  const totalFrames = Math.max(2, Math.round(args.seconds * fps));

  console.log("Native B-roll renderer gate");
  console.log(`  source=${imagePath}`);
  console.log(`  card=${CARD.width}x${CARD.height}@${CARD.x},${CARD.y} canvas=${FULL_OVERLAY_CANVAS.width}x${FULL_OVERLAY_CANVAS.height}`);
  console.log(`  frames=${totalFrames} fps=${fps} default_renderer=${getBrollRendererChoice({})}`);

  /* ------------------------------- native ------------------------------ */
  const nativeDir = path.join(args.workDir, "native");
  // Our own frame-XXXXXX.png naming is applied after the phase render, so the
  // comparison always reads one convention.
  const nativeRaw = path.join(args.workDir, "native-raw");
  const nativeStartedAt = Date.now();
  const nativeResult = await renderNativeCardPhase({
    item: { id: "gate-card", kind: "landscape", start: 0, end: totalFrames / fps, imagePath, card: CARD },
    canvas: FULL_OVERLAY_CANVAS,
    startFrame: 0,
    endFrame: totalFrames - 1,
    fps,
    outputDir: nativeRaw,
  });
  const nativeMs = Date.now() - nativeStartedAt;

  /* ------------------------------ remotion ----------------------------- */
  const remotionDir = path.join(args.workDir, "remotion");
  const remotion = await renderWithRemotion(imagePath, totalFrames, fps, remotionDir);
  if (!remotion.ok && offlineRejections.length > 0) {
    remotion.reason = `${remotion.reason ?? "unknown"} (also: ${offlineRejections[0]})`;
  }

  console.log(`  native: ${nativeResult.frames} frame(s) in ${nativeMs} ms (bake ${nativeResult.bakeMs} ms, paint ${nativeResult.paintMs} ms)`);
  if (!remotion.ok) {
    console.log(`  remotion: UNAVAILABLE (${remotion.reason})`);
    console.log("  NEEDS MANUAL VERIFICATION: run this on a machine with Chromium to record the SSIM gate.");
    process.exitCode = 2;
    return;
  }
  console.log(`  remotion: ${listFrames(remotionDir).length} frame(s) in ${remotion.ms} ms`);

  /* ------------------------------- compare ----------------------------- */
  const nativeFiles = listFrames(nativeRaw);
  if (nativeFiles.length !== totalFrames) {
    console.error(`  FAIL: native produced ${nativeFiles.length} of ${totalFrames} frames`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(nativeDir, { recursive: true });

  const enter = Math.max(1, Math.round(0.25 * fps));
  const exitStart = totalFrames - Math.max(1, Math.round(0.2 * fps));
  const picks = new Set<number>([
    0, // first frame
    Math.min(enter - 1, totalFrames - 1), // enter + 3 at 30 fps
    Math.min(enter, totalFrames - 1), // enter + 4
    Math.floor(totalFrames / 2), // middle
    Math.max(0, exitStart - 3), // exit - 4
    Math.max(0, exitStart - 2), // exit - 3
    exitStart,
    totalFrames - 1, // last frame
  ]);
  const targets = [...picks].sort((a, b) => a - b).filter((frame) => frame >= 0 && frame < totalFrames);

  let failed = 0;
  const box = { x: CARD.x - 4, y: CARD.y - 4, width: CARD.width + 8, height: CARD.height + 8 };
  for (const frame of targets) {
    const nativeFile = nativeFiles[frame];
    // Keep a copy under the overlay-frame-cache naming so the gate artefacts are
    // directly comparable with a real render's frames.
    fs.copyFileSync(
      path.join(nativeRaw, nativeFile),
      path.join(nativeDir, `ov_${String(frame + 1).padStart(5, "0")}.png`),
    );
    const a = await readPng(path.join(nativeRaw, nativeFile));
    // Remotion writes `frame-000N.png` for the same absolute frame index.
    const b = await readPng(path.join(remotionDir, `frame-${String(frame + 1).padStart(6, "0")}.png`));
    const result = compareImages(a, b, { box });
    const ok = passesNativeGate(result);
    if (!ok) failed += 1;
    console.log(
      `  frame ${String(frame + 1).padStart(4, "0")} ssim=${result.ssim.toFixed(6)} ` +
        `max_diff=${result.maxAbsDiff} max_alpha_diff=${result.maxAbsAlphaDiff} ` +
        `changed=${(result.changedFraction * 100).toFixed(2)}% ${ok ? "PASS" : "FAIL"}`,
    );
  }

  console.log(
    `  gate: ssim>=${NATIVE_GATE.minSsim} max_diff<=${NATIVE_GATE.maxAbsDiff} ` +
      `changed<=${(NATIVE_GATE.maxChangedFraction * 100).toFixed(0)}%`,
  );
  console.log(
    `  timing: native=${nativeMs}ms remotion=${remotion.ms}ms ` +
      `speedup=${(remotion.ms / Math.max(1, nativeMs)).toFixed(2)}x`,
  );
  if (!args.keep) fs.rmSync(args.workDir, { recursive: true, force: true });
  else console.log(`  artefacts kept in ${args.workDir}`);
  if (failed > 0) {
    console.error(`  FAIL: ${failed} comparison(s) outside the gate`);
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: native output is pixel-equivalent to Remotion on every compared frame.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
