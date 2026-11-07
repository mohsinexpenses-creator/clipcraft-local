/**
 * The `broll` queue job: plan B-roll for ONE clip and store the plan on the clip
 * row. Runs after viral detection and before the render (auto pipelines), and on
 * demand from the clip tile (manual re-run). Re-running never duplicates images:
 * the plan is replaced, not appended to.
 *
 * The render step only reads the stored plan, so a re-render is free and cannot
 * change the images.
 */

import { AppError, RenderCancelledError } from "../lib/errors";
import {
  getClip,
  getDefaultCaptionPreset,
  getVideo,
  saveClipBrollPlan,
  saveClipBrollPlanForRunningJob,
  updateClip,
  updateClipForRunningJob,
} from "../lib/db";
import { loadEffectiveSettings } from "../lib/app-settings";
import { DEFAULT_BROLL_OPTIONS, type BrollJobData, type BrollPlan, type WordTimestamp } from "../lib/types";
import { resolveBrollOptions } from "../lib/pipeline-defaults";
import { resolveHookTiming, DEFAULT_HOOK_FALLBACK_SECONDS } from "./hook-timing";
import path from "node:path";
import { captionReservedBand } from "../lib/overlay-stack";
import { buildBrollPlan } from "../lib/broll/plan";
import type { FaceZoneRect } from "../lib/broll/card";
import { mapFaceToCanvas } from "../lib/broll/card";
import { createBrollDeps } from "./broll-sources";

/** Words are matched to the clip window with the same slack the renderer uses. */
const WORD_SLACK_SECONDS = 0.35;

export interface BrollJobResult {
  status: "done" | "failed" | "skipped";
  plan?: BrollPlan;
  error?: string;
}

function clipWordsFor(videoWords: readonly WordTimestamp[], start: number, end: number): WordTimestamp[] {
  return videoWords
    .filter((word) => word.end >= start - WORD_SLACK_SECONDS && word.start <= end + WORD_SLACK_SECONDS)
    .map((word) => ({
      word: word.word,
      // Clip-relative, exactly like the caption pipeline.
      start: Math.max(0, word.start - start),
      end: Math.max(0.1, word.end - start),
    }));
}

/**
 * Face boxes on the canvas, sampled from the source video. A landscape card must
 * never sit on the speaker's face; without a sample the card still avoids the
 * caption band and the usual head area, so this is an improvement, not a
 * requirement (and a failure here never fails the job).
 */
async function sampleFaceZones(
  videoPath: string,
  clipStart: number,
  clipDuration: number,
  signal?: AbortSignal,
): Promise<FaceZoneRect[]> {
  try {
    if (signal?.aborted) throw new RenderCancelledError();
    const { sampleSegmentFrames, cleanupSampledFrames } = await import("./frame-sampler");
    const { loadYuNet, detectFacesYunet } = await import("./yunet-detector");
    const runtime = await loadYuNet();
    if (!runtime) return [];
    const sampled = await sampleSegmentFrames(
      videoPath,
      clipStart,
      Math.min(clipDuration, 12),
      1,
      3,
      "broll-faces",
      480,
      signal,
    );
    try {
      const { Jimp } = await import("jimp");
      const zones: FaceZoneRect[] = [];
      for (const frame of sampled.frames) {
        if (signal?.aborted) throw new RenderCancelledError();
        const image = await Jimp.read(frame);
        const faces = await detectFacesYunet(runtime, {
          data: Buffer.from(image.bitmap.data),
          width: image.bitmap.width,
          height: image.bitmap.height,
        });
        const best = faces.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
        if (!best) continue;
        const zone = mapFaceToCanvas(best.box, image.bitmap.width, image.bitmap.height);
        if (zone) zones.push(zone);
      }
      return zones;
    } finally {
      if (sampled.frames[0]) cleanupSampledFrames(path.dirname(sampled.frames[0]));
    }
  } catch (error) {
    if (error instanceof RenderCancelledError || signal?.aborted) throw new RenderCancelledError();
    console.warn(
      `[broll] Face zone sampling skipped: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Run the B-roll step for one clip. A failure is recorded on the clip (so the
 * tile can show it) and rethrown for the queue's retry/backoff logic.
 */
export async function runBrollJob(
  data: BrollJobData,
  onProgress: (percent: number) => void,
  execution: { signal?: AbortSignal; jobId?: string; startedAt?: string; claimToken?: string } = {},
): Promise<BrollJobResult> {
  const throwIfCancelled = (): void => {
    if (execution.signal?.aborted) throw new RenderCancelledError();
  };
  const persistClip = async (candidate: Parameters<typeof updateClip>[0]): Promise<boolean> =>
    execution.jobId && execution.startedAt
      ? updateClipForRunningJob(candidate, execution.jobId, execution.startedAt, execution.claimToken)
      : updateClip(candidate);
  const persistPlan = async (
    plan: BrollPlan | null,
    status: NonNullable<Parameters<typeof saveClipBrollPlan>[2]>,
    error?: string,
  ): Promise<boolean> => execution.jobId && execution.startedAt
    ? saveClipBrollPlanForRunningJob(
      data.clipId,
      plan,
      status,
      error,
      execution.jobId,
      execution.startedAt,
      execution.claimToken,
    )
    : saveClipBrollPlan(data.clipId, plan, status, error);
  throwIfCancelled();
  const clip = await getClip(data.clipId);
  if (!clip) throw new AppError("The clip for this B-roll job no longer exists.", { status: 404 });
  const video = await getVideo(clip.videoId ?? data.videoId ?? "");
  if (!video) throw new AppError("The video for this B-roll job no longer exists.", { status: 404 });

  const clipStart = Number.isFinite(clip.start) ? clip.start : 0;
  const clipEnd = Number.isFinite(clip.end) ? clip.end : clipStart + 30;
  const clipDuration = Math.max(0.5, clipEnd - clipStart);
  const trigger: BrollJobData["trigger"] = data.trigger ?? "auto";

  const settings = await loadEffectiveSettings();
  const options = resolveBrollOptions(
    (video.pipeline?.broll as unknown) ?? (settings.pipeline?.broll as unknown) ?? DEFAULT_BROLL_OPTIONS
  );

  if (!options.autoBroll && trigger === "auto") {
    console.log("[broll] autoBroll is off for this video - nothing to do.");
    return { status: "skipped" };
  }

  // The tile shows "planning…" while the job runs; nothing else writes this field.
  // Set only once the job will really do work, so a skipped clip is not left
  // advertising a plan that no job is producing.
  clip.brollStatus = "running";
  clip.brollError = undefined;
  if (!(await persistClip(clip))) throw new RenderCancelledError();

  const jobWords = (video.transcript?.words ?? []) as WordTimestamp[];
  const words = clipWordsFor(jobWords, clipStart, clipEnd);
  if (words.length === 0) {
    const plan: BrollPlan = {
      version: 1,
      generatedAt: new Date().toISOString(),
      trigger,
      clipDuration,
      hookDuration: 0,
      totalDuration: clipDuration,
      options,
      items: [],
      skipped: [{ stage: "analysis", reason: "No transcript words in this clip window." }],
      counts: { targetMin: 0, targetMax: 0, fullscreen: 0, landscape: 0 },
      notes: ["The clip has no spoken words, so no B-roll was planned."],
    };
    if (!(await persistPlan(plan, "done"))) throw new RenderCancelledError();
    return { status: "done", plan };
  }

  // The hook replay is part of the rendered timeline but never gets B-roll.
  const hook = clip.aiAnalysis?.hook_line_analysis;
  const rawHookDuration =
    Number.isFinite(clip.hookDuration) && (clip.hookDuration ?? 0) >= 0
      ? (clip.hookDuration as number)
      : DEFAULT_HOOK_FALLBACK_SECONDS;
  const hookTiming = resolveHookTiming({
    enabled: rawHookDuration >= 0.15,
    clipStart,
    clipEnd,
    hookTimestampStart: hook?.hook_timestamp.start,
    hookTimestampEnd: hook?.hook_timestamp.end,
    fallbackDuration: rawHookDuration,
  });

  const captionPreset = clip.captionPreset ?? (await getDefaultCaptionPreset());
  const captionBand = captionPreset
    ? captionReservedBand(captionPreset)
    : { top: 1230, bottom: 1440 };

  onProgress(10);
  const faceZones = await sampleFaceZones(video.filePath, clipStart, clipDuration, execution.signal);
  throwIfCancelled();
  onProgress(20);

  const deps = createBrollDeps({
    ai: settings.ai,
    providerOrder: options.providerOrder,
    signal: execution.signal,
  });

  let plan: BrollPlan;
  try {
    plan = await buildBrollPlan(
      {
        clipDuration,
        hookDuration: hookTiming.duration,
        words,
        options,
        trigger,
        captionBand,
        faceZones,
        signal: execution.signal,
      },
      deps
    );
  } catch (error) {
    if (error instanceof RenderCancelledError || execution.signal?.aborted) throw new RenderCancelledError();
    const message = error instanceof Error ? error.message : String(error);
    if (!(await persistPlan(null, "failed", message))) throw new RenderCancelledError();
    throw error;
  }

  // Everything before this point is preparation; only now does the plan exist.
  onProgress(95);
  throwIfCancelled();
  const saved = await persistPlan(plan, "done");
  if (!saved) throw new RenderCancelledError("The B-roll plan could not be saved because the job was cancelled.");
  onProgress(100);
  return { status: "done", plan };
}
