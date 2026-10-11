import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppError, RenderCancelledError, toErrorMessage } from '../lib/errors';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
import { maskProfanity } from '../lib/profanity';
import { log } from '../lib/logger';
import { CaptionOverlayCompositionProps } from '../remotion/OverlayCompositions';
import { OverlayFrameSequence } from './ffmpeg-pipeline';
import { normalizeFps } from './ffmpeg-pipeline';

export interface PreparedCaptionOverlays {
  workDir: string;
  sequences: OverlayFrameSequence[];
}

export interface PrepareRemotionOverlaysOptions {
  fps: number;
  totalDuration: number;
  hookText: string;
  hookDuration: number;
  hookStart: number;
  hookTransitionDuration: number;
  ctaText: string;
  ctaDuration: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  hookStyle: OverlayStylePreset;
  ctaStyle: OverlayStylePreset;
  captionLiftScale?: number;
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
}

/**
 * bundle() is clip-independent, so cache it for the lifetime of the worker.
 * The worker now uses Remotion only to paint transparent overlay PNGs; FFmpeg
 * composites those with the source crop and produces the final video once.
 */
let cachedBundlePromise: Promise<string> | null = null;

export function getRemotionBundle(): Promise<string> {
  if (cachedBundlePromise) return cachedBundlePromise;

  cachedBundlePromise = (async () => {
    const { bundle } = await import('@remotion/bundler');
    const entryPoint = path.join(process.cwd(), 'remotion', 'index.tsx');

    log.detail('Bundling the Remotion project (first clip only)...');
    const bundled = await bundle({ entryPoint });
    log.ok(`Bundle ready: ${bundled}`);
    return bundled;
  })().catch((error) => {
    cachedBundlePromise = null;
    throw error;
  });

  return cachedBundlePromise;
}

function getRenderTimeoutMs(): number {
  const minutes = Number(process.env.REMOTION_TIMEOUT_MINUTES?.trim());
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 60 * 60_000;
}

function checkCancelled(isCancelled?: () => boolean): void {
  try {
    if (isCancelled?.()) throw new RenderCancelledError();
  } catch (error) {
    if (error instanceof RenderCancelledError) throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AppError(`Remotion overlay rendering timed out after ${Math.round(ms / 60000)} minutes.`, {
        resolution: 'Close other heavy apps, lower REMOTION_CONCURRENCY, shorten the clip, or raise REMOTION_TIMEOUT_MINUTES.',
      })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizePngSequence(outputDir: string): string {
  const files = fs.readdirSync(outputDir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .map((file) => ({ file, index: Number(file.match(/(\d+)/)?.[1] ?? -1) }))
    .filter(({ index }) => Number.isFinite(index) && index >= 0)
    .sort((a, b) => a.index - b.index);
  if (files.length === 0) throw new Error(`Remotion produced no PNG frames in ${outputDir}`);

  // Rename in two phases to avoid a collision if the renderer already happens
  // to use the ov_00001.png pattern.
  const temporary = files.map(({ file }, index) => {
    const tempName = `__normalized_${String(index + 1).padStart(6, '0')}.png`;
    fs.renameSync(path.join(outputDir, file), path.join(outputDir, tempName));
    return tempName;
  });
  temporary.forEach((file, index) => {
    fs.renameSync(
      path.join(outputDir, file),
      path.join(outputDir, `ov_${String(index + 1).padStart(5, '0')}.png`)
    );
  });
  return path.join(outputDir, 'ov_%05d.png');
}

export async function prepareRemotionCaptionOverlays(
  options: PrepareRemotionOverlaysOptions
): Promise<PreparedCaptionOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(0.1, options.totalDuration);
  const durationInFrames = Math.max(1, Math.round(totalDuration * fps));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-remotion-'));
  const outputDir = path.join(workDir, 'frames');
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    checkCancelled(options.isCancelled);
    const { renderFrames, selectComposition } = await import('@remotion/renderer');
    const bundleDir = await withTimeout(getRemotionBundle(), getRenderTimeoutMs());
    const inputProps: CaptionOverlayCompositionProps = {
      hookText: maskProfanity(options.hookText),
      hookDuration: options.hookDuration,
      hookStart: Math.max(0, options.hookStart),
      hookTransitionDuration: options.hookTransitionDuration,
      ctaText: maskProfanity(options.ctaText),
      ctaDuration: options.ctaDuration,
      totalDuration,
      words: options.words.map((word) => ({ ...word, word: maskProfanity(word.word) })),
      preset: options.preset,
      hookStyle: options.hookStyle,
      ctaStyle: options.ctaStyle,
      captionLiftScale: options.captionLiftScale ?? 1,
    };

    const composition = await withTimeout(
      selectComposition({
        serveUrl: bundleDir,
        id: 'CaptionOverlayComposition',
        inputProps,
        logLevel: 'error',
      }),
      getRenderTimeoutMs()
    );
    checkCancelled(options.isCancelled);

    log.detail(
      `Remotion overlay frames: ${durationInFrames} frames @ ${fps}fps, ` +
      `${totalDuration.toFixed(2)}s (transparent PNG; no source-video encode)`
    );
    await withTimeout(
      renderFrames({
        composition: {
          ...composition,
          width: 1080,
          height: 1920,
          fps,
          durationInFrames,
        },
        serveUrl: bundleDir,
        inputProps,
        outputDir,
        imageFormat: 'png',
        concurrency: Number(process.env.REMOTION_CONCURRENCY?.trim()) || undefined,
        onStart: () => undefined,
        onFrameUpdate: (framesRendered) => {
          if (options.onProgress) {
            options.onProgress(Math.round((framesRendered / durationInFrames) * 100));
          }
        },
        logLevel: (process.env.REMOTION_LOG_LEVEL?.trim() as 'info' | 'verbose' | 'warn' | 'error') || 'info',
      }),
      getRenderTimeoutMs()
    );
    checkCancelled(options.isCancelled);

    const inputPattern = normalizePngSequence(outputDir);
    log.ok(`Remotion overlays ready: ${durationInFrames} transparent frames`);
    return {
      workDir,
      sequences: [{ name: 'remotion overlays', inputPattern, startAtSeconds: 0 }],
    };
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (error instanceof RenderCancelledError || error instanceof AppError) throw error;
    throw new AppError('Remotion overlay rendering failed.', {
      details: toErrorMessage(error),
      resolution: 'Inspect the Remotion log, confirm Chromium is available, and retry the render.',
    });
  }
}
