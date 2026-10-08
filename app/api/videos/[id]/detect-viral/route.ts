import { NextResponse } from 'next/server';
import { runViralDetection } from '@/lib/pipeline';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * POST /api/videos/[id]/detect-viral
 *
 * Thin HTTP wrapper around `runViralDetection()` in lib/pipeline.ts, which the
 * worker's automatic `viral-detection` job calls too. Keeping the rules in one
 * function means the manual button and the automatic run can never drift apart:
 * same transcript checks, same clamping, same default render configuration, and
 * the same "render them right away" behaviour.
 *
 * Body (all optional):
 *   { "options": { clipCount, minClipDuration, includeHookText, includeCta },
 *     "autoRender": true }
 *
 * `autoRender` defaults to whatever is stored on the video (on by default for
 * uploads), so an omitted body means "detect and render".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // Empty body is fine - every option falls back to its default.
    }

    const result = await runViralDetection(id, {
      pipeline: body,
      ...(typeof body.autoRender === 'boolean' ? { autoRender: body.autoRender } : {}),
      // A press of the button is an explicit request for a fresh analysis run.
      mode: 'manual',
    });

    return NextResponse.json({
      success: true,
      clips: result.clips,
      video: result.video,
      options: result.options,
      autoRender: result.autoRender,
      renderQueued: result.renderQueued,
      reusedExistingClips: result.reusedExistingClips,
    });
  } catch (error) {
    console.error('[API Detect Viral] Error:', error);
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to detect viral segments.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
