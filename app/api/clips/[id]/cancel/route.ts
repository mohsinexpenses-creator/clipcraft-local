import { NextResponse } from 'next/server';
import { getClip, updateClip } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { cancelJob } from '@/lib/queue';

/**
 * Request cancellation of a clip render.
 *
 * - Immediately cancels any `queued` or `running` job in SQLite (`cancelJob`).
 * - Marks the clip `failed` with `"Cancelled by user."` and sets `cancelling = true`
 *   when the clip was `processing` so the worker's cancel watcher / progress sink
 *   kills any in-flight FFmpeg / Remotion child process within <500ms.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const clip = await getClip(id);
    if (!clip) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    if (clip.status !== 'pending' && clip.status !== 'processing') {
      return NextResponse.json(
        { error: 'Only a clip that is queued or rendering can be cancelled.' },
        { status: 400 }
      );
    }

    const wasProcessing = clip.status === 'processing';
    const jobOutcome = cancelJob(`clip:${clip._id}`);
    cancelJob(`visual:${clip._id}`);

    clip.status = 'failed';
    clip.error = 'Cancelled by user.';
    clip.progress = 0;
    clip.cancelling = wasProcessing || jobOutcome === 'running';

    if (!(await updateClip(clip))) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, clip });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to cancel render.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
