import { NextResponse } from 'next/server';
import { getVideo, updateVideo } from '@/lib/db';
import { toErrorStatus, toErrorMessage } from '@/lib/errors';
import { enqueueTranscriptionJob } from '@/lib/queue';
import { getPlannedTranscriptionEngine } from '@/lib/whisper';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    return NextResponse.json({
      status: video.status,
      transcript: video.transcript || null,
      transcriptionProvider: video.transcriptionProvider || null,
      transcriptionModel: video.transcriptionModel || null,
      error: video.error || null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load transcript status.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

/**
 * "Transcribe again" / retry endpoint.
 *
 * It now only ENQUEUES the job. The previous version awaited `transcribeVideo()`
 * inside the request, which held the HTTP connection open for the whole whisper run
 * (minutes on a long video) - any proxy timeout or page refresh left the video stuck
 * in `transcribing` with no way to recover except editing SQLite by hand.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  let videoId = '';

  try {
    const { id } = await params;
    videoId = id;

    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    // Fail fast, in the request, if no engine could ever run - better than queueing a
    // job that immediately errors in the worker.
    const engine = await getPlannedTranscriptionEngine();

    video.status = 'transcribing';
    video.transcriptionProvider = engine.provider;
    video.transcriptionModel = engine.model;
    video.error = undefined;
    await enqueueTranscriptionJob(
      { videoId: video._id, filePath: video.filePath, retry: true },
      video
    );

    return NextResponse.json({
      success: true,
      queued: true,
      engine: `${engine.label} (${engine.model})`,
      message:
        'Transcription queued. The worker will pick it up - refresh the dashboard to follow its progress.',
    });
  } catch (error) {
    if (videoId && toErrorStatus(error, 500) !== 409) {
      try {
        const video = await getVideo(videoId);
        if (video) {
          video.status = 'failed';
          video.error = toErrorMessage(error, 'Failed to queue transcription.');
          await updateVideo(video);
        }
      } catch (saveError) {
        console.error('[API Transcript POST] Failed to persist error state:', saveError);
      }
    }

    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to queue transcription.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
