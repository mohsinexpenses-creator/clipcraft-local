import { NextResponse } from 'next/server';
import { getClip, updateClip } from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { enqueueBrollJob, enqueueClipJob } from '@/lib/queue';
import { jobDataFromClip } from '@/lib/pipeline';
import { getClipBrollSummary, removeBrollItem, swapBrollItem } from '@/lib/broll/edit';

export const runtime = 'nodejs';

/**
 * B-roll for ONE clip - the clip grid's only B-roll surface.
 *
 *   GET  -> the stored plan (thumbnails, type, time range, attribution) + status
 *   POST -> { action: 'rerun' | 'swap' | 'remove', itemId? }
 *
 * Swapping uses the alternatives recorded with the plan, so it never triggers a new
 * provider search and can never quietly substitute a different subject. Both edits
 * re-render the clip so what the user sees is what the plan says.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const summary = await getClipBrollSummary(id);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load the B-roll plan.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? '').trim();
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';

    const clip = await getClip(id);
    if (!clip) throw new AppError('Clip not found.', { status: 404 });

    if (action === 'rerun') {
      clip.brollStatus = 'pending';
      clip.brollError = undefined;
      await updateClip(clip);
      await enqueueBrollJob({ clipId: clip._id, videoId: clip.videoId, trigger: 'manual' });
      return NextResponse.json({ queued: true, status: 'pending' });
    }

    if (action !== 'swap' && action !== 'remove') {
      return NextResponse.json(
        { error: "action must be one of 'rerun', 'swap' or 'remove'" },
        { status: 400 }
      );
    }
    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required for this action.' }, { status: 400 });
    }

    const plan =
      action === 'swap' ? await swapBrollItem(clip._id, itemId) : await removeBrollItem(clip._id, itemId);

    // The plan changed, so the rendered file is now stale. Queue a render, but a
    // clip that is already rendering keeps working: the user can render again.
    let renderQueued = false;
    let note: string | undefined;
    if (clip.status !== 'processing') {
      try {
        await enqueueClipJob(await jobDataFromClip(clip));
        renderQueued = true;
      } catch (queueError) {
        note = toErrorMessage(queueError, 'The render could not be queued.');
      }
    } else {
      note = 'The clip is rendering right now; render it again to see this change.';
    }

    return NextResponse.json({ plan, renderQueued, ...(note ? { note } : {}) });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'The B-roll edit failed.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
