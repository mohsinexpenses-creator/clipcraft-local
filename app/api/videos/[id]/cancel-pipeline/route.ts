import { NextResponse } from 'next/server';
import { getVideo, listClips, updateClip, updateVideo } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { cancelJob } from '@/lib/queue';
import { sanitizePipelineOptions } from '@/lib/pipeline-defaults';

export const runtime = 'nodejs';

/**
 * POST /api/videos/[id]/cancel-pipeline
 *
 * The dashboard's "Cancel pipeline" button. Stops the automatic chain and all
 * queued/running jobs for the video immediately:
 *
 *  - every RENDERING or QUEUED clip has its queue job cancelled and is marked
 *    "Cancelled by user." (`clip.cancelling = true` signals the worker to kill
 *    any in-flight FFmpeg / Remotion render within <500ms),
 *  - queued or running transcription / viral-detection jobs are cancelled,
 *  - auto-detect / auto-render are switched OFF for this video, so nothing
 *    chains back in automatically.
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

    const clips = await listClips(id);
    let runningStops = 0;
    let queuedCancels = 0;

    for (const clip of clips) {
      if (clip.status === 'processing' || clip.status === 'pending') {
        const wasProcessing = clip.status === 'processing';
        const outcome = cancelJob(`clip:${clip._id}`);
        cancelJob(`visual:${clip._id}`);
        clip.status = 'failed';
        clip.error = 'Cancelled by user.';
        clip.progress = 0;
        clip.cancelling = wasProcessing || outcome === 'running';
        if (wasProcessing || outcome === 'running') {
          runningStops += 1;
        } else {
          queuedCancels += 1;
        }
        await updateClip(clip);
      }
    }

    const transOutcome = cancelJob(`transcription:${id}`);
    const detectOutcome = cancelJob(`viral-detection:${id}`);
    const removedJobs = [transOutcome !== 'none', detectOutcome !== 'none'].filter(Boolean).length;

    if (!video.transcript && (video.status === 'uploaded' || video.status === 'transcribing' || transOutcome !== 'none')) {
      video.status = 'failed';
      video.error = 'Cancelled by user.';
    } else if (detectOutcome !== 'none' && clips.length === 0) {
      video.error = 'Cancelled by user.';
    }

    // Stop the chain from restarting itself: a running transcription would
    // otherwise queue detection on completion (and detection would queue the
    // renders). The user can turn automation back on in Pipeline settings.
    const pipeline = sanitizePipelineOptions(video.pipeline ?? {});
    const automationWasOn = pipeline.autoDetect || pipeline.autoRender;
    pipeline.autoDetect = false;
    pipeline.autoRender = false;
    video.pipeline = pipeline;
    await updateVideo(video);

    return NextResponse.json({
      success: true,
      runningStops,
      queuedCancels,
      removedJobs,
      automationDisabled: automationWasOn,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to cancel the pipeline.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
