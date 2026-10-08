import { NextResponse } from 'next/server';
import { listVideoSummaries, listVideos } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { listJobsByTypes, TRANSCRIPTION_QUEUE_NAME, VIRAL_DETECTION_QUEUE_NAME } from '@/lib/queue';
import { pipelineStatusForSummary, type PipelineJobLike } from '@/lib/pipeline-status';

export const runtime = 'nodejs';

/**
 * GET /api/videos
 *
 * Default response is the *summary* projection: every video without its
 * transcript JSON, with the clip tally and the derived pipeline stage. The
 * dashboard polls this every couple of seconds while a pipeline runs, and a
 * three-hour podcast transcript is megabytes - so the transcript never enters
 * this response (`?full=1` still returns the old, complete shape for scripts).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get('full') === '1') {
      const videos = await listVideos();
      return NextResponse.json({ videos });
    }

    const summaries = await listVideoSummaries();

    // Latest job per video and type, collected in one query for the whole list.
    const jobsByVideo = new Map<string, PipelineJobLike[]>();
    for (const job of listJobsByTypes([TRANSCRIPTION_QUEUE_NAME, VIRAL_DETECTION_QUEUE_NAME])) {
      if (!job.videoId) continue;
      const list = jobsByVideo.get(job.videoId) ?? [];
      list.push({
        type: job.type,
        status: job.status,
        progress: job.progress,
        ...(job.error ? { error: job.error } : {}),
        videoId: job.videoId,
      });
      jobsByVideo.set(job.videoId, list);
    }

    const videos = summaries.map((entry) => ({
      ...entry.video,
      counts: entry.counts,
      pipelineStatus: pipelineStatusForSummary(entry.video, entry.counts, jobsByVideo.get(entry.video._id) ?? []),
    }));

    return NextResponse.json({ videos });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load videos.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
