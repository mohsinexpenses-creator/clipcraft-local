import {
  getClip,
  getDefaultCaptionPreset,
  getVideo,
  listClips,
  saveClip,
  saveClipForRunningJob,
  updateClip,
  updateVideo,
  updateVideoForRunningJob,
} from './db';
import {
  detectViralSegments,
  generateCtaText,
  generateHookText,
  detectHookMoment,
} from './ai';
import { AppError, RenderCancelledError, toErrorMessage } from './errors';
import { log } from './logger';
import {
  BROLL_QUEUE_NAME,
  CLIP_QUEUE_NAME,
  TRANSCRIPTION_QUEUE_NAME,
  VIRAL_DETECTION_QUEUE_NAME,
  enqueueBrollJob,
  enqueueClipJob,
  enqueueTranscriptionJob,
  enqueueViralDetectionJob,
  findActiveJob,
  findLatestJob,
  isJobClaimCurrent,
  type PipelineEnqueueContext,
} from './queue';
import { resolveBrollOptions, sanitizePipelineOptions } from './pipeline-defaults';
import { parseTimestamp } from './viral-response';
import { loadEffectiveSettings } from './app-settings';
import {
  BrollOptions,
  ClipLayout,
  ClipRecord,
  JobData,
  RenderDefaults,
  PipelineOptions,
  VideoRecord,
  ViralDetectionOptions,
} from './types';

/**
 * The upload pipeline: transcribe -> detect viral clips -> render.
 *
 * Every step is a queue job, and every step hands over to the next one, so the
 * chain survives a page refresh, a dev-server reload and a worker restart. The
 * three entry points that start it are all here:
 *
 *   - the upload routes store the per-video `PipelineOptions` on the record and
 *     queue transcription (lib/upload.ts), which is step 1;
 *   - the worker chains transcription -> `queueViralDetection()`;
 *   - `runViralDetection()` creates the clips and, with `autoRender`, hands each
 *     one to the render queue with the default configuration.
 *
 * Nothing about the rendering itself lives here - `worker/processor.ts` and the
 * FFmpeg pipeline are unchanged and stay the single implementation of a render.
 */

/**
 * A worker's downstream enqueue carries its exact running claim. This closes the
 * gap between a successful guarded write and the next queue insertion: a
 * cancellation/reclaim can no longer create a fresh child job after it won.
 */
function handoffContextFor(input: Pick<DetectionRunInput, 'jobId' | 'startedAt' | 'claimToken'>): PipelineEnqueueContext {
  if (!input.jobId || !input.startedAt) return {};
  return {
    sourceClaim: {
      jobId: input.jobId,
      startedAt: input.startedAt,
      ...(input.claimToken ? { claimToken: input.claimToken } : {}),
    },
  };
}

/** True when a cancelled/reclaimed upstream worker must stop rather than skip one clip. */
function sourceClaimWasLost(context: PipelineEnqueueContext): boolean {
  const source = context.sourceClaim;
  return Boolean(
    source && !isJobClaimCurrent(source.jobId, source.startedAt, undefined, source.claimToken),
  );
}

/**
 * Render configuration a clip gets when nobody has opened the editor yet:
 * the Settings page owns all of it: preset ids, engine, layout, durations. The values
 * are read once per step from `lib/app-settings.ts`, which returns what was saved there
 * or the built-in default - never a surprise from `.env.local`.
 */
export async function resolveRenderDefaults(): Promise<RenderDefaults> {
  const settings = await loadEffectiveSettings();
  return settings.render;
}

/**
 * The render payload for one clip: stored values first, explicit edits on top,
 * app render defaults underneath. Stored values always win - a clip the user
 * edited must re-render exactly as it did before.
 */
export async function jobDataFromClip(
  clip: ClipRecord,
  overrides: Partial<JobData> = {}
): Promise<JobData> {
  const render = await resolveRenderDefaults();
  return {
    clipId: clip._id,
    videoId: clip.videoId,
    start: clip.start,
    end: clip.end,
    hookDuration: clip.hookDuration ?? 0,
    hookText: clip.hookText ?? '',
    ctaText: clip.ctaText ?? '',
    ctaDuration: clip.ctaDuration ?? 0,
    filterPreset: clip.filterPreset || render.filterPreset,
    captionPresetId: clip.captionPresetId ?? '',
    layout: (clip.layout ?? render.layout) as ClipLayout,
    hookStylePresetId: clip.hookStylePresetId,
    ctaStylePresetId: clip.ctaStylePresetId,
    ...overrides,
  };
}

/**
 * Effective pipeline for one video: an explicit request payload wins over the
 * settings stored on the record, which win over the app defaults.
 */
export function resolvePipeline(
  video: Pick<VideoRecord, 'pipeline'>,
  payload?: unknown
): PipelineOptions {
  if (payload === undefined) return video.pipeline ?? sanitizePipelineOptions({});
  const incoming = sanitizePipelineOptions(payload);
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const nested = (typeof body.pipeline === 'object' && body.pipeline !== null ? body.pipeline : {}) as Record<string, unknown>;
  const carriesFlags = 'autoDetect' in body || 'autoRender' in body || 'autoDetect' in nested || 'autoRender' in nested;
  if (!carriesFlags && video.pipeline) {
    // A bare "detect again" request carries only the AI options; keep the video's
    // own automation flags instead of silently switching render back on.
    return { ...video.pipeline, viral: incoming.viral };
  }
  return incoming;
}

/** Queue the detection step unless one is already queued/running for this video. */
export async function queueViralDetection(
  videoId: string,
  context: PipelineEnqueueContext = {},
): Promise<'queued' | 'already-queued' | 'running'> {
  const active = findActiveJob(VIRAL_DETECTION_QUEUE_NAME, { videoId });
  if (active) return active.status === 'running' ? 'running' : 'already-queued';
  await enqueueViralDetectionJob(videoId, context);
  return 'queued';
}

/** B-roll automation for one video (stored pipeline first, defaults underneath). */
export function brollOptionsFor(video: Pick<VideoRecord, 'pipeline'>): BrollOptions {
  return resolveBrollOptions(video.pipeline?.broll ?? null);
}

/**
 * Queue the B-roll step for clips that do not have a plan yet. Returns the clips
 * that actually got a job; a clip whose B-roll job is already queued/running is
 * skipped, which is what keeps a restart from duplicating work.
 */
export async function queueBrollForClips(
  clips: readonly ClipRecord[],
  trigger: 'auto' | 'manual' | 'recovered' = 'auto',
  options: { skipWhenFailed?: boolean; context?: PipelineEnqueueContext } = {},
): Promise<ClipRecord[]> {
  const queued: ClipRecord[] = [];
  for (const clip of clips) {
    if (clip.broll) continue;
    if (findActiveJob(BROLL_QUEUE_NAME, { clipId: clip._id })) continue;
    if (options.skipWhenFailed) {
      // A restart must not retry a plan that already exhausted its attempts. The
      // clip tile still offers "Re-run B-roll" for that case.
      const latest = findLatestJob(BROLL_QUEUE_NAME, { clipId: clip._id });
      if (latest?.status === 'failed') continue;
    }
    try {
      await enqueueBrollJob(
        { clipId: clip._id, videoId: clip.videoId, trigger },
        options.context,
      );
      queued.push(clip);
    } catch (error) {
      // A lost upstream claim means the entire automatic hand-off was cancelled
      // or reclaimed, so stop the old producer rather than letting it continue.
      if (error instanceof RenderCancelledError && sourceClaimWasLost(options.context ?? {})) {
        throw error;
      }
      // A specific clip may have been cancelled while a video-level detection
      // pass is still valid. Leave that clip terminal and continue the batch.
      if (error instanceof RenderCancelledError) continue;
      // A 409 (another pass is starting) is not a failure of this clip; anything
      // else is recorded on the clip without stopping the batch.
      const message = toErrorMessage(error, 'Could not queue B-roll.');
      log.warn(`Could not queue B-roll for ${clip._id}: ${message}`);
    }
  }
  return queued;
}

/**
 * Hand one clip to the render queue if the video's automation still wants that.
 * Called by the worker right after the B-roll job wrote its plan.
 */
export async function continueAfterBroll(
  clipId: string,
  context: PipelineEnqueueContext = {},
): Promise<boolean> {
  const clip = await getClip(clipId);
  if (!clip) return false;
  const video = await getVideo(clip.videoId);
  if (!video?.pipeline || video.pipelineCancelled) return false;

  const options = brollOptionsFor(video);
  // `autoRender` alone decides whether a render follows; B-roll is a step *inside*
  // the automatic pipeline, never a reason to render something the user paused.
  if (!video.pipeline.autoRender) {
    log.detail(`B-roll ready for ${clipId}; autoRender is off, so the render waits for you.`);
    return false;
  }
  if (
    clip.status === 'processing' ||
    clip.status === 'failed' ||
    findActiveJob(CLIP_QUEUE_NAME, { clipId })
  ) return false;

  await enqueueClipJob(await jobDataFromClip(clip), context);
  log.ok(
    `B-roll ready (${clip.broll?.items.length ?? 0} image${clip.broll?.items.length === 1 ? '' : 's'}` +
      `${options.enableFullscreen ? `, ${clip.broll?.counts.fullscreen ?? 0} full-screen` : ''}) - render queued.`
  );
  return true;
}

export interface DetectionRunInput {
  /** Raw request body (or nothing) - see `resolvePipeline`. */
  pipeline?: unknown;
  /** Overrides the stored `autoRender` flag for this run. */
  autoRender?: boolean;
  /**
   * `auto` = the pipeline chained itself after transcription; `manual` = the
   * user pressed the button. An automatic run never duplicates a detection:
   * if the video already has clips, the run just re-queues whatever is still
   * unrendered (so "transcribe again" does not double the grid).
   */
  mode?: 'auto' | 'manual';
  /** Worker-only cancellation signal; HTTP callers omit it. */
  signal?: AbortSignal;
  /** Exact queue claim that owns worker-originated persistence. */
  jobId?: string;
  startedAt?: string;
  claimToken?: string;
}

export interface DetectionRunResult {
  video: VideoRecord;
  clips: ClipRecord[];
  /** How many of the new clips were handed to the render queue. */
  renderQueued: number;
  /** How many of the new clips were handed to the B-roll queue instead. */
  brollQueued: number;
  autoRender: boolean;
  options: Required<ViralDetectionOptions>;
  /** True when an automatic run found existing clips and reused them. */
  reusedExistingClips: boolean;
}

/** The hook intro must not replay the first spoken seconds of the clip. */
const MIN_REUSABLE_HOOK_OFFSET_SECONDS = 3;

interface ReusableHookInterval {
  start: number;
  end: number;
}

/**
 * A viral response already contains a hook interval. Trust it when it is a
 * complete, later-in-the-clip range; otherwise the dedicated picker remains the
 * conservative fallback. This keeps the old "never replay the opening" rule.
 */
function reusableViralHookInterval(
  timestamp: { start: string; end: string },
  clipStart: number,
  clipEnd: number,
): ReusableHookInterval | null {
  const start = parseTimestamp(timestamp.start);
  const end = parseTimestamp(timestamp.end);
  const clipDuration = clipEnd - clipStart;
  if (
    start === null ||
    end === null ||
    end <= start ||
    start < clipStart + MIN_REUSABLE_HOOK_OFFSET_SECONDS ||
    end > clipEnd ||
    end - start > clipDuration / 2
  ) {
    return null;
  }
  return { start, end };
}

/**
 * One viral-detection run for one video: AI pass over the transcript, clip
 * records written with the analysis + default render config, then (by default)
 * every new clip queued for rendering.
 *
 * Called by `POST /api/videos/[id]/detect-viral` AND by the worker's
 * `viral-detection` job, so the manual button and the automatic run are the same
 * code with the same rules.
 */
export async function runViralDetection(
  videoId: string,
  input: DetectionRunInput = {}
): Promise<DetectionRunResult> {
  if (input.signal?.aborted) throw new RenderCancelledError();
  const hasClaimGuard = Boolean(input.jobId && input.startedAt);
  const downstreamContext = handoffContextFor(input);
  const persistVideo = async (candidate: VideoRecord): Promise<boolean> =>
    hasClaimGuard
      ? updateVideoForRunningJob(candidate, input.jobId!, input.startedAt!, input.claimToken)
      : updateVideo(candidate);
  const persistDetectedClip = async (candidate: ClipRecord): Promise<boolean> =>
    hasClaimGuard
      ? saveClipForRunningJob(candidate, input.jobId!, input.startedAt!, input.claimToken)
      : (await saveClip(candidate), true);
  const video = await getVideo(videoId);
  if (!video) {
    throw new AppError('Video not found', {
      status: 404,
      resolution: 'Upload the source video again before detecting clips.',
    });
  }

  if (input.mode === 'manual' && video.pipelineCancelled) {
    video.pipelineCancelled = false;
    video.error = undefined;
    await updateVideo(video);
  }

  if (!video.transcript) {
    throw new AppError('Video has no transcript available yet. Please transcribe first.', {
      status: 409,
      details: `status=${video.status}`,
      resolution:
        'Wait for the transcript to finish, or press "Transcribe again" on the video.',
    });
  }

  if (!video.transcript.segments.length || !video.transcript.words.length) {
    throw new AppError('The saved transcript is incomplete and cannot be used for viral analysis.', {
      status: 400,
      resolution: 'Re-run transcription so the video has timestamped transcript segments and words.',
    });
  }

  if (!video.duration || video.duration <= 0) {
    throw new AppError('Video duration is missing, so viral analysis cannot be timed correctly.', {
      status: 500,
      resolution: 'Re-upload the source video so FFmpeg can extract valid metadata.',
    });
  }

  const pipeline = resolvePipeline(video, input.pipeline);
  if (input.autoRender !== undefined) pipeline.autoRender = input.autoRender;
  const options = pipeline.viral;
  const brollOptions = resolveBrollOptions(pipeline.broll);
  const mode = input.mode ?? 'manual';

  if (mode === 'auto') {
    const existing = await listClips(videoId);
    if (existing.length) {
      // The video was already analyzed (e.g. the transcript was regenerated).
      // Never stack a second identical batch on top of it - only make sure the
      // clips that exist get their missing B-roll plan and then a render.
      const brollFailed = (clip: ClipRecord): boolean =>
        findLatestJob(BROLL_QUEUE_NAME, { clipId: clip._id })?.status === 'failed';
      const missingBroll = brollOptions.autoBroll
        ? existing.filter((clip) => !clip.broll && !brollFailed(clip))
        : [];
      const brollQueued = missingBroll.length
        ? await queueBrollForClips(missingBroll, 'recovered', {
            skipWhenFailed: true,
            context: downstreamContext,
          })
        : [];
      const stranded = pipeline.autoRender
        ? existing.filter(
            (clip) =>
              clip.status === 'pending' &&
              // A clip still waiting for B-roll waits for continueAfterBroll().
              // A terminal B-roll failure is different: it deliberately renders
              // without a plan so one provider outage cannot strand the clip.
              (!brollOptions.autoBroll || clip.broll || brollFailed(clip))
          )
        : [];
      const queued = stranded.length
        ? await queueRenders(stranded, downstreamContext)
        : { queued: [], failed: [] };
      log.detail(
        `Viral detection skipped - ${existing.length} clip(s) already exist for ${videoId}` +
          (brollQueued.length ? `, queued B-roll for ${brollQueued.length}.` : '') +
          (stranded.length ? ` Re-queued ${queued.queued.length} for rendering.` : '.')
      );
      return {
        video,
        clips: existing,
        renderQueued: queued.queued.length,
        brollQueued: brollQueued.length,
        autoRender: pipeline.autoRender,
        options,
        reusedExistingClips: true,
      };
    }
  }

  if (video.duration < options.minClipDuration) {
    throw new AppError(
      `The video (${Math.round(video.duration)}s) is shorter than the minimum clip length (${options.minClipDuration}s).`,
      {
        status: 400,
        resolution: 'Lower the minimum clip length in the AI clip options, or upload a longer video.',
      }
    );
  }

  // Remember the settings this run used, so a later automatic retry (worker
  // restart, failed render) and the dashboard both show the same numbers.
  if (JSON.stringify(video.pipeline ?? null) !== JSON.stringify(pipeline)) {
    video.pipeline = pipeline;
    const persisted = await persistVideo(video).catch((error) => {
      log.warn(`Could not persist the pipeline options for ${videoId}: ${toErrorMessage(error)}`);
      return false;
    });
    if (!persisted && hasClaimGuard) throw new RenderCancelledError();
  }

  log.detail(
    `Detecting viral segments for ${videoId} (up to ${options.clipCount} clips, ` +
      `min ${options.minClipDuration}s, max ${options.maxClipDuration}s (fixed), ` +
      `hook ${options.includeHookText ? 'on' : 'off'}, CTA ${options.includeCta ? 'on' : 'off'})...`
  );

  const viralSegments = await detectViralSegments(video.transcript, video.duration, options, input.signal);
  if (input.signal?.aborted) throw new RenderCancelledError();

  if (!viralSegments.length) {
    throw new AppError('AI analysis returned zero viral segments.', {
      status: 502,
      resolution: 'Adjust the prompt template or retry with a transcript that contains clearer spoken content.',
    });
  }

  const defaultCaptionPreset = await getDefaultCaptionPreset();
  // Settings -> "Render clip defaults". Everything below is what a clip looks like
  // before anyone opens the editor, so an unattended run uses exactly these values.
  const render = await resolveRenderDefaults();
  const createdClips: ClipRecord[] = [];

  // One timestamp for the whole run: the clips of a detection run tie on
  // createdAt, so the grid can show newest run first and, inside a run, best
  // rank first (see lib/clip-order.ts).
  const runCreatedAt = new Date().toISOString();

  for (const segment of viralSegments) {
    const clipId = `clip_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const segmentTranscript = video.transcript.segments
      .filter((entry) => entry.start >= segment.start - 1 && entry.end <= segment.end + 1)
      .map((entry) => entry.text)
      .join(' ')
      .trim();

    const overlayTranscript = segmentTranscript || video.transcript.text;

    // Hook text: skipped entirely when the option is off. When on, the viral
    // prompt's own hook text is preferred and the dedicated hook template is
    // only the fallback.
    const { hook_text_on_video, cta_text } = segment.clip.viral_packaging;
    const hookText = options.includeHookText
      ? await resolveOverlayText(hook_text_on_video.toUpperCase(), () => generateHookText(overlayTranscript, input.signal), 'hook')
      : '';
    let hookIntroEnabled = Boolean(options.includeHookText && hookText && render.hookDuration > 0);

    if (hookIntroEnabled) {
      const segmentDuration = segment.end - segment.start;
      const reusableHook = reusableViralHookInterval(
        segment.clip.hook_line_analysis.hook_timestamp,
        segment.start,
        segment.end,
      );

      if (reusableHook) {
        segment.clip.hook_line_analysis.hook_moment_source = 'viral';
        log.info(
          `[LLM] hook reuse clip_rank=${segment.clip.rank} source=viral-response ` +
            `interval=${reusableHook.start.toFixed(3)}s-${reusableHook.end.toFixed(3)}s`,
        );
      } else {
        log.info(
          `[LLM] hook fallback clip_rank=${segment.clip.rank} reason=missing-or-invalid-viral-interval`,
        );
        const hookWords = video.transcript.words
          .filter((word) => word.end >= segment.start && word.start <= segment.end)
          .map((word) => ({
            ...word,
            start: Math.max(0, word.start - segment.start),
            end: Math.min(segmentDuration, word.end - segment.start),
          }));
        const hookMoment = await detectHookMoment({
          words: hookWords,
          segmentDuration,
          hookDuration: Math.min(render.hookDuration, segmentDuration / 2),
          signal: input.signal,
        });

        if (hookMoment) {
          segment.clip.hook_line_analysis.hook_timestamp = {
            start: `${(segment.start + hookMoment.start).toFixed(3)}s`,
            end: `${(segment.start + hookMoment.end).toFixed(3)}s`,
          };
          segment.clip.hook_line_analysis.hook_moment_source = 'picker';
        } else {
          segment.clip.hook_line_analysis.hook_timestamp = { start: '', end: '' };
          hookIntroEnabled = false;
          log.warn(
            `No later hook moment was found for clip ${segment.clip.rank}; disabling its hook intro instead of replaying the clip opening.`,
          );
        }
      }
    }

    // Same idea for the CTA; when the switch is off the clip is marked with
    // ctaDuration 0 and the renderer skips the CTA overlay.
    const ctaText = options.includeCta
      ? await resolveOverlayText(cta_text, () => generateCtaText(overlayTranscript, input.signal), 'CTA')
      : '';

    const clipRecord: ClipRecord = {
      _id: clipId,
      videoId,
      videoTitle: video.originalName,
      start: segment.start,
      end: segment.end,
      // hookDuration 0 means "no hook intro / no hook overlay" downstream.
      hookDuration: hookIntroEnabled ? render.hookDuration : 0,
      hookText,
      ctaText,
      // 0 = no CTA overlay (CTA switch was off for this run).
      ctaDuration: options.includeCta ? render.ctaDuration : 0,
      // Default render configuration: the app settings for the knobs, the database
      // defaults for the presets, so an automatic render uses exactly what the user
      // configured in Settings -> Render clip defaults.
      filterPreset: render.filterPreset,
      captionPresetId: render.captionPresetId ?? defaultCaptionPreset?._id ?? 'preset-bold-yellow',
      layout: render.layout,
      ...(render.hookStylePresetId ? { hookStylePresetId: render.hookStylePresetId } : {}),
      ...(render.ctaStylePresetId ? { ctaStylePresetId: render.ctaStylePresetId } : {}),
      // Everything the AI said about the clip, stored as returned; the card,
      // the analysis panel and the worker read it from here.
      aiAnalysis: segment.clip,
      status: 'pending',
      progress: 0,
      error: undefined,
      createdAt: runCreatedAt,
      updatedAt: runCreatedAt,
    };

    if (input.signal?.aborted) throw new RenderCancelledError();
    if (!(await persistDetectedClip(clipRecord))) {
      throw new RenderCancelledError('Viral detection claim was cancelled before its clip could be saved.');
    }
    createdClips.push(clipRecord);
  }

  let renderQueued = 0;
  let brollQueued = 0;

  // B-roll is planned before the render (and only once per clip): the render step
  // consumes the stored plan and must never call a provider itself. With
  // autoBroll off, this block does nothing at all and the pipeline behaves exactly
  // as it did before the feature existed.
  if (brollOptions.autoBroll) {
    const queuedForBroll = await queueBrollForClips(createdClips, 'auto', {
      context: downstreamContext,
    });
    brollQueued = queuedForBroll.length;
    log.ok(
      brollQueued
        ? `B-roll queued for ${brollQueued}/${createdClips.length} clip(s); each render follows its plan.`
        : 'B-roll was not queued for any clip - see the clip errors.'
    );
  }

  if (pipeline.autoRender) {
    // With B-roll on, the render is handed over by the B-roll job itself
    // (continueAfterBroll), so a render can never start against a missing plan.
    if (!brollOptions.autoBroll) {
      renderQueued = (await queueRenders(createdClips, downstreamContext)).queued.length;
      log.ok(
        renderQueued
          ? `Auto-render queued for ${renderQueued}/${createdClips.length} clip(s).`
          : `No clip could be queued for rendering - see the clip errors.`
      );
    }
  }

  const refreshed = await getVideo(videoId);
  return {
    video: refreshed ?? video,
    clips: createdClips,
    renderQueued,
    brollQueued,
    autoRender: pipeline.autoRender,
    options,
    reusedExistingClips: false,
  };
}

/**
 * Hand clips to the render queue. A clip that cannot be queued (deleted row,
 * preset default missing, a render already running) is marked failed with the
 * reason and the rest of the batch continues - one bad clip never stops a run.
 */
export async function queueRenders(
  clips: readonly ClipRecord[],
  context: PipelineEnqueueContext = {},
): Promise<{ queued: ClipRecord[]; failed: Array<{ clipId: string; error: string }> }> {
  const queued: ClipRecord[] = [];
  const failed: Array<{ clipId: string; error: string }> = [];

  for (const clip of clips) {
    try {
      await enqueueClipJob(await jobDataFromClip(clip), context);
      const withJob = await getClip(clip._id);
      queued.push(withJob ?? clip);
    } catch (error) {
      if (error instanceof RenderCancelledError && sourceClaimWasLost(context)) {
        throw error;
      }
      // A cancelled clip/pipeline is terminal until an explicit manual resume;
      // do not overwrite its cancellation reason with a stale automatic hand-off.
      if (error instanceof RenderCancelledError) continue;
      const message = toErrorMessage(error, 'Could not queue this render.');
      failed.push({ clipId: clip._id, error: message });
      log.warn(`Could not queue render for ${clip._id}: ${message}`);
      if (clip._id) {
        const fresh = await getClip(clip._id).catch(() => null);
        if (fresh) {
          fresh.status = 'failed';
          fresh.error = message;
          await updateClip(fresh).catch(() => undefined);
        }
      }
    }
  }

  return { queued, failed };
}

/** Queue every clip of a video that is not currently rendering. */
export async function queueRendersForVideo(
  videoId: string,
  options: {
    clipIds?: string[];
    includeDone?: boolean;
    context?: PipelineEnqueueContext;
  } = {},
): Promise<{ queued: ClipRecord[]; skipped: string[]; failed: Array<{ clipId: string; error: string }> }> {
  const all = await listClips(videoId);
  const wanted = options.clipIds?.length
    ? all.filter((clip) => options.clipIds!.includes(clip._id))
    : all;

  const selected = wanted.filter((clip) => {
    if (options.includeDone) return true;
    if (clip.status === 'done') return false;
    if (clip.status === 'processing') return false;
    return true;
  });

  const skipped = wanted
    .filter((clip) => !selected.includes(clip))
    .map((clip) => clip._id);

  const result = await queueRenders(selected, options.context);
  return { queued: result.queued, skipped, failed: result.failed };
}

/**
 * Called by the worker right after a successful transcription: the automatic
 * pipeline keeps going on its own. Returns whether it did.
 */
export async function continueAfterTranscription(
  videoId: string,
  context: PipelineEnqueueContext = {},
): Promise<boolean> {
  const video = await getVideo(videoId);
  if (!video || video.pipelineCancelled || !video.pipeline?.autoDetect) return false;
  const state = await queueViralDetection(videoId, context);
  if (state === 'queued') log.ok('Transcript ready - viral detection queued automatically.');
  return true;
}

/**
 * Startup sweep for pipelines interrupted by a crash or a restart between two
 * steps. Only videos that opted into the automation (i.e. uploaded through the
 * new flow) are touched; a manual clip is never auto-queued.
 */
export async function recoverAutoPipelines(): Promise<{ resumed: string[] }> {
  const { listVideos } = await import('./db');
  const videos = await listVideos();
  const resumed: string[] = [];

  for (const video of videos) {
    if (!video.pipeline?.autoDetect || video.pipelineCancelled) continue;
    if (video.status === 'failed') continue;

    const clips = await listClips(video._id);

    // File already consumed, transcript still missing -> restart step 1.
    if (!video.transcript) {
      if (!findActiveJob(TRANSCRIPTION_QUEUE_NAME, { videoId: video._id })) {
        await enqueueTranscriptionJob({ videoId: video._id, filePath: video.filePath });
        resumed.push(`${video._id}:transcription`);
      }
      continue;
    }

    // Transcript done but no clips -> the detection pass never finished.
    if (!clips.length) {
      if (!findActiveJob(VIRAL_DETECTION_QUEUE_NAME, { videoId: video._id })) {
        await enqueueViralDetectionJob(video._id);
        resumed.push(`${video._id}:viral-detection`);
      }
      continue;
    }

    const brollOptions = brollOptionsFor(video);
    const brollFailed = (clip: ClipRecord): boolean =>
      findLatestJob(BROLL_QUEUE_NAME, { clipId: clip._id })?.status === 'failed';
    const missingPlans = brollOptions.autoBroll
      ? clips.filter((clip) => !clip.broll && !brollFailed(clip))
      : [];

    // Clips exist and renders were automatic: re-queue the ones left pending.
    if (video.pipeline.autoRender) {
      const stranded = clips.filter(
        (clip) =>
          clip.status === 'pending' &&
          !findActiveJob(CLIP_QUEUE_NAME, { clipId: clip._id }) &&
          // A clip whose B-roll is still being planned must wait for its plan;
          // an exhausted B-roll job intentionally falls through to plain render.
          (!brollOptions.autoBroll || clip.broll || brollFailed(clip))
      );
      if (stranded.length) {
        await queueRenders(stranded);
        resumed.push(`${video._id}:render x${stranded.length}`);
      }
    }

    // A crash between detection and the B-roll step (or between the plan and the
    // render) resumes HERE: the jobs table is the only state, so nothing is lost.
    if (missingPlans.length) {
      const queuedForBroll = await queueBrollForClips(missingPlans, 'recovered', {
        skipWhenFailed: true,
      });
      if (queuedForBroll.length) {
        resumed.push(`${video._id}:broll x${queuedForBroll.length}`);
      }
    }
  }

  return { resumed };
}

/**
 * On-screen text for one clip: the AI's own suggestion first, then the dedicated
 * generation template (the existing fallback). If that fails too, the run goes
 * on with empty text - like the renderer, detection never dies because one
 * overlay line is missing; the user can type it into the clip editor.
 */
async function resolveOverlayText(
  aiText: string | undefined,
  generate: () => Promise<string>,
  label: 'hook' | 'CTA'
): Promise<string> {
  if (aiText?.trim()) return aiText.trim();
  try {
    return (await generate()).trim();
  } catch (error) {
    if (error instanceof RenderCancelledError) throw error;
    log.warn(
      `The AI left out the ${label} text and it could not be generated ` +
        `(${error instanceof AppError ? error.summary : toErrorMessage(error)}). ` +
        `This clip gets no ${label} text - add one in the clip editor.`
    );
    return '';
  }
}
