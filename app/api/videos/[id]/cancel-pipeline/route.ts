import { NextResponse } from 'next/server';
import { cancelVideoPipelineSync, getDatabase } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * Stop every pending/running job in a video's automatic chain transactionally.
 * The `pipeline_cancelled` marker intentionally leaves the user's automation
 * choices untouched, so the normal Resume action can restart the same pipeline.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = cancelVideoPipelineSync(getDatabase(), id);
    if (!result.found) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...result, pipelineCancelled: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to cancel the pipeline.') },
      { status: toErrorStatus(error, 500) },
    );
  }
}
