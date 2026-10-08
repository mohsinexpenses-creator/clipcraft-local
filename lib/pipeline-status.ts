import {
  ClipRecord,
  ClipCounts,
  DEFAULT_PIPELINE_OPTIONS,
  PipelineOptions,
  VideoRecord,
  VideoSummary,
} from './types';

export type { ClipCounts };

/**
 * Pure pipeline maths shared by the API and the dashboard.
 *
 * The pipeline stage is deliberately not stored anywhere: it is derived from
 * what is already true (transcript present, clips present, jobs queued or
 * running, per-clip status). A page refresh, a worker restart or a retry can
 * therefore never show a stale "step 2 of 4", because there is no step counter
 * that could go stale.
 */

export const TRANSCRIPTION_JOB_TYPE = 'transcription';
export const VIRAL_DETECTION_JOB_TYPE = 'viral-detection';
export const CLIP_JOB_TYPE = 'clip-processing';

export type PipelineStage =
  /** Upload accepted; transcription queued but not started yet. */
  | 'queued'
  /** whisper.cpp / Deepgram is running. */
  | 'transcribing'
  /** Viral detection is running (the AI is picking the clip windows). */
  | 'analyzing'
  /** Transcript ready, detection not queued (the user paused the automation). */
  | 'awaiting-detection'
  /** Render jobs queued or running. */
  | 'rendering'
  /** Clips detected but their renders were left to the user. */
  | 'awaiting-render'
  /** Nothing is running and at least one clip is finished. */
  | 'ready'
  /** The active step failed. */
  | 'failed';

export type PipelineStepKey = 'transcript' | 'analyze' | 'render';
export type PipelineStepState = 'pending' | 'active' | 'done' | 'failed' | 'paused';

export interface PipelineStep {
  key: PipelineStepKey;
  label: string;
  state: PipelineStepState;
  /** 0-100 within this step. */
  progress: number;
  /** Short line under the step ("1,482 words", "3 of 10 clips"). */
  detail?: string;
  error?: string;
}

export interface PipelineJobLike {
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error?: string;
  videoId?: string;
  clipId?: string;
}

export interface PipelineFacts {
  videoStatus: VideoRecord['status'];
  transcriptReady: boolean;
  transcriptSegmentCount?: number;
  videoError?: string;
  counts: ClipCounts;
  clipError?: string;
  jobs?: readonly PipelineJobLike[];
  pipeline?: PipelineOptions;
}

export interface PipelineStatus {
  stage: PipelineStage;
  /** 0-100 across the whole pipeline (100 when ready). */
  progress: number;
  steps: PipelineStep[];
  counts: ClipCounts;
  /** Queued + rendering clips. */
  activeClips: number;
  error?: string;
  pipeline: PipelineOptions;
}

export function countClips(clips: readonly ClipRecord[]): ClipCounts {
  const counts: ClipCounts = {
    clips: clips.length,
    done: 0,
    active: 0,
    queued: 0,
    failed: 0,
    progress: 0,
  };
  let progressSum = 0;
  for (const clip of clips) {
    if (clip.status === 'done') {
      counts.done += 1;
      progressSum += 100;
    } else if (clip.status === 'processing') {
      counts.active += 1;
      progressSum += clampPercent(clip.progress ?? 0);
    } else if (clip.status === 'failed') {
      counts.failed += 1;
    } else {
      counts.queued += 1;
      progressSum += clampPercent(clip.progress ?? 0);
    }
  }
  counts.progress = clips.length ? Math.round(progressSum / clips.length) : 0;
  return counts;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function step(
  key: PipelineStepKey,
  label: string,
  state: PipelineStepState,
  progress: number,
  extra?: { detail?: string; error?: string }
): PipelineStep {
  return {
    key,
    label,
    state,
    progress: clampPercent(progress),
    ...(extra?.detail ? { detail: extra.detail } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
  };
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}

function latestJob(
  jobs: readonly PipelineJobLike[] | undefined,
  type: string
): PipelineJobLike | undefined {
  if (!jobs?.length) return undefined;
  return jobs.filter((job) => job.type === type).at(-1);
}

/** The one derivation both the list and the detail view run through. */
export function derivePipelineStatus(facts: PipelineFacts): PipelineStatus {
  const {
    videoStatus,
    transcriptReady,
    counts,
    jobs,
    videoError,
    clipError,
  } = facts;
  const pipeline = facts.pipeline ?? DEFAULT_PIPELINE_OPTIONS;

  const transcriptionJob = latestJob(jobs, TRANSCRIPTION_JOB_TYPE);
  const detectionJob = latestJob(jobs, VIRAL_DETECTION_JOB_TYPE);

  const transcriptionRunning =
    transcriptionJob?.status === 'queued' || transcriptionJob?.status === 'running';
  const transcriptionActive = !transcriptReady && (videoStatus === 'transcribing' || transcriptionRunning);
  const transcriptionFailed =
    !transcriptReady &&
    !transcriptionActive &&
    (transcriptionJob?.status === 'failed' || videoStatus === 'failed');

  const detectionRunning =
    detectionJob?.status === 'queued' || detectionJob?.status === 'running';
  const detectionActive = !transcriptionActive && detectionRunning;
  const detectionFailed =
    !transcriptionActive &&
    !detectionRunning &&
    counts.clips === 0 &&
    (detectionJob?.status === 'failed' || (videoStatus === 'failed' && transcriptReady));

  const renderActive =
    counts.active > 0 || (counts.queued > 0 && pipeline.autoRender && !detectionActive);
  const allClipsFailed =
    counts.clips > 0 && counts.done === 0 && counts.failed === counts.clips;
  const awaitingRender = counts.queued > 0 && !pipeline.autoRender;

  let stage: PipelineStage;
  if (transcriptionActive) stage = 'transcribing';
  else if (transcriptionFailed) stage = 'failed';
  else if (detectionActive) stage = 'analyzing';
  else if (detectionFailed) stage = 'failed';
  else if (renderActive) stage = 'rendering';
  else if (counts.clips > 0 && awaitingRender) stage = 'awaiting-render';
  else if (counts.clips > 0 && allClipsFailed) stage = 'failed';
  else if (counts.clips > 0) stage = 'ready';
  else if (transcriptReady) stage = pipeline.autoDetect ? 'queued' : 'awaiting-detection';
  else stage = videoStatus === 'failed' ? 'failed' : 'queued';

  const steps: PipelineStep[] = [];
  if (transcriptReady) {
    steps.push(
      step('transcript', 'Transcript', 'done', 100, {
        detail: facts.transcriptSegmentCount ? plural(facts.transcriptSegmentCount, 'segment') : undefined,
      })
    );
  } else if (transcriptionActive) {
    steps.push(
      step('transcript', 'Transcript', 'active', transcriptionJob?.progress ?? 0, {
        detail: transcriptionJob?.status === 'running' ? 'Word-level timestamps' : 'Queued',
      })
    );
  } else if (transcriptionFailed) {
    steps.push(
      step('transcript', 'Transcript', 'failed', 0, { error: transcriptionJob?.error ?? videoError })
    );
  } else {
    steps.push(step('transcript', 'Transcript', 'pending', 0));
  }

  if (counts.clips > 0) {
    steps.push(step('analyze', 'Viral detection', 'done', 100, { detail: plural(counts.clips, 'clip') }));
  } else if (detectionActive) {
    steps.push(
      step('analyze', 'Viral detection', 'active', detectionJob?.progress ?? 0, {
        detail: detectionJob?.status === 'running' ? 'Scoring the transcript' : 'Queued',
      })
    );
  } else if (detectionFailed) {
    steps.push(step('analyze', 'Viral detection', 'failed', 0, { error: detectionJob?.error ?? videoError }));
  } else {
    steps.push(
      step('analyze', 'Viral detection', pipeline.autoDetect ? 'pending' : 'paused', 0, {
        detail: pipeline.autoDetect ? undefined : 'Paused',
      })
    );
  }

  if (counts.clips === 0) {
    steps.push(
      step('render', 'Render', pipeline.autoRender ? 'pending' : 'paused', 0, {
        detail: pipeline.autoRender ? undefined : 'Manual',
      })
    );
  } else if (renderActive) {
    steps.push(
      step('render', 'Render', 'active', counts.progress, {
        detail: `${counts.done}/${counts.clips} rendered`,
      })
    );
  } else if (counts.done === counts.clips) {
    steps.push(step('render', 'Render', 'done', 100, { detail: plural(counts.done, 'clip') }));
  } else if (awaitingRender) {
    steps.push(
      step('render', 'Render', 'paused', 0, { detail: `${counts.queued} waiting for you` })
    );
  } else {
    steps.push(
      step('render', 'Render', counts.failed > 0 ? 'failed' : 'pending', counts.progress, {
        detail: `${counts.done} done · ${counts.failed} failed`,
      })
    );
  }

  const error = stage === 'failed' ? clipError ?? videoError : undefined;

  // A single 0-100 bar for the whole run: transcription is the first half,
  // detection the next 20%, rendering the last 30%.
  let progress: number;
  if (stage === 'ready') progress = 100;
  else if (stage === 'transcribing') progress = 5 + (transcriptionJob?.progress ?? 0) * 0.45;
  else if (stage === 'analyzing') progress = 50 + (detectionJob?.progress ?? 0) * 0.2;
  else if (stage === 'rendering') progress = 70 + counts.progress * 0.3;
  else if (stage === 'awaiting-render') progress = 70;
  else if (stage === 'awaiting-detection') progress = 50;
  else if (stage === 'failed') progress = Math.max(5, counts.clips ? 70 : transcriptReady ? 50 : 5);
  else progress = 0;

  return {
    stage,
    progress: clampPercent(progress),
    steps,
    counts,
    activeClips: counts.active + counts.queued,
    ...(error ? { error } : {}),
    pipeline,
  };
}

/** Detail view: full video record + its clips + the jobs belonging to them. */
export function pipelineStatusForVideo(
  video: VideoRecord,
  clips: readonly ClipRecord[],
  jobs: readonly PipelineJobLike[] = [],
  pipeline?: PipelineOptions
): PipelineStatus {
  const counts = countClips(clips);
  return derivePipelineStatus({
    videoStatus: video.status,
    transcriptReady: Boolean(video.transcript),
    transcriptSegmentCount: video.transcript?.segments?.length,
    ...(video.error ? { videoError: video.error } : {}),
    counts,
    ...(clips.find((clip) => clip.error)?.error
      ? { clipError: clips.find((clip) => clip.error)!.error }
      : {}),
    jobs,
    ...(pipeline ?? video.pipeline ? { pipeline: pipeline ?? video.pipeline } : {}),
  });
}

/** List view: transcript JSON was never loaded, clip counts came from SQL. */
export function pipelineStatusForSummary(
  video: VideoSummary,
  counts: ClipCounts,
  jobs: readonly PipelineJobLike[] = []
): PipelineStatus {
  return derivePipelineStatus({
    videoStatus: video.status,
    transcriptReady: video.transcriptReady,
    transcriptSegmentCount: video.transcriptSegmentCount,
    ...(video.error ? { videoError: video.error } : {}),
    counts,
    jobs,
    ...(video.pipeline ? { pipeline: video.pipeline } : {}),
  });
}

/** Score-weighted ordering used by the clip grid (best clip top-left). */
export function bestScoreOf(clips: readonly ClipRecord[]): number | null {
  const scores = clips
    .map((clip) => clip.aiAnalysis?.scores.viral_score)
    .filter((score): score is number => typeof score === 'number');
  return scores.length ? Math.max(...scores) : null;
}
