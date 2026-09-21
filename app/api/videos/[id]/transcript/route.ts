import { NextResponse } from 'next/server';
import { getVideo, saveVideo } from '@/lib/db';
import { transcribeVideo } from '@/lib/whisper';

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
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    video.status = 'transcribing';
    await saveVideo(video);

    const transcript = await transcribeVideo(video.filePath);
    video.transcript = transcript;
    video.status = 'transcribed';
    await saveVideo(video);

    return NextResponse.json({ success: true, transcript });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
