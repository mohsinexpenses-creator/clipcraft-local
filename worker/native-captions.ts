import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppError, RenderCancelledError, toErrorMessage } from '../lib/errors';
import { maskProfanity } from '../lib/profanity';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
import { HOOK_TRANSITION_SECONDS, normalizeFps } from './ffmpeg-pipeline';
import { color, log } from '../lib/logger';
import { getRemotionBundle, type PreparedCaptionOverlays } from './remotion-renderer';
import { generateAssFile } from './captions-ass';

export interface PrepareNativeOverlaysOptions {
  fps: number;
  totalDuration: number;
  hookText: string;
  hookDuration: number;
  /** Seconds of the segment the hook intro was duplicated from. */
  hookStart: number;
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

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
/** File name of the ASS burned by processVideoSegment (relative to workDir). */
export const NATIVE_ASS_FILE = 'captions.ass';

function checkCancelled(isCancelled?: () => boolean): void {
  try {
    if (isCancelled?.()) throw new RenderCancelledError();
  } catch (error) {
    if (error instanceof RenderCancelledError) throw error;
  }
}

function normalizePngSequence(outputDir: string): string {
  const files = fs.readdirSync(outputDir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .map((file) => ({ file, index: Number(file.match(/(\d+)/)?.[1] ?? -1) }))
    .filter(({ index }) => Number.isFinite(index) && index >= 0)
    .sort((a, b) => a.index - b.index);
  if (files.length === 0) throw new Error(`no PNG frames were produced in ${outputDir}`);

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

async function renderRemotionFrames(opts: {
  bundleDir: string;
  compositionId: string;
  outputDir: string;
  fps: number;
  durationSeconds: number;
  inputProps: Record<string, unknown>;
  label: string;
  onProgress?: (progress: number) => void;
}): Promise<string> {
  const { selectComposition, renderFrames } = await import('@remotion/renderer');
  const durationInFrames = Math.max(1, Math.round(opts.durationSeconds * opts.fps));
  const composition = await selectComposition({
    serveUrl: opts.bundleDir,
    id: opts.compositionId,
    inputProps: opts.inputProps,
    logLevel: 'error',
  });
  await renderFrames({
    composition: {
      ...composition,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fps: opts.fps,
      durationInFrames,
    },
    serveUrl: opts.bundleDir,
    inputProps: opts.inputProps,
    outputDir: opts.outputDir,
    imageFormat: 'png',
    onStart: () => undefined,
    onFrameUpdate: (framesRendered) => {
      if (opts.onProgress) opts.onProgress(Math.round((framesRendered / durationInFrames) * 100));
    },
    logLevel: 'error',
  });
  const pattern = normalizePngSequence(opts.outputDir);
  log.detail(`${opts.label}: ${durationInFrames} transparent frames rendered`);
  return pattern;
}

/**
 * Fast caption-engine overlay preparation.
 *
 * Captions are NOT rasterized to PNGs here: libass in current FFmpeg builds
 * cannot produce transparent subtitle frames (the `color=c=black@0.0` canvas
 * comes out OPAQUE - the source silently drops the `@0.0` alpha - and the ass
 * filter never raises the alpha channel of the frame it renders onto), which
 * used to cover the whole clip in a black screen. Instead the ASS file is
 * handed to `processVideoSegment`, which burns it straight onto the opaque
 * video in the final encode - same one-pass output, zero transparency
 * pitfalls, and one fewer rasterize/encode/decode round trip.
 *
 * Hook/CTA cards keep the Remotion PNG route (Chrome paints true-alpha frames).
 */
export async function prepareNativeCaptionOverlays(
  options: PrepareNativeOverlaysOptions
): Promise<PreparedCaptionOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(0.1, options.totalDuration);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-native-'));

  try {
    checkCancelled(options.isCancelled);
    if (options.words.length === 0) {
      throw new AppError('Caption overlay rendering cannot start without transcript words.', {
        resolution: 'Re-run transcription or select a segment that overlaps transcript text.',
      });
    }

    const transitionDuration = options.hookDuration > 0
      ? Math.max(0, Math.min(HOOK_TRANSITION_SECONDS, options.hookDuration / 2))
      : 0;
    const hookOverlayEnd = Math.max(0, options.hookDuration - transitionDuration);
    const ctaStart = Math.max(0, totalDuration - options.ctaDuration);
    fs.writeFileSync(path.join(workDir, NATIVE_ASS_FILE), generateAssFile({
      words: options.words,
      preset: options.preset,
      totalDurationSeconds: totalDuration,
      hookDuration: options.hookDuration,
      hookStart: Math.max(0, options.hookStart),
      ctaDuration: options.ctaDuration,
      hookTransitionDuration: transitionDuration,
      captionLiftScale: options.captionLiftScale,
    }), 'utf8');
    log.detail(`Native captions: ASS burned directly onto the video (${color.bold(NATIVE_ASS_FILE)})`);

    const sequences: PreparedCaptionOverlays['sequences'] = [];
    const hookEnabled = options.hookDuration > 0 && options.hookText.trim().length > 0 && hookOverlayEnd > 0.05;
    const ctaEnabled = options.ctaDuration > 0 && options.ctaText.trim().length > 0;

    if (hookEnabled || ctaEnabled) {
      const bundleDir = await getRemotionBundle();
      if (hookEnabled) {
        const hookDir = path.join(workDir, 'hook');
        fs.mkdirSync(hookDir, { recursive: true });
        const inputPattern = await renderRemotionFrames({
          bundleDir,
          compositionId: 'HookOverlayComposition',
          outputDir: hookDir,
          fps,
          durationSeconds: hookOverlayEnd,
          inputProps: {
            hookText: maskProfanity(options.hookText),
            hookDuration: hookOverlayEnd,
            hookStyle: options.hookStyle,
          },
          label: 'Hook overlay',
          onProgress: options.onProgress,
        });
        sequences.push({ name: 'hook', inputPattern, startAtSeconds: 0 });
      }
      if (ctaEnabled) {
        const ctaDir = path.join(workDir, 'cta');
        fs.mkdirSync(ctaDir, { recursive: true });
        const inputPattern = await renderRemotionFrames({
          bundleDir,
          compositionId: 'CtaOverlayComposition',
          outputDir: ctaDir,
          fps,
          durationSeconds: options.ctaDuration,
          inputProps: {
            ctaText: maskProfanity(options.ctaText),
            ctaDuration: options.ctaDuration,
            ctaStyle: options.ctaStyle,
          },
          label: 'CTA overlay',
          onProgress: options.onProgress,
        });
        sequences.push({ name: 'CTA', inputPattern, startAtSeconds: ctaStart });
      }
    }

    checkCancelled(options.isCancelled);
    if (options.onProgress) options.onProgress(100);
    return { workDir, sequences, assFile: NATIVE_ASS_FILE };
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (error instanceof RenderCancelledError || error instanceof AppError) throw error;
    throw new AppError('Native caption overlay rendering failed.', {
      details: toErrorMessage(error),
      resolution: 'Inspect the Remotion log above, confirm the hook/CTA overlay bundle builds, and retry.',
    });
  }
}
