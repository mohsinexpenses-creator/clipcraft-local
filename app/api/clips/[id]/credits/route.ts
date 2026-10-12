import { NextResponse } from 'next/server';
import { getClip } from '@/lib/db';
import { buildClipCreditsManifest } from '@/lib/contextual-visuals';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * GET /api/clips/[id]/credits
 *
 * Returns the attribution and licensing manifest for a clip's contextual visual overlays.
 * Supports `?format=txt` for a plain-text credits file or default JSON.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const clip = await getClip(id);
    if (!clip) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    const manifest = buildClipCreditsManifest({
      clipId: clip._id,
      videoId: clip.videoId,
      clipTitle: clip.aiAnalysis?.viral_packaging?.video_title || clip.videoTitle,
      visualOverlays: clip.visualOverlays,
    });

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format')?.toLowerCase();
    const download = searchParams.get('download') === '1';

    if (format === 'txt' || format === 'text') {
      return new NextResponse(manifest.plainText, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...(download
            ? {
                'Content-Disposition': `attachment; filename="clip-${clip._id}-credits.txt"`,
              }
            : {}),
        },
      });
    }

    return NextResponse.json(manifest, {
      status: 200,
      headers: download
        ? {
            'Content-Disposition': `attachment; filename="clip-${clip._id}-credits.json"`,
          }
        : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to build clip credits manifest.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
