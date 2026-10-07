import { NextResponse } from 'next/server';
import {
  getClip,
  getDefaultCaptionPreset,
  getDefaultOverlayStylePreset,
  listClips,
  updateClip,
} from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { enqueueClipJob } from '@/lib/queue';
import { CaptionEngine, ClipLayout, JobData } from '@/lib/types';

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
    const captionPresetIdRaw =
      typeof body.captionPresetId === 'string' && body.captionPresetId.trim()
        ? body.captionPresetId.trim()
        : undefined;
    const layout: ClipLayout = body.layout === 'split-screen' ? 'split-screen' : 'speaker-focus';
    const captionEngine: CaptionEngine = body.captionEngine === 'native' ? 'native' : 'remotion';
    const hookStylePresetIdRaw =
      typeof body.hookStylePresetId === 'string' && body.hookStylePresetId.trim()
        ? body.hookStylePresetId.trim()
        : undefined;
    const ctaStylePresetIdRaw =
      typeof body.ctaStylePresetId === 'string' && body.ctaStylePresetId.trim()
        ? body.ctaStylePresetId.trim()
        : undefined;

    if (!clipId || !videoId) {
      return NextResponse.json({ error: 'Missing clipId or videoId' }, { status: 400 });
    }

    const existingClip = await getClip(clipId);
    if (!existingClip) {
      return NextResponse.json({ error: 'Clip record not found' }, { status: 404 });
    }

    const [defaultCaptionPreset, defaultHookStyle, defaultCtaStyle] = await Promise.all([
      getDefaultCaptionPreset(),
      getDefaultOverlayStylePreset('hook'),
      getDefaultOverlayStylePreset('cta'),
    ]);
    const storedCaptionPresetId = existingClip.captionPresetId?.trim() || undefined;
    const storedHookPresetId = existingClip.hookStylePresetId?.trim() || undefined;
    const storedCtaPresetId = existingClip.ctaStylePresetId?.trim() || undefined;
    const captionPresetId =
      captionPresetIdRaw ?? storedCaptionPresetId ?? defaultCaptionPreset?._id;
    const hookStylePresetId =
      hookStylePresetIdRaw ?? storedHookPresetId ?? defaultHookStyle?._id;
    const ctaStylePresetId = ctaStylePresetIdRaw ?? storedCtaPresetId ?? defaultCtaStyle?._id;
    if (!captionPresetId || !hookStylePresetId || !ctaStylePresetId) {
      throw new AppError('A database default preset is missing for this clip.', {
        status: 500,
        resolution: 'Open preset settings and choose a default for Caption, Hook, and CTA.',
      });
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
    existingClip.captionEngine = captionEngine;
    existingClip.hookStylePresetId = hookStylePresetId;
    existingClip.ctaStylePresetId = ctaStylePresetId;

    existingClip.status = 'pending';
    existingClip.progress = 0;
    existingClip.error = undefined;
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
      captionEngine: existingClip.captionEngine,
      hookStylePresetId: existingClip.hookStylePresetId,
      ctaStylePresetId: existingClip.ctaStylePresetId,
    };

    await enqueueClipJob(jobData);
    const queuedClip = await getClip(existingClip._id);

    return NextResponse.json({
      success: true,
      clip: queuedClip ?? existingClip,
    });
  } catch (error) {
    const clipId = typeof body?.clipId === 'string' ? body.clipId : undefined;

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
