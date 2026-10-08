import { NextResponse } from 'next/server';
import { getVideo, listClips } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { listVideoPipelineJobs } from '@/lib/queue';
import { pipelineStatusForVideo } from '@/lib/pipeline-status';
import { queueRendersForVideo, queueViralDetection } from '@/lib/pipeline';
import { queueTranscription } from '@/lib/upload';

export const runtime = 'nodejs';

/**
 * GET /api/videos/[id]/pipeline
 *
 * The single call the dashboard polls while a pipeline is running: the video,
 * its clips and the derived stage/progress. The stage is computed from the queue
 * and clip rows on every request (lib/pipeline-status.ts) - nothing about it is
 * stored, so a reload or a worker restart can never show progress that is not
 * really happening.
 *
 * The transcript is deliberately left out: a three-hour podcast transcript is
 * tens of thousands of words, and the dashboard asks for it separately (and only
 * when the transcript panel is opened).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const clips = await listClips(id);
    const jobs = listVideoPipelineJobs(id);

    const videoWithoutTranscript = { ...video };
    delete videoWithoutTranscript.transcript;

    return NextResponse.json({
      video: videoWithoutTranscript,
      transcriptReady: Boolean(video.transcript),
      clips,
      status: pipelineStatusForVideo(video, clips, jobs),
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load pipeline status.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

/**
 * POST /api/videos/[id]/pipeline
 *
 * Nudge a stalled pipeline by re-queueing the *earliest* step that has not
 * finished: the transcript when there is none, then detection when no clips
 * exist, otherwise the renders that are still pending. That order matters -
 * queueing detection for an untranscribed video would only produce a job that
 * fails again.
 *
 * The dashboard's "Resume" button calls this and it is safe to press repeatedly:
 * queued-but-not-started work is never duplicated because every job id is stable
 * per record.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    if (!video.transcript) {
      const queued = await queueTranscription(video);
      return NextResponse.json({
        success: true,
        step: 'transcript',
        state: queued ? 'queued' : 'already-running',
      });
    }

    const clips = await listClips(id);
    if (!clips.length) {
      const state = await queueViralDetection(id);
      return NextResponse.json({ success: true, step: 'viral-detection', state });
    }

    const result = await queueRendersForVideo(id, {
      clipIds: clips
        .filter((clip) => clip.status === 'pending' || clip.status === 'failed')
        .map((clip) => clip._id),
    });

    return NextResponse.json({
      success: true,
      step: 'render',
      queued: result.queued.length,
      skipped: result.skipped.length,
      failed: result.failed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to resume the pipeline.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
