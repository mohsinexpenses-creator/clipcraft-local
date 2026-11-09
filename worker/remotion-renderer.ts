import fs from "fs";
import path from "path";
import { AppError, RenderCancelledError, toErrorMessage } from "../lib/errors";
import { removePathOrDefer } from "../lib/file-cleanup";
import { CaptionPreset, OverlayStylePreset, WordTimestamp } from "../lib/types";
import {
  FULL_OVERLAY_CANVAS,
  getBrollCardCanvasRegion,
  getCaptionOverlayCanvasRegion,
  type OverlayCanvasRegion,
} from "../lib/overlay-canvas";
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
import { resolveTempDir } from "../lib/paths";
import { customFontFilesForRender } from "../lib/custom-fonts";
import { startMediaServer, type ClipMediaServer } from "./clip-http-server";
import {
  getBrollCardCroppedCanvasEnabled,
  getCaptionActiveRangeRenderingEnabled,
  getCaptionBandCroppedCanvasEnabled,
  getRemotionConcurrency,
} from "./remotion-options";
import {
  buildOverlayFrameCacheKey,
  createOverlayFrameCacheStagingDirectory,
  enforceOverlayFrameCacheLimit,
  getOverlayFrameCacheSettings,
  materializeOverlayFrameCache,
  publishOverlayFrameCache,
  readOverlayFrameCache,
  removeOverlayFrameCacheStaging,
  type OverlayFrameCacheDescriptor,
} from "./overlay-frame-cache";

export interface PreparedCaptionOverlays {
  workDir: string;
  sequences: OverlayFrameSequence[];
}

/** Lower-level timings included in the parent clip job's [JOB-TIMING] summary. */
export type RemotionTimingStage =
  | "bundle"
  | "select-composition"
  | "render-frames"
  | "frame-normalization";
export type RemotionStageTimingReporter = (
  stage: RemotionTimingStage,
  elapsedMs: number,
) => void;

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
  /** Optional sink for bundle/select/render/normalization substage durations. */
  onStageTiming?: RemotionStageTimingReporter;
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

function reportRemotionStageTiming(
  report: RemotionStageTimingReporter | undefined,
  stage: RemotionTimingStage,
  elapsedMs: number,
): void {
  if (!report) return;
  try {
    report(stage, elapsedMs);
  } catch (error) {
    // Job diagnostics are optional and must not break the actual render.
    log.warn(`Remotion timing reporter failed for ${stage}: ${toErrorMessage(error)}`);
  }
}

async function timedRenderStage<T>(
  stage: string,
  operation: () => Promise<T>,
  details = "",
  timing?: { stage: RemotionTimingStage; report?: RemotionStageTimingReporter },
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
  } finally {
    if (timing) {
      reportRemotionStageTiming(timing.report, timing.stage, Date.now() - startedAt);
    }
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
  /** Used by a timeout as well as the worker's abort signal. */
  cancel: () => void;
  dispose: () => void;
}> {
  const { makeCancelSignal } = await import('@remotion/renderer');
  const bridge = makeCancelSignal();
  const abort = () => bridge.cancel();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    cancelSignal: bridge.cancelSignal,
    cancel: abort,
    dispose: () => signal?.removeEventListener('abort', abort),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage = "remotion.operation",
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        try {
          onTimeout?.();
        } catch {
          // A best-effort Remotion cancel must not hide the timeout itself.
        }
        log.error(
          `[RENDER-DIAG] stage=${stage} event=timeout timeout_ms=${ms} underlying_promise_cancelled=${onTimeout ? "requested" : "false"} ${renderMemoryUsage()}`,
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
  onStageTiming?: RemotionStageTimingReporter,
): string {
  const startedAt = Date.now();
  log.info(
    `[RENDER-DIAG] stage=remotion.frame-normalization event=before format=${extension} output_dir=${outputDir} ${renderMemoryUsage()}`,
  );
  try {
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
  } finally {
    reportRemotionStageTiming(onStageTiming, "frame-normalization", Date.now() - startedAt);
  }
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

interface OverlayFrameCachePhase {
  startFrame: number;
  endFrame: number;
  frameCount: number;
  startAtSeconds: number;
}

/**
 * A custom-font loopback URL includes a random worker port, so it must never be
 * part of a cache key. The immutable registry id + current file metadata is the
 * visual identity instead; a replaced/deleted font invalidates safely.
 */
function customFontCacheIdentity(
  fonts: Array<{ id: string; family: string; weight: number; filePath: string; format: string }>,
): Array<{ id: string; family: string; weight: number; format: string; bytes: number; mtimeMs: number }> {
  return fonts
    .map((font) => {
      try {
        const stat = fs.statSync(font.filePath);
        return {
          id: font.id,
          family: font.family,
          weight: font.weight,
          format: font.format,
          bytes: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
        };
      } catch {
        // `customFontFilesForRender` normally filtered this already; retaining a
        // marker makes a race-to-delete a new key rather than stale font pixels.
        return {
          id: font.id,
          family: font.family,
          weight: font.weight,
          format: font.format,
          bytes: -1,
          mtimeMs: -1,
        };
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Build the caption-frame key without ephemeral loopback URLs or runtime tuning. */
export function buildCaptionOverlayFrameCacheKey(input: {
  props: Omit<CaptionOverlayCompositionProps, "customFonts">;
  phase: OverlayFrameCachePhase;
  fps: number;
  durationInFrames: number;
  canvas: OverlayCanvasRegion;
  customFonts: Array<{ id: string; family: string; weight: number; format: string; bytes: number; mtimeMs: number }>;
}): string {
  return buildOverlayFrameCacheKey({
    composition: "CaptionOverlayComposition",
    props: input.props,
    phase: input.phase,
    fps: input.fps,
    durationInFrames: input.durationInFrames,
    canvas: input.canvas,
    customFonts: input.customFonts,
  });
}

function cacheDescriptor(
  kind: OverlayFrameCacheDescriptor["kind"],
  key: string,
  phase: OverlayFrameCachePhase,
  canvas: OverlayCanvasRegion,
): OverlayFrameCacheDescriptor {
  return {
    kind,
    key,
    frameCount: phase.frameCount,
    canvas: { ...canvas },
  };
}

async function cleanupRemotionWorkDirectory(directory: string, stage: string): Promise<void> {
  try {
    const removed = await removePathOrDefer(directory, "remotion-frame-workdir");
    if (!removed) {
      log.warn(
        `[RENDER-DIAG] stage=${stage} event=temporary-cleanup-deferred directory=${directory}`,
      );
    }
  } catch (error) {
    log.warn(
      `[RENDER-DIAG] stage=${stage} event=temporary-cleanup-failed directory=${directory} error=${toErrorMessage(error)}`,
    );
  }
}

/**
 * Cache publication deliberately starts from a completed job workdir, not the
 * live Remotion output directory. A Settings cache clear can therefore race a
 * publish harmlessly without deleting frames Chromium is still writing or the
 * exact inputs FFmpeg will consume for this job.
 */
function stageNormalizedOverlayFrames(
  sourceDirectory: string,
  stagingDirectory: string,
  frameCount: number,
): boolean {
  try {
    for (let frame = 1; frame <= frameCount; frame += 1) {
      const name = `ov_${String(frame).padStart(5, "0")}.png`;
      const source = path.join(sourceDirectory, name);
      const destination = path.join(stagingDirectory, name);
      try {
        fs.linkSync(source, destination);
      } catch {
        fs.copyFileSync(source, destination);
      }
    }
    return true;
  } catch {
    removeOverlayFrameCacheStaging(stagingDirectory);
    return false;
  }
}

export async function prepareRemotionCaptionOverlays(
  options: PrepareRemotionOverlaysOptions,
): Promise<PreparedCaptionOverlays> {
  const fps = normalizeFps(options.fps);
  const totalDuration = Math.max(0.1, options.totalDuration ?? 0.1);
  const durationInFrames = Math.max(1, Math.round(totalDuration * fps));
  // Active ranges depend only on timing/text. Custom font URLs are attached
  // only if there is a cache miss, after the throwaway loopback server starts.
  const inputPropsBase: CaptionOverlayCompositionProps = {
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
  const captionBandCropEnabled = getCaptionBandCroppedCanvasEnabled();
  const renderRegion = captionBandCropEnabled
    ? getCaptionOverlayCanvasRegion({
        preset: options.preset,
        hookText: inputPropsBase.hookText,
        hookDuration: options.hookDuration,
        hookStyle: options.hookStyle,
        ctaText: inputPropsBase.ctaText,
        ctaDuration: options.ctaDuration,
        ctaStyle: options.ctaStyle,
      }) ?? undefined
    : undefined;
  inputPropsBase.renderRegion = renderRegion;
  const activeRanges = calculateCaptionActiveFrameRanges(
    inputPropsBase,
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
  const workDir = fs.mkdtempSync(path.join(resolveTempDir(), "clipcraft-remotion-"));
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
  const cacheSettings = getOverlayFrameCacheSettings();
  const cacheStagingDirectories = new Set<string>();
  let browser: Awaited<
    ReturnType<typeof import("@remotion/renderer").openBrowser>
  > | null = null;
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;
  let fontServer: ClipMediaServer | null = null;
  let renderer: Awaited<typeof import("@remotion/renderer")> | null = null;
  let composition: Awaited<
    ReturnType<typeof import("@remotion/renderer").selectComposition>
  > | null = null;
  let bundleDir: string | null = null;
  let inputProps: CaptionOverlayCompositionProps = { ...inputPropsBase, customFonts: [] };
  let completed = false;

  try {
    checkCancelled(options.isCancelled, options.signal);
    if (useActiveRanges && phases.length === 0) {
      log.detail(
        "Caption active-range rendering skipped all transparent idle frames (no caption, hook, or CTA visibility windows).",
      );
      completed = true;
      return { workDir, sequences: [] };
    }

    // Font files are part of visual cache identity, but their worker loopback URLs
    // are intentionally excluded: a new ephemeral port must not defeat reuse.
    const customFontFiles = await customFontFilesForRender(
      options.preset,
      options.hookStyle,
      options.ctaStyle,
    );
    const fontIdentity = customFontCacheIdentity(customFontFiles);
    const activeFrameCount = activeRanges.reduce(
      (sum, range) => sum + range.frameCount,
      0,
    );
    const renderCanvas = renderRegion ?? FULL_OVERLAY_CANVAS;
    log.info(
      `[RENDER-DIAG] stage=caption.phase-model event=active ` +
        `mode=${useActiveRanges ? "sparse-active-ranges" : "full-timeline"} ` +
        `requested=${activeRangeEnabled ? 1 : 0} active_sequences=${activeRanges.length} ` +
        `active_frames=${activeFrameCount}/${durationInFrames} ` +
        `canvas=${renderCanvas.width}x${renderCanvas.height}@${renderCanvas.x},${renderCanvas.y} ` +
        `cropped_canvas=${renderRegion ? 1 : 0} cropped_canvas_requested=${captionBandCropEnabled ? 1 : 0} ` +
        `frame_cache=${cacheSettings.enabled ? "enabled" : "disabled"} ` +
        `concurrency=${remotionConcurrency ?? "auto"}`,
    );

    const ensureRenderer = async (): Promise<void> => {
      if (renderer && composition) return;
      if (customFontFiles.length > 0 && !fontServer) {
        fontServer = await startMediaServer(
          customFontFiles.map((font) => ({
            route: `fonts/${font.id}.${font.format}`,
            filePath: font.filePath,
          })),
        );
        log.detail(
          `Custom font loopback server ready: ${customFontFiles.length} selected face(s) on 127.0.0.1:${fontServer.port}.`,
        );
      }
      const fontBaseUrl = fontServer?.baseUrl;
      inputProps = {
        ...inputPropsBase,
        customFonts: fontBaseUrl
          ? customFontFiles.map((font) => ({
              family: font.family,
              weight: font.weight,
              source: `${fontBaseUrl}/fonts/${font.id}.${font.format}`,
              format: font.format,
            }))
          : [],
      };
      renderer = await timedRenderStage("remotion.renderer-import", () =>
        import("@remotion/renderer"),
      );
      cancelBridge = await remotionCancelBridge(options.signal);
      bundleDir = await timedRenderStage(
        "remotion.bundle-load",
        () => withTimeout(getRemotionBundle(), getRenderTimeoutMs(), "remotion.bundle-load", () => cancelBridge?.cancel()),
        "",
        { stage: "bundle", report: options.onStageTiming },
      );
      const selectedBundleDir = bundleDir;
      if (!selectedBundleDir) throw new AppError("Remotion bundle did not return a serve URL.");
      // Own the Chrome process even on the full-timeline path. That gives every
      // success, failure, cancellation, and timeout one deterministic close point.
      browser = await timedRenderStage(
        "chromium.browser-initialization",
        () => renderer!.openBrowser("chrome", {}),
        "browser=chrome",
      );
      composition = await timedRenderStage(
        "remotion.select-composition",
        () =>
          withTimeout(
            renderer!.selectComposition({
              serveUrl: selectedBundleDir,
              id: "CaptionOverlayComposition",
              inputProps,
              logLevel: "error",
            }),
            getRenderTimeoutMs(),
            "remotion.select-composition",
            () => cancelBridge?.cancel(),
          ),
        "composition=CaptionOverlayComposition",
        { stage: "select-composition", report: options.onStageTiming },
      );
    };

    const totalFramesForProgress = phases.reduce((sum, phase) => sum + phase.frameCount, 0);
    log.detail(
      `Remotion overlay frames: ${totalFramesForProgress}/${durationInFrames} frames @ ${fps}fps, ` +
        `${totalDuration.toFixed(2)}s (transparent PNG; no source-video encode)`,
    );
    const sequences: OverlayFrameSequence[] = [];
    let completedFrames = 0;

    for (const phase of phases) {
      checkCancelled(options.isCancelled, options.signal);
      const phaseInfo: OverlayFrameCachePhase = {
        startFrame: phase.startFrame,
        endFrame: phase.endFrame,
        frameCount: phase.frameCount,
        startAtSeconds: phase.startAtSeconds,
      };
      const descriptor = cacheDescriptor(
        "caption",
        buildCaptionOverlayFrameCacheKey({
          props: inputPropsBase,
          phase: phaseInfo,
          fps,
          durationInFrames,
          canvas: renderCanvas,
          customFonts: fontIdentity,
        }),
        phaseInfo,
        renderCanvas,
      );
      const cached = readOverlayFrameCache(cacheSettings, descriptor);
      if (cached) {
        const cachedPattern = materializeOverlayFrameCache(cached, phase.outputDir);
        if (cachedPattern) {
          log.info(
            `[RENDER-DIAG] stage=caption.frame-cache event=hit key=${descriptor.key.slice(0, 12)} ` +
              `frames=${phase.frameCount} output_directory=${phase.outputDir}`,
          );
          sequences.push({
            name: phase.name,
            inputPattern: cachedPattern,
            startAtSeconds: phase.startAtSeconds,
            layer: "captions",
            frameCount: phase.frameCount,
            ...(renderRegion ? { canvas: renderRegion } : {}),
          });
          completedFrames += phase.frameCount;
          options.onProgress?.(Math.round((completedFrames / totalFramesForProgress) * 100));
          continue;
        }
        log.warn(
          `[RENDER-DIAG] stage=caption.frame-cache event=materialize-fallback key=${descriptor.key.slice(0, 12)}`,
        );
      }

      await ensureRenderer();
      checkCancelled(options.isCancelled, options.signal);
      if (!renderer || !composition || !browser || !bundleDir) {
        throw new AppError("Remotion renderer did not initialize a Chromium instance.");
      }
      const activeRenderer = renderer as Awaited<typeof import("@remotion/renderer")>;
      const activeComposition = composition as Awaited<
        ReturnType<typeof import("@remotion/renderer").selectComposition>
      >;
      const activeBrowser = browser as NonNullable<typeof browser>;
      const activeBundleDir = bundleDir;
      // Chromium always writes into this job's disposable workdir. Cache
      // publication later links/copies the completed normalized frames, so a
      // Settings clear can never remove live output or FFmpeg's active inputs.
      const renderOutputDir = phase.outputDir;
      fs.mkdirSync(renderOutputDir, { recursive: true });
      log.info(
        `[RENDER-DIAG] stage=caption.frame-cache event=miss key=${descriptor.key.slice(0, 12)} ` +
          `frames=${phase.frameCount} cache_write=${cacheSettings.enabled ? 1 : 0}`,
      );

      let lastLoggedFrames = 0;
      const renderStartedAt = Date.now();
      await timedRenderStage(
        "remotion.render-frames",
        () =>
          withTimeout(
            activeRenderer.renderFrames({
              composition: {
                ...activeComposition,
                id: "CaptionOverlayComposition",
                width: renderCanvas.width,
                height: renderCanvas.height,
                fps,
                durationInFrames,
              },
              serveUrl: activeBundleDir,
              inputProps,
              outputDir: renderOutputDir,
              imageFormat: "png",
              ...(useActiveRanges
                ? {
                    frameRange: [phase.startFrame, phase.endFrame] as [number, number],
                  }
                : {}),
              cancelSignal: cancelBridge?.cancelSignal,
              puppeteerInstance: activeBrowser,
              concurrency: remotionConcurrency,
              onStart: () =>
                log.info(
                  `[RENDER-DIAG] stage=remotion.render-frames event=renderer-started image_format=png ` +
                    `frame_range=${phase.startFrame}-${phase.endFrame} planned_frames=${phase.frameCount} ` +
                    `output_dir=${renderOutputDir} ${renderMemoryUsage()}`,
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
                  Math.round(((completedFrames + framesRendered) / totalFramesForProgress) * 100),
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
            () => cancelBridge?.cancel(),
          ),
        `composition=CaptionOverlayComposition image_format=png frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} output_dir=${renderOutputDir}`,
        { stage: "render-frames", report: options.onStageTiming },
      );
      checkCancelled(options.isCancelled, options.signal);
      const generated = frameOutputStats(renderOutputDir);
      if (generated.count !== phase.frameCount) {
        throw new AppError(
          `Caption renderer produced ${generated.count} frames for ${phase.name}; expected ${phase.frameCount}.`,
          {
            details: `frame_range=${phase.startFrame}-${phase.endFrame}, output=${renderOutputDir}`,
            resolution: "Retry the render or set CAPTION_ACTIVE_RANGE_RENDERING=0 for the legacy full-timeline renderer.",
          },
        );
      }
      const inputPattern = normalizeFrameSequence(renderOutputDir, "png", options.onStageTiming);
      const stagingDirectory = createOverlayFrameCacheStagingDirectory(
        cacheSettings,
        "caption",
        descriptor.key,
      );
      if (stagingDirectory) {
        cacheStagingDirectories.add(stagingDirectory);
        if (stageNormalizedOverlayFrames(renderOutputDir, stagingDirectory, phase.frameCount)) {
          const published = publishOverlayFrameCache(cacheSettings, descriptor, stagingDirectory);
          cacheStagingDirectories.delete(stagingDirectory);
          if (published) {
            enforceOverlayFrameCacheLimit(cacheSettings);
            log.info(
              `[RENDER-DIAG] stage=caption.frame-cache event=stored key=${descriptor.key.slice(0, 12)} ` +
                `frames=${phase.frameCount} bytes=${generated.bytes}`,
            );
          } else {
            removeOverlayFrameCacheStaging(stagingDirectory);
            log.warn(
              `[RENDER-DIAG] stage=caption.frame-cache event=publish-fallback key=${descriptor.key.slice(0, 12)}`,
            );
          }
        } else {
          cacheStagingDirectories.delete(stagingDirectory);
          log.warn(
            `[RENDER-DIAG] stage=caption.frame-cache event=stage-fallback key=${descriptor.key.slice(0, 12)}`,
          );
        }
      }
      sequences.push({
        name: phase.name,
        inputPattern,
        startAtSeconds: phase.startAtSeconds,
        layer: "captions",
        frameCount: phase.frameCount,
        ...(renderRegion ? { canvas: renderRegion } : {}),
      });
      completedFrames += phase.frameCount;
    }

    log.ok(
      `Remotion overlays ready: ${totalFramesForProgress} transparent frame(s) in ${sequences.length} sequence(s)`,
    );
    completed = true;
    return { workDir, sequences };
  } catch (error) {
    (cancelBridge as Awaited<ReturnType<typeof remotionCancelBridge>> | null)?.cancel();
    if (options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof RenderCancelledError || error instanceof AppError) throw error;
    throw new AppError("Remotion overlay rendering failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the Remotion log, confirm Chromium is available, and retry the render.",
    });
  } finally {
    (cancelBridge as Awaited<ReturnType<typeof remotionCancelBridge>> | null)?.dispose();
    // Chromium can still flush a failed/timed-out frame after the Promise race
    // settles. Close it before deleting staging or work directories.
    const browserToClose = browser as Awaited<
      ReturnType<typeof import("@remotion/renderer").openBrowser>
    > | null;
    if (browserToClose) {
      const closeStartedAt = Date.now();
      log.info(
        `[RENDER-DIAG] stage=chromium.browser-close event=before ${renderMemoryUsage()}`,
      );
      try {
        await browserToClose.close({ silent: true });
        log.info(
          `[RENDER-DIAG] stage=chromium.browser-close event=after time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
      } catch {
        log.warn(
          `[RENDER-DIAG] stage=chromium.browser-close event=failed time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
      }
    }
    const fontServerToClose = fontServer as unknown as ClipMediaServer | null;
    if (fontServerToClose) {
      try {
        await fontServerToClose.close();
      } catch {
        log.warn("Custom font loopback server did not close cleanly.");
      }
    }
    for (const stagingDirectory of cacheStagingDirectories) {
      removeOverlayFrameCacheStaging(stagingDirectory);
    }
    if (!completed) await cleanupRemotionWorkDirectory(workDir, "caption.temporary-cleanup");
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
  /**
   * Stable prepared-image identity. The worker's loopback URL has a random
   * port each job, so it is deliberately excluded from cache reuse when this
   * immutable source fingerprint is available.
   */
  cacheIdentity?: string;
  card?: { x: number; y: number; width: number; height: number };
}

/** Build a B-roll frame key that remains stable across fresh loopback servers. */
export function buildBrollOverlayFrameCacheKey(input: {
  items: readonly BrollOverlayItem[];
  phase: OverlayFrameCachePhase;
  fps: number;
  totalFrames: number;
  canvas: OverlayCanvasRegion;
  captionTextColor?: string;
  captionBand?: { top: number; bottom: number };
}): string {
  return buildOverlayFrameCacheKey({
    composition: "BrollTimelineComposition",
    items: input.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      start: item.start,
      end: item.end,
      card: item.card,
      // Direct/test callers that do not have a prepared-file identity still
      // invalidate safely when their image URL changes.
      image: item.cacheIdentity ?? item.imageUrl,
    })),
    phase: input.phase,
    fps: input.fps,
    totalFrames: input.totalFrames,
    canvas: input.canvas,
    captionTextColor: input.captionTextColor,
    captionBand: input.captionBand,
  });
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
  /** Optional sink for bundle/select/render/normalization substage durations. */
  onStageTiming?: RemotionStageTimingReporter;
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
  /** Small landscape-card canvas, or undefined for the legacy full canvas. */
  renderRegion?: OverlayCanvasRegion;
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
  const workDir = fs.mkdtempSync(path.join(resolveTempDir(), "clipcraft-broll-"));
  const activeRanges = calculateBrollActiveFrameRanges(options.items, fps, totalDuration);
  const croppedCardCanvasEnabled = getBrollCardCroppedCanvasEnabled();
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
        ...(croppedCardCanvasEnabled && range.item.kind === "landscape" && range.item.card
          ? { renderRegion: getBrollCardCanvasRegion(range.item.card) }
          : {}),
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
  const cacheSettings = getOverlayFrameCacheSettings();
  const cacheStagingDirectories = new Set<string>();
  let browser: Awaited<
    ReturnType<typeof import("@remotion/renderer").openBrowser>
  > | null = null;
  let cancelBridge: Awaited<ReturnType<typeof remotionCancelBridge>> | null = null;
  let renderer: Awaited<typeof import("@remotion/renderer")> | null = null;
  let composition: Awaited<
    ReturnType<typeof import("@remotion/renderer").selectComposition>
  > | null = null;
  let bundleDir: string | null = null;
  let completed = false;

  try {
    checkCancelled(options.isCancelled, options.signal);
    if (phases.length === 0) {
      log.detail("B-roll schedule has no active frames inside the final timeline.");
      completed = true;
      return { workDir, sequences: [] };
    }

    const ensureRenderer = async (): Promise<void> => {
      if (renderer && composition) return;
      renderer = await timedRenderStage("remotion.renderer-import", () =>
        import("@remotion/renderer"),
      );
      cancelBridge = await remotionCancelBridge(options.signal);
      bundleDir = await timedRenderStage(
        "remotion.bundle-load",
        () => withTimeout(getRemotionBundle(), getRenderTimeoutMs(), "remotion.bundle-load", () => cancelBridge?.cancel()),
        "",
        { stage: "bundle", report: options.onStageTiming },
      );
      const selectedBundleDir = bundleDir;
      if (!selectedBundleDir) throw new AppError("Remotion bundle did not return a serve URL.");
      browser = await timedRenderStage(
        "chromium.browser-initialization",
        () => renderer!.openBrowser("chrome", {}),
        "browser=chrome",
      );
      const compositionInputProps = {
        items: options.items,
        captionTextColor: options.captionTextColor,
        captionBand: options.captionBand,
      };
      composition = await timedRenderStage(
        "remotion.select-composition",
        () =>
          withTimeout(
            renderer!.selectComposition({
              serveUrl: selectedBundleDir,
              id: "BrollTimelineComposition",
              inputProps: compositionInputProps,
              logLevel: "error",
            }),
            getRenderTimeoutMs(),
            "remotion.select-composition",
            () => cancelBridge?.cancel(),
          ),
        `composition=BrollTimelineComposition items=${options.items.length} frame_range=0-${totalFrames - 1}`,
        { stage: "select-composition", report: options.onStageTiming },
      );
    };

    log.info(
      `[RENDER-DIAG] stage=broll.phase-model event=active render_api=renderFrames ` +
        `mode=${activeRangeRendering ? "per-item-active-range" : "legacy-full-timeline"} ` +
        `fps=${fps} total_frame_range=0-${totalFrames - 1} active_sequences=${phases.length} ` +
        `cropped_card_canvas_requested=${croppedCardCanvasEnabled ? 1 : 0} ` +
        `frame_cache=${cacheSettings.enabled ? "enabled" : "disabled"} ` +
        `concurrency=${remotionConcurrency ?? "auto"}`,
    );

    const totalFramesForProgress = phases.reduce((sum, phase) => sum + phase.frameCount, 0);
    let completedFrames = 0;
    const sequences: OverlayFrameSequence[] = [];

    for (const phase of phases) {
      checkCancelled(options.isCancelled, options.signal);
      const renderCanvas = phase.renderRegion ?? FULL_OVERLAY_CANVAS;
      const phaseInfo: OverlayFrameCachePhase = {
        startFrame: phase.startFrame,
        endFrame: phase.endFrame,
        frameCount: phase.frameCount,
        startAtSeconds: phase.startAtSeconds,
      };
      const descriptor = cacheDescriptor(
        "broll",
        buildBrollOverlayFrameCacheKey({
          items: phase.items,
          phase: phaseInfo,
          fps,
          totalFrames,
          canvas: renderCanvas,
          captionTextColor: options.captionTextColor,
          captionBand: options.captionBand,
        }),
        phaseInfo,
        renderCanvas,
      );
      const cached = readOverlayFrameCache(cacheSettings, descriptor);
      if (cached) {
        const cachedPattern = materializeOverlayFrameCache(cached, phase.outputDir);
        if (cachedPattern) {
          log.info(
            `[RENDER-DIAG] stage=broll.frame-cache event=hit key=${descriptor.key.slice(0, 12)} ` +
              `frames=${phase.frameCount} output_directory=${phase.outputDir}`,
          );
          sequences.push({
            name: phase.name,
            inputPattern: cachedPattern,
            startAtSeconds: phase.startAtSeconds,
            layer: "broll",
            frameCount: phase.frameCount,
            ...(phase.renderRegion ? { canvas: phase.renderRegion } : {}),
          });
          completedFrames += phase.frameCount;
          options.onProgress?.(Math.round((completedFrames / totalFramesForProgress) * 100));
          continue;
        }
        log.warn(
          `[RENDER-DIAG] stage=broll.frame-cache event=materialize-fallback key=${descriptor.key.slice(0, 12)}`,
        );
      }

      await ensureRenderer();
      checkCancelled(options.isCancelled, options.signal);
      if (!renderer || !composition || !browser || !bundleDir) {
        throw new AppError("Remotion renderer did not initialize a Chromium instance.");
      }
      const activeRenderer = renderer as Awaited<typeof import("@remotion/renderer")>;
      const activeComposition = composition as Awaited<
        ReturnType<typeof import("@remotion/renderer").selectComposition>
      >;
      const activeBrowser = browser as NonNullable<typeof browser>;
      const activeBundleDir = bundleDir;
      // Keep Chromium output in this job workdir until the final FFmpeg pass is
      // done. Cache publication is a later best-effort link/copy of complete
      // frames, so Settings -> Clear caches cannot disrupt this active render.
      const renderOutputDir = phase.outputDir;
      fs.mkdirSync(renderOutputDir, { recursive: true });
      const phaseInputProps = {
        items: phase.items,
        captionTextColor: options.captionTextColor,
        captionBand: options.captionBand,
        renderRegion: phase.renderRegion,
      };
      const itemDescription = phase.items.map((item) => `${item.id}:${item.kind}`).join(",");
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=before items=${itemDescription} ` +
          `mode=${activeRangeRendering ? "active-range" : "combined-timeline"} image_format=png ` +
          `canvas=${renderCanvas.width}x${renderCanvas.height}@${renderCanvas.x},${renderCanvas.y} ` +
          `cropped_canvas=${phase.renderRegion ? 1 : 0} frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} timeline_start_seconds=${phase.startAtSeconds.toFixed(6)} ` +
          `output_directory=${renderOutputDir} ${renderMemoryUsage()}`,
      );
      log.info(
        `[RENDER-DIAG] stage=broll.frame-cache event=miss key=${descriptor.key.slice(0, 12)} ` +
          `frames=${phase.frameCount} cache_write=${cacheSettings.enabled ? 1 : 0}`,
      );

      let lastLoggedFrames = 0;
      const renderStartedAt = Date.now();
      await timedRenderStage(
        "broll.render-frames",
        () =>
          withTimeout(
            activeRenderer.renderFrames({
              composition: {
                ...activeComposition,
                id: "BrollTimelineComposition",
                width: renderCanvas.width,
                height: renderCanvas.height,
                fps,
                durationInFrames: totalFrames,
              },
              serveUrl: activeBundleDir,
              inputProps: phaseInputProps,
              outputDir: renderOutputDir,
              imageFormat: "png",
              frameRange: [phase.startFrame, phase.endFrame],
              cancelSignal: cancelBridge?.cancelSignal,
              puppeteerInstance: activeBrowser,
              concurrency: remotionConcurrency,
              onStart: () =>
                log.info(
                  `[RENDER-DIAG] stage=broll.render-frames event=renderer-started image_format=png ` +
                    `frame_range=${phase.startFrame}-${phase.endFrame} planned_frames=${phase.frameCount} ` +
                    `output_dir=${renderOutputDir} ${renderMemoryUsage()}`,
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
                options.onProgress?.(
                  Math.round(((completedFrames + framesRendered) / totalFramesForProgress) * 100),
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
            "broll.render-frames",
            () => cancelBridge?.cancel(),
          ),
        `composition=BrollTimelineComposition image_format=png frame_range=${phase.startFrame}-${phase.endFrame} ` +
          `planned_frames=${phase.frameCount} items=${itemDescription} output_dir=${renderOutputDir}`,
        { stage: "render-frames", report: options.onStageTiming },
      );
      checkCancelled(options.isCancelled, options.signal);

      const generatedStats = frameOutputStats(renderOutputDir);
      if (generatedStats.count !== phase.frameCount) {
        throw new AppError(
          `B-roll renderer produced ${generatedStats.count} frames for ${phase.name}; expected ${phase.frameCount}.`,
          {
            details: `frame_range=${phase.startFrame}-${phase.endFrame}, output=${renderOutputDir}`,
            resolution: "Retry the render; if it repeats, disable BROLL_ACTIVE_RANGE_RENDERING for the legacy renderer.",
          },
        );
      }
      const inputPattern = normalizeFrameSequence(renderOutputDir, "png", options.onStageTiming);
      const stagingDirectory = createOverlayFrameCacheStagingDirectory(
        cacheSettings,
        "broll",
        descriptor.key,
      );
      if (stagingDirectory) {
        cacheStagingDirectories.add(stagingDirectory);
        if (stageNormalizedOverlayFrames(renderOutputDir, stagingDirectory, phase.frameCount)) {
          const published = publishOverlayFrameCache(cacheSettings, descriptor, stagingDirectory);
          cacheStagingDirectories.delete(stagingDirectory);
          if (published) {
            enforceOverlayFrameCacheLimit(cacheSettings);
            log.info(
              `[RENDER-DIAG] stage=broll.frame-cache event=stored key=${descriptor.key.slice(0, 12)} ` +
                `frames=${phase.frameCount} bytes=${generatedStats.bytes}`,
            );
          } else {
            removeOverlayFrameCacheStaging(stagingDirectory);
            log.warn(
              `[RENDER-DIAG] stage=broll.frame-cache event=publish-fallback key=${descriptor.key.slice(0, 12)}`,
            );
          }
        } else {
          cacheStagingDirectories.delete(stagingDirectory);
          log.warn(
            `[RENDER-DIAG] stage=broll.frame-cache event=stage-fallback key=${descriptor.key.slice(0, 12)}`,
          );
        }
      }
      sequences.push({
        name: phase.name,
        inputPattern,
        startAtSeconds: phase.startAtSeconds,
        layer: "broll",
        frameCount: phase.frameCount,
        ...(phase.renderRegion ? { canvas: phase.renderRegion } : {}),
      });
      log.info(
        `[RENDER-DIAG] stage=broll.item-render event=after items=${itemDescription} ` +
          `generated_frames=${generatedStats.count} output_directory=${renderOutputDir} ` +
          `total_generated_file_size_bytes=${generatedStats.bytes} time_taken_ms=${Date.now() - renderStartedAt} ` +
          `${renderMemoryUsage()}`,
      );
      completedFrames += phase.frameCount;
    }

    log.ok(
      `Remotion B-roll ready: ${options.items.length} item(s), ${sequences.length} active sequence(s), ` +
        `${totalFramesForProgress}/${totalFrames} timeline frame(s) painted`,
    );
    completed = true;
    return { workDir, sequences };
  } catch (error) {
    (cancelBridge as Awaited<ReturnType<typeof remotionCancelBridge>> | null)?.cancel();
    if (options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof RenderCancelledError || error instanceof AppError) throw error;
    throw new AppError("Remotion B-roll rendering failed.", {
      details: toErrorMessage(error),
      resolution:
        "Inspect the Remotion log, confirm Chromium is available, and retry the render.",
    });
  } finally {
    (cancelBridge as Awaited<ReturnType<typeof remotionCancelBridge>> | null)?.dispose();
    const browserToClose = browser as unknown as Awaited<
      ReturnType<typeof import("@remotion/renderer").openBrowser>
    > | null;
    if (browserToClose) {
      const closeStartedAt = Date.now();
      log.info(
        `[RENDER-DIAG] stage=chromium.browser-close event=before ${renderMemoryUsage()}`,
      );
      try {
        await browserToClose.close({ silent: true });
        log.info(
          `[RENDER-DIAG] stage=chromium.browser-close event=after time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
      } catch {
        log.warn(
          `[RENDER-DIAG] stage=chromium.browser-close event=failed time_taken_ms=${Date.now() - closeStartedAt} ${renderMemoryUsage()}`,
        );
      }
    }
    for (const stagingDirectory of cacheStagingDirectories) {
      removeOverlayFrameCacheStaging(stagingDirectory);
    }
    if (!completed) await cleanupRemotionWorkDirectory(workDir, "broll.temporary-cleanup");
  }
}
