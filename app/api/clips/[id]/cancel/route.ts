import { NextResponse } from 'next/server';
import { cancelClipWorkSync, getDatabase } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * Terminally cancel BOTH B-roll and rendering for a clip in one SQLite
 * transaction. Running workers notice their claim token disappear within 400ms;
 * queued workers can never claim a cancelled row in the meantime.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = cancelClipWorkSync(getDatabase(), id);
    if (!result.found) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to cancel clip work.') },
      { status: toErrorStatus(error, 500) },
    );
  }
}
