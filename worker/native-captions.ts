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
import {
  ProfanityAudioMode,
  buildProfanityAudioFilter,
  buildProfanityWindows,
  getProfanityAudioMode,
  maskProfanity,
} from '../lib/profanity';
import { HOOK_TRANSITION_SECONDS, ffmpegFpsArg, normalizeFps } from './ffmpeg-pipeline';
import { color, log } from '../lib/logger';
import { OverlayStylePreset, CaptionPreset, WordTimestamp } from '../lib/types';
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
  /** Overlay STYLE presets (font/colors/card/animation) for the hook/CTA cards. */
  hookStyle?: OverlayStylePreset;
  ctaStyle?: OverlayStylePreset;
  /** 1 = lift the captions while the CTA shows (default); 0 = they stay put (split screen). */
  captionLiftScale?: number;
  onProgress?: (progress: number) => void;
  /** Poll for a user-requested cancel; the running FFmpeg child is killed. */
  isCancelled?: () => boolean;
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
  /** When the hook overlay stops (end of the dip-to-black window). */
  hookOverlayEnd: number;
  ctaEnabled: boolean;
  ctaStart: number;
  hasAudio: boolean;
  /** Final-timeline [start, end) windows where a profane word is spoken. */
  profanityWindows: [number, number][];
  /** How those windows are treated in the audio (mute/beep/off). */
  profanityMode: ProfanityAudioMode;
}

/**
 * Pure FFmpeg argument builder for the native pass (exported so it can be
 * tested without a Remotion bundle). Layout:
 *   input 0  = the processed clip (video + audio)
 *   input 1? = hook PNG sequence (plays at t=0)
 *   input N? = CTA PNG sequence (shifted onto the timeline via setpts)
 *   input ?  = 1 kHz tone (beep mode only, supplied by the profanity filter)
 *   filter   = ass burn -> [overlay hook] -> [overlay CTA]
 *              + profanity mute/beep on the audio (PROFANITY_AUDIO_MODE)
 */
export function buildFfmpegArgs(input: FfmpegBuildInput): string[] {
  const {
    videoPath, outputPath, workDir, assFile, fps, totalDuration,
    hookEnabled, hookOverlayEnd, ctaEnabled, ctaStart, hasAudio,
    profanityWindows, profanityMode,
  } = input;

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  if (hookEnabled) {
    args.push('-framerate', ffmpegFpsArg(fps), '-start_number', '1', '-i', path.join(workDir, 'hook', 'ov_%05d.png'));
  }
  const ctaInputIndex = hookEnabled ? 2 : 1;
  if (ctaEnabled) {
    args.push('-framerate', ffmpegFpsArg(fps), '-start_number', '1', '-i', path.join(workDir, 'cta', 'ov_%05d.png'));
  }

  // Profanity audio (mute/beep) - the 1 kHz tone (beep mode) becomes the LAST
  // input, after the video and the optional PNG sequences.
  const audioPlan = hasAudio
    ? buildProfanityAudioFilter(
        profanityWindows,
        profanityMode,
        totalDuration,
        (hookEnabled ? 1 : 0) + (ctaEnabled ? 1 : 0) + 1
      )
    : null;
  if (audioPlan && audioPlan.extraArgs.length > 0) args.push(...audioPlan.extraArgs);

  const filter: string[] = [`[0:v]ass=${assFile}[vbase]`];
  if (ctaEnabled) {
    // Shift the CTA sequence onto the main timeline (it plays at t=ctaStart).
    filter.push(`[${ctaInputIndex}:v]setpts=PTS+${ctaStart.toFixed(3)}/TB[vcta]`);
  }
  let lastLabel = 'vbase';
  if (hookEnabled) {
    const next = 'vhook';
    // The hook card stops at the dip-to-black window - no overlay text on the
    // black (the PNG sequence itself is only hookOverlayEnd long).
    filter.push(
      `[${lastLabel}][1:v]overlay=0:0:enable='between(t,0,${hookOverlayEnd.toFixed(3)})'[${next}]`
    );
    lastLabel = next;
  }
  if (ctaEnabled) {
    const next = 'vout';
    filter.push(`[${lastLabel}][vcta]overlay=0:0:enable='between(t,${ctaStart.toFixed(3)},${totalDuration.toFixed(3)})'[${next}]`);
    lastLabel = next;
  }
  if (lastLabel !== 'vout') filter.push(`[${lastLabel}]null[vout]`);
  if (audioPlan) filter.push(...audioPlan.filters);

  args.push('-filter_complex', filter.join(';'), '-map', '[vout]');
  if (hasAudio) args.push('-map', audioPlan ? audioPlan.audioLabel : '0:a');
  // FINAL deliverable: CRF 18 (visually lossless for most content; CRF 20 left
  // visible softening once the footage had been through three encodes).
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
  // Audio: re-encoded only when something has to be muted/bleeped. Otherwise the
  // processed clip's AAC is COPIED, so the sound goes through this pass untouched
  // (one less lossy generation).
  if (hasAudio) args.push(...(audioPlan ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']));
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
  const { videoPath, outputPath, hookText, hookDuration, hookStart, ctaText, ctaDuration, words, preset, hookStyle, ctaStyle, captionLiftScale, onProgress, isCancelled } = options;

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

  // The dip-to-black transition around the hook join: the hook card stops at
  // its start, and the ASS file blanks captions across the whole window.
  const transitionDur =
    hookDuration > 0
      ? Math.max(0, Math.min(HOOK_TRANSITION_SECONDS, hookDuration / 2))
      : 0;
  const hookOverlayEnd = Math.max(0, hookDuration - transitionDur);

  // On-screen profanity masking for the overlay PNGs (captions are masked in
  // generateAssFile). The stored transcript and logs keep the original words.
  const maskedHookText = maskProfanity(hookText);
  const maskedCtaText = maskProfanity(ctaText);

  const hookEnabled = hookDuration > 0 && hookText.trim().length > 0 && hookOverlayEnd > 0.05;
  const ctaEnabled = ctaDuration > 0 && ctaText.trim().length > 0;
  const ctaStart = Math.max(0, totalDuration - ctaDuration);

  // Profane AUDIO windows (PROFANITY_AUDIO_MODE: mute|beep|off). The transcript
  // words are on the base timeline; buildProfanityWindows shifts them onto the
  // final clip timeline (hook intro + base) and also covers the words that
  // replay during the duplicated hook intro.
  const profanityMode = getProfanityAudioMode();
  const profanityWindows = buildProfanityWindows(
    words,
    Math.max(0, Number(hookStart) || 0),
    hookDuration,
    Math.max(0, totalDuration - hookDuration)
  );
  if (profanityWindows.length > 0) {
    log.detail(
      `Profanity audio: ${profanityMode} ${profanityWindows.length} window(s) ` +
      `[${profanityWindows.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}s`).join(', ')}]`
    );
  }

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
      hookTransitionDuration: transitionDur,
      captionLiftScale,
    }), 'utf8');

    // 2. Transparent overlay sequences (only when the overlays are on).
    if (hookEnabled || ctaEnabled) {
      const bundleDir = await getRemotionBundle();
      if (hookEnabled) {
        // The sequence only covers 0..hookOverlayEnd (it stops at the
        // dip-to-black window, so no hook text sits on the black).
        await renderOverlayFrames({
          bundleDir,
          compositionId: 'HookOverlayComposition',
          outputDir: path.join(workDir, 'hook'),
          fps,
          durationSeconds: hookOverlayEnd,
          inputProps: { hookText: maskedHookText, hookDuration: hookOverlayEnd, hookStyle },
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
          inputProps: { ctaText: maskedCtaText, ctaDuration, ctaStyle },
          label: 'CTA overlay',
        });
      }
      if (onProgress) onProgress(88);
    }

    // 3. Single native pass: captions + overlays + audio (+ profanity mute/beep).
    const args = buildFfmpegArgs({
      videoPath,
      outputPath,
      workDir,
      assFile,
      fps,
      totalDuration,
      hookEnabled,
      hookDuration,
      hookOverlayEnd,
      ctaEnabled,
      ctaStart,
      hasAudio: meta.hasAudio,
      profanityWindows,
      profanityMode,
    });

    log.detail(`Native burn: ${totalDuration.toFixed(1)}s, hook=${hookEnabled ? hookDuration + 's' : 'off'}, cta=${ctaEnabled ? ctaDuration + 's' : 'off'}`);
    await runFfmpeg(args, {
      label: 'native-captions',
      cwd: workDir,
      totalDurationSeconds: totalDuration,
      isCancelled,
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
