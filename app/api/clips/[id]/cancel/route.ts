import { NextResponse } from 'next/server';
import { getClip, updateClip } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { removeJobIfQueued } from '@/lib/queue';

/**
 * Request cancellation of a clip render.
 *
 * - `processing`: flips clip.cancelling = true; the worker's cancel watcher
 *   polls the DB and kills the in-flight FFmpeg / Remotion render within ~2s,
 *   then marks the clip as "Cancelled by user.".
 * - `pending`: deletes the still-queued render job and marks the clip as
 *   cancelled immediately. If the worker claimed the job a moment earlier, the
 *   request falls back to the running-render path instead.
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

    if (clip.status === 'pending') {
      const removed = removeJobIfQueued(`clip:${clip._id}`);
      if (removed) {
        clip.status = 'failed';
        clip.error = 'Cancelled by user.';
        clip.progress = 0;
        clip.cancelling = false;
      } else {
        // The worker claimed the job between our read and the delete - it is
        // rendering now, so cancel it the running-render way.
        clip.cancelling = true;
      }
    } else if (clip.status === 'processing') {
      clip.cancelling = true;
    } else {
      return NextResponse.json(
        { error: 'Only a clip that is queued or rendering can be cancelled.' },
        { status: 400 }
      );
    }

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
