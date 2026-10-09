import { NextResponse } from 'next/server';
import { getVideo, listClips, updateClip, updateVideo } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { removeJobIfQueued } from '@/lib/queue';
import { sanitizePipelineOptions } from '@/lib/pipeline-defaults';

export const runtime = 'nodejs';

/**
 * POST /api/videos/[id]/cancel-pipeline
 *
 * The dashboard's "Cancel pipeline" button. Stops as much of the automatic
 * chain as can be stopped:
 *
 *  - every RENDERING clip gets clip.cancelling = true (the worker kills the
 *    in-flight render within ~2s and marks it "Cancelled by user."),
 *  - every QUEUED clip loses its render job and is marked cancelled; if the
 *    worker claimed one a moment earlier it is cancelled the running way,
 *  - a transcription or detection job that is still QUEUED is deleted,
 *  - auto-detect / auto-render are switched OFF for this video, so a step that
 *    is already running cannot chain the next one back in after it finishes.
 *
 * A transcription/detection pass that is ALREADY RUNNING finishes - there is
 * no mid-flight abort for those - but nothing follows it automatically.
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
      if (clip.status === 'processing') {
        clip.cancelling = true;
        await updateClip(clip);
        runningStops += 1;
      } else if (clip.status === 'pending') {
        if (removeJobIfQueued(`clip:${clip._id}`)) {
          clip.status = 'failed';
          clip.error = 'Cancelled by user.';
          clip.progress = 0;
          clip.cancelling = false;
          queuedCancels += 1;
        } else {
          clip.cancelling = true;
          runningStops += 1;
        }
        await updateClip(clip);
      }
    }

    // Queued (not yet running) transcription / detection jobs can simply go.
    const removedJobs = [
      removeJobIfQueued(`transcription:${id}`),
      removeJobIfQueued(`viral-detection:${id}`),
    ].filter(Boolean).length;

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
