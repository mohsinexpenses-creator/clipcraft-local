import { NextResponse } from 'next/server';
import { getClip, listClips, saveClip } from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { enqueueClipJob } from '@/lib/queue';
import { JobData } from '@/lib/types';

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

export async function POST(request: Request) {
  let body: Record<string, unknown> | null = null;

  try {
    body = (await request.json()) as Record<string, unknown>;

    const clipId = typeof body.clipId === 'string' ? body.clipId : '';
    const videoId = typeof body.videoId === 'string' ? body.videoId : '';
    const start = body.start;
    const end = body.end;
    const hookDurationValue = body.hookDuration ?? 3;
    const ctaDurationValue = body.ctaDuration ?? 2.5;
    const hookText = typeof body.hookText === 'string' ? body.hookText : undefined;
    const ctaText = typeof body.ctaText === 'string' ? body.ctaText : undefined;
    const filterPreset = typeof body.filterPreset === 'string' ? body.filterPreset : 'vibrant';
    const captionPresetId =
      typeof body.captionPresetId === 'string' ? body.captionPresetId : 'preset-bold-yellow';
    const layout = body.layout === 'split-screen' ? 'split-screen' : 'speaker-focus';
    const hookStylePresetIdRaw =
      typeof body.hookStylePresetId === 'string' && body.hookStylePresetId
        ? body.hookStylePresetId
        : undefined;
    const ctaStylePresetIdRaw =
      typeof body.ctaStylePresetId === 'string' && body.ctaStylePresetId
        ? body.ctaStylePresetId
        : undefined;

    if (!clipId || !videoId) {
      return NextResponse.json({ error: 'Missing clipId or videoId' }, { status: 400 });
    }

    const existingClip = await getClip(clipId);
    if (!existingClip) {
      return NextResponse.json({ error: 'Clip record not found' }, { status: 404 });
    }

    const parsedStart = Number(start);
    const parsedEnd = Number(end);
    const parsedHookDuration = Number(hookDurationValue);
    const parsedCtaDuration = Number(ctaDurationValue);

    if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedEnd <= parsedStart) {
      throw new AppError('Clip render request has invalid start/end timestamps.', {
        status: 400,
        details: `start=${String(start)}, end=${String(end)}`,
        resolution: 'Choose a valid clip window before rendering.',
      });
    }

    if (!Number.isFinite(parsedHookDuration) || parsedHookDuration < 0) {
      throw new AppError('Clip render request has an invalid hook duration.', {
        status: 400,
        details: `hookDuration=${String(hookDurationValue)}`,
        resolution: 'Use a non-negative hook duration before rendering.',
      });
    }

    if (!Number.isFinite(parsedCtaDuration) || parsedCtaDuration < 0) {
      throw new AppError('Clip render request has an invalid CTA duration.', {
        status: 400,
        details: `ctaDuration=${String(ctaDurationValue)}`,
        resolution: 'Use a non-negative CTA duration before rendering.',
      });
    }

    existingClip.start = parsedStart;
    existingClip.end = parsedEnd;
    existingClip.hookDuration = parsedHookDuration;
    existingClip.ctaDuration = parsedCtaDuration;
    if (hookText !== undefined) existingClip.hookText = hookText;
    if (ctaText !== undefined) existingClip.ctaText = ctaText;
    existingClip.filterPreset = filterPreset;
    existingClip.captionPresetId = captionPresetId;
    existingClip.layout = layout;
    existingClip.hookStylePresetId = hookStylePresetIdRaw ?? existingClip.hookStylePresetId;
    existingClip.ctaStylePresetId = ctaStylePresetIdRaw ?? existingClip.ctaStylePresetId;

    existingClip.status = 'pending';
    existingClip.progress = 0;
    existingClip.error = undefined;
    await saveClip(existingClip);

    const jobData: JobData = {
      clipId: existingClip._id,
      videoId: existingClip.videoId,
      start: existingClip.start,
      end: existingClip.end,
      hookDuration: existingClip.hookDuration,
      hookText: existingClip.hookText,
      ctaText: existingClip.ctaText,
      ctaDuration: existingClip.ctaDuration,
      filterPreset: existingClip.filterPreset,
      captionPresetId: existingClip.captionPresetId,
      layout: existingClip.layout,
      hookStylePresetId: existingClip.hookStylePresetId,
      ctaStylePresetId: existingClip.ctaStylePresetId,
    };

    await enqueueClipJob(jobData);

    return NextResponse.json({
      success: true,
      clip: existingClip,
    });
  } catch (error) {
    const clipId = typeof body?.clipId === 'string' ? body.clipId : undefined;

    if (clipId) {
      try {
        const clip = await getClip(clipId);
        if (clip) {
          clip.status = 'failed';
          clip.error = toErrorMessage(error, 'Failed to start render job.');
          await saveClip(clip);
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
