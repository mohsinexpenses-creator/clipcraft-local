import {
  closeDatabase,
  getClip,
  getDatabase,
  getDatabasePath,
  getVideo,
  saveClipBrollPlan,
  saveClipBrollPlanForRunningJob,
  updateClip,
  updateVideo,
  updateVideoForRunningJob,
} from '../lib/db';
import { RenderCancelledError, toErrorMessage } from '../lib/errors';
import { sweepDeferredFileCleanup } from '../lib/file-cleanup';
import { loadEffectiveSettings } from '../lib/app-settings';
import { applyStoredRuntimeSettings } from './runtime-settings';
import {
  BROLL_QUEUE_NAME,
  CLIP_QUEUE_NAME,
  QUEUE_POLL_INTERVAL_MS,
  TRANSCRIPTION_QUEUE_NAME,
  VIRAL_DETECTION_QUEUE_NAME,
  QueueJob,
  claimNextJob,
  completeJob,
  failJob,
  isJobClaimCurrent,
  recoverRunningJobs,
  updateJobProgress,
  watchJobClaim,
  type JobExecutionControl,
} from '../lib/queue';
import { BrollJobData, JobData, TranscriptionJobData, ViralDetectionJobData, VideoRecord } from '../lib/types';
import { transcribeVideo } from '../lib/whisper';
import {
  continueAfterBroll,
  continueAfterTranscription,
  recoverAutoPipelines,
  runViralDetection,
} from '../lib/pipeline';
import { processClipJob } from './processor';
import { runBrollJob, type BrollJobResult } from './broll-job';
import { color, log } from '../lib/logger';

// NOTE: .env.local is loaded by lib/errors.ts (loadEnvConfig), which this file imports
// transitively - that only works when the worker is started from the repository root.

/**
 * Concurrency comes from `lib/app-settings.ts`, which already folds in the
 * the values saved on /settings, whose built-in default is 1. `.env.local` is not a
 * fallback for these two, so there is deliberately no second reader here.
 */
async function transcribeVideoJob(
  data: TranscriptionJobData,
  control: JobExecutionControl & { jobId?: string; startedAt?: string; claimToken?: string },
): Promise<{ status: string; videoId: string; autoDetectQueued?: boolean }> {
  const persistVideo = async (candidate: VideoRecord): Promise<boolean> =>
    control.jobId && control.startedAt
      ? updateVideoForRunningJob(candidate, control.jobId, control.startedAt, control.claimToken)
      : updateVideo(candidate);
  const video = await getVideo(data.videoId);
  if (!video) {
    throw new Error(`Video ${data.videoId} no longer exists in SQLite - nothing to transcribe.`);
  }

  log.section(`Transcribe ${color.bold(data.videoId)}` + color.gray(`  ·  ${video.originalName}`));
  video.status = 'transcribing';
  video.error = undefined;
  if (!(await persistVideo(video))) return { status: 'cancelled', videoId: data.videoId };

  try {
    if (control.signal.aborted) throw new RenderCancelledError();
    const transcript = await transcribeVideo(data.filePath, { signal: control.signal });
    if (control.signal.aborted) throw new RenderCancelledError();
    // A user may delete the source while transcription is running. Do not recreate its row.
    const current = await getVideo(data.videoId);
    if (!current) return { status: 'cancelled', videoId: data.videoId };

    current.transcript = transcript;
    current.status = 'transcribed';
    current.error = undefined;
    if (!(await persistVideo(current))) throw new RenderCancelledError();
    log.ok(
      `Transcription done: ${transcript.segments.length} segments, ${transcript.words.length} words.`
    );

    // Step 2 of the automatic pipeline. The upload stored `pipeline.autoDetect`
    // on the record; queueing (instead of awaiting here) keeps one step per job,
    // so a crash in the LLM pass retries the detection alone and never re-runs
    // transcription. Videos uploaded before this existed have no `pipeline` and stay
    // manual.
    const chained = await continueAfterTranscription(data.videoId, {
      ...(control.jobId && control.startedAt
        ? {
            sourceClaim: {
              jobId: control.jobId,
              startedAt: control.startedAt,
              ...(control.claimToken ? { claimToken: control.claimToken } : {}),
            },
          }
        : {}),
    });
    return { status: 'done', videoId: data.videoId, autoDetectQueued: chained };
  } catch (error) {
    if (error instanceof RenderCancelledError || control.signal.aborted) {
      throw new RenderCancelledError();
    }
    const current = await getVideo(data.videoId);
    if (current) {
      current.status = 'failed';
      current.error = toErrorMessage(error, 'Transcription failed.');
      await persistVideo(current);
    }
    throw error;
  }
}

/**
 * Step 2: turn the transcript into clip records (and, with `autoRender` on, hand
 * each of them to the render queue). All the rules live in lib/pipeline.ts, which
 * the manual "Detect viral clips" button calls too - one implementation, two
 * entry points.
 */
async function viralDetectionJob(
  data: ViralDetectionJobData,
  control: JobExecutionControl & { jobId?: string; startedAt?: string; claimToken?: string },
): Promise<{ status: string; videoId: string; clips: number; renderQueued: number }> {
  const video = await getVideo(data.videoId);
  if (!video) {
    throw new Error(`Video ${data.videoId} no longer exists in SQLite - nothing to analyze.`);
  }

  log.section(`Viral detection ${color.bold(data.videoId)}` + color.gray(`  ·  ${video.originalName}`));

  try {
    const result = await runViralDetection(data.videoId, {
      // Chained run: never duplicates a detection that already happened.
      mode: 'auto',
      ...(data.autoRender === undefined ? {} : { autoRender: data.autoRender }),
      signal: control.signal,
      jobId: control.jobId,
      startedAt: control.startedAt,
      claimToken: control.claimToken,
    });
    log.ok(
      `Detection done: ${result.clips.length} clip(s)` +
        (result.autoRender ? `, ${result.renderQueued} queued for rendering.` : '.')
    );
    return {
      status: 'done',
      videoId: data.videoId,
      clips: result.clips.length,
      renderQueued: result.renderQueued,
    };
  } catch (error) {
    if (error instanceof RenderCancelledError || control.signal.aborted) {
      throw new RenderCancelledError();
    }
    // The transcript itself is still fine, so only the error is recorded - the
    // dashboard shows it on the analysis step and offers a retry.
    const current = await getVideo(data.videoId);
    if (current) {
      current.error = toErrorMessage(error, 'Viral detection failed.');
      if (control.jobId && control.startedAt) {
        await updateVideoForRunningJob(current, control.jobId, control.startedAt, control.claimToken);
      } else {
        await updateVideo(current);
      }
    }
    throw error;
  }
}

/**
 * Step 3 of the automatic pipeline: plan B-roll for one clip, then hand the clip
 * to the render queue. A manual re-run uses the same job, so there is one
 * implementation of "what a plan is".
 */
async function brollJob(
  data: BrollJobData,
  progress: (value: number) => void,
  control: { signal: AbortSignal; jobId?: string; startedAt?: string; claimToken?: string },
): Promise<BrollJobResult> {
  try {
    if (control.signal.aborted) throw new RenderCancelledError();
    const result = await runBrollJob(data, progress, control);
    if (result.status === 'done') {
      // A late planner must not hand work to render after its claim was
      // cancelled/replaced, even during the watcher's 400 ms polling window.
      if (
        control.jobId &&
        control.startedAt &&
        !isJobClaimCurrent(control.jobId, control.startedAt, getDatabase(), control.claimToken)
      ) {
        throw new RenderCancelledError();
      }
      // The hand-off lives in lib/pipeline.ts, like every other step boundary.
      // It carries the same claim fence as the plan write, so cancellation cannot
      // insert a render between this check and the downstream enqueue.
      await continueAfterBroll(data.clipId, {
        ...(control.jobId && control.startedAt
          ? {
              sourceClaim: {
                jobId: control.jobId,
                startedAt: control.startedAt,
                ...(control.claimToken ? { claimToken: control.claimToken } : {}),
              },
            }
          : {}),
      });
    }
    return result;
  } catch (error) {
    if (error instanceof RenderCancelledError || control.signal.aborted) {
      throw new RenderCancelledError();
    }
    // Recorded even when the queue will retry: the clip tile must never claim a
    // plan is coming when the pass is already failing.
    const message = toErrorMessage(error);
    const persisted = control.jobId && control.startedAt
      ? saveClipBrollPlanForRunningJob(
          data.clipId,
          null,
          'failed',
          message,
          control.jobId,
          control.startedAt,
          control.claimToken,
        )
      : saveClipBrollPlan(data.clipId, null, 'failed', message);
    await persisted.catch(() => undefined);
    throw error;
  }
}

interface LoopState {
  stopping: boolean;
}

type JobHandler = (
  job: QueueJob,
  onProgress: (progress: number) => void,
  control: JobExecutionControl,
) => Promise<unknown>;

async function markRecordRetrying(job: QueueJob): Promise<void> {
  try {
    if (job.type === BROLL_QUEUE_NAME && job.clipId) {
      // A retried B-roll pass must not touch the RENDER status of the clip; only
      // its own progress fields are reset.
      const clip = await getClip(job.clipId);
      if (clip) {
        clip.brollStatus = 'pending';
        clip.brollError = undefined;
        await updateClip(clip);
      }
    } else if (job.clipId) {
      const clip = await getClip(job.clipId);
      if (clip) {
        clip.status = 'pending';
        clip.progress = 0;
        clip.error = undefined;
        clip.cancelling = false;
        await updateClip(clip);
      }
    } else if (job.type === TRANSCRIPTION_QUEUE_NAME && job.videoId) {
      const video = await getVideo(job.videoId);
      if (video) {
        video.status = 'transcribing';
        video.error = undefined;
        await updateVideo(video);
      }
    } else if (job.type === VIRAL_DETECTION_QUEUE_NAME && job.videoId) {
      const video = await getVideo(job.videoId);
      if (video) {
        video.error = undefined;
        await updateVideo(video);
      }
    }
  } catch (error) {
    log.warn(`Could not refresh record status for retrying job ${job.id}: ${toErrorMessage(error)}`);
  }
}

async function executeJob(job: QueueJob, label: string, handler: JobHandler): Promise<void> {
  log.detail(`Received ${label} job ${job.id} (attempt ${job.attempts}/${job.maxAttempts}).`);
  await applyStoredRuntimeSettings();
  const control = watchJobClaim(job);
  try {
    if (control.signal.aborted) throw new RenderCancelledError();
    const result = await handler(job, (progress) => {
      if (!control.signal.aborted) updateJobProgress(job.id, progress, undefined, job.startedAt, job.claimToken);
    }, control);
    // The cancel route has already terminally failed this row. Do not overwrite
    // it with a late success from a network/renderer promise that settled after
    // the abort signal.
    if (control.signal.aborted) {
      log.warn(`${label} job ${job.id} stopped after its claim was cancelled.`);
      return;
    }
    if (completeJob(job.id, result, undefined, job.startedAt, job.claimToken)) {
      log.ok(`${label} job ${job.id} completed.`);
    }
  } catch (error) {
    if (control.signal.aborted || error instanceof RenderCancelledError) {
      log.warn(`${label} job ${job.id} cancelled.`);
      return;
    }
    const message = toErrorMessage(error);
    const outcome = failJob(job.id, message, undefined, job.startedAt, job.claimToken);
    if (outcome === 'retry') {
      await markRecordRetrying(job);
      log.warn(
        `${label} job ${job.id} failed on attempt ${job.attempts}/${job.maxAttempts}; ` +
        `queued for retry: ${message}`
      );
    } else if (outcome === 'failed') {
      // A B-roll plan is optional. Its terminal failure must hand the original
      // clip to the render queue (without a plan), never block later work.
      if (job.type === BROLL_QUEUE_NAME && job.clipId) {
        try {
          const handedOff = await continueAfterBroll(job.clipId);
          if (handedOff) log.warn(`B-roll failed permanently for ${job.clipId}; queued its render without B-roll.`);
        } catch (handoffError) {
          log.error(`Could not hand ${job.clipId} to render after B-roll failure: ${toErrorMessage(handoffError)}`);
        }
      }
      log.error(`${label} job ${job.id} failed permanently: ${message}`);
    }
  } finally {
    control.dispose();
  }
}

/** Each loop owns its own concurrency and polls only its own job type(s). */
async function runQueueLoop(
  type: string,
  label: string,
  concurrency: number,
  handler: JobHandler,
  state: LoopState
): Promise<void> {
  const runSlot = async (): Promise<void> => {
    while (!state.stopping) {
      let job: QueueJob | null;
      try {
        job = claimNextJob([type]);
      } catch (error) {
        log.error(`${label} queue claim failed: ${toErrorMessage(error)}`);
        await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
        continue;
      }

      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
        continue;
      }
      await executeJob(job, label, handler);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runSlot()));
}

async function startWorker(): Promise<void> {
  // Opening the database applies the schema and enables WAL + the five-second busy wait.
  getDatabase();
  const recovered = recoverRunningJobs();
  const cleanup = await sweepDeferredFileCleanup().catch((error) => {
    log.warn(`Could not sweep deferred file cleanup: ${toErrorMessage(error)}`);
    return { removed: 0, remaining: 0 };
  });
  await applyStoredRuntimeSettings();
  // Settings win, `.env.local` is the fallback, and both are folded together there.
  // Loop counts cannot change while the loops are running, so this is the one value
  // that needs a restart - the Settings page says so on the field.
  const workerSettings = (await loadEffectiveSettings()).worker;
  const clipConcurrency = workerSettings.clipConcurrency;
  const transcriptionConcurrency = 1;
  const detectionConcurrency = workerSettings.viralConcurrency;
  // One B-roll pass at a time: each one calls the LLM, Wikipedia and stock providers, and the
  // free tiers are per-account, so parallel passes only compete with themselves.
  const brollConcurrency = 1;

  log.section('ClipCraft worker starting');
  log.detail(`SQLite: ${getDatabasePath()} (WAL, busy_timeout=5000ms)`);
  log.detail(`Clip concurrency: ${clipConcurrency} (Settings -> Worker & limits; restart the worker to change it)`);
  log.detail(`Transcription concurrency: ${transcriptionConcurrency}`);
  log.detail(`Viral detection concurrency: ${detectionConcurrency}`);
  log.detail(`B-roll concurrency: ${brollConcurrency} (network-bound)`);
  if (recovered > 0) log.warn(`Recovered ${recovered} job(s) left running by a previous worker process.`);
  if (cleanup.removed > 0 || cleanup.remaining > 0) {
    log.detail(`Deferred file cleanup: removed=${cleanup.removed}, remaining=${cleanup.remaining}.`);
  }

  // A worker that died between two pipeline steps would otherwise leave a video
  // stuck mid-chain (transcribed but never analyzed, analyzed but never
  // rendered). Re-enter the chain where it stopped; manual videos are untouched.
  try {
    const { resumed } = await recoverAutoPipelines();
    if (resumed.length) {
      log.warn(`Resumed ${resumed.length} interrupted pipeline step(s): ${resumed.join(', ')}`);
    }
  } catch (error) {
    log.error(`Could not resume interrupted pipelines: ${toErrorMessage(error)}`);
  }

  const state: LoopState = { stopping: false };
  const loops = Promise.all([
    runQueueLoop(
      CLIP_QUEUE_NAME,
      'clip',
      clipConcurrency,
      async (job, onProgress, control) => {
        return processClipJob(job.payload as JobData, async (progress) => onProgress(progress), {
          jobId: job.id,
          startedAt: job.startedAt,
          claimToken: job.claimToken,
          signal: control.signal,
        });
      },
      state
    ),
    runQueueLoop(
      TRANSCRIPTION_QUEUE_NAME,
      'transcription',
      transcriptionConcurrency,
      async (job, _onProgress, control) => transcribeVideoJob(job.payload as TranscriptionJobData, {
        ...control,
        jobId: job.id,
        startedAt: job.startedAt,
        claimToken: job.claimToken,
      }),
      state
    ),
    runQueueLoop(
      VIRAL_DETECTION_QUEUE_NAME,
      'viral detection',
      detectionConcurrency,
      async (job, _onProgress, control) => viralDetectionJob(job.payload as ViralDetectionJobData, {
        ...control,
        jobId: job.id,
        startedAt: job.startedAt,
        claimToken: job.claimToken,
      }),
      state
    ),
    // B-roll is network-bound (LLM + image providers), so one job at a time is
    // plenty on one machine; the render loop stays the CPU-bound one.
    runQueueLoop(
      BROLL_QUEUE_NAME,
      'b-roll',
      brollConcurrency,
      async (job, onProgress, control) =>
        brollJob(job.payload as BrollJobData, onProgress, {
          signal: control.signal,
          jobId: job.id,
          startedAt: job.startedAt,
          claimToken: job.claimToken,
        }),
      state
    ),
  ]);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.stopping = true;
    log.warn(`${signal} received - stopping queue polling and finishing active jobs...`);

    const timer = setTimeout(() => {
      log.error('Forced exit after 30s; any remaining running jobs will be recovered on next startup.');
      process.exit(1);
    }, 30_000);
    timer.unref?.();

    try {
      await loops;
      clearTimeout(timer);
      closeDatabase();
      log.ok('Worker stopped cleanly.');
    } catch (error) {
      clearTimeout(timer);
      log.error(`Error while shutting down: ${toErrorMessage(error)}`);
      closeDatabase();
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await loops;
}

startWorker().catch((error) => {
  log.error(`Startup error: ${toErrorMessage(error)}`);
  closeDatabase();
  process.exit(1);
});
