import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { saveVideo } from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { getVideoMetadata } from '@/lib/ffmpeg';
import { VideoRecord } from '@/lib/types';
import { getPlannedTranscriptionEngine, transcribeVideo } from '@/lib/whisper';
import { downloadYoutubeVideo } from '@/lib/youtube';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    let file: File | null = null;
    let youtubeUrl: string | null = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      file = formData.get('file') as File | null;
      youtubeUrl = (formData.get('youtubeUrl') as string) || null;
    } else if (contentType.includes('application/json')) {
      const body = await request.json();
      youtubeUrl = body.youtubeUrl || null;
    }

    if (!file && (!youtubeUrl || !youtubeUrl.trim())) {
      return NextResponse.json(
        { error: 'Please provide either a video file or a valid YouTube URL.' },
        { status: 400 }
      );
    }

    const videoId = `vid_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const uploadsDir = path.join(process.cwd(), 'uploads', videoId);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, 'original.mp4');
    let originalName = 'Uploaded Video';
    let fileSize = 0;

    if (youtubeUrl && youtubeUrl.trim()) {
      console.log(`[API Upload] Processing YouTube URL: ${youtubeUrl}`);
      const ytInfo = await downloadYoutubeVideo(youtubeUrl.trim(), filePath);
      originalName = ytInfo.title;

      if (!fs.existsSync(filePath)) {
        throw new AppError('YouTube download finished without creating the source video file.', {
          status: 500,
          details: filePath,
          resolution: 'Retry the YouTube download, or upload the source MP4 file manually.',
        });
      }

      fileSize = fs.statSync(filePath).size;
    } else if (file) {
      originalName = file.name;
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      fs.writeFileSync(filePath, buffer);
      fileSize = buffer.length;
      console.log(`[API Upload] Saved uploaded file ${file.name} (${fileSize} bytes)`);
    }

    if (!fs.existsSync(filePath)) {
      throw new AppError('The uploaded video file could not be found on disk after saving.', {
        status: 500,
        details: filePath,
        resolution: 'Retry the upload and confirm the app can write to the uploads directory.',
      });
    }

    const metadata = await getVideoMetadata(filePath);
    const transcriptionEngine = getPlannedTranscriptionEngine();

    const videoRecord: VideoRecord = {
      _id: videoId,
      originalName,
      filePath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      fileSize,
      status: 'transcribing',
      transcriptionProvider: transcriptionEngine.provider,
      transcriptionModel: transcriptionEngine.model,
      error: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveVideo(videoRecord);

    runBackgroundTranscription(videoId, filePath);

    return NextResponse.json({
      success: true,
      video: videoRecord,
    });
  } catch (error) {
    console.error('[API Upload] Error uploading video:', error);
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to process video upload.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

async function runBackgroundTranscription(videoId: string, filePath: string) {
  try {
    console.log(`[Background Transcribe] Starting transcription for video ${videoId}...`);
    const transcript = await transcribeVideo(filePath);

    const { getVideo, saveVideo } = await import('@/lib/db');
    const video = await getVideo(videoId);
    if (video) {
      video.transcript = transcript;
      video.status = 'transcribed';
      video.error = undefined;
      await saveVideo(video);
      console.log(`[Background Transcribe] Finished transcription for video ${videoId}.`);
    }
  } catch (error) {
    console.error(`[Background Transcribe] Failed for video ${videoId}:`, error);

    try {
      const { getVideo, saveVideo } = await import('@/lib/db');
      const video = await getVideo(videoId);
      if (video) {
        video.status = 'failed';
        video.error = toErrorMessage(error, 'Transcription failed.');
        await saveVideo(video);
      }
    } catch (saveError) {
      console.error(`[Background Transcribe] Failed to persist error state for video ${videoId}:`, saveError);
    }
  }
}
