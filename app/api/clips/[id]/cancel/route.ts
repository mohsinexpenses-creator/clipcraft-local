import { NextResponse } from 'next/server';
import { getClip, updateClip } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

/**
 * Request cancellation of a running render. Flips clip.cancelling = true; the
 * worker's cancel watcher polls the DB and kills the in-flight FFmpeg /
 * Remotion render within ~2s, then marks the clip as "Cancelled by user.".
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

    if (clip.status !== 'processing') {
      return NextResponse.json(
        { error: 'Only a clip that is currently rendering can be cancelled.' },
        { status: 400 }
      );
    }

    clip.cancelling = true;
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
