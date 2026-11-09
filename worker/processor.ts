import fs from "fs";
import path from "path";
import {
  getCaptionPreset,
  getClip,
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  getOverlayStylePreset,
  getVideo,
  updateClip,
  updateClipForRunningJob,
} from "../lib/db";
import { AppError, RenderCancelledError, toErrorMessage } from "../lib/errors";
import { removePathOrDefer } from "../lib/file-cleanup";
import { resolveClipsDir } from "../lib/paths";
import { resolveCaptionThemeOverlayStyle } from "../lib/caption-theme-styles";

import { getVideoMetadata } from "../lib/ffmpeg";
import { getCaptionOffsetMs, shiftCaptionWords } from "./caption-timing";
import { detectSpeakerTimeline, type AsdStageTimingReporter } from "./asd";
import {
  CaptionPreset,
  ClipLayout,
  ClipRecord,
  JobData,
  OverlayStylePreset,
} from "../lib/types";
import { buildLayoutPlan, getSplitFramingSettings } from "./layout";
import { adaptOverlaysToLayout, describePlacements } from "./overlay-layout";
import { color, log } from "../lib/logger";
import { JobTimer, type JobTimingOutcome } from "../lib/job-timing";
import {
  HOOK_TRANSITION_SECONDS,
  normalizeFps,
  processVideoSegment,
  type OverlayFrameSequence,
} from "./ffmpeg-pipeline";
import {
  DEFAULT_HOOK_FALLBACK_SECONDS,
  resolveHookTiming,
} from "./hook-timing";
import {
  prepareRemotionBrollOverlays,
  prepareRemotionCaptionOverlays,
  type PreparedBrollOverlays,
  type PreparedCaptionOverlays,
  type RemotionStageTimingReporter,
} from "./remotion-renderer";
import { startMediaServer, type ClipMediaServer } from "./clip-http-server";
import { runParallelRenderBranches } from "./parallel";
import {
  canParallelizeBrollWithAsd,
  getParallelBrollAsdConcurrencyCap,
  getParallelBrollAsdEnabled,
} from "./render-options";
import { cachedImagePath } from "../lib/broll/cache";
import { anchoredCardRect } from "../lib/broll/card";
import { buildBrollSfxCues } from "../lib/broll/sfx";
import { captionReservedBand } from "../lib/overlay-stack";
import { buildClipFileName } from "./clip-file-name";
import { loadEffectiveSettings } from "../lib/app-settings";
import {
  findContextCensorWordIndexes,
  findViralSafetyWordIndexes,
  getForceLlmSafetyReview,
  getProfanityContextPassEnabled,
  resolveCensoredWordIndexes,
} from "../lib/profanity";

/** How far either side of the window we still accept transcript words. */
const WORD_SLACK_SECONDS = 0.5;

/**
 * Last-resort overlay copy. A render should never die just because an LLM call was
 * skipped or returned nothing - the user can always re-render with better text.
 */
function deriveOverlayText(
  words: Array<{ word: string }>,
  maxWords: number,
  fallback: string,
): string {
  const text = words
    .slice(0, maxWords)
    .map((entry) => entry.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  return text || fallback;
}

/** Resolve an explicit overlay id, or use the current database default only when absent. */
async function resolveOverlayStyle(
  id: string | undefined,
  kind: "hook" | "cta",
): Promise<OverlayStylePreset> {
  if (id?.trim()) {
    const preset = await getOverlayStylePreset(id.trim());
    if (!preset || preset.kind !== kind) {
      throw new AppError(
        `Overlay style preset ${id} was not found for ${kind}.`,
        {
          status: 404,
          resolution:
            "Select an existing overlay style preset from the dashboard and retry rendering.",
        },
      );
    }
    return preset;
  }

  const preset = await getDefaultOverlayStylePreset(kind);
  if (!preset) {
    throw new AppError(
      `No default ${kind.toUpperCase()} style preset is configured.`,
      {
        status: 500,
        resolution:
          "Choose a database default for Hook and CTA in preset settings.",
      },
    );
  }
  return preset;
}

interface BrollRenderPreparation {
  preparedBroll: PreparedBrollOverlays | null;
  sequences: OverlayFrameSequence[];
  fileCount: number;
  sfx: Array<{ filePath: string; atSeconds: number; volume?: number }>;
}

/**
 * Prepared Remotion frames are never user media. If Windows/Chrome briefly holds
 * one open, persist a deferred cleanup row so the worker startup sweep removes it
 * instead of silently accumulating transient PNG directories.
 */
async function cleanupPreparedOverlayFrames(
  overlays: { workDir: string } | null,
  kind: "caption-overlay-frames" | "broll-overlay-frames",
): Promise<void> {
  if (!overlays) return;
  try {
    const removed = await removePathOrDefer(overlays.workDir, kind);
    if (!removed) {
      log.warn(`[RENDER-DIAG] stage=${kind} event=temporary-cleanup-deferred directory=${overlays.workDir}`);
    }
  } catch (error) {
    log.warn(
      `[RENDER-DIAG] stage=${kind} event=temporary-cleanup-failed directory=${overlays.workDir} error=${toErrorMessage(error)}`,
    );
  }
}

/**
 * Loopback B-roll URLs use a fresh port per render, so cache transparent frames
 * by the immutable prepared-image identity instead. The content-addressed plan
 * key plus file metadata catches a locally replaced prepared JPEG safely.
 */
function preparedBrollImageCacheIdentity(filePath: string, cacheKey: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${cacheKey}:${path.basename(filePath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    // The caller filters missing files before invoking Remotion. Retain a unique
    // fallback rather than ever reusing pixels for an unreadable replacement.
    return `${cacheKey}:${path.basename(filePath)}:missing`;
  }
}

interface PrepareBrollForRenderOptions {
  brollPlan: ClipRecord["broll"];
  fps: number;
  totalDuration: number;
  captionPreset: CaptionPreset;
  cardLayout: "speaker-focus" | "split-screen";
  faceBands?: Array<{ top: number; bottom: number }>;
  onProgress: (progress: number) => void;
  /** Cap Chrome tabs only when this render shares resources with ASD. */
  remotionConcurrencyCap?: number;
  /** Adds B-roll Remotion substages to the enclosing job timing summary. */
  onStageTiming?: RemotionStageTimingReporter;
  signal?: AbortSignal;
  isCancelled: () => boolean;
}

async function prepareBrollForRender(
  options: PrepareBrollForRenderOptions,
): Promise<BrollRenderPreparation> {
  const empty: BrollRenderPreparation = {
    preparedBroll: null,
    sequences: [],
    fileCount: 0,
    sfx: [],
  };
  const brollPlan = options.brollPlan;
  if (!brollPlan || brollPlan.items.length === 0) return empty;

  const usable = brollPlan.items
    .map((item) => ({ item, filePath: cachedImagePath(item.renderFile) }))
    .filter(({ filePath }) => {
      const exists = fs.existsSync(filePath);
      if (!exists) {
        log.warn(
          `B-roll image missing from the cache, skipping it: ${path.basename(filePath)}`,
        );
      }
      return exists;
    });
  if (usable.length === 0) return empty;

  let mediaServer: ClipMediaServer | null = null;
  try {
    const mediaServerStartedAt = Date.now();
    log.info(
      `[RENDER-DIAG] stage=broll.media-server-start event=before images=${usable.length}`,
    );
    const servedMedia = await startMediaServer(
      usable.map(({ filePath }, index) => ({
        route: `broll-${index}${path.extname(filePath) || ".jpg"}`,
        filePath,
      })),
    );
    mediaServer = servedMedia;
    log.info(
      `[RENDER-DIAG] stage=broll.media-server-start event=after time_taken_ms=${Date.now() - mediaServerStartedAt} images=${usable.length}`,
    );

    const captionBand = captionReservedBand(options.captionPreset);
    log.info(
      `[RENDER-DIAG] stage=broll.remotion-prepare event=before ` +
        `items=${usable.map(({ item }) => `${item.id}:${item.kind}@${item.start.toFixed(3)}-${item.end.toFixed(3)}s`).join(",")} ` +
        `fps=${options.fps} total_timeline_frame_range=0-${Math.max(0, Math.ceil(options.totalDuration * options.fps) - 1)}`,
    );
    const brollPrepareStartedAt = Date.now();
    const preparedBroll = await prepareRemotionBrollOverlays({
      fps: options.fps,
      totalDuration: options.totalDuration,
      items: usable.map(({ item }, index) => ({
        id: item.id,
        kind: item.kind,
        start: item.start,
        end: item.end,
        imageUrl: `${servedMedia.baseUrl}/broll-${index}${path.extname(usable[index].filePath) || ".jpg"}`,
        cacheIdentity: preparedBrollImageCacheIdentity(usable[index].filePath, item.cacheKey),
        // This matches the legacy renderer exactly. For speaker-focus the anchor
        // has no ASD inputs; for split screen the caller supplies the face bands.
        ...(item.card
          ? {
              card: anchoredCardRect(options.cardLayout, {
                faceBands: options.faceBands,
              }),
            }
          : {}),
      })),
      captionTextColor: options.captionPreset.textColor,
      captionBand,
      onProgress: options.onProgress,
      maxConcurrency: options.remotionConcurrencyCap,
      isCancelled: options.isCancelled,
      signal: options.signal,
      onStageTiming: options.onStageTiming,
    });
    log.info(
      `[RENDER-DIAG] stage=broll.remotion-prepare event=after time_taken_ms=${Date.now() - brollPrepareStartedAt} sequence_count=${preparedBroll.sequences.length} output_directory=${preparedBroll.workDir}`,
    );

    let sfx: BrollRenderPreparation["sfx"] = [];
    if (brollPlan.options.sfx) {
      sfx = buildBrollSfxCues(
        usable.map(({ item }) => ({ start: item.start, end: item.end })),
        { totalDuration: options.totalDuration, enabled: true },
      )
        .map((cue) => ({
          filePath: path.join(process.cwd(), "public", "sfx", cue.file),
          atSeconds: cue.atSeconds,
          volume: cue.volume,
        }))
        .filter((cue) => fs.existsSync(cue.filePath));
    }
    return {
      preparedBroll,
      sequences: preparedBroll.sequences,
      fileCount: usable.length,
      sfx,
    };
  } catch (error) {
    if (error instanceof RenderCancelledError || options.signal?.aborted) {
      throw new RenderCancelledError();
    }
    // B-roll is an enhancement: a provider/Chromium failure must never lose the clip.
    log.warn(`B-roll rendering skipped: ${toErrorMessage(error)}`);
    return empty;
  } finally {
    if (mediaServer) {
      const mediaServerCloseStartedAt = Date.now();
      log.info("[RENDER-DIAG] stage=broll.media-server-close event=before");
      await mediaServer.close();
      log.info(
        `[RENDER-DIAG] stage=broll.media-server-close event=after time_taken_ms=${Date.now() - mediaServerCloseStartedAt}`,
      );
    }
  }
}

export interface ProcessClipJobOptions {
  /** Queue job identity plus its claim token prevent a cancelled old worker write. */
  jobId?: string;
  startedAt?: string;
  /** Opaque per-attempt fence, so a stale worker cannot write a re-claimed job. */
  claimToken?: string;
  /** Worker-owned cancellation signal, polled against the jobs table every 400ms. */
  signal?: AbortSignal;
}

export async function processClipJob(
  jobData: JobData,
  onProgress?: (progress: number) => void,
  execution: ProcessClipJobOptions = {},
): Promise<ClipRecord> {
  const {
    clipId,
    videoId,
    start,
    end,
    hookDuration,
    hookText,
    ctaText,
    ctaDuration,
    filterPreset,
    captionPresetId,
  } = jobData;

  log.section(
    `Render ${color.bold(clipId)}` +
      color.gray(`  ·  video ${videoId}  ·  ${start}s → ${end}s`),
  );

  // This remains wall-clock based when stages overlap (for example B-roll and
  // ASD in the opt-in parallel renderer). The final job-end summary makes a
  // real baseline/re-run directly comparable without adding database writes.
  const jobTimer = new JobTimer({ job: `clip-render:${clipId}` });
  // Keep component timings namespaced beneath their existing top-level stage.
  // They intentionally overlap their parent measure; wall time remains the only
  // end-to-end number, while this exposes the expensive work inside it.
  const asdStageTiming: AsdStageTimingReporter = (stage, elapsedMs): void =>
    jobTimer.record(`asd.${stage}`, elapsedMs);
  const remotionStageTiming = (
    parent: "caption-remotion" | "broll-remotion",
  ): RemotionStageTimingReporter =>
    (stage, elapsedMs) => jobTimer.record(`${parent}.${stage}`, elapsedMs);
  const captionStageTiming = remotionStageTiming("caption-remotion");
  const brollStageTiming = remotionStageTiming("broll-remotion");
  let jobTimingOutcome: JobTimingOutcome = "failed";

  const reportProgress = async (value: number): Promise<void> => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (onProgress) await onProgress(clamped);
  };
  const checkCancelled = (): void => {
    if (execution.signal?.aborted) throw new RenderCancelledError();
  };
  const persistClip = async (candidate: ClipRecord): Promise<boolean> => {
    if (execution.jobId && execution.startedAt) {
      return updateClipForRunningJob(candidate, execution.jobId, execution.startedAt, execution.claimToken);
    }
    return updateClip(candidate);
  };

  checkCancelled();
  const clip = await getClip(clipId);
  if (!clip) {
    throw new AppError(`Clip record ${clipId} was not found in SQLite.`, {
      status: 404,
      resolution:
        "Create the clip again from viral detection before attempting to render it.",
    });
  }

  const video = await getVideo(videoId);
  if (!video) {
    throw new AppError(
      `Source video record ${videoId} was not found in SQLite.`,
      {
        status: 404,
        resolution: "Upload the source video again before rendering clips.",
      },
    );
  }

  if (!fs.existsSync(video.filePath)) {
    throw new AppError("The source video file is missing from disk.", {
      status: 404,
      details: video.filePath,
      resolution:
        "Upload the video again so ClipCraft can rebuild the source file.",
    });
  }

  clip.status = "processing";
  clip.progress = 5;
  clip.error = undefined;
  // A re-render starts fresh: a stale cancelling flag (from a previous
  // cancelled render) must not abort this new job on its first poll.
  clip.cancelling = false;
  if (!(await persistClip(clip))) {
    throw new RenderCancelledError(
      "Clip was deleted before rendering started.",
    );
  }
  await reportProgress(5);

  // Output folder mirrors the uploaded video's stored name (e.g. 001_my_recording);
  // pre-convention uploads fall back to the video id. The root comes from
  // Settings -> Paths & binaries (default: ./generated-clips), while the stored
  // outputPath keeps its logical /generated-clips/ prefix for the media route.
  const outputBase = video.fileBase || videoId;
  const outputDir = path.join(resolveClipsDir(), outputBase);
  // Optional pre-caption diagnostic branch (SAVE_PRECAPTION_DEBUG=1). The normal
  // final render goes directly from the source into the title-named deliverable.
  const intermediateVideoPath = path.join(
    outputDir,
    `${clipId}_precaption.mp4`,
  );
  const clipFileBase =
    buildClipFileName(
      clip.aiAnalysis?.rank,
      clip.aiAnalysis?.viral_packaging.video_title,
      clip.aiAnalysis?.viral_packaging.hashtags,
    ) || clipId;
  const finalVideoPath = uniqueClipPath(outputDir, clipFileBase);

  // `worker/index.ts` owns the job-token watcher. The signal is shared by
  // speaker detection, Remotion and FFmpeg; no per-clip polling race can let a
  // cancelled attempt write after a replacement job claims this clip.
  // Track transient Remotion directories from the moment each branch completes,
  // including B-roll that completed in parallel before later caption work fails.
  let captionOverlaysForCleanup: PreparedCaptionOverlays | null = null;
  let brollOverlaysForCleanup: PreparedBrollOverlays | null = null;
  try {
    checkCancelled();
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    /**
     * Probe the SOURCE once: FFprobe's average/base rates identify VFR inputs,
     * the stream starts keep audio aligned to video, and fps selects the CFR
     * overlay/output cadence. Missing ffprobe is reported by getVideoMetadata().
     */
    const sourceMeta = await jobTimer.measure("source-probe", () =>
      getVideoMetadata(video.filePath),
    );
    const renderFps = normalizeFps(sourceMeta.fps);
    const sourceVariableFrameRate = sourceMeta.isVariableFrameRate === true;
    const audioStartOffsetSeconds =
      sourceMeta.audioStartTime === null
        ? 0
        : sourceMeta.audioStartTime - sourceMeta.videoStartTime;
    const rateDetail =
      sourceMeta.averageFrameRate && sourceMeta.nominalFrameRate
        ? `avg/r=${sourceMeta.averageFrameRate}/${sourceMeta.nominalFrameRate}`
        : "FFprobe frame rates unavailable";
    log.detail(
      `Source ${sourceMeta.width}x${sourceMeta.height} @ ${sourceMeta.fps}fps ` +
        `(${rateDetail}${sourceVariableFrameRate ? ", VFR → CFR normalize" : ""}; render @ ${renderFps}fps), ` +
        `audio=${sourceMeta.hasAudio ? "yes" : "no"}, ${sourceMeta.duration.toFixed(1)}s`,
    );
    if (sourceMeta.hasAudio && Math.abs(audioStartOffsetSeconds) > 0.001) {
      log.detail(
        `Audio stream starts ${audioStartOffsetSeconds >= 0 ? "+" : ""}${audioStartOffsetSeconds.toFixed(3)}s from video; preserving this offset.`,
      );
    }

    const segmentDuration = Math.max(0.1, end - start);

    // Compute the clip's words UP FRONT: captions need them, the hook-moment
    // detector needs them, and a window without spoken words should fail fast
    // before we waste an FFmpeg encode on it.
    const allWords = video.transcript?.words || [];
    const clipWords = allWords
      .filter(
        (word) =>
          word.end >= start - WORD_SLACK_SECONDS &&
          word.start <= end + WORD_SLACK_SECONDS,
      )
      .map((word) => ({
        ...word,
        // Relative to the segment start; the composition adds hookDuration back on.
        start: Math.max(0, word.start - start),
        end: Math.max(0.1, word.end - start),
      }));

    if (clipWords.length === 0) {
      throw new AppError(
        "No transcript words were found for this clip window.",
        {
          status: 400,
          details: `window=${start}s-${end}s, transcriptWords=${allWords.length}`,
          resolution:
            "Re-run transcription, or pick a segment that overlaps spoken audio - captions need word timings.",
        },
      );
    }

    // This adjustment is deliberately caption-only. The audio filter and profanity
    // windows below continue to use the original transcript timestamps.
    const captionOffsetMs = getCaptionOffsetMs();
    const captionWords = shiftCaptionWords(clipWords, captionOffsetMs);
    if (captionOffsetMs !== 0) {
      log.detail(
        `Caption offset ${captionOffsetMs > 0 ? "+" : ""}${captionOffsetMs}ms (positive = captions later; audio unchanged).`,
      );
    }

    // Resolve safety exactly once for this render. Viral detection already returns
    // explicit risky phrases, so reuse its validated result first rather than
    // paying for a second LLM moderation pass. The optional LLM pass remains a
    // fail-open fallback for older clips / empty safety data, or an explicit audit.
    const viralSafety = findViralSafetyWordIndexes(clipWords, clip.aiAnalysis);
    const forceLlmSafetyReview = getForceLlmSafetyReview();
    const contextualSafetyEnabled = getProfanityContextPassEnabled();
    const shouldRunLlmSafetyReview =
      forceLlmSafetyReview ||
      (contextualSafetyEnabled && viralSafety.phrases.length === 0);
    let contextualCensorIndexes: number[] = [];

    if (viralSafety.phrases.length > 0) {
      log.info(
        `[LLM] safety reuse clip=${clipId} phrases=${viralSafety.phrases.length} ` +
          `matched_word_indexes=${viralSafety.indexes.length}` +
          (forceLlmSafetyReview ? " force_review=1" : ""),
      );
    }
    if (shouldRunLlmSafetyReview) {
      log.info(
        `[LLM] safety fallback clip=${clipId} reason=` +
          (forceLlmSafetyReview ? "FORCE_LLM_SAFETY_REVIEW" : "no-viral-safety-data"),
      );
      contextualCensorIndexes = await jobTimer.measure("safety-review", () =>
        findContextCensorWordIndexes(clipWords, {
          enabled: true,
          signal: execution.signal,
        }),
      );
    } else if (viralSafety.phrases.length === 0 && !contextualSafetyEnabled) {
      log.detail("LLM safety review is disabled and viral analysis supplied no risky phrases.");
    }

    const censoredWordIndexes = resolveCensoredWordIndexes(clipWords, [
      ...viralSafety.indexes,
      ...contextualCensorIndexes,
    ]);
    const renderSettings = (await loadEffectiveSettings()).render;
    checkCancelled();

    // hookDuration/ctaDuration are optional on the job payload; never pass undefined
    // into the FFmpeg/Remotion stages or the timeline maths silently breaks.
    // A positive hookDuration means "hook intro enabled". When viral analysis has
    // a valid hook_timestamp, its complete start→end interval is the actual intro
    // duration; the 3s value is only a fallback for older/invalid analysis data.
    const rawHookDuration =
      Number.isFinite(hookDuration) && (hookDuration ?? 0) >= 0
        ? (hookDuration as number)
        : DEFAULT_HOOK_FALLBACK_SECONDS;
    const hookOff = rawHookDuration < 0.15;

    // Reuse the hook interval selected and stored during clip creation (or edited by the user).
    const hook = clip.aiAnalysis?.hook_line_analysis;
    const hookTiming = resolveHookTiming({
      enabled: !hookOff,
      clipStart: start,
      clipEnd: end,
      hookTimestampStart: hook?.hook_timestamp.start,
      hookTimestampEnd: hook?.hook_timestamp.end,
      fallbackDuration: rawHookDuration,
    });
    const safeHookDuration = hookTiming.duration;
    const hookStart = hookTiming.start;

    if (hookTiming.source === "timestamps") {
      log.ok(
        `Hook moment (from viral prompt): ${hookTiming.startAbsolute!.toFixed(1)}s → ` +
          `${hookTiming.endAbsolute!.toFixed(1)}s (${safeHookDuration.toFixed(2)}s)` +
          (hook?.hook_line ? `  ("${hook.hook_line}")` : ""),
      );
    } else if (hookTiming.source === "fallback") {
      log.detail(
        `No usable hook timestamp range on this clip - using a ${safeHookDuration.toFixed(2)}s fallback.`,
      );
    }

    log.step("Step 1/3 · Face tracking + active speaker detection");
    const layout: ClipLayout =
      jobData.layout === "split-screen" ? "split-screen" : "speaker-focus";
    clip.layout = layout;

    // Resolving the base caption preset is database-only work. For a speaker-focus
    // clip its caption colour and B-roll anchor cannot change after ASD, so doing
    // it before ASD lets the independent B-roll branch start safely.
    const requestedCaptionPresetId =
      typeof captionPresetId === "string" && captionPresetId.trim()
        ? captionPresetId.trim()
        : clip.captionPresetId?.trim() || undefined;
    const defaultCaptionPreset = requestedCaptionPresetId
      ? null
      : await getDefaultCaptionPreset();
    const resolvedCaptionPresetId =
      requestedCaptionPresetId ?? defaultCaptionPreset?._id;
    if (!resolvedCaptionPresetId) {
      throw new AppError(
        "No caption preset is selected and no database default is configured.",
        {
          status: 500,
          resolution:
            "Choose a default caption preset in preset settings before rendering.",
        },
      );
    }
    const preset = await getCaptionPreset(resolvedCaptionPresetId);
    if (!preset) {
      throw new AppError(
        `Caption preset ${resolvedCaptionPresetId} was not found.`,
        {
          status: 404,
          resolution:
            "Select an existing caption preset from the dashboard and retry rendering.",
        },
      );
    }
    const totalDuration = segmentDuration + safeHookDuration;
    const overlayProgressSink = (progress: number): void => {
      const scaled = 20 + Math.max(0, Math.min(100, progress)) * 0.1;
      clip.progress = Math.max(clip.progress ?? 0, Math.round(scaled));
      void persistClip(clip).catch((error) =>
        log.warn("progress save failed: " + toErrorMessage(error)),
      );
      void reportProgress(scaled);
    };

    // No fallbacks by design: detectSpeakerTimeline throws an informative
    // error when it finds no face in the window (or YuNet is unavailable),
    // and the render STOPS - no static-centre crop, no legacy skin track.
    //
    // Speaker-focus B-roll has a fixed anchor, so it can render while ASD reads
    // and samples the source. A split-screen job can now join that overlap when
    // every item is fullscreen: only landscape cards need ASD's final face bands
    // for their seam placement and therefore retain the proven sequential path.
    const brollPlan = clip.broll ?? null;
    const parallelBrollRequested = getParallelBrollAsdEnabled();
    const parallelBrollEligible = Boolean(
      parallelBrollRequested &&
        canParallelizeBrollWithAsd(layout, brollPlan?.items),
    );
    if (parallelBrollRequested && !parallelBrollEligible) {
      log.detail(
        !brollPlan?.items.length
          ? "B-roll/ASD parallel rendering requested, but this clip has no B-roll items."
          : "B-roll/ASD parallel rendering is skipped because a split-screen landscape card needs final face-safe placement.",
      );
    }

    checkCancelled();
    let parallelBrollPreparation: BrollRenderPreparation | null = null;
    let asd: Awaited<ReturnType<typeof detectSpeakerTimeline>>;
    if (parallelBrollEligible && brollPlan) {
      log.detail(
        layout === "speaker-focus"
          ? "B-roll/ASD parallel rendering enabled: starting the fixed-anchor B-roll branch beside active-speaker detection."
          : "B-roll/ASD parallel rendering enabled: split-screen fullscreen B-roll does not depend on face-band placement.",
      );
      const [brollPreparation, detectedSpeakerTimeline] =
        await runParallelRenderBranches(
          execution.signal,
          (signal) =>
            jobTimer.measure("broll-remotion", () =>
              prepareBrollForRender({
                brollPlan,
                fps: renderFps,
                totalDuration,
                captionPreset: preset,
                // Any split-screen branch reaching here contains fullscreen-only
                // B-roll; speaker-focus remains the established fixed-card path.
                cardLayout: "speaker-focus",
                // Do not race ASD's planning persistence with background progress
                // writes. Remotion still emits detailed frame diagnostics; normal
                // overlay progress resumes after the joined branches.
                onProgress: () => undefined,
                remotionConcurrencyCap: getParallelBrollAsdConcurrencyCap(),
                onStageTiming: brollStageTiming,
                signal,
                isCancelled: () => signal.aborted,
              }),
            ),
          (signal) =>
            jobTimer.measure("asd", () =>
              detectSpeakerTimeline(
                video.filePath,
                start,
                segmentDuration,
                sourceMeta.width,
                sourceMeta.height,
                {
                  hasAudio: sourceMeta.hasAudio,
                  signal,
                  onStageTiming: asdStageTiming,
                },
              ),
            ),
        );
      parallelBrollPreparation = brollPreparation;
      brollOverlaysForCleanup = brollPreparation.preparedBroll;
      asd = detectedSpeakerTimeline;
    } else {
      asd = await jobTimer.measure("asd", () =>
        detectSpeakerTimeline(
          video.filePath,
          start,
          segmentDuration,
          sourceMeta.width,
          sourceMeta.height,
          {
            hasAudio: sourceMeta.hasAudio,
            signal: execution.signal,
            onStageTiming: asdStageTiming,
          },
        ),
      );
    }
    const splitFraming = getSplitFramingSettings();
    const plan = buildLayoutPlan(
      asd,
      layout,
      sourceMeta.width,
      sourceMeta.height,
      splitFraming,
    );
    if (layout === "split-screen") {
      log.detail(
        `Split framing: face target ${(splitFraming.faceTargetFrac * 100).toFixed(0)}% of pane height, ` +
          `maximum crop zoom ${splitFraming.zoom.toFixed(1)}x.`,
      );
    }
    checkCancelled();

    // Say what was ACTUALLY produced. A split request must never quietly turn
    // into something else: when only one person is found the planner renders a
    // single speaker window, and that is reported loudly here and on the clip.
    // Persist an empty string to clear any note from a previous render.
    clip.layoutNote = "";
    if (layout === "split-screen") {
      if (plan.mode === "split") {
        log.ok(
          `Split screen: ${plan.cells.length} panes - ` +
            plan.cells
              .map((cell, i) => `pane ${i + 1} = person#${cell.trackId}`)
              .join(", "),
        );
      } else {
        clip.layoutNote =
          plan.splitFallbackReason ??
          "Split screen could not be applied; rendered a single speaker window.";
        log.warn(`SPLIT SCREEN NOT APPLIED - ${clip.layoutNote}`);
      }
    }

    if (plan.mode === "single") {
      clip.cropData = {
        x: 0,
        y: 0,
        width: plan.cropW,
        height: plan.cropH,
      };
    }
    // The parallel B-roll branch may already have reported overlay progress.
    // Keep progress monotonic rather than moving the UI backwards after ASD.
    clip.progress = Math.max(clip.progress ?? 0, 20);
    if (!(await persistClip(clip))) {
      throw new RenderCancelledError(
        "Clip was deleted while render planning was in progress.",
      );
    }
    await reportProgress(20);

    // hookDuration 0 means the hook intro/overlay was turned off for this clip
    // (detection ran with the hook-text switch off) - don't derive text that
    // would only be ignored by the overlay.
    const hookOverlayEnabled = safeHookDuration > 0;
    const resolvedHookText = !hookOverlayEnabled
      ? ""
      : hookText?.trim() ||
        clip.hookText?.trim() ||
        deriveOverlayText(clipWords, 8, "WATCH THIS");
    if (!hookOverlayEnabled) {
      log.detail(
        "Hook overlay disabled for this clip (hookDuration=0) - rendering without hook text.",
      );
    } else if (!hookText?.trim() && !clip.hookText?.trim()) {
      log.warn(
        `No hook text supplied - derived "${resolvedHookText}" from the transcript.`,
      );
    }

    // ctaDuration 0 means the CTA card was turned off for this clip (detection
    // ran with the CTA switch off) - don't derive text that would only be
    // ignored by the overlay. An explicit job-payload ctaDuration > 0 re-enables
    // it for a re-render.
    const rawCtaDuration = Number.isFinite(ctaDuration)
      ? (ctaDuration as number)
      : (clip.ctaDuration ?? 2.5);
    const ctaOverlayEnabled = rawCtaDuration > 0;
    const resolvedCtaText = !ctaOverlayEnabled
      ? ""
      : ctaText?.trim() ||
        clip.ctaText?.trim() ||
        deriveOverlayText(clipWords.slice(-10), 8, "FOLLOW FOR MORE");
    if (!ctaOverlayEnabled) {
      log.detail(
        "CTA overlay disabled for this clip (ctaDuration=0) - rendering without CTA text.",
      );
    } else if (!ctaText?.trim() && !clip.ctaText?.trim()) {
      log.warn(
        `No CTA text supplied - derived "${resolvedCtaText}" from the transcript.`,
      );
    }

    const resolvedCtaDuration = ctaOverlayEnabled ? rawCtaDuration : 0;

    // Overlay STYLE presets (font/colors/card/animation) - per clip, falling
    // back to the seeded defaults. The TEXT above stays prompt-generated.
    const requestedHookStylePresetId = [
      jobData.hookStylePresetId,
      clip.hookStylePresetId,
    ]
      .find((id) => typeof id === "string" && id.trim())
      ?.trim();
    const requestedCtaStylePresetId = [
      jobData.ctaStylePresetId,
      clip.ctaStylePresetId,
    ]
      .find((id) => typeof id === "string" && id.trim())
      ?.trim();
    const hookStyle = await resolveOverlayStyle(
      requestedHookStylePresetId,
      "hook",
    );
    const ctaStyle = await resolveOverlayStyle(
      requestedCtaStylePresetId,
      "cta",
    );

    // Persist the resolved ids so legacy clips keep the exact presets used by
    // this render even if the database defaults change before a later rerender.
    clip.captionPresetId = resolvedCaptionPresetId;
    clip.hookStylePresetId = hookStyle._id;
    clip.ctaStylePresetId = ctaStyle._id;
    if (!(await persistClip(clip))) {
      throw new RenderCancelledError(
        "Clip was deleted while presets were being resolved.",
      );
    }

    // A selected caption theme also skins the Hook and CTA card typography,
    // palette and motion. Keep the saved standalone presets intact; these are
    // render-time variants used identically by the preview and the worker.
    const themedHookStyle = resolveCaptionThemeOverlayStyle(preset, hookStyle);
    const themedCtaStyle = resolveCaptionThemeOverlayStyle(preset, ctaStyle);

    // Where the captions / hook / CTA go depends on the layout. In a split screen
    // the preset positions would land on the two faces, so they are re-placed from
    // where the heads really are (speaker focus keeps the presets unchanged).
    const overlayLayout = adaptOverlaysToLayout({
      plan,
      // When the timed overlays are on screen (base-clip seconds): the hook card
      // shows over the replayed hook moment, minus the dip-to-black window; the CTA
      // over the last seconds of the clip.
      timing: {
        clipDuration: segmentDuration,
        hookStart,
        hookVisibleSeconds: Math.max(
          0,
          safeHookDuration -
            Math.min(HOOK_TRANSITION_SECONDS, safeHookDuration / 2),
        ),
        ctaDuration: resolvedCtaDuration,
      },
      caption: preset,
      hook: hookOverlayEnabled
        ? { style: themedHookStyle, text: resolvedHookText }
        : null,
      cta: ctaOverlayEnabled
        ? { style: themedCtaStyle, text: resolvedCtaText }
        : null,
    });
    if (overlayLayout.adapted) {
      log.detail(
        `Overlay layout (split screen): ${describePlacements(overlayLayout)}`,
      );
      for (const note of overlayLayout.notes) log.detail(`  · ${note}`);
    }
    const captionPresetForRender = overlayLayout.caption;
    const hookStyleForRender = overlayLayout.hookStyle ?? themedHookStyle;
    const ctaStyleForRender = overlayLayout.ctaStyle ?? themedCtaStyle;

    log.step(
      `Step 2/3 · Render transparent overlays (Remotion)  ${color.gray(`(${clipWords.length} words, preset "${preset.name}")`)}`,
    );
    checkCancelled();
    const preparedOverlays: PreparedCaptionOverlays =
      await jobTimer.measure("caption-remotion", () =>
        prepareRemotionCaptionOverlays({
          fps: renderFps,
          totalDuration,
          hookText: resolvedHookText,
          hookDuration: safeHookDuration,
          hookStart,
          hookTransitionDuration:
            safeHookDuration > 0
              ? Math.min(HOOK_TRANSITION_SECONDS, safeHookDuration / 2)
              : 0,
          ctaText: resolvedCtaText,
          ctaDuration: resolvedCtaDuration,
          words: captionWords,
          censoredWordIndexes,
          preset: captionPresetForRender,
          hookStyle: hookStyleForRender,
          ctaStyle: ctaStyleForRender,
          captionLiftScale: overlayLayout.captionLiftScale,
          onProgress: overlayProgressSink,
          isCancelled: () => Boolean(execution.signal?.aborted),
          signal: execution.signal,
          onStageTiming: captionStageTiming,
        }),
      );
    captionOverlaysForCleanup = preparedOverlays;

    /**
     * B-roll is planned before rendering and is optional. In the safe parallel
     * path above this work is already complete; otherwise preserve the legacy
     * ordering and use the resolved ASD/layout data here.
     */
    let brollPreparation = parallelBrollPreparation;
    if (!brollPreparation && brollPlan && brollPlan.items.length > 0) {
      const cardLayout =
        plan.mode === "split" ? "split-screen" : "speaker-focus";
      const faceBands =
        plan.mode === "split"
          ? plan.cells.map((cell) => ({
              top: cell.faceZone.top,
              bottom: cell.faceZone.bottom,
            }))
          : [];
      brollPreparation = await jobTimer.measure("broll-remotion", () =>
        prepareBrollForRender({
          brollPlan,
          fps: renderFps,
          totalDuration,
          captionPreset: captionPresetForRender,
          cardLayout,
          faceBands,
          onProgress: overlayProgressSink,
          signal: execution.signal,
          isCancelled: () => Boolean(execution.signal?.aborted),
          onStageTiming: brollStageTiming,
        }),
      );
    }

    const preparedBroll = brollPreparation?.preparedBroll ?? null;
    brollOverlaysForCleanup = preparedBroll;
    const brollSequences = brollPreparation?.sequences ?? [];
    const brollFileCount = brollPreparation?.fileCount ?? 0;
    const sfx = brollPreparation?.sfx ?? [];
    if (brollSequences.length > 0) {
      log.detail(
        `B-roll: ${brollSequences.length} sequence(s) from ${brollFileCount} image(s), ` +
          `${sfx.length} sound effect(s); painted UNDER the captions`,
      );
    }

    let renderResult: {
      fps: number;
      width: number;
      height: number;
      durationSeconds: number;
      fileSizeBytes: number;
    };
    try {
      checkCancelled();
      log.step(
        `Step 3/3 · FFmpeg crop + hook + overlays + one final encode ` +
          color.gray(
            `(${preparedOverlays.sequences.length} transparent layer(s))`,
          ),
      );
      const progressSink = (progress: number): void => {
        const scaled = 30 + Math.max(0, Math.min(80, progress)) * 0.85;
        clip.progress = Math.max(clip.progress ?? 0, Math.round(scaled));
        void persistClip(clip).catch((error) =>
          log.warn("progress save failed: " + toErrorMessage(error)),
        );
        void reportProgress(scaled);
      };

      log.info(
        `[RENDER-DIAG] stage=ffmpeg.process-video-segment event=before overlays=${[...brollSequences, ...preparedOverlays.sequences].length} broll_overlays=${brollSequences.length} output=${finalVideoPath}`,
      );
      const processVideoStartedAt = Date.now();
      await jobTimer.measure("ffmpeg-composite", () =>
        processVideoSegment({
          sourceVideoPath: video.filePath,
          outputPath: finalVideoPath,
          start,
          end,
          hookDuration: safeHookDuration,
          hookStart,
          filterPresetId: filterPreset,
          plan,
          sourceWidth: sourceMeta.width,
          sourceHeight: sourceMeta.height,
          targetFps: renderFps,
          sourceHasAudio: sourceMeta.hasAudio,
          // ORDER IS THE CONTRACT: B-roll sequences first, so the caption/hook/CTA
          // layer is composited ON TOP of every image.
          overlays: [...brollSequences, ...preparedOverlays.sequences],
          sfx,
          words: clipWords,
          censoredWordIndexes,
          fadeOutSeconds: renderSettings.fadeOutSeconds,
          debugOutputPath:
            process.env.SAVE_PRECAPTION_DEBUG?.trim() === "1"
              ? intermediateVideoPath
              : undefined,
          isCancelled: () => Boolean(execution.signal?.aborted),
          signal: execution.signal,
          sourceIsVariableFrameRate: sourceVariableFrameRate,
          videoStartTimeSeconds: sourceMeta.videoStartTime,
          audioStartOffsetSeconds,
          onProgress: progressSink,
        }),
      );
      log.info(
        `[RENDER-DIAG] stage=ffmpeg.process-video-segment event=after time_taken_ms=${Date.now() - processVideoStartedAt} output=${finalVideoPath}`,
      );

      log.info("[RENDER-DIAG] stage=ffmpeg.output-probe event=before");
      const outputProbeStartedAt = Date.now();
      const outputMeta = await jobTimer.measure("output-probe", () =>
        getVideoMetadata(finalVideoPath),
      );
      log.info(
        `[RENDER-DIAG] stage=ffmpeg.output-probe event=after time_taken_ms=${Date.now() - outputProbeStartedAt}`,
      );
      renderResult = {
        fps: outputMeta.fps,
        width: outputMeta.width,
        height: outputMeta.height,
        durationSeconds: outputMeta.duration,
        fileSizeBytes: fs.statSync(finalVideoPath).size,
      };
    } finally {
      // FFmpeg has finished (or failed) reading all image2/ffconcat inputs. Use
      // the durable cleanup queue rather than silently leaving locked PNGs on
      // Windows, then clear the outer references to avoid a redundant second try.
      await cleanupPreparedOverlayFrames(preparedOverlays, "caption-overlay-frames");
      captionOverlaysForCleanup = null;
      await cleanupPreparedOverlayFrames(preparedBroll, "broll-overlay-frames");
      brollOverlaysForCleanup = null;
    }

    clip.status = "done";
    clip.progress = 100;
    clip.hookText = resolvedHookText;
    clip.ctaText = resolvedCtaText;
    clip.ctaDuration = resolvedCtaDuration;
    clip.captionPresetId = resolvedCaptionPresetId;
    clip.captionPreset = preset;
    clip.hookStylePresetId = hookStyle._id;
    clip.ctaStylePresetId = ctaStyle._id;
    clip.outputPath = `/generated-clips/${outputBase}/${path.basename(finalVideoPath)}`;
    clip.outputFileSize = renderResult.fileSizeBytes;
    clip.outputFps = renderResult.fps;
    clip.error = undefined;
    if (!(await persistClip(clip))) {
      throw new RenderCancelledError(
        "Clip was deleted while rendering was finishing.",
      );
    }
    await reportProgress(100);

    log.ok(
      `Rendered ${color.bold(clipId)}: ${renderResult.width}x${renderResult.height} @ ` +
        `${renderResult.fps}fps, ${renderResult.durationSeconds.toFixed(2)}s, ` +
        `${(renderResult.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );
    log.detail(`→ ${finalVideoPath}`);
    jobTimingOutcome = "done";
    return clip;
  } catch (error) {
    if (error instanceof RenderCancelledError || execution.signal?.aborted) {
      // Never leave a playable-looking partial MP4 after a cancelled FFmpeg
      // process. Windows may defer this deletion through the normal video/clip
      // deletion sweep, but force removes it on every other platform.
      for (const output of [finalVideoPath, intermediateVideoPath]) {
        await removePathOrDefer(output, "cancelled-render-output").catch((cleanupError) =>
          log.warn(`Could not remove cancelled render output ${output}: ${toErrorMessage(cleanupError)}`),
        );
      }
      // A cancel is not a failure: persist the cancelled state, end the job
      // cleanly (no rethrow -> no retry).
      log.warn(`Render cancelled by user: ${color.bold(clipId)}`);
      clip.status = "failed";
      clip.error = "Cancelled by user.";
      clip.cancelling = false;
      await persistClip(clip).catch((saveError) =>
        log.error(
          "Could not persist the cancelled state: " + toErrorMessage(saveError),
        ),
      );
      jobTimingOutcome = "cancelled";
      return clip;
    }
    log.error(
      `Render failed for ${color.bold(clipId)}: ${toErrorMessage(error)}`,
    );
    clip.status = "failed";
    clip.error = toErrorMessage(error);
    clip.cancelling = false;
    await persistClip(clip).catch((saveError) =>
      log.error(
        "Could not persist the failure state: " + toErrorMessage(saveError),
      ),
    );
    throw error;
  } finally {
    // A parallel B-roll branch can finish before later overlay work throws. Clean
    // both directories from this outer scope as well as the normal post-FFmpeg
    // path so cancellation/failure never leaves transparent-frame work behind.
    await Promise.all([
      cleanupPreparedOverlayFrames(captionOverlaysForCleanup, "caption-overlay-frames"),
      cleanupPreparedOverlayFrames(brollOverlaysForCleanup, "broll-overlay-frames"),
    ]);
    // The shared queue controller is disposed by worker/index.ts.
    jobTimer.logSummary(jobTimingOutcome);
  }
}

/** Same-title clips must not overwrite each other: append -2, -3, ... if needed. */
function uniqueClipPath(dir: string, base: string): string {
  let candidate = path.join(dir, `${base}.mp4`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${suffix}.mp4`);
    suffix += 1;
  }
  return candidate;
}
