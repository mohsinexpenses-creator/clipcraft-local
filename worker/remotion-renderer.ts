import fs from "fs";
import os from "os";
import path from "path";
import { AppError, RenderCancelledError, toErrorMessage } from "../lib/errors";
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from "../lib/types";
import { maskProfanity, maskTranscriptWords, maskTranscriptWordsFromIndexes } from "../lib/profanity";
import { log } from "../lib/logger";
import { CaptionOverlayCompositionProps } from "../remotion/OverlayCompositions";
import { OverlayFrameSequence } from "./ffmpeg-pipeline";
import { normalizeFps } from "./ffmpeg-pipeline";

export interface PreparedCaptionOverlays {
  workDir: string;
  sequences: OverlayFrameSequence[];
}

export interface PrepareRemotionOverlaysOptions {
  fps: number;
  hookText: string;
  hookDuration: number;
  hookStart: number;
  hookTransitionDuration: number;
  ctaText: string;
  ctaDuration: number;
  words: WordTimestamp[];
  /** Fully resolved static + optional context indexes, relative to `words`. */
  censoredWordIndexes?: number[];
  /** Compatibility input for callers that only have contextual indexes. */
  additionalCensoredWordIndexes?: number[];
  preset: CaptionPreset;
  hookStyle: OverlayStylePreset;
  ctaStyle: OverlayStylePreset;
  captionLiftScale?: number;
  onProgress?: (progress: number) => void;
  /** Final clip length (incl. hook). The merged layer is padded to this. */
  totalDuration?: number;
  isCancelled?: () => boolean;
  /** Shared worker job signal: cancels Remotion and its Chromium work immediately. */
  signal?: AbortSignal;
}

/**
 * bundle() is clip-independent, so cache it for the lifetime of the worker.
 * The worker now uses Remotion only to paint transparent overlay PNGs; FFmpeg
 * composites those with the source crop and produces the final video once.
 */
let cachedBundlePromise: Promise<string> | null = null;

function renderMemoryUsage(): string {
  const memory = process.memoryUsage();
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  return `rss=${mb(memory.rss)}MB heap=${mb(memory.heapUsed)}MB external=${mb(memory.external)}MB`;
}

async function timedRenderStage<T>(
  stage: string,
  operation: () => Promise<T>,
  details = "",
): Promise<T> {
  const startedAt = Date.now();
  log.info(
    `[RENDER-DIAG] stage=${stage} event=before ${details} ${renderMemoryUsage()}`.trim(),
  );
  try {
    const result = await operation();
    log.info(
      `[RENDER-DIAG] stage=${stage} event=after time_taken_ms=${Date.now() - startedAt} ${details} ${renderMemoryUsage()}`.trim(),
    );
    return result;
  } catch (error) {
    log.error(
      `[RENDER-DIAG] stage=${stage} event=failed time_taken_ms=${Date.now() - startedAt} error=${toErrorMessage(error)} ${details} ${renderMemoryUsage()}`.trim(),
    );
    throw error;
  }
}

function frameOutputStats(outputDir: string): {
  count: number;
  bytes: number;
  firstFrame: number | null;
  lastFrame: number | null;
} {
  const frames = fs
    .readdirSync(outputDir)
    .filter((file) => /\.(?:png|jpe?g)$/i.test(file))
    .map((file) => ({
      index: Number(file.match(/(\d+)(?=\.[^.]+$)/)?.[1] ?? Number.NaN),
      size: fs.statSync(path.join(outputDir, file)).size,
    }));
  const indices = frames
    .map(({ index }) => index)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: frames.length,
    bytes: frames.reduce((sum, frame) => sum + frame.size, 0),
    firstFrame: indices[0] ?? null,
    lastFrame: indices.at(-1) ?? null,
  };
}

export function getRemotionBundle(): Promise<string> {
  if (cachedBundlePromise) {
    log.info("[RENDER-DIAG] stage=remotion.bundle event=cache-hit");
    return cachedBundlePromise;
  }

  cachedBundlePromise = (async () => {
    const { bundle } = await timedRenderStage("remotion.bundler-import", () =>
      import("@remotion/bundler"),
    );
    const entryPoint = path.join(process.cwd(), "remotion", "index.tsx");

    log.detail("Bundling the Remotion project (first clip only)...");
    const bundled = await timedRenderStage(
      "remotion.bundle-build",
      () => bundle({ entryPoint }),
      `entry_point=${entryPoint}`,
    );
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
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : 60 * 60_000;
}

function checkCancelled(isCancelled?: () => boolean, signal?: AbortSignal): void {
  try {
    if (signal?.aborted || isCancelled?.()) throw new RenderCancelledError();
  } catch (error) {
    if (error instanceof RenderCancelledError) throw error;
  }
}

async function remotionCancelBridge(signal?: AbortSignal): Promise<{
  cancelSignal: import('@remotion/renderer').CancelSignal;
  dispose: () => void;
}> {
  const { makeCancelSignal } = await import('@remotion/renderer');
  const bridge = makeCancelSignal();
  const abort = () => bridge.cancel();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    cancelSignal: bridge.cancelSignal,
    dispose: () => signal?.removeEventListener('abort', abort),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage = "remotion.operation",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        log.error(
          `[RENDER-DIAG] stage=${stage} event=timeout timeout_ms=${ms} underlying_promise_cancelled=false ${renderMemoryUsage()}`,
        );
        reject(
          new AppError(
            `Remotion overlay rendering timed out after ${Math.round(ms / 60000)} minutes.`,
            {
              resolution:
                "Close other heavy apps, lower REMOTION_CONCURRENCY, shorten the clip, or raise REMOTION_TIMEOUT_MINUTES.",
            },
          ),
        );
      },
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeFrameSequence(
  outputDir: string,
  extension: "png" | "jpeg",
): string {
  const startedAt = Date.now();
  log.info(
    `[RENDER-DIAG] stage=remotion.frame-normalization event=before format=${extension} output_dir=${outputDir} ${renderMemoryUsage()}`,
  );
  const files = fs
    .readdirSync(outputDir)
    .filter((file) => file.toLowerCase().endsWith(`.${extension}`))
    .map((file) => ({ file, index: Number(file.match(/(\d+)/)?.[1] ?? -1) }))
    .filter(({ index }) => Number.isFinite(index) && index >= 0)
    .sort((a, b) => a.index - b.index);
  if (files.length === 0)
    throw new Error(`Remotion produced no ${extension.toUpperCase()} frames in ${outputDir}`);

  // Rename in two phases to avoid a collision if the renderer already happens
  // to use the ov_00001.png pattern.
  const temporary = files.map(({ file }, index) => {
    const tempName = `__normalized_${String(index + 1).padStart(6, "0")}.${extension}`;
    fs.renameSync(path.join(outputDir, file), path.join(outputDir, tempName));
    return tempName;
  });
  temporary.forEach((file, index) => {
    fs.renameSync(
      path.join(outputDir, file),
      path.join(outputDir, `ov_${String(index + 1).padStart(5, "0")}.${extension}`),
    );
  });
  const stats = frameOutputStats(outputDir);
  log.info(
    `[RENDER-DIAG] stage=remotion.frame-normalization event=after format=${extension} frame_range=${stats.firstFrame ?? "unknown"}-${stats.lastFrame ?? "unknown"} generated_frames=${stats.count} output_dir=${outputDir} total_file_size_bytes=${stats.bytes} time_taken_ms=${Date.now() - startedAt} ${renderMemoryUsage()}`,
  );
  return path.join(outputDir, `ov_%05d.${extension}`);
}

export async function prepareRemotionCaptionOverlays(
  options: PrepareRemotionOverlaysOptions,
): Promise<PreparedCaptionOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(0.1, options.totalDuration ?? 0.1);
  const durationInFrames = Math.max(1, Math.round(totalDuration * fps));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-remotion-"));
  const outputDir = path.join(workDir, "frames");
  fs.mkdirSync(outputDir, { recursive: true });
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;

  try {
    checkCancelled(options.isCancelled, options.signal);
    const { renderFrames, selectComposition } = await timedRenderStage(
      "remotion.renderer-import",
      () => import("@remotion/renderer"),
    );
    cancelBridge = await remotionCancelBridge(options.signal);
    const bundleDir = await timedRenderStage(
      "remotion.bundle-load",
      () => withTimeout(getRemotionBundle(), getRenderTimeoutMs(), "remotion.bundle-load"),
    );
    const inputProps: CaptionOverlayCompositionProps = {
      hookText: maskProfanity(options.hookText),
      hookDuration: options.hookDuration,
      hookStart: Math.max(0, options.hookStart),
      hookTransitionDuration: options.hookTransitionDuration,
      ctaText: maskProfanity(options.ctaText),
      ctaDuration: options.ctaDuration,
      totalDuration,
      words: options.censoredWordIndexes
        ? maskTranscriptWordsFromIndexes(options.words, options.censoredWordIndexes)
        : maskTranscriptWords(options.words, options.additionalCensoredWordIndexes ?? []),
      preset: options.preset,
      hookStyle: options.hookStyle,
      ctaStyle: options.ctaStyle,
      captionLiftScale: options.captionLiftScale ?? 1,
    };

    const composition = await timedRenderStage(
      "remotion.select-composition",
      () =>
        withTimeout(
          selectComposition({
            serveUrl: bundleDir,
            id: "CaptionOverlayComposition",
            inputProps,
            logLevel: "error",
          }),
          getRenderTimeoutMs(),
          "remotion.select-composition",
        ),
      `composition=CaptionOverlayComposition`,
    );
    checkCancelled(options.isCancelled, options.signal);

    log.detail(
      `Remotion overlay frames: ${durationInFrames} frames @ ${fps}fps, ` +
        `${totalDuration.toFixed(2)}s (transparent PNG; no source-video encode)`,
    );
    let lastLoggedFrames = 0;
    const renderStartedAt = Date.now();
    await timedRenderStage(
      "remotion.render-frames",
      () =>
        withTimeout(renderFrames({
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
        imageFormat: "png",
        cancelSignal: cancelBridge?.cancelSignal,
        concurrency:
          Number(process.env.REMOTION_CONCURRENCY?.trim()) || undefined,
        onStart: () =>
          log.info(
            `[RENDER-DIAG] stage=remotion.render-frames event=renderer-started image_format=png frame_range=0-${durationInFrames - 1} planned_frames=${durationInFrames} output_dir=${outputDir} ${renderMemoryUsage()}`,
          ),
        onFrameUpdate: (framesRendered) => {
          const progressInterval = Math.max(1, Math.ceil(durationInFrames / 10));
          if (
            framesRendered === durationInFrames ||
            framesRendered - lastLoggedFrames >= progressInterval
          ) {
            lastLoggedFrames = framesRendered;
            log.info(
              `[RENDER-DIAG] stage=remotion.render-frames event=frame-progress frames=${framesRendered}/${durationInFrames} elapsed_ms=${Date.now() - renderStartedAt} ${renderMemoryUsage()}`,
            );
          }
          if (options.onProgress) {
            options.onProgress(
              Math.round((framesRendered / durationInFrames) * 100),
            );
          }
        },
        logLevel:
          (process.env.REMOTION_LOG_LEVEL?.trim() as
            | "info"
            | "verbose"
            | "warn"
            | "error") || "info",
      }), getRenderTimeoutMs(), "remotion.render-frames"),
      `composition=CaptionOverlayComposition image_format=png frame_range=0-${durationInFrames - 1} planned_frames=${durationInFrames} output_dir=${outputDir}`,
    );
    checkCancelled(options.isCancelled, options.signal);

    const inputPattern = normalizeFrameSequence(outputDir, "png");
    cancelBridge?.dispose();
    cancelBridge = null;
    log.ok(`Remotion overlays ready: ${durationInFrames} transparent frames`);
    return {
      workDir,
      sequences: [
        { name: "remotion overlays", inputPattern, startAtSeconds: 0 },
      ],
    };
  } catch (error) {
    cancelBridge?.dispose();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof RenderCancelledError || error instanceof AppError)
      throw error;
    throw new AppError("Remotion overlay rendering failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the Remotion log, confirm Chromium is available, and retry the render.",
    });
  }
}

/* -------------------------------------------------------------------------- *
 * B-roll overlays
 * -------------------------------------------------------------------------- */

export interface PrepareBrollOverlaysOptions {
  fps: number;
  /** Items to paint, already scheduled on the FINAL (hook-inclusive) timeline. */
  items: Array<{
    id: string;
    kind: "fullscreen" | "landscape";
    start: number;
    end: number;
    imageUrl: string;
    card?: { x: number; y: number; width: number; height: number };
  }>;
  captionTextColor?: string;
  captionBand?: { top: number; bottom: number };
  onProgress?: (progress: number) => void;
  /** Final clip length (incl. hook). The merged B-roll layer is padded to this. */
  totalDuration?: number;
  isCancelled?: () => boolean;
  /** Shared worker job signal: cancels Remotion and closes Chromium. */
  signal?: AbortSignal;
}

export interface PreparedBrollOverlays {
  workDir: string;
  sequences: OverlayFrameSequence[];
}

/**
 * Paint all scheduled B-roll items together as one transparent timeline sequence.
 * FFmpeg composites that single layer before captions, avoiding a long chain of
 * independent image-sequence overlays.
 */
export async function prepareRemotionBrollOverlays(
  options: PrepareBrollOverlaysOptions,
): Promise<PreparedBrollOverlays> {
  const fps = normalizeFps(options.fps);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-broll-"));
  let browser: Awaited<
    ReturnType<typeof import("@remotion/renderer").openBrowser>
  > | null = null;
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;

  try {
    const { renderFrames, selectComposition, openBrowser } =
      await timedRenderStage("remotion.renderer-import", () =>
        import("@remotion/renderer"),
      );
    cancelBridge = await remotionCancelBridge(options.signal);
    const bundleDir = await timedRenderStage(
      "remotion.bundle-load",
      () => withTimeout(getRemotionBundle(), getRenderTimeoutMs(), "remotion.bundle-load"),
    );
    browser = await timedRenderStage(
      "chromium.browser-initialization",
      () => openBrowser("chrome", {}),
      "browser=chrome",
    );
    const activeBrowser = browser;

    checkCancelled(options.isCancelled, options.signal);
    const totalDuration = Math.max(
      0.1,
      options.totalDuration ?? Math.max(...options.items.map((item) => item.end)),
    );
    const durationInFrames = Math.max(1, Math.ceil(totalDuration * fps));
    const outputDir = path.join(workDir, "frames");
    fs.mkdirSync(outputDir, { recursive: true });
    const inputProps = {
      items: options.items,
      captionTextColor: options.captionTextColor,
      captionBand: options.captionBand,
    };
    const composition = await timedRenderStage(
      "remotion.select-composition",
      () =>
        withTimeout(
          selectComposition({
            serveUrl: bundleDir,
            id: "BrollTimelineComposition",
            inputProps,
            logLevel: "error",
          }),
          getRenderTimeoutMs(),
          "remotion.select-composition",
        ),
      `composition=BrollTimelineComposition items=${options.items.length} frame_range=0-${durationInFrames - 1}`,
    );
    checkCancelled(options.isCancelled, options.signal);

    log.info(
      `[RENDER-DIAG] stage=broll.phase-model event=active render_api=renderFrames renderRange=absent phase=combined-timeline image_format=png separate_enter_hold_exit=false fps=${fps} frame_range=0-${durationInFrames - 1} planned_frames=${durationInFrames} output_dir=${outputDir}`,
    );
    const itemPhaseRanges = options.items.map((item) => {
      const startFrame = Math.max(0, Math.round(item.start * fps));
      const itemFrames = Math.max(1, Math.round((item.end - item.start) * fps));
      return {
        item,
        startFrame,
        endFrame: startFrame + itemFrames - 1,
        frameCount: itemFrames,
      };
    });
    for (const phase of itemPhaseRanges) {
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=before item_id=${phase.item.id} type=${phase.item.kind} phase=combined-timeline image_format=png canvas=1080x1920 frame_range=${phase.startFrame}-${phase.endFrame} generated_frames=pending output_directory=${outputDir} total_generated_file_size_bytes=pending time_taken_ms=pending ${renderMemoryUsage()}`,
      );
    }
    let lastLoggedFrames = 0;
    const renderStartedAt = Date.now();
    await timedRenderStage(
      "broll.render-frames",
      () =>
        withTimeout(renderFrames({
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
        imageFormat: "png",
        cancelSignal: cancelBridge?.cancelSignal,
        puppeteerInstance: activeBrowser,
        concurrency:
          Number(process.env.REMOTION_CONCURRENCY?.trim()) || undefined,
        onStart: () =>
          log.info(
            `[RENDER-DIAG] stage=broll.render-frames event=renderer-started image_format=png canvas=1080x1920 frame_range=0-${durationInFrames - 1} planned_frames=${durationInFrames} output_dir=${outputDir} ${renderMemoryUsage()}`,
          ),
        onFrameUpdate: (framesRendered) => {
          const progressInterval = Math.max(1, Math.ceil(durationInFrames / 10));
          if (
            framesRendered === durationInFrames ||
            framesRendered - lastLoggedFrames >= progressInterval
          ) {
            lastLoggedFrames = framesRendered;
            log.info(
              `[RENDER-DIAG] stage=broll.render-frames event=frame-progress frames=${framesRendered}/${durationInFrames} elapsed_ms=${Date.now() - renderStartedAt} ${renderMemoryUsage()}`,
            );
          }
          if (options.onProgress) {
            options.onProgress(
              Math.round((framesRendered / durationInFrames) * 100),
            );
          }
        },
        logLevel:
          (process.env.REMOTION_LOG_LEVEL?.trim() as
            | "info"
            | "verbose"
            | "warn"
            | "error") || "info",
      }), getRenderTimeoutMs(), "broll.render-frames"),
      `composition=BrollTimelineComposition image_format=png frame_range=0-${durationInFrames - 1} planned_frames=${durationInFrames} items=${options.items.length} output_dir=${outputDir}`,
    );
    checkCancelled(options.isCancelled, options.signal);

    const renderTimeMs = Date.now() - renderStartedAt;
    const generatedStats = frameOutputStats(outputDir);
    for (const phase of itemPhaseRanges) {
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=after item_id=${phase.item.id} type=${phase.item.kind} phase=combined-timeline image_format=png canvas=1080x1920 frame_range=${phase.startFrame}-${phase.endFrame} generated_frames=${phase.frameCount} output_directory=${outputDir} shared_timeline_generated_frames=${generatedStats.count} total_generated_file_size_bytes=${generatedStats.bytes} time_taken_ms=${renderTimeMs} ${renderMemoryUsage()}`,
      );
    }

    const normalizationStartedAt = Date.now();
    const inputPattern = normalizeFrameSequence(outputDir, "png");
    const normalizationStats = frameOutputStats(outputDir);
    for (const phase of itemPhaseRanges) {
      log.info(
        `[RENDER-DIAG] stage=broll.frame-normalization event=after item_id=${phase.item.id} type=${phase.item.kind} phase=frame-normalization image_format=png canvas=1080x1920 frame_range=${phase.startFrame}-${phase.endFrame} generated_frames=${phase.frameCount} output_directory=${outputDir} shared_timeline_generated_frames=${normalizationStats.count} total_generated_file_size_bytes=${normalizationStats.bytes} time_taken_ms=${Date.now() - normalizationStartedAt} ${renderMemoryUsage()}`,
      );
    }

    const sequences: OverlayFrameSequence[] = [
      {
        name: "b-roll timeline",
        inputPattern,
        startAtSeconds: 0,
      },
    ];

    log.ok(
      `Remotion B-roll ready: ${options.items.length} item(s) in one timeline layer`,
    );
    cancelBridge?.dispose();
    cancelBridge = null;
    return { workDir, sequences };
  } catch (error) {
    cancelBridge?.dispose();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof RenderCancelledError || error instanceof AppError)
      throw error;
    throw new AppError("Remotion B-roll rendering failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the Remotion log, confirm Chromium is available, and retry the render.",
    });
  } finally {
    if (browser) {
      const closeStartedAt = Date.now();
      log.info(
        `[RENDER-DIAG] stage=chromium.browser-close event=before ${renderMemoryUsage()}`,
      );
      try {
        await browser.close({ silent: true });
        log.info(
          `[RENDER-DIAG] stage=chromium.browser-close event=after time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
      } catch {
        log.warn(
          `[RENDER-DIAG] stage=chromium.browser-close event=failed time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
        /* the render already finished or failed */
      }
    }
  }
}
