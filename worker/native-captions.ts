/**
 * NATIVE caption engine: burn animated captions with FFmpeg instead of
 * rendering every frame through headless Chrome.
 *
 * Pipeline (all native except two tiny Remotion renders):
 *   1. worker/captions-ass.ts builds an .ass file (word karaoke fill, line
 *      pop/fade entrances, CTA lift) from the transcript words + preset.
 *   2. Hook text and CTA card are rendered by Remotion as SHORT transparent
 *      PNG sequences (no video in the composition -> ~165 frames, seconds).
 *   3. ONE FFmpeg pass: ass burn + overlay the two PNG sequences at the right
 *      timestamps + re-encode. ~real-time speed instead of ~30 min/clip.
 *
 * The Remotion engine (worker/remotion-renderer.ts) is kept side-by-side;
 * the user picks per clip in the UI (ClipRecord.captionEngine).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { normalizeFps } from './ffmpeg-pipeline';
import { color, log } from '../lib/logger';
import { CaptionPreset, WordTimestamp } from '../lib/types';
import { generateAssFile } from './captions-ass';
import { getRemotionBundle } from './remotion-renderer';

export interface RenderNativeCaptionsOptions {
  videoPath: string;
  outputPath: string;
  hookText: string;
  hookDuration: number;
  ctaText: string;
  ctaDuration: number;
  /** Seconds of the segment the hook intro was duplicated from (for ASS word shift). */
  hookStart: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  onProgress?: (progress: number) => void;
}

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

function renderOverlayFrames(opts: {
  bundleDir: string;
  compositionId: string;
  outputDir: string;
  fps: number;
  durationSeconds: number;
  inputProps: Record<string, unknown>;
  label: string;
}): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const { selectComposition, renderFrames } = await import('@remotion/renderer');
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
          durationInFrames: Math.max(1, Math.round(opts.durationSeconds * opts.fps)),
        },
        serveUrl: opts.bundleDir,
        inputProps: opts.inputProps,
        outputDir: opts.outputDir,
        imageFormat: 'png',
        onStart: () => undefined,
        onFrameUpdate: () => undefined,
        logLevel: 'error',
      });
    } catch (error) {
      reject(error);
      return;
    }
    // Remotion names frames frame_N.png (padding varies by version) - normalise
    // to a deterministic sequence ffmpeg can consume.
    try {
      const files = fs
        .readdirSync(opts.outputDir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, n: Number(f.match(/(\d+)/)?.[1] ?? -1) }))
        .filter((x) => Number.isFinite(x.n) && x.n >= 0)
        .sort((a, b) => a.n - b.n);
      if (files.length === 0) {
        throw new Error(`no PNG frames were produced in ${opts.outputDir}`);
      }
      files.forEach(({ f }, i) => {
        fs.renameSync(path.join(opts.outputDir, f), path.join(opts.outputDir, `ov_${String(i + 1).padStart(5, '0')}.png`));
      });
      log.detail(`${opts.label}: ${files.length} transparent frames rendered`);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
      return;
    }
    resolve();
  });
}

export interface FfmpegBuildInput {
  videoPath: string;
  outputPath: string;
  /** cwd for the process, so the ass filter gets a plain file name. */
  workDir: string;
  /** Plain file name (inside workDir) of the generated .ass. */
  assFile: string;
  fps: number;
  totalDuration: number;
  hookEnabled: boolean;
  hookDuration: number;
  ctaEnabled: boolean;
  ctaStart: number;
  hasAudio: boolean;
}

/**
 * Pure FFmpeg argument builder for the native pass (exported so it can be
 * tested without a Remotion bundle). Layout:
 *   input 0  = the processed clip (video + audio)
 *   input 1? = hook PNG sequence (plays at t=0)
 *   input N? = CTA PNG sequence (shifted onto the timeline via setpts)
 *   filter   = ass burn -> [overlay hook] -> [overlay CTA]
 */
export function buildFfmpegArgs(input: FfmpegBuildInput): string[] {
  const {
    videoPath, outputPath, workDir, assFile, fps, totalDuration,
    hookEnabled, hookDuration, ctaEnabled, ctaStart, hasAudio,
  } = input;

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  if (hookEnabled) {
    args.push('-framerate', String(fps), '-start_number', '1', '-i', path.join(workDir, 'hook', 'ov_%05d.png'));
  }
  const ctaInputIndex = hookEnabled ? 2 : 1;
  if (ctaEnabled) {
    args.push('-framerate', String(fps), '-start_number', '1', '-i', path.join(workDir, 'cta', 'ov_%05d.png'));
  }

  const filter: string[] = [`[0:v]ass=${assFile}[vbase]`];
  if (ctaEnabled) {
    // Shift the CTA sequence onto the main timeline (it plays at t=ctaStart).
    filter.push(`[${ctaInputIndex}:v]setpts=PTS+${ctaStart.toFixed(3)}/TB[vcta]`);
  }
  let lastLabel = 'vbase';
  if (hookEnabled) {
    const next = 'vhook';
    filter.push(`[${lastLabel}][1:v]overlay=0:0:enable='between(t,0,${hookDuration.toFixed(3)})'[${next}]`);
    lastLabel = next;
  }
  if (ctaEnabled) {
    const next = 'vout';
    filter.push(`[${lastLabel}][vcta]overlay=0:0:enable='between(t,${ctaStart.toFixed(3)},${totalDuration.toFixed(3)})'[${next}]`);
    lastLabel = next;
  }
  if (lastLabel !== 'vout') filter.push(`[${lastLabel}]null[vout]`);

  args.push('-filter_complex', filter.join(';'), '-map', '[vout]');
  if (hasAudio) args.push('-map', '0:a');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', outputPath);
  return args;
}

export interface RenderNativeCaptionsResult {
  outputPath: string;
  fps: number;
  width: number;
  height: number;
  durationSeconds: number;
  fileSizeBytes: number;
}

export async function renderNativeCaptions(options: RenderNativeCaptionsOptions): Promise<RenderNativeCaptionsResult> {
  const { videoPath, outputPath, hookText, hookDuration, hookStart, ctaText, ctaDuration, words, preset, onProgress } = options;

  log.detail(`Native captions (FFmpeg ASS) for ${color.bold(path.basename(videoPath))}`);
  if (onProgress) onProgress(82);

  if (words.length === 0) {
    throw new AppError('Caption rendering cannot start without transcript words.', {
      resolution: 'Re-run transcription or select a segment that overlaps spoken transcript text.',
    });
  }
  if (!fs.existsSync(videoPath)) {
    throw new AppError('The processed clip is missing, so captions cannot be rendered.', {
      status: 404,
      details: videoPath,
      resolution: 'Re-run the render - the FFmpeg stage did not leave a file behind.',
    });
  }

  const meta = await getVideoMetadata(videoPath);
  const fps = normalizeFps(meta.fps);
  const totalDuration = Math.max(0.1, meta.duration);
  const hookEnabled = hookDuration > 0 && hookText.trim().length > 0;
  const ctaEnabled = ctaDuration > 0 && ctaText.trim().length > 0;
  const ctaStart = Math.max(0, totalDuration - ctaDuration);

  const workDir = path.join(os.tmpdir(), 'clipcraft-native', path.basename(videoPath));
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. ASS file (plain file name - FFmpeg runs with cwd=workDir so the ass
    //    filter never has to escape Windows backslashes/colons).
    const assFile = 'captions.ass';
    fs.writeFileSync(path.join(workDir, assFile), generateAssFile({
      words,
      preset,
      totalDurationSeconds: totalDuration,
      hookDuration,
      hookStart: Math.max(0, Number(hookStart) || 0),
      ctaDuration,
    }), 'utf8');

    // 2. Transparent overlay sequences (only when the overlays are on).
    if (hookEnabled || ctaEnabled) {
      const bundleDir = await getRemotionBundle();
      if (hookEnabled) {
        await renderOverlayFrames({
          bundleDir,
          compositionId: 'HookOverlayComposition',
          outputDir: path.join(workDir, 'hook'),
          fps,
          durationSeconds: hookDuration,
          inputProps: { hookText, hookDuration },
          label: 'Hook overlay',
        });
      }
      if (ctaEnabled) {
        await renderOverlayFrames({
          bundleDir,
          compositionId: 'CtaOverlayComposition',
          outputDir: path.join(workDir, 'cta'),
          fps,
          durationSeconds: ctaDuration,
          inputProps: { ctaText, ctaDuration },
          label: 'CTA overlay',
        });
      }
      if (onProgress) onProgress(88);
    }

    // 3. Single native pass: captions + overlays + audio.
    const args = buildFfmpegArgs({
      videoPath,
      outputPath,
      workDir,
      assFile,
      fps,
      totalDuration,
      hookEnabled,
      hookDuration,
      ctaEnabled,
      ctaStart,
      hasAudio: meta.hasAudio,
    });

    log.detail(`Native burn: ${totalDuration.toFixed(1)}s, hook=${hookEnabled ? hookDuration + 's' : 'off'}, cta=${ctaEnabled ? ctaDuration + 's' : 'off'}`);
    await runFfmpeg(args, {
      label: 'native-captions',
      cwd: workDir,
      totalDurationSeconds: totalDuration,
      onProgress: ({ percent }) => {
        if (percent !== undefined && onProgress) onProgress(88 + Math.min(10, Math.round(percent / 10)));
      },
    });

    if (!fs.existsSync(outputPath)) {
      throw new AppError('FFmpeg reported success but no output file exists.', {
        details: outputPath,
        resolution: 'Retry the render - the native caption pass did not leave a file behind.',
      });
    }
    const fileSizeBytes = fs.statSync(outputPath).size;
    if (fileSizeBytes < 10 * 1024) {
      throw new AppError('FFmpeg produced an unusably small video file.', {
        details: `${outputPath} (${fileSizeBytes} bytes)`,
      });
    }

    if (onProgress) onProgress(98);
    const outMeta = await getVideoMetadata(outputPath);
    if (!outMeta.hasAudio) {
      log.warn('Rendered clip has no audio stream - check that the processed clip has audio.');
    }
    log.ok(
      `Native captions burned: ${outMeta.width}x${outMeta.height} @ ${outMeta.fps}fps, ` +
      `${outMeta.duration.toFixed(2)}s, ${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB`
    );

    return {
      outputPath,
      fps: outMeta.fps,
      width: outMeta.width,
      height: outMeta.height,
      durationSeconds: outMeta.duration,
      fileSizeBytes,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Native caption rendering failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the FFmpeg log above and retry. If the error mentions the "ass" filter, ' +
        'your FFmpeg build lacks libass - the Remotion caption engine still works as a fallback.',
    });
  } finally {
    // Always release the temp workdir (ass + png sequences).
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort.
    }
  }
}
