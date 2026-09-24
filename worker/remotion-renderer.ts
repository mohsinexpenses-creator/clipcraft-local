import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { getVideoMetadata } from '../lib/ffmpeg';
import { CaptionPreset, WordTimestamp } from '../lib/types';
import { normalizeFps } from './ffmpeg-pipeline';

export interface RenderCaptionsOptions {
  videoPath: string;
  outputPath: string;
  hookText: string;
  hookDuration: number;
  ctaText: string;
  ctaDuration: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  onProgress?: (progress: number) => void;
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

function getRemotionBundle(): Promise<string> {
  if (cachedBundlePromise) return cachedBundlePromise;

  cachedBundlePromise = (async () => {
    const { bundle } = await import('@remotion/bundler');
    const entryPoint = path.join(process.cwd(), 'remotion', 'index.tsx');

    console.log(`[Remotion Renderer] Bundling ${entryPoint} (first clip only)...`);
    const bundled = await bundle({ entryPoint });
    console.log(`[Remotion Renderer] Bundle ready: ${bundled}`);
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
  const { videoPath, outputPath, hookText, hookDuration, ctaText, ctaDuration, words, preset, onProgress } =
    options;

  console.log(`[Remotion Renderer] Rendering captions & overlays for ${videoPath}...`);
  if (onProgress) onProgress(82);

  if (!hookText.trim()) {
    throw new AppError('Caption rendering cannot start without hook text.', {
      status: 400,
      resolution: 'Generate hook text again or enter a non-empty hook text before rendering.',
    });
  }

  if (words.length === 0) {
    throw new AppError('Caption rendering cannot start without transcript words.', {
      status: 400,
      resolution: 'Re-run transcription or select a segment that overlaps spoken transcript text.',
    });
  }

  if (!ctaText.trim()) {
    throw new AppError('Caption rendering cannot start without CTA text.', {
      status: 400,
      resolution: 'Generate a CTA or enter one manually before rendering.',
    });
  }

  if (!fs.existsSync(videoPath)) {
    throw new AppError('The processed clip is missing, so captions cannot be rendered.', {
      status: 404,
      details: videoPath,
      resolution: 'Re-run the render - the FFmpeg stage did not leave a file behind.',
    });
  }

  try {
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    const meta = await getVideoMetadata(videoPath);
    const fps = normalizeFps(meta.fps);
    const durationInFrames = Math.max(1, Math.round(meta.duration * fps));

    console.log(
      `[Remotion Renderer] Source: ${meta.width}x${meta.height} @ ${meta.fps}fps, ${meta.duration.toFixed(2)}s, ` +
      `audio=${meta.hasAudio ? 'yes' : 'no'} -> rendering ${durationInFrames} frames @ ${fps}fps`
    );

    const bundled = await withTimeout(getRemotionBundle(), getRenderTimeoutMs(), 'bundle');

    /**
     * `videoSrc` is an ABSOLUTE FILE PATH, not a `file://` URL.
     *
     * The composition renders it with <OffthreadVideo>, which extracts frames with
     * ffmpeg outside the browser (and needs no CORS), so a plain path works. The old
     * code passed `file://${videoPath}` into a raw <video> tag: headless Chrome
     * refuses to load a file:// resource from an http:// origin, which is exactly the
     * "Not allowed to load local resource" error, and the rendered clip came out with
     * a black background and no video. On Windows `file://C:\...` was additionally a
     * malformed URL (the drive letter was parsed as the host).
     */
    const inputProps = {
      videoSrc: videoPath,
      videoHasAudio: meta.hasAudio,
      videoWidth: meta.width,
      videoHeight: meta.height,
      sourceFps: meta.fps,
      hookText,
      hookDuration,
      ctaText,
      ctaDuration,
      words,
      preset,
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

    await withTimeout(
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
        crf: 20,
        audioBitrate: '192k',
        /**
         * Without an audio *source* in the composition Remotion omits the audio track
         * entirely, which is why the previous renders were silent even though the
         * FFmpeg stage had produced AAC audio. <OffthreadVideo> now carries the audio,
         * and this flag guarantees a track exists either way.
         */
        enforceAudioTrack: true,
        ...(renderConcurrency ? { concurrency: renderConcurrency } : {}),
        logLevel:
          (process.env.REMOTION_LOG_LEVEL?.trim() as 'info' | 'verbose' | 'warn' | 'error') || 'info',
        onProgress: ({ progress }: { progress: number }) => {
          if (onProgress) onProgress(82 + Math.floor(progress * 0.16));
        },
      }),
      getRenderTimeoutMs(),
      'renderMedia'
    );

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
        resolution: 'The composition probably rendered empty frames - check videoSrc and the Remotion log.',
      });
    }

    // Sanity-check the finished file so "no video/no audio" can never silently ship again.
    const outputMeta = await getVideoMetadata(outputPath);
    if (!outputMeta.hasAudio) {
      console.warn(
        '[Remotion Renderer] WARNING: the rendered clip has no audio stream. ' +
        'Check that the processed clip has audio and that enforceAudioTrack is still set.'
      );
    }

    if (onProgress) onProgress(100);
    console.log(
      `[Remotion Renderer] Rendered ${outputMeta.width}x${outputMeta.height} @ ${outputMeta.fps}fps, ` +
      `${outputMeta.duration.toFixed(2)}s, audio=${outputMeta.hasAudio ? 'yes' : 'NO'}, ` +
      `${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB -> ${outputPath}`
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
    if (error instanceof AppError) throw error;

    throw new AppError('Remotion caption rendering failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the Remotion render log above, confirm videoSrc points at an existing processed clip, and retry.',
    });
  }
}
