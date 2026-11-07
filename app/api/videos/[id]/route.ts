import path from 'path';
import { NextResponse } from 'next/server';
import { deleteVideo, getVideo, listClips, updateVideo } from '@/lib/db';
import { getUploadDirValue } from '@/lib/upload';
import { getClipsDirValue } from '@/lib/paths';
import { outputPathToDiskPath, removePathOrDefer, resolveInside } from '@/lib/file-cleanup';
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
    // An explicit edit is a deliberate restart of automation, not a permanent
    // cancellation. Queuing still happens through the normal guarded paths.
    video.pipelineCancelled = false;
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

    const clips = await listClips(id);
    // This removes queued/running jobs before the row cascade, so all active
    // worker attempt tokens become invalid before any source/output deletion.
    await deleteVideo(id);

    const uploadRoot = getUploadDirValue();
    const clipsRoot = getClipsDirValue();
    const targets = new Map<string, string>();
    // `filePath` is the authoritative flat upload path (it can predate a later
    // Settings-root change), not the old incorrect `<uploads>/<video-id>` guess.
    const sourcePath = path.resolve(video.filePath);
    targets.set(sourcePath, 'uploaded-source');

    // Legacy deployments stored a directory per video; current uploads are flat,
    // so cover both without mistakenly treating the configured root itself as a target.
    for (const folder of [video.fileBase || id, id]) {
      const candidate = resolveInside(uploadRoot, folder);
      if (candidate) targets.set(candidate, 'legacy-video-upload-directory');
    }
    for (const folder of [video.fileBase || id, id]) {
      const candidate = resolveInside(clipsRoot, folder);
      if (candidate) targets.set(candidate, 'video-clips-directory');
    }
    for (const clip of clips) {
      if (!clip.outputPath) continue;
      const candidate = outputPathToDiskPath(clip.outputPath, clipsRoot);
      if (candidate) targets.set(candidate, 'clip-output');
    }

    const removals = await Promise.all(
      [...targets].map(async ([target, kind]) => ({ target, removed: await removePathOrDefer(target, kind) })),
    );
    return NextResponse.json({
      success: true,
      cleanupDeferred: removals.filter((result) => !result.removed).map((result) => result.target),
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete video.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
