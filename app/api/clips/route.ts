import { NextResponse } from 'next/server';
import {
  getClip,
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  getVideo,
  listClips,
  updateClip,
} from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { enqueueClipJob } from '@/lib/queue';
import { jobDataFromClip } from '@/lib/pipeline';
import { sanitizeClipEdits } from '@/lib/clip-edits';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const videoId = searchParams.get('videoId') || undefined;

    const clips = await listClips(videoId);
    return NextResponse.json({ clips });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load clips.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

/**
 * POST /api/clips - queue one clip for rendering.
 *
 * The body may carry the edits made in the clip editor; whatever it carries is
 * applied to the stored clip record and then rendered, so "Save & re-render" is
 * one request and one atomic step. Fields left out keep their stored value,
 * which is also what makes a plain `{ clipId }` body a "re-render as is".
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> | null = null;
  let clipId = '';

  try {
    body = (await request.json()) as Record<string, unknown>;

    clipId = typeof body.clipId === 'string' ? body.clipId : '';
    const videoId = typeof body.videoId === 'string' ? body.videoId : '';

    if (!clipId) {
      return NextResponse.json({ error: 'Missing clipId' }, { status: 400 });
    }

    const existingClip = await getClip(clipId);
    if (!existingClip) {
      return NextResponse.json({ error: 'Clip record not found' }, { status: 404 });
    }
    if (videoId && existingClip.videoId !== videoId) {
      throw new AppError(`Clip ${clipId} does not belong to video ${videoId}.`, { status: 400 });
    }

    const video = await getVideo(existingClip.videoId);
    const edits = sanitizeClipEdits(body, { duration: video?.duration });
    Object.assign(existingClip, edits);

    // Preset ids fall back to the configured database defaults, so a re-render
    // of an old clip (created before presets existed) still finds a style. The
    // worker resolves the same defaults again; doing it here too means the clip
    // record and the queue job agree on exactly what is being rendered.
    const [defaultCaptionPreset, defaultHookStyle, defaultCtaStyle] = await Promise.all([
      getDefaultCaptionPreset(),
      getDefaultOverlayStylePreset('hook'),
      getDefaultOverlayStylePreset('cta'),
    ]);
    existingClip.captionPresetId =
      existingClip.captionPresetId?.trim() || defaultCaptionPreset?._id || '';
    existingClip.hookStylePresetId =
      existingClip.hookStylePresetId?.trim() || defaultHookStyle?._id;
    existingClip.ctaStylePresetId = existingClip.ctaStylePresetId?.trim() || defaultCtaStyle?._id;

    if (!existingClip.captionPresetId) {
      throw new AppError('No caption preset is selected for this clip.', {
        status: 500,
        resolution: 'Pick a caption preset in the clip editor, or set a default in preset settings.',
      });
    }

    // A re-render always starts from scratch: clear the previous failure and
    // progress so the grid shows a clean 0% instead of an old error.
    existingClip.status = 'pending';
    existingClip.progress = 0;
    existingClip.error = undefined;

    // enqueueClipJob() writes the edits and the job in one transaction, so an
    // active-job conflict can never leave the row looking "pending" while no
    // render was actually queued.
    await enqueueClipJob(jobDataFromClip(existingClip));
    const queuedClip = await getClip(existingClip._id);

    return NextResponse.json({
      success: true,
      clip: queuedClip ?? existingClip,
    });
  } catch (error) {
    if (clipId && toErrorStatus(error, 500) !== 409) {
      try {
        const clip = await getClip(clipId);
        if (clip) {
          clip.status = 'failed';
          clip.error = toErrorMessage(error, 'Failed to start render job.');
          await updateClip(clip);
        }
      } catch (saveError) {
        console.error('[API Clips POST] Failed to persist error state:', saveError);
      }
    }

    console.error('[API Clips POST] Error:', error);
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to start clip render.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
