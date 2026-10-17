import { NextResponse } from 'next/server';
import { getClip } from '@/lib/db';
import { enqueueVisualPrefetchJob, getJob } from '@/lib/queue';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/** Return queue-derived state; refreshing the page never loses a visual request. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const clip = await getClip(id);
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  const job = getJob(`visual:${id}`);
  return NextResponse.json({ clip, visualOverlays: clip.visualOverlays ?? [], jobStatus: job?.status, error: job?.error });
}

/** The editor requests a queue job; no network/planning work runs in this route. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const clip = await getClip(id);
    if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    const body = await request.json().catch(() => ({})) as { overlayId?: string; customQuery?: string };
    if (body.overlayId) {
      if (!clip.visualOverlays?.some((ov) => ov.id === body.overlayId)) throw new AppError('Visual beat not found', { status: 404 });
      const query = typeof body.customQuery === 'string' ? body.customQuery.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      clip.visualsUseEditedMoments = true;
      clip.visualOverlays = clip.visualOverlays.map((ov) => ov.id === body.overlayId ? {
        ...ov, searchQueries: query ? [...new Set([query, ...ov.searchQueries])].slice(0, 3) : ov.searchQueries,
        status: 'planned', localFilePath: undefined, mediaUrl: undefined, attribution: undefined, visualVerificationHash: undefined,
      } : ov);
    }
    clip.autoVisuals = true;
    clip.visualPrefetchSettings = { ...clip.visualPrefetchSettings, autoVisuals: true };
    clip.cancelling = false;
    if (clip.error === 'Cancelled by user.') clip.error = undefined;
    const jobId = await enqueueVisualPrefetchJob({ clipId: id, videoId: clip.videoId, renderAfter: false }, clip);
    return NextResponse.json({ success: true, queued: true, jobId, clip, visualOverlays: clip.visualOverlays ?? [] }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error, 'Failed to queue visual prefetch.') }, { status: toErrorStatus(error, 500) });
  }
}
