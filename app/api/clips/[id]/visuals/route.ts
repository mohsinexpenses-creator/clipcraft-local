import { NextResponse } from 'next/server';
import { getClip, getVideo, updateClip } from '@/lib/db';
import { resolveVisualProviderSettings } from '@/lib/app-settings';
import { planClipVisualMoments } from '@/lib/contextual-visuals';
import {
  resolveSingleVisualOverlay,
  resolveVisualOverlaysForClip,
} from '@/lib/visual-providers';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * POST /api/clips/[id]/visuals
 *
 * Resolves or refreshes contextual visual overlays for a clip so the user can
 * inspect, replace, or adjust visual moments in the studio UI before rendering.
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

    const body = (await request.json().catch(() => ({}))) as {
      overlayId?: string;
      customQuery?: string;
    };

    const { render, pexelsApiKey, openverseClientId, openverseClientSecret, wikimediaUserAgent } =
      await resolveVisualProviderSettings();

    let overlays = clip.visualOverlays ?? [];
    if (overlays.length === 0 && clip.aiAnalysis?.visualMoments?.length) {
      const video = await getVideo(clip.videoId);
      overlays = planClipVisualMoments({
        rawMoments: clip.aiAnalysis.visualMoments,
        clipStart: clip.start,
        clipEnd: clip.end,
        transcript: video?.transcript,
        hookTiming: {
          start: 0,
          duration: clip.hookDuration ?? 0,
        },
        options: {
          autoVisuals: true,
          maxVisualMoments: render.maxVisualMoments,
          confidenceThreshold: render.visualConfidenceThreshold,
          minDuration: render.visualMinDuration,
          defaultDuration: render.visualDefaultDuration,
          defaultAnimation: render.visualAnimation,
        },
      });
    }

    const providerOptions = {
      renderSettings: { ...render, autoVisuals: true },
      pexelsApiKey,
      openverseClientId,
      openverseClientSecret,
      wikimediaUserAgent,
    };

    if (body.overlayId) {
      const usedAssetIds = new Set<string>();
      for (const item of overlays) {
        if (item.attribution) {
          usedAssetIds.add(`${item.attribution.provider}:${item.attribution.assetId}`);
        }
      }

      overlays = await Promise.all(
        overlays.map(async (item) => {
          if (item.id !== body.overlayId) return item;
          const nextQueries =
            typeof body.customQuery === 'string' && body.customQuery.trim()
              ? [body.customQuery.trim(), ...item.searchQueries]
              : item.searchQueries;
          const resetItem = {
            ...item,
            searchQueries: nextQueries,
            status: 'planned' as const,
            localFilePath: undefined,
            mediaUrl: undefined,
            attribution: undefined,
          };
          return resolveSingleVisualOverlay(resetItem, providerOptions, usedAssetIds);
        })
      );
    } else {
      overlays = await resolveVisualOverlaysForClip(overlays, providerOptions);
    }

    clip.visualOverlays = overlays;
    clip.autoVisuals = true;
    await updateClip(clip);

    return NextResponse.json({
      success: true,
      clip,
      visualOverlays: overlays,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to resolve visual overlays.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
