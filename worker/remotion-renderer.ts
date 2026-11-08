import fs from "fs";
import os from "os";
import path from "path";
import { AppError, RenderCancelledError, toErrorMessage } from "../lib/errors";
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from "../lib/types";
import { maskProfanity, maskTranscriptWords, maskTranscriptWordsFromIndexes } from "../lib/profanity";
import { log } from "../lib/logger";
import { CaptionOverlayCompositionProps } from "../remotion/OverlayCompositions";
import { buildFinalCaptionChunks } from "../remotion/CaptionComposition";
import {
  CAPTION_HOLD_AFTER_SECONDS,
  CAPTION_LOOKAHEAD_SECONDS,
  getCaptionChunkWordLimit,
} from "../lib/caption-layout";
import { OverlayFrameSequence } from "./ffmpeg-pipeline";
import { normalizeFps } from "./ffmpeg-pipeline";
import {
  getCaptionActiveRangeRenderingEnabled,
  getRemotionConcurrency,
} from "./remotion-options";

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

/** A contiguous final-timeline interval whose transparent caption frames are needed. */
export interface CaptionActiveFrameRange {
  startFrame: number;
  endFrame: number;
  frameCount: number;
  startAtSeconds: number;
}

/**
 * Locate every frame that can contain a caption, hook, or CTA. The composition
 * still renders against its complete clock, so animations and word timing stay
 * bit-for-bit aligned with the legacy full-timeline renderer; only transparent
 * idle spans are omitted and rebased by FFmpeg like B-roll active ranges.
 */
export function calculateCaptionActiveFrameRanges(
  input: Pick<
    CaptionOverlayCompositionProps,
    | "hookText"
    | "hookDuration"
    | "hookStart"
    | "hookTransitionDuration"
    | "ctaText"
    | "ctaDuration"
    | "words"
    | "preset"
  >,
  fpsInput: number,
  totalDurationInput: number,
): CaptionActiveFrameRange[] {
  const fps = normalizeFps(fpsInput);
  const totalDuration = Math.max(0.1, totalDurationInput);
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));
  const intervals: Array<{ start: number; end: number }> = [];
  const add = (start: number, end: number): void => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const clippedStart = Math.max(0, Math.min(totalDuration, start));
    const clippedEnd = Math.max(0, Math.min(totalDuration, end));
    if (clippedEnd >= clippedStart) intervals.push({ start: clippedStart, end: clippedEnd });
  };

  const transition = input.hookDuration > 0
    ? Math.max(0, Math.min(input.hookTransitionDuration, input.hookDuration / 2))
    : 0;
  const transitionStart = input.hookDuration - transition;
  const transitionEnd = input.hookDuration + transition;
  const chunks = buildFinalCaptionChunks(
    input.words,
    input.hookStart,
    input.hookDuration,
    getCaptionChunkWordLimit(input.preset),
  ).filter((chunk) =>
    transition <= 0 || chunk.end <= transitionStart || chunk.start >= transitionEnd,
  );
  for (const chunk of chunks) {
    add(
      chunk.start - CAPTION_LOOKAHEAD_SECONDS,
      chunk.end + CAPTION_HOLD_AFTER_SECONDS,
    );
  }

  const hookVisibleDuration = Math.max(0, input.hookDuration - transition);
  if (hookVisibleDuration > 0.05 && input.hookText.trim()) {
    add(0, hookVisibleDuration);
  }
  if (input.ctaDuration > 0 && input.ctaText.trim()) {
    add(totalDuration - input.ctaDuration, totalDuration);
  }

  const frameIntervals = intervals
    .map(({ start, end }) => ({
      // Conservative floor/ceil bounds can render a harmless transparent edge
      // frame but can never omit a visible fractional-frame animation.
      startFrame: Math.max(0, Math.min(totalFrames - 1, Math.floor(start * fps))),
      endFrame: Math.max(0, Math.min(totalFrames - 1, Math.ceil(end * fps))),
    }))
    .filter((range) => range.endFrame >= range.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged: Array<{ startFrame: number; endFrame: number }> = [];
  for (const range of frameIntervals) {
    const previous = merged.at(-1);
    if (previous && range.startFrame <= previous.endFrame + 1) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((range) => ({
    ...range,
    frameCount: range.endFrame - range.startFrame + 1,
    startAtSeconds: range.startFrame / fps,
  }));
}

/**
 * Sparse ranges pay an extra renderFrames setup cost. Keep full rendering for
 * dense speech or a fragmented timeline; opt-in saves work only when it should.
 */
export function shouldUseCaptionActiveFrameRanges(
  enabled: boolean,
  ranges: readonly CaptionActiveFrameRange[],
  totalFrames: number,
): boolean {
  if (!enabled) return false;
  if (ranges.length === 0) return true;
  const activeFrames = ranges.reduce((sum, range) => sum + range.frameCount, 0);
  return ranges.length <= 8 && activeFrames < totalFrames * 0.85;
}

interface CaptionRenderPhase {
  name: string;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  startAtSeconds: number;
  outputDir: string;
}

export async function prepareRemotionCaptionOverlays(
  options: PrepareRemotionOverlaysOptions,
): Promise<PreparedCaptionOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(0.1, options.totalDuration ?? 0.1);
  const durationInFrames = Math.max(1, Math.round(totalDuration * fps));
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
  const activeRanges = calculateCaptionActiveFrameRanges(
    inputProps,
    fps,
    totalDuration,
  );
  const activeRangeEnabled = getCaptionActiveRangeRenderingEnabled();
  const useActiveRanges = shouldUseCaptionActiveFrameRanges(
    activeRangeEnabled,
    activeRanges,
    durationInFrames,
  );
  const remotionConcurrency = getRemotionConcurrency();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-remotion-"));
  const phases: CaptionRenderPhase[] = useActiveRanges
    ? activeRanges.map((range, index) => ({
        name: `remotion overlays ${index + 1}`,
        ...range,
        outputDir: path.join(workDir, `range-${String(index + 1).padStart(3, "0")}`),
      }))
    : [
        {
          name: "remotion overlays",
          startFrame: 0,
          endFrame: durationInFrames - 1,
          frameCount: durationInFrames,
          startAtSeconds: 0,
          outputDir: path.join(workDir, "frames"),
        },
      ];
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;
  let browser: Awaited<
    ReturnType<typeof import("@remotion/renderer").openBrowser>
  > | null = null;

  try {
    checkCancelled(options.isCancelled, options.signal);
    if (useActiveRanges && phases.length === 0) {
      log.detail(
        "Caption active-range rendering skipped all transparent idle frames (no caption, hook, or CTA visibility windows).",
      );
      return { workDir, sequences: [] };
    }
    const activeFrameCount = activeRanges.reduce(
      (sum, range) => sum + range.frameCount,
      0,
    );
    log.info(
      `[RENDER-DIAG] stage=caption.phase-model event=active ` +
        `mode=${useActiveRanges ? "sparse-active-ranges" : "full-timeline"} ` +
        `requested=${activeRangeEnabled ? 1 : 0} active_sequences=${activeRanges.length} ` +
        `active_frames=${activeFrameCount}/${durationInFrames} ` +
        `concurrency=${remotionConcurrency ?? "auto"}`,
    );

    const { renderFrames, selectComposition, openBrowser } = await timedRenderStage(
      "remotion.renderer-import",
      () => import("@remotion/renderer"),
    );
    cancelBridge = await remotionCancelBridge(options.signal);
    const bundleDir = await timedRenderStage(
      "remotion.bundle-load",
      () => withTimeout(getRemotionBundle(), getRenderTimeoutMs(), "remotion.bundle-load"),
    );
    // A sparse render can have several discontinuous phases. Reuse one Chrome
    // process so setup does not erase the transparent-frame savings. The legacy
    // full-timeline path intentionally retains Remotion's existing behavior.
    if (useActiveRanges) {
      browser = await timedRenderStage(
        "chromium.browser-initialization",
        () => openBrowser("chrome", {}),
        "browser=chrome",
      );
    }

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
      "composition=CaptionOverlayComposition",
    );
    checkCancelled(options.isCancelled, options.signal);

    const totalRenderedFrames = phases.reduce((sum, phase) => sum + phase.frameCount, 0);
    log.detail(
      `Remotion overlay frames: ${totalRenderedFrames}/${durationInFrames} frames @ ${fps}fps, ` +
        `${totalDuration.toFixed(2)}s (transparent PNG; no source-video encode)`,
    );
    let completedFrames = 0;
    const sequences: OverlayFrameSequence[] = [];
    for (const phase of phases) {
      checkCancelled(options.isCancelled, options.signal);
      fs.mkdirSync(phase.outputDir, { recursive: true });
      let lastLoggedFrames = 0;
      const renderStartedAt = Date.now();
      await timedRenderStage(
        "remotion.render-frames",
        () =>
          withTimeout(
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
              outputDir: phase.outputDir,
              imageFormat: "png",
              ...(useActiveRanges
                ? {
                    frameRange: [phase.startFrame, phase.endFrame] as [number, number],
                    puppeteerInstance: browser ?? undefined,
                  }
                : {}),
              cancelSignal: cancelBridge?.cancelSignal,
              concurrency: remotionConcurrency,
              onStart: () =>
                log.info(
                  `[RENDER-DIAG] stage=remotion.render-frames event=renderer-started image_format=png ` +
                    `frame_range=${phase.startFrame}-${phase.endFrame} planned_frames=${phase.frameCount} ` +
                    `output_dir=${phase.outputDir} ${renderMemoryUsage()}`,
                ),
              onFrameUpdate: (framesRendered) => {
                const progressInterval = Math.max(1, Math.ceil(phase.frameCount / 10));
                if (
                  framesRendered === phase.frameCount ||
                  framesRendered - lastLoggedFrames >= progressInterval
                ) {
                  lastLoggedFrames = framesRendered;
                  log.info(
                    `[RENDER-DIAG] stage=remotion.render-frames event=frame-progress ` +
                      `frames=${framesRendered}/${phase.frameCount} elapsed_ms=${Date.now() - renderStartedAt} ` +
                      `${renderMemoryUsage()}`,
                  );
                }
                options.onProgress?.(
                  Math.round(((completedFrames + framesRendered) / totalRenderedFrames) * 100),
                );
              },
              logLevel:
                (process.env.REMOTION_LOG_LEVEL?.trim() as
                  | "info"
                  | "verbose"
                  | "warn"
                  | "error") || "info",
            }),
            getRenderTimeoutMs(),
            "remotion.render-frames",
          ),
        `composition=CaptionOverlayComposition image_format=png frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} output_dir=${phase.outputDir}`,
      );
      checkCancelled(options.isCancelled, options.signal);
      const generated = frameOutputStats(phase.outputDir);
      if (generated.count !== phase.frameCount) {
        throw new AppError(
          `Caption renderer produced ${generated.count} frames for ${phase.name}; expected ${phase.frameCount}.`,
          {
            details: `frame_range=${phase.startFrame}-${phase.endFrame}, output=${phase.outputDir}`,
            resolution: "Retry the render or set CAPTION_ACTIVE_RANGE_RENDERING=0 for the legacy full-timeline renderer.",
          },
        );
      }
      sequences.push({
        name: phase.name,
        inputPattern: normalizeFrameSequence(phase.outputDir, "png"),
        startAtSeconds: phase.startAtSeconds,
        layer: "captions",
        frameCount: phase.frameCount,
      });
      completedFrames += phase.frameCount;
    }

    cancelBridge?.dispose();
    cancelBridge = null;
    log.ok(
      `Remotion overlays ready: ${totalRenderedFrames} transparent frame(s) in ${sequences.length} sequence(s)`,
    );
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
    throw new AppError("Remotion overlay rendering failed.", {
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
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * B-roll overlays
 * -------------------------------------------------------------------------- */

export interface BrollOverlayItem {
  id: string;
  kind: "fullscreen" | "landscape";
  /** FINAL timeline seconds, including any prepended hook replay. */
  start: number;
  end: number;
  imageUrl: string;
  card?: { x: number; y: number; width: number; height: number };
}

export interface PrepareBrollOverlaysOptions {
  fps: number;
  /** Items to paint, already scheduled on the FINAL (hook-inclusive) timeline. */
  items: BrollOverlayItem[];
  captionTextColor?: string;
  captionBand?: { top: number; bottom: number };
  onProgress?: (progress: number) => void;
  /** Upper bound for Chrome tabs when B-roll shares the host with another stage. */
  maxConcurrency?: number;
  /** Final clip length (incl. hook), used to clamp every active range. */
  totalDuration?: number;
  isCancelled?: () => boolean;
  /** Shared worker job signal: cancels Remotion and closes Chromium. */
  signal?: AbortSignal;
}

export interface PreparedBrollOverlays {
  workDir: string;
  sequences: OverlayFrameSequence[];
}

export interface BrollActiveFrameRange {
  item: BrollOverlayItem;
  /** Absolute frame numbers in the final composition, both inclusive. */
  startFrame: number;
  endFrame: number;
  frameCount: number;
  /** The matching FFmpeg input starts at this final-timeline timestamp. */
  startAtSeconds: number;
}

/**
 * Translate schedule seconds with the exact `Sequence` rounding used by the
 * Remotion composition. Rendering these absolute frames one item at a time and
 * rebasing them in FFmpeg is pixel-equivalent to rendering the old full canvas.
 */
export function calculateBrollActiveFrameRanges(
  items: readonly BrollOverlayItem[],
  fpsInput: number,
  totalDurationInput: number,
): BrollActiveFrameRange[] {
  const fps = normalizeFps(fpsInput);
  const totalFrames = Math.max(1, Math.ceil(Math.max(0.1, totalDurationInput) * fps));
  const ranges: BrollActiveFrameRange[] = [];

  for (const item of items) {
    const rawStartFrame = Math.round(item.start * fps);
    const rawFrameCount = Math.max(1, Math.round((item.end - item.start) * fps));
    const rawEndFrame = rawStartFrame + rawFrameCount - 1;
    // An entirely off-timeline item was invisible in the legacy full render too.
    if (rawEndFrame < 0 || rawStartFrame >= totalFrames) continue;

    const startFrame = Math.max(0, Math.min(totalFrames - 1, rawStartFrame));
    const endFrame = Math.max(startFrame, Math.min(totalFrames - 1, rawEndFrame));
    ranges.push({
      item,
      startFrame,
      endFrame,
      frameCount: endFrame - startFrame + 1,
      startAtSeconds: startFrame / fps,
    });
  }

  return ranges;
}

/**
 * Active-range rendering is the default. Set this to 0 only as a visual
 * rollback switch; it restores the previous one-full-timeline B-roll sequence.
 */
export function getBrollActiveRangeRenderingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !/^(0|false|no|off)$/i.test(env.BROLL_ACTIVE_RANGE_RENDERING?.trim() ?? "");
}

function safeBrollDirectoryPart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 72) || "item";
}

interface BrollRenderPhase {
  name: string;
  items: BrollOverlayItem[];
  startFrame: number;
  endFrame: number;
  frameCount: number;
  startAtSeconds: number;
  outputDir: string;
}

/**
 * Render only each item's active frames. Each range remains in the full
 * composition clock while Remotion paints it, then is normalized to frame 1 and
 * shifted back to that same clock by FFmpeg. This keeps animation, z-order,
 * captions and card/fullscreen geometry identical without decoding transparent
 * frames before or after the item.
 */
export async function prepareRemotionBrollOverlays(
  options: PrepareBrollOverlaysOptions,
): Promise<PreparedBrollOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(
    0.1,
    options.totalDuration ?? Math.max(0, ...options.items.map((item) => item.end)),
  );
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
  const activeRangeRendering = getBrollActiveRangeRenderingEnabled();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-broll-"));
  let browser: Awaited<
    ReturnType<typeof import("@remotion/renderer").openBrowser>
  > | null = null;
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;

  const activeRanges = calculateBrollActiveFrameRanges(options.items, fps, totalDuration);
  const remotionConcurrency = getRemotionConcurrency(process.env, {
    maxConcurrency: options.maxConcurrency,
  });
  const phases: BrollRenderPhase[] = activeRangeRendering
    ? activeRanges.map((range, index) => ({
        name: `b-roll ${range.item.kind} ${range.item.id}`,
        items: [range.item],
        startFrame: range.startFrame,
        endFrame: range.endFrame,
        frameCount: range.frameCount,
        startAtSeconds: range.startAtSeconds,
        outputDir: path.join(
          workDir,
          `item-${String(index + 1).padStart(3, "0")}-${safeBrollDirectoryPart(range.item.id)}`,
        ),
      }))
    : [
        {
          name: "b-roll timeline",
          items: options.items,
          startFrame: 0,
          endFrame: totalFrames - 1,
          frameCount: totalFrames,
          startAtSeconds: 0,
          outputDir: path.join(workDir, "timeline"),
        },
      ];

  try {
    checkCancelled(options.isCancelled, options.signal);
    if (phases.length === 0) {
      log.detail("B-roll schedule has no active frames inside the final timeline.");
      return { workDir, sequences: [] };
    }

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

    const compositionInputProps = {
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
            inputProps: compositionInputProps,
            logLevel: "error",
          }),
          getRenderTimeoutMs(),
          "remotion.select-composition",
        ),
      `composition=BrollTimelineComposition items=${options.items.length} frame_range=0-${totalFrames - 1}`,
    );
    checkCancelled(options.isCancelled, options.signal);

    log.info(
      `[RENDER-DIAG] stage=broll.phase-model event=active render_api=renderFrames ` +
        `mode=${activeRangeRendering ? "per-item-active-range" : "legacy-full-timeline"} ` +
        `fps=${fps} total_frame_range=0-${totalFrames - 1} active_sequences=${phases.length} ` +
        `concurrency=${remotionConcurrency ?? "auto"}`,
    );

    const totalRenderedFrames = phases.reduce((sum, phase) => sum + phase.frameCount, 0);
    let completedFrames = 0;
    const sequences: OverlayFrameSequence[] = [];

    for (const phase of phases) {
      checkCancelled(options.isCancelled, options.signal);
      fs.mkdirSync(phase.outputDir, { recursive: true });
      const phaseInputProps = {
        items: phase.items,
        captionTextColor: options.captionTextColor,
        captionBand: options.captionBand,
      };
      const itemDescription = phase.items.map((item) => `${item.id}:${item.kind}`).join(",");
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=before items=${itemDescription} ` +
          `mode=${activeRangeRendering ? "active-range" : "combined-timeline"} image_format=png ` +
          `canvas=1080x1920 frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} timeline_start_seconds=${phase.startAtSeconds.toFixed(6)} ` +
          `output_directory=${phase.outputDir} ${renderMemoryUsage()}`,
      );

      let lastLoggedFrames = 0;
      const renderStartedAt = Date.now();
      await timedRenderStage(
        "broll.render-frames",
        () =>
          withTimeout(
            renderFrames({
              composition: {
                ...composition,
                width: 1080,
                height: 1920,
                fps,
                durationInFrames: totalFrames,
              },
              serveUrl: bundleDir,
              inputProps: phaseInputProps,
              outputDir: phase.outputDir,
              imageFormat: "png",
              frameRange: [phase.startFrame, phase.endFrame],
              cancelSignal: cancelBridge?.cancelSignal,
              puppeteerInstance: activeBrowser,
              concurrency: remotionConcurrency,
              onStart: () =>
                log.info(
                  `[RENDER-DIAG] stage=broll.render-frames event=renderer-started image_format=png ` +
                    `frame_range=${phase.startFrame}-${phase.endFrame} planned_frames=${phase.frameCount} ` +
                    `output_dir=${phase.outputDir} ${renderMemoryUsage()}`,
                ),
              onFrameUpdate: (framesRendered) => {
                const progressInterval = Math.max(1, Math.ceil(phase.frameCount / 10));
                if (
                  framesRendered === phase.frameCount ||
                  framesRendered - lastLoggedFrames >= progressInterval
                ) {
                  lastLoggedFrames = framesRendered;
                  log.info(
                    `[RENDER-DIAG] stage=broll.render-frames event=frame-progress ` +
                      `frames=${framesRendered}/${phase.frameCount} elapsed_ms=${Date.now() - renderStartedAt} ` +
                      `${renderMemoryUsage()}`,
                  );
                }
                if (options.onProgress) {
                  options.onProgress(
                    Math.round(((completedFrames + framesRendered) / totalRenderedFrames) * 100),
                  );
                }
              },
              logLevel:
                (process.env.REMOTION_LOG_LEVEL?.trim() as
                  | "info"
                  | "verbose"
                  | "warn"
                  | "error") || "info",
            }),
            getRenderTimeoutMs(),
            "broll.render-frames",
          ),
        `composition=BrollTimelineComposition image_format=png frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} items=${itemDescription} output_dir=${phase.outputDir}`,
      );
      checkCancelled(options.isCancelled, options.signal);

      const generatedStats = frameOutputStats(phase.outputDir);
      if (generatedStats.count !== phase.frameCount) {
        throw new AppError(
          `B-roll renderer produced ${generatedStats.count} frames for ${phase.name}; expected ${phase.frameCount}.`,
          {
            details: `frame_range=${phase.startFrame}-${phase.endFrame}, output=${phase.outputDir}`,
            resolution: "Retry the render; if it repeats, disable BROLL_ACTIVE_RANGE_RENDERING for the legacy renderer.",
          },
        );
      }
      const inputPattern = normalizeFrameSequence(phase.outputDir, "png");
      sequences.push({
        name: phase.name,
        inputPattern,
        startAtSeconds: phase.startAtSeconds,
        layer: "broll",
        frameCount: phase.frameCount,
      });
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=after items=${itemDescription} ` +
          `generated_frames=${generatedStats.count} output_directory=${phase.outputDir} ` +
          `total_generated_file_size_bytes=${generatedStats.bytes} time_taken_ms=${Date.now() - renderStartedAt} ` +
          `${renderMemoryUsage()}`,
      );
      completedFrames += phase.frameCount;
    }

    log.ok(
      `Remotion B-roll ready: ${options.items.length} item(s), ${sequences.length} active sequence(s), ` +
        `${totalRenderedFrames}/${totalFrames} timeline frame(s) painted`,
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
