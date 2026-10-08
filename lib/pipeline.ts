import {
  getClip,
  getDefaultCaptionPreset,
  getVideo,
  listClips,
  saveClip,
  updateClip,
  updateVideo,
} from './db';
import {
  detectViralSegments,
  generateCtaText,
  generateHookText,
} from './ai';
import { AppError, toErrorMessage } from './errors';
import { log } from './logger';
import {
  CLIP_QUEUE_NAME,
  TRANSCRIPTION_QUEUE_NAME,
  VIRAL_DETECTION_QUEUE_NAME,
  enqueueClipJob,
  enqueueTranscriptionJob,
  enqueueViralDetectionJob,
  findActiveJob,
} from './queue';
import { sanitizePipelineOptions } from './pipeline-defaults';
import {
  CaptionEngine,
  ClipLayout,
  ClipRecord,
  DEFAULT_RENDER_OPTIONS,
  JobData,
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

/** Clip render configuration used when nobody has opened the editor yet. */
export function defaultCaptionEngine(): CaptionEngine {
  const configured = process.env.AUTO_RENDER_CAPTION_ENGINE?.trim().toLowerCase();
  return configured === 'native' ? 'native' : DEFAULT_RENDER_OPTIONS.captionEngine;
}

/** The render payload for one clip: stored values first, explicit edits on top. */
export function jobDataFromClip(
  clip: ClipRecord,
  overrides: Partial<JobData> = {}
): JobData {
  return {
    clipId: clip._id,
    videoId: clip.videoId,
    start: clip.start,
    end: clip.end,
    hookDuration: clip.hookDuration ?? 0,
    hookText: clip.hookText ?? '',
    ctaText: clip.ctaText ?? '',
    ctaDuration: clip.ctaDuration ?? 0,
    filterPreset: clip.filterPreset || DEFAULT_RENDER_OPTIONS.filterPreset,
    captionPresetId: clip.captionPresetId ?? '',
    layout: (clip.layout ?? DEFAULT_RENDER_OPTIONS.layout) as ClipLayout,
    captionEngine: clip.captionEngine ?? defaultCaptionEngine(),
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
  videoId: string
): Promise<'queued' | 'already-queued' | 'running'> {
  const active = findActiveJob(VIRAL_DETECTION_QUEUE_NAME, { videoId });
  if (active) return active.status === 'running' ? 'running' : 'already-queued';
  await enqueueViralDetectionJob(videoId);
  return 'queued';
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
}

export interface DetectionRunResult {
  video: VideoRecord;
  clips: ClipRecord[];
  /** How many of the new clips were handed to the render queue. */
  renderQueued: number;
  autoRender: boolean;
  options: Required<ViralDetectionOptions>;
  /** True when an automatic run found existing clips and reused them. */
  reusedExistingClips: boolean;
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
  const video = await getVideo(videoId);
  if (!video) {
    throw new AppError('Video not found', {
      status: 404,
      resolution: 'Upload the source video again before detecting clips.',
    });
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
  const mode = input.mode ?? 'manual';

  if (mode === 'auto') {
    const existing = await listClips(videoId);
    if (existing.length) {
      // The video was already analyzed (e.g. the transcript was regenerated).
      // Never stack a second identical batch on top of it - only make sure the
      // clips that exist are rendered.
      const stranded = pipeline.autoRender
        ? existing.filter((clip) => clip.status === 'pending' || clip.status === 'failed')
        : [];
      const queued = stranded.length ? await queueRenders(stranded) : { queued: [], failed: [] };
      log.detail(
        `Viral detection skipped - ${existing.length} clip(s) already exist for ${videoId}` +
          (stranded.length ? `, re-queued ${queued.queued.length} for rendering.` : '.')
      );
      return {
        video,
        clips: existing,
        renderQueued: queued.queued.length,
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
    await updateVideo(video).catch((error) =>
      log.warn(`Could not persist the pipeline options for ${videoId}: ${toErrorMessage(error)}`)
    );
  }

  log.detail(
    `Detecting viral segments for ${videoId} (up to ${options.clipCount} clips, ` +
      `min ${options.minClipDuration}s, max ${options.maxClipDuration}s (fixed), ` +
      `hook ${options.includeHookText ? 'on' : 'off'}, CTA ${options.includeCta ? 'on' : 'off'})...`
  );

  const viralSegments = await detectViralSegments(video.transcript, video.duration, options);

  if (!viralSegments.length) {
    throw new AppError('AI analysis returned zero viral segments.', {
      status: 502,
      resolution: 'Adjust the prompt template or retry with a transcript that contains clearer spoken content.',
    });
  }

  const defaultCaptionPreset = await getDefaultCaptionPreset();
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
      ? await resolveOverlayText(hook_text_on_video.toUpperCase(), () => generateHookText(overlayTranscript), 'hook')
      : '';

    // Same idea for the CTA; when the switch is off the clip is marked with
    // ctaDuration 0 and the renderer skips the CTA overlay.
    const ctaText = options.includeCta
      ? await resolveOverlayText(cta_text, () => generateCtaText(overlayTranscript), 'CTA')
      : '';

    const clipRecord: ClipRecord = {
      _id: clipId,
      videoId,
      videoTitle: video.originalName,
      start: segment.start,
      end: segment.end,
      // hookDuration 0 means "no hook intro / no hook overlay" downstream.
      hookDuration: options.includeHookText && hookText ? 3 : 0,
      hookText,
      ctaText,
      // 0 = no CTA overlay (CTA switch was off for this run).
      ctaDuration: options.includeCta ? 2.5 : 0,
      // Default render configuration: the database defaults for the presets, so
      // an automatic render uses exactly what the user configured in settings.
      filterPreset: DEFAULT_RENDER_OPTIONS.filterPreset,
      captionPresetId: defaultCaptionPreset?._id ?? 'preset-bold-yellow',
      layout: DEFAULT_RENDER_OPTIONS.layout,
      captionEngine: defaultCaptionEngine(),
      // Everything the AI said about the clip, stored as returned; the card,
      // the analysis panel and the worker read it from here.
      aiAnalysis: segment.clip,
      status: 'pending',
      progress: 0,
      error: undefined,
      createdAt: runCreatedAt,
      updatedAt: runCreatedAt,
    };

    await saveClip(clipRecord);
    createdClips.push(clipRecord);
  }

  let renderQueued = 0;
  if (pipeline.autoRender) {
    renderQueued = (await queueRenders(createdClips)).queued.length;
    log.ok(
      renderQueued
        ? `Auto-render queued for ${renderQueued}/${createdClips.length} clip(s).`
        : `No clip could be queued for rendering - see the clip errors.`
    );
  }

  const refreshed = await getVideo(videoId);
  return {
    video: refreshed ?? video,
    clips: createdClips,
    renderQueued,
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
  clips: readonly ClipRecord[]
): Promise<{ queued: ClipRecord[]; failed: Array<{ clipId: string; error: string }> }> {
  const queued: ClipRecord[] = [];
  const failed: Array<{ clipId: string; error: string }> = [];

  for (const clip of clips) {
    try {
      await enqueueClipJob(jobDataFromClip(clip));
      const withJob = await getClip(clip._id);
      queued.push(withJob ?? clip);
    } catch (error) {
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
  options: { clipIds?: string[]; includeDone?: boolean } = {}
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

  const result = await queueRenders(selected);
  return { queued: result.queued, skipped, failed: result.failed };
}

/**
 * Called by the worker right after a successful transcription: the automatic
 * pipeline keeps going on its own. Returns whether it did.
 */
export async function continueAfterTranscription(videoId: string): Promise<boolean> {
  const video = await getVideo(videoId);
  if (!video || !video.pipeline?.autoDetect) return false;
  const state = await queueViralDetection(videoId);
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
    if (!video.pipeline?.autoDetect) continue;
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

    // Clips exist and renders were automatic: re-queue the ones left pending.
    if (video.pipeline.autoRender) {
      const stranded = clips.filter(
        (clip) => clip.status === 'pending' && !findActiveJob(CLIP_QUEUE_NAME, { clipId: clip._id })
      );
      if (stranded.length) {
        await queueRenders(stranded);
        resumed.push(`${video._id}:render x${stranded.length}`);
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
    log.warn(
      `The AI left out the ${label} text and it could not be generated ` +
        `(${error instanceof AppError ? error.summary : toErrorMessage(error)}). ` +
        `This clip gets no ${label} text - add one in the clip editor.`
    );
    return '';
  }
}
