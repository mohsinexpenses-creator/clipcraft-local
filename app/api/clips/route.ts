import { NextResponse } from 'next/server';
import { listClips, getClip, saveClip } from '@/lib/db';
import { enqueueClipJob } from '@/lib/queue';
import { JobData } from '@/lib/types';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const videoId = searchParams.get('videoId') || undefined;

    const clips = await listClips(videoId);
    return NextResponse.json({ clips });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      clipId,
      videoId,
      start,
      end,
      hookDuration = 3,
      hookText,
      filterPreset = 'vibrant',
      captionPresetId = 'preset-bold-yellow',
    } = body;

    if (!clipId || !videoId) {
      return NextResponse.json({ error: 'Missing clipId or videoId' }, { status: 400 });
    }

    const existingClip = await getClip(clipId);
    if (!existingClip) {
      return NextResponse.json({ error: 'Clip record not found' }, { status: 404 });
    }

    // Update settings if changed
    existingClip.start = Number(start) ?? existingClip.start;
    existingClip.end = Number(end) ?? existingClip.end;
    existingClip.hookDuration = Number(hookDuration) ?? existingClip.hookDuration;
    if (hookText !== undefined) existingClip.hookText = hookText;
    if (filterPreset !== undefined) existingClip.filterPreset = filterPreset;
    if (captionPresetId !== undefined) existingClip.captionPresetId = captionPresetId;

    existingClip.status = 'pending';
    existingClip.progress = 0;
    await saveClip(existingClip);

    const jobData: JobData = {
      clipId: existingClip._id,
      videoId: existingClip.videoId,
      start: existingClip.start,
      end: existingClip.end,
      hookDuration: existingClip.hookDuration,
      hookText: existingClip.hookText,
      filterPreset: existingClip.filterPreset,
      captionPresetId: existingClip.captionPresetId,
    };

    await enqueueClipJob(jobData);

    return NextResponse.json({
      success: true,
      clip: existingClip,
    });
  } catch (err: any) {
    console.error('[API Clips POST] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
