import { NextResponse } from 'next/server';
import { getVideo, saveVideo } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { getPlannedTranscriptionEngine, transcribeVideo } from '@/lib/whisper';

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let videoId = '';

  try {
    const { id } = await params;
    videoId = id;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const transcriptionEngine = getPlannedTranscriptionEngine();
    video.status = 'transcribing';
    video.transcriptionProvider = transcriptionEngine.provider;
    video.transcriptionModel = transcriptionEngine.model;
    video.error = undefined;
    await saveVideo(video);

    const transcript = await transcribeVideo(video.filePath);
    video.transcript = transcript;
    video.status = 'transcribed';
    video.error = undefined;
    await saveVideo(video);

    return NextResponse.json({ success: true, transcript });
  } catch (error) {
    if (videoId) {
      try {
        const video = await getVideo(videoId);
        if (video) {
          video.status = 'failed';
          video.error = toErrorMessage(error, 'Transcription failed.');
          await saveVideo(video);
        }
      } catch (saveError) {
        console.error('[API Transcript POST] Failed to persist error state:', saveError);
      }
    }

    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to transcribe video.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
