import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { deleteVideo, getVideo, listClips, updateVideo } from '@/lib/db';
import { getUploadDirValue } from '@/lib/upload';
import { getClipsDirValue } from '@/lib/paths';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { pipelineStatusForVideo } from '@/lib/pipeline-status';
import { sanitizePipelineOptions } from '@/lib/pipeline-defaults';
import { listVideoPipelineJobs } from '@/lib/queue';
import { queueViralDetection } from '@/lib/pipeline';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const clips = await listClips(id);
    const url = new URL(request.url);
    // The transcript is only sent when explicitly asked for; it is by far the
    // biggest part of this record and the dashboard loads it on its own.
    const withTranscript = url.searchParams.get('transcript') === '1';
    const payload = { ...video };
    if (!withTranscript) delete payload.transcript;

    return NextResponse.json({
      video: payload,
      clips,
      status: pipelineStatusForVideo(video, clips, listVideoPipelineJobs(id)),
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load video details.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

/**
 * PATCH /api/videos/[id]
 *
 * Update the automation for this video: `autoDetect`, `autoRender` and the AI
 * clip options. Values are clamped by the same `sanitizePipelineOptions()` the
 * upload uses, and the stored record is what the worker's automatic steps read
 * afterwards - so changing these settings genuinely changes the next run.
 *
 * Body: { "pipeline": { autoDetect, autoRender, viral: {...} } }
 *       { "autoRender": true, "options": { "clipCount": 6 } }   (flat form)
 * Optional "detectNow": true queues a detection run right away.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const next = sanitizePipelineOptions({ ...video.pipeline, ...body, viral: body.viral ?? body.options ?? video.pipeline?.viral });

    video.pipeline = next;
    if (!(await updateVideo(video))) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    let detectionQueued: string | undefined;
    if (body.detectNow === true && video.transcript) {
      detectionQueued = await queueViralDetection(id);
    }

    return NextResponse.json({ success: true, video, detectionQueued });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to update the video.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    await deleteVideo(id);

    // The roots come from Settings -> Paths & binaries; per-video folder names
    // inside them never change.
    const uploadDir = path.join(getUploadDirValue(), id);
    // Output folder: current convention names it after the stored file
    // (001_my_recording); older uploads used the video id - clean up both.
    const clipsDir = path.join(getClipsDirValue(), video.fileBase || id);
    const legacyClipsDir = path.join(getClipsDirValue(), id);

    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
    if (fs.existsSync(clipsDir)) {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    }
    if (clipsDir !== legacyClipsDir && fs.existsSync(legacyClipsDir)) {
      fs.rmSync(legacyClipsDir, { recursive: true, force: true });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete video.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
