import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { saveVideo } from '@/lib/db';
import { getVideoMetadata } from '@/lib/ffmpeg';
import { transcribeVideo } from '@/lib/whisper';
import { downloadYoutubeVideo } from '@/lib/youtube';
import { VideoRecord } from '@/lib/types';

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
    let duration = 0;

    if (youtubeUrl && youtubeUrl.trim()) {
      console.log(`[API Upload] Processing YouTube URL: ${youtubeUrl}`);
      try {
        const ytInfo = await downloadYoutubeVideo(youtubeUrl.trim(), filePath);
        originalName = ytInfo.title;
        duration = ytInfo.duration;

        if (fs.existsSync(filePath)) {
          fileSize = fs.statSync(filePath).size;
        }
      } catch (err: any) {
        console.error('[API Upload] YouTube download error:', err);
        return NextResponse.json(
          { error: `YouTube download failed: ${err.message || String(err)}` },
          { status: 500 }
        );
      }
    } else if (file) {
      originalName = file.name;
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      fs.writeFileSync(filePath, buffer);
      fileSize = buffer.length;
      console.log(`[API Upload] Saved uploaded file ${file.name} (${fileSize} bytes)`);
    }

    // Get metadata from FFmpeg
    let metadata = { duration: duration || 0, width: 1920, height: 1080, fps: 30 };
    try {
      const ffmpegMeta = await getVideoMetadata(filePath);
      if (ffmpegMeta.duration > 0) metadata.duration = ffmpegMeta.duration;
      metadata.width = ffmpegMeta.width || 1920;
      metadata.height = ffmpegMeta.height || 1080;
      metadata.fps = ffmpegMeta.fps || 30;
    } catch (e) {
      console.warn('[API Upload] FFmpeg metadata extraction warning:', e);
    }

    const videoRecord: VideoRecord = {
      _id: videoId,
      originalName,
      filePath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      fileSize,
      status: 'uploaded',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveVideo(videoRecord);

    // Trigger asynchronous transcription pipeline
    runBackgroundTranscription(videoId, filePath);

    return NextResponse.json({
      success: true,
      video: videoRecord,
    });
  } catch (err: any) {
    console.error('[API Upload] Error uploading video:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to process video' },
      { status: 500 }
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
      await saveVideo(video);
      console.log(`[Background Transcribe] Finished transcription for video ${videoId}.`);
    }
  } catch (err) {
    console.error(`[Background Transcribe] Failed for video ${videoId}:`, err);
    const { getVideo, saveVideo } = await import('@/lib/db');
    const video = await getVideo(videoId);
    if (video) {
      video.status = 'failed';
      await saveVideo(video);
    }
  }
}
