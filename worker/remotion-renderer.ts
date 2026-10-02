import fs from 'fs';
import path from 'path';
import { AppError, RenderCancelledError, toErrorMessage } from '../lib/errors';
import { getVideoMetadata, runFfmpeg } from '../lib/ffmpeg';
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from '../lib/types';
import {
  buildProfanityAudioFilter,
  buildProfanityWindows,
  getProfanityAudioMode,
  maskProfanity,
} from '../lib/profanity';
import { HOOK_TRANSITION_SECONDS, normalizeFps } from './ffmpeg-pipeline';
import { startClipMediaServer } from './clip-http-server';
import { color, log } from '../lib/logger';

export interface RenderCaptionsOptions {
  videoPath: string;
  outputPath: string;
  hookText: string;
  hookDuration: number;
  /** Where in the clip (seconds from clip start) the duplicated hook intro was cut from. */
  hookStart: number;
  ctaText: string;
  ctaDuration: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  /** Visual style of the hook intro overlay. */
  hookStyle: OverlayStylePreset;
  /** Visual style of the end-of-clip CTA overlay. */
  ctaStyle: OverlayStylePreset;
  onProgress?: (progress: number) => void;
  /** Poll for a user-requested cancel; the in-flight render is abandoned. */
  isCancelled?: () => boolean;
}

export interface RenderCaptionsResult {
  outputPath: string;
  fps: number;
  width: number;
  height: number;
  durationSeconds: number;
  fileSizeBytes: number;
}

const COMPOSITION_ID = 'CaptionComposition';

/**
 * bundle() takes ~20-60s and its result does not depend on the clip, so cache it
 * for the lifetime of the worker process. Previously every single clip re-bundled
 * the whole Remotion project.
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
    // Do not cache a failed bundle - let the next clip try again.
    cachedBundlePromise = null;
    throw error;
  });

  return cachedBundlePromise;
}

function getRenderConcurrency(): number | undefined {
  const raw = Number(process.env.REMOTION_CONCURRENCY?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return undefined; // let Remotion pick half the CPU threads
}

/**
 * Optional knobs for Remotion's offthread video cache/threads, exposed as env vars.
 *
 * "Compositor error: No frame found at position N" can also mean the offthread
 * video frame cache is too small for the clip (frames extracted are evicted
 * before they are consumed) - the Remotion docs name this as the most likely
 * cause. When unset, Remotion's defaults apply.
 */
function getOffthreadCacheBytes(): number | undefined {
  const raw = Number(process.env.OFFTHREAD_VIDEO_CACHE_MB?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw) * 1024 * 1024;
  return undefined;
}

function getOffthreadThreads(): number | undefined {
  const raw = Number(process.env.OFFTHREAD_VIDEO_THREADS?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return undefined;
}

function getRenderTimeoutMs(): number {
  const minutes = Number(process.env.REMOTION_TIMEOUT_MINUTES?.trim());
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  return 60 * 60_000; // 1 hour ceiling for a single short clip
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError(`Remotion ${label} timed out after ${Math.round(ms / 60000)} minutes.`, {
          resolution:
            'Close other heavy apps, lower REMOTION_CONCURRENCY, shorten the clip, or raise REMOTION_TIMEOUT_MINUTES.',
        })
      );
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function renderCaptionsAndOverlays(
  options: RenderCaptionsOptions
): Promise<RenderCaptionsResult> {
  const { videoPath, outputPath, hookText, hookDuration, hookStart, ctaText, ctaDuration, words, preset, hookStyle, ctaStyle, onProgress, isCancelled } =
    options;

  log.detail(`Captions & overlays for ${color.bold(path.basename(videoPath))}`);
  if (onProgress) onProgress(82);

  if (!hookText.trim()) {
    if (hookDuration > 0) {
      throw new AppError('Caption rendering cannot start without hook text.', {
        status: 400,
        resolution:
          'Enter a non-empty hook text, or set the hook duration to 0 to render the clip without a hook overlay.',
      });
    }
    // hookDuration 0 + empty text = the hook overlay is intentionally off.
    log.detail('Rendering without hook text (hook overlay disabled).');
  }

  if (words.length === 0) {
    throw new AppError('Caption rendering cannot start without transcript words.', {
      status: 400,
      resolution: 'Re-run transcription or select a segment that overlaps spoken transcript text.',
    });
  }

  if (!ctaText.trim()) {
    if (ctaDuration > 0) {
      throw new AppError('Caption rendering cannot start without CTA text.', {
        status: 400,
        resolution: 'Generate a CTA or enter one manually before rendering.',
      });
    }
    // ctaDuration 0 + empty text = the CTA card is intentionally off.
    log.detail('Rendering without CTA text (CTA overlay disabled).');
  }

  if (!fs.existsSync(videoPath)) {
    throw new AppError('The processed clip is missing, so captions cannot be rendered.', {
      status: 404,
      details: videoPath,
      resolution: 'Re-run the render - the FFmpeg stage did not leave a file behind.',
    });
  }

  // Headless Chrome (where Remotion renders the composition) cannot read the
  // filesystem, so the clip is served over a throwaway loopback HTTP server
  // for the duration of this render and passed to Remotion as an http URL.
  // See worker/clip-http-server.ts for the full reasoning.
  let mediaServer: Awaited<ReturnType<typeof startClipMediaServer>>;
  try {
    mediaServer = await startClipMediaServer(videoPath);
  } catch (error) {
    throw new AppError('Could not serve the processed clip to Remotion.', {
      status: 500,
      details: toErrorMessage(error),
      resolution: 'The clip file could not be opened for streaming - re-run the render.',
    });
  }

  try {
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    const meta = await getVideoMetadata(videoPath);
    const fps = normalizeFps(meta.fps);
    const durationInFrames = Math.max(1, Math.round(meta.duration * fps));

    log.detail(
      `Source: ${meta.width}x${meta.height} @ ${meta.fps}fps, ${meta.duration.toFixed(2)}s, ` +
      `audio=${meta.hasAudio ? 'yes' : 'no'} → rendering ${durationInFrames} frames @ ${fps}fps`
    );
    log.detail(`Serving clip to Remotion via ${mediaServer.url}`);

    const bundled = await withTimeout(getRemotionBundle(), getRenderTimeoutMs(), 'bundle');

    /**
     * `videoSrc` MUST be an http(s) URL - Remotion's asset downloader (and the
     * OffthreadVideo proxy) only accepts http(s)/data: sources.
     *
     * History: v1 passed `file://${videoPath}` into a raw <video> tag -> "Not
     * allowed to load local resource" + black frames. v2 passed the raw ABSOLUTE
     * PATH (a "fix" that seemed to work in some environments) -> on Windows the
     * path reaches the browser, where it is mangled into a bogus `d:\...` or
     * `file:///D:/...` URL, and the renderer dies with
     * "Can only download URLs starting with http:// or https://".
     * v3 (now): serve the clip from a throwaway 127.0.0.1 server and pass the
     * http URL. This is the approach Remotion's own docs recommend.
     */
    // On-screen profanity masking (captions + hook/CTA overlays). Only the
    // words handed to the renderer are masked - the stored transcript and the
    // worker log keep the original words, so re-renders never need a
    // re-transcription.
    const maskedWords: WordTimestamp[] = words.map((w) => ({
      ...w,
      word: maskProfanity(w.word),
    }));
    const maskedHookText = maskProfanity(hookText);
    const maskedCtaText = maskProfanity(ctaText);

    const inputProps = {
      videoSrc: mediaServer.url,
      videoHasAudio: meta.hasAudio,
      videoWidth: meta.width,
      videoHeight: meta.height,
      sourceFps: meta.fps,
      hookText: maskedHookText,
      hookDuration,
      // Dip-to-black window around the hook join: the composition blanks all
      // captions/overlays inside it (see CaptionComposition).
      hookTransitionDuration: HOOK_TRANSITION_SECONDS,
      hookStart: Math.max(0, Number(hookStart) || 0),
      ctaText: maskedCtaText,
      ctaDuration,
      words: maskedWords,
      preset,
      hookStyle,
      ctaStyle,
    };

    const composition = await withTimeout(
      selectComposition({
        serveUrl: bundled,
        id: COMPOSITION_ID,
        inputProps,
        logLevel: (process.env.REMOTION_LOG_LEVEL?.trim() as 'info' | 'verbose' | 'warn' | 'error') || 'info',
      }),
      getRenderTimeoutMs(),
      'selectComposition'
    );

    if (!composition) {
      throw new AppError('Remotion could not find the CaptionComposition.', {
        resolution: 'Verify remotion/index.tsx registers a composition with id "CaptionComposition".',
      });
    }

    const renderConcurrency = getRenderConcurrency();
    const offthreadCacheBytes = getOffthreadCacheBytes();
    const offthreadThreads = getOffthreadThreads();
    if (offthreadCacheBytes || offthreadThreads) {
      log.detail(
        `Offthread video cache=${offthreadCacheBytes ? (offthreadCacheBytes / 1024 / 1024).toFixed(0) + ' MB' : 'default'}, ` +
        `threads=${offthreadThreads ?? 'default'}`
      );
    }

    const renderJob = withTimeout(
      renderMedia({
        composition: {
          ...composition,
          // Authoritative: derived from the real processed clip, not a hard-coded 30fps.
          fps,
          durationInFrames,
          width: composition.width,
          height: composition.height,
        },
        serveUrl: bundled,
        inputProps,
        outputLocation: outputPath,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        // FINAL deliverable - keep in step with the native caption burn (CRF 18).
        crf: 18,
        audioBitrate: '192k',
        /**
         * Without an audio *source* in the composition Remotion omits the audio track
         * entirely, which is why the previous renders were silent even though the
         * FFmpeg stage had produced AAC audio. <OffthreadVideo> now carries the audio,
         * and this flag guarantees a track exists either way.
         */
        enforceAudioTrack: true,
        ...(renderConcurrency ? { concurrency: renderConcurrency } : {}),
        ...(offthreadCacheBytes ? { offthreadVideoCacheSizeInBytes: offthreadCacheBytes } : {}),
        ...(offthreadThreads ? { offthreadVideoThreads: offthreadThreads } : {}),
        logLevel:
          (process.env.REMOTION_LOG_LEVEL?.trim() as 'info' | 'verbose' | 'warn' | 'error') || 'info',
        onProgress: ({ progress }: { progress: number }) => {
          if (onProgress) onProgress(82 + Math.floor(progress * 0.16));
        },
      }),
      getRenderTimeoutMs(),
      'renderMedia'
    );

    // Cancellation: poll the flag while the browser renders; when the user
    // asks to stop, drop the partial file and reject - the in-flight render is
    // abandoned and its (ignored) result never settles anything.
    if (isCancelled) {
      renderJob.catch(() => undefined); // result handled by the race below
      const cancelRace = new Promise<never>((_, rejectCancel) => {
        const poll = setInterval(() => {
          let wantsCancel = false;
          try {
            wantsCancel = isCancelled() === true;
          } catch {
            wantsCancel = false;
          }
          if (!wantsCancel) return;
          clearInterval(poll);
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {
            // ignore
          }
          rejectCancel(new RenderCancelledError());
        }, 1000);
        void renderJob.then(
          () => clearInterval(poll),
          () => clearInterval(poll),
        );
      });
      await Promise.race([renderJob, cancelRace]);
    } else {
      await renderJob;
    }

    if (!fs.existsSync(outputPath)) {
      throw new AppError('Remotion reported success but no output file exists.', {
        details: outputPath,
        resolution: 'Check disk space and the Remotion log above, then retry the render.',
      });
    }

    const fileSizeBytes = fs.statSync(outputPath).size;
    if (fileSizeBytes < 10 * 1024) {
      throw new AppError('Remotion produced an unusably small video file.', {
        details: `${outputPath} (${fileSizeBytes} bytes)`,
        resolution: 'The composition probably rendered empty frames - check the Remotion log above.',
      });
    }

    // Sanity-check the finished file so "no video/no audio" can never silently ship again.
    const outputMeta = await getVideoMetadata(outputPath);
    if (!outputMeta.hasAudio) {
      log.warn('Rendered clip has no audio stream - check that the processed clip has audio and enforceAudioTrack is still set.');
    }

    // --- Profanity audio (PROFANITY_AUDIO_MODE: mute|beep|off) ---
    // Remotion already encoded the audio, so mute/beep is applied in a second
    // fast FFmpeg pass on the finished file: the video stream is COPIED
    // untouched, only the audio is re-encoded to AAC. Skipped entirely when
    // the transcript has no profane words in this clip.
    if (outputMeta.hasAudio) {
      const profanityMode = getProfanityAudioMode();
      const profanityWindows = buildProfanityWindows(
        words,
        Math.max(0, Number(hookStart) || 0),
        hookDuration,
        Math.max(0, meta.duration - hookDuration)
      );
      const audioPlan = buildProfanityAudioFilter(profanityWindows, profanityMode, outputMeta.duration, 1);
      if (audioPlan) {
        const passPath = `${outputPath}.profaudio.tmp.mp4`;
        log.detail(
          `Profanity audio: ${profanityMode} ${profanityWindows.length} window(s) - separate pass (video copied)`
        );
        try {
          const args = [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', outputPath,
            ...audioPlan.extraArgs,
            '-filter_complex', audioPlan.filters.join(';'),
            '-map', '0:v',
            '-map', audioPlan.audioLabel,
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            passPath,
          ];
          await runFfmpeg(args, { label: 'profanity-audio', isCancelled });
          if (!fs.existsSync(passPath)) {
            throw new AppError('The profanity audio pass finished without creating its output file.', {
              details: passPath,
              resolution: 'Inspect the FFmpeg log above and retry the render.',
            });
          }
          fs.rmSync(outputPath, { force: true });
          fs.renameSync(passPath, outputPath);
        } catch (error) {
          try { fs.rmSync(passPath, { force: true }); } catch { /* ignore */ }
          // A cancel is not a failure - let the processor persist the cancelled state.
          if (error instanceof RenderCancelledError) throw error;
          if (error instanceof AppError) throw error;
          throw new AppError('The profanity audio pass failed.', {
            details: toErrorMessage(error),
            resolution: 'Inspect the FFmpeg log above and retry the render.',
          });
        }
      }
    }

    if (onProgress) onProgress(100);
    log.ok(
      `Rendered ${outputMeta.width}x${outputMeta.height} @ ${outputMeta.fps}fps, ` +
      `${outputMeta.duration.toFixed(2)}s, audio=${outputMeta.hasAudio ? 'yes' : color.red('NO')}, ` +
      `${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB`
    );

    return {
      outputPath,
      fps: outputMeta.fps,
      width: outputMeta.width,
      height: outputMeta.height,
      durationSeconds: outputMeta.duration,
      fileSizeBytes,
    };
  } catch (error) {
    // A cancel is not a failure - the processor needs the raw error to persist
    // the "Cancelled by user" state (same contract as runFfmpeg's cancellation).
    if (error instanceof RenderCancelledError) throw error;
    if (error instanceof AppError) throw error;

    throw new AppError('Remotion caption rendering failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the Remotion render log above, confirm the processed clip exists, and retry. ' +
        'The clip is served to Remotion over a local HTTP server - if the error mentions ' +
        'downloading URLs, the render was aborted before the clip finished streaming.',
    });
  } finally {
    // Always release the port, even on timeout/error paths.
    await mediaServer.close();
  }
}
