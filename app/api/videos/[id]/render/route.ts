import { NextResponse } from 'next/server';
import { getVideo, listClips } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { queueRendersForVideo } from '@/lib/pipeline';

export const runtime = 'nodejs';

/**
 * POST /api/videos/[id]/render
 *
 * Queue the renders this video still needs, using each clip's stored
 * configuration. Body is optional:
 *   { "clipIds": ["clip_1"], "includeDone": false }
 *
 * Without `clipIds` it renders every clip that is pending or failed - the
 * "Render all" / "Retry failed" button. Clips that are already rendering are
 * never double-queued (`enqueueClipJob` refuses while a job for that clip is
 * running), so pressing it twice is harmless.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // No body: "everything that still needs a render".
    }

    const clipIds = Array.isArray(body.clipIds)
      ? body.clipIds.filter((value): value is string => typeof value === 'string')
      : undefined;
    const includeDone = body.includeDone === true;

    const clips = await listClips(id);
    if (!clips.length) {
      return NextResponse.json(
        {
          error: 'This video has no clips yet. Run viral detection first.',
        },
        { status: 400 }
      );
    }

    const result = await queueRendersForVideo(id, { clipIds, includeDone });

    return NextResponse.json({
      success: true,
      queued: result.queued.map((clip) => clip._id),
      skipped: result.skipped,
      failed: result.failed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to queue the renders.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
