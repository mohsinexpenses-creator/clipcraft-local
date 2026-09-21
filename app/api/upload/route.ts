import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { saveVideo } from '@/lib/db';
import { getVideoMetadata } from '@/lib/ffmpeg';
import { transcribeVideo } from '@/lib/whisper';
import { VideoRecord } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 });
    }

    const videoId = `vid_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const uploadsDir = path.join(process.cwd(), 'uploads', videoId);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, 'original.mp4');
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    fs.writeFileSync(filePath, buffer);

    console.log(`[API Upload] Saved video file ${file.name} to ${filePath} (${buffer.length} bytes)`);

    // Get video metadata using FFmpeg
    let metadata = { duration: 0, width: 1920, height: 1080, fps: 30 };
    try {
      metadata = await getVideoMetadata(filePath);
    } catch (e) {
      console.warn('[API Upload] Metadata extraction error:', e);
    }

    const videoRecord: VideoRecord = {
      _id: videoId,
      originalName: file.name,
      filePath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      fileSize: buffer.length,
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
      { error: err.message || 'Failed to upload video' },
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
      console.log(`[Background Transcribe] Finished transcription for video ${videoId}. Segments: ${transcript.segments.length}`);
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
