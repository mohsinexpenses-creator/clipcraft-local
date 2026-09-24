import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { listVideos, saveVideo } from '../../../lib/db';
import { AppError, getErrorResponse, toErrorMessage } from '../../../lib/errors';
import { getVideoMetadata } from '../../../lib/ffmpeg';
import { enqueueTranscriptionJob } from '../../../lib/queue';
import { VideoRecord } from '../../../lib/types';
import { getPlannedTranscriptionEngine } from '../../../lib/whisper';

export const runtime = 'nodejs';

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const MAX_SIZE_MB = 512;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

/** Error responses must carry the real HTTP status, not a 200 with an error body. */
function jsonError(error: unknown): NextResponse {
  const payload = getErrorResponse(error);
  return NextResponse.json(payload, { status: payload.statusCode });
}

function validateUploadFileName(fileName: string): string {
  const trimmed = fileName.trim();

  // Reject path separators outright - this name is later appended to UPLOAD_DIR.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new AppError('Invalid file name.', {
      status: 400,
      details: fileName,
      resolution: 'Re-upload with a plain file name (no path separators or control characters).',
    });
  }

  if (!ALLOWED_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) {
    throw new AppError('Unsupported file extension.', {
      status: 400,
      details: trimmed,
      resolution: `Upload one of: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
    });
  }

  return trimmed;
}

/**
 * Build a complete VideoRecord.
 *
 * `duration` / `width` / `height` / `fileSize` are required fields that the dashboard
 * renders - the old code saved a record without any of them, so every uploaded video
 * showed as 0x0 / 0s. A probe failure is downgraded to zeros instead of rejecting an
 * upload that is already safely on disk.
 */
async function buildVideoRecord(
  originalName: string,
  fileName: string,
  filePath: string
): Promise<VideoRecord> {
  const now = new Date().toISOString();
  let width = 0;
  let height = 0;
  let duration = 0;

  try {
    const meta = await getVideoMetadata(filePath);
    width = meta.width;
    height = meta.height;
    duration = meta.duration;
  } catch (error) {
    console.warn(
      `[Upload] FFmpeg could not read ${fileName} - saving it with zeroed media facts: ${toErrorMessage(error)}`
    );
  }

  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    // Leave 0; the record is still useful.
  }

  // The uploader UI shows which engine will run, so resolve it up-front. If no engine is
  // configured yet the upload still succeeds - the queued job reports the real error and
  // the user can fix .env.local and press "Transcribe again".
  let transcriptionProvider: VideoRecord['transcriptionProvider'];
  let transcriptionModel: string | undefined;
  try {
    const engine = getPlannedTranscriptionEngine();
    transcriptionProvider = engine.provider;
    transcriptionModel = engine.model;
  } catch (error) {
    console.warn(`[Upload] Transcription engine not ready yet: ${toErrorMessage(error)}`);
  }

  return {
    _id: '', // saveVideo() assigns a UUID
    originalName,
    fileName,
    filePath,
    duration,
    width,
    height,
    fileSize,
    status: 'uploaded',
    ...(transcriptionProvider ? { transcriptionProvider } : {}),
    ...(transcriptionModel ? { transcriptionModel } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Write the uploaded bytes to disk in chunks instead of buffering them in RAM. */
async function streamFileToDisk(file: File, filePath: string): Promise<void> {
  const fileStream = fs.createWriteStream(filePath);

  try {
    const reader = file.stream().getReader();
    let written = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      written += chunk.byteLength;
      if (written > MAX_SIZE_BYTES) {
        await reader.cancel();
        throw new AppError(`File is too large (max ${MAX_SIZE_MB} MB).`, { status: 400 });
      }

      // Respect backpressure so memory stays flat on huge uploads.
      if (!fileStream.write(chunk)) {
        await new Promise<void>((resolve) => fileStream.once('drain', resolve));
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.once('finish', () => resolve());
      fileStream.once('error', reject);
      fileStream.end();
    });
  } catch (error) {
    fileStream.destroy();
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
}

/** Queue the transcription and persist the outcome; never throws. */
async function queueTranscription(video: VideoRecord): Promise<boolean> {
  try {
    await enqueueTranscriptionJob({ videoId: video._id, filePath: video.filePath });
    return true;
  } catch (error) {
    video.status = 'failed';
    video.error = toErrorMessage(error, 'Could not queue the transcription job.');
    await saveVideo(video).catch((saveError) =>
      console.error('[Upload] Could not persist the queue failure:', saveError)
    );
    return false;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const contentType = request.headers.get('content-type') || '';

    /**
     * A multipart/form-data stream can be written straight to disk. The previous
     * version called `file.arrayBuffer()`, which buffers the ENTIRE upload in RAM - a
     * 500 MB talking-head video could OOM the dev server before transcription started.
     */
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');

      if (!file || !(file instanceof File)) {
        return jsonError(new AppError('No file was uploaded.', { status: 400 }));
      }

      if (file.size === 0) {
        return jsonError(
          new AppError('The uploaded file is empty.', {
            status: 400,
            resolution: 'Re-export the video and upload it again.',
          })
        );
      }

      if (file.size > MAX_SIZE_BYTES) {
        return jsonError(
          new AppError(`File is too large (max ${MAX_SIZE_MB} MB).`, {
            status: 400,
            details: `${(file.size / 1024 / 1024).toFixed(1)} MB uploaded`,
          })
        );
      }

      const originalName = validateUploadFileName(file.name);

      const uploadDir = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });

      const fileExtension = path.extname(originalName).toLowerCase();
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}${fileExtension}`;
      const filePath = path.join(uploadDir, fileName);

      await streamFileToDisk(file, filePath);

      const video = await buildVideoRecord(originalName, fileName, filePath);
      await saveVideo(video);

      /**
       * Transcription now runs in the BullMQ worker instead of inside this request. The
       * old code awaited `transcribeVideo()` here, so the browser request stayed open for
       * the whole whisper run and any proxy timeout (or a page refresh) left the video
       * stuck in `transcribing` forever.
       */
      const queued = await queueTranscription(video);

      // Shape matters: components/video-uploader.tsx reads `data.video._id`.
      return NextResponse.json({
        success: true,
        video,
        transcriptionQueued: queued,
        message: queued
          ? 'Upload complete. Transcription is queued - refresh the dashboard to follow its progress.'
          : 'Upload complete, but the transcription job could not be queued. Is Redis running?',
      });
    }

    /**
     * Legacy YouTube import. Kept but DISABLED by default: ytdl-core breaks whenever
     * YouTube changes its player response, and it needs a full download before
     * transcription. Set ENABLE_YT_IMPORT=1 to turn it back on.
     */
    if (process.env.ENABLE_YT_IMPORT === '1') {
      const body = (await request.json().catch(() => ({}))) as {
        youtubeUrl?: unknown;
        url?: unknown;
      };
      // components/video-uploader.tsx posts { youtubeUrl }; accept `url` as well.
      const url =
        (typeof body.youtubeUrl === 'string' && body.youtubeUrl.trim()) ||
        (typeof body.url === 'string' && body.url.trim()) ||
        '';

      if (!url) {
        return jsonError(
          new AppError('YouTube URL is required.', {
            status: 400,
            resolution: 'Send { "youtubeUrl": "https://www.youtube.com/watch?v=..." } as JSON.',
          })
        );
      }

      try {
        // lib/youtube.ts already validates the URL, merges adaptive streams with FFmpeg
        // and wraps errors. (The previous version imported the `ytdl-core` package, which
        // is not even in package.json - only @distube/ytdl-core is.)
        const { downloadYoutubeVideo } = await import('../../../lib/youtube');

        const uploadDir = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
        fs.mkdirSync(uploadDir, { recursive: true });

        const fileName = `${Date.now()}-youtube.mp4`;
        const filePath = path.join(uploadDir, fileName);

        const info = await downloadYoutubeVideo(url, filePath);

        const video = await buildVideoRecord(`${info.title}.mp4`, fileName, filePath);
        await saveVideo(video);

        const queued = await queueTranscription(video);

        return NextResponse.json({
          success: true,
          video,
          transcriptionQueued: queued,
          message: queued
            ? 'YouTube video downloaded. Transcription is queued.'
            : 'YouTube video downloaded, but the transcription job could not be queued.',
        });
      } catch (error) {
        return jsonError(
          new AppError('Failed to download the YouTube video.', {
            status: 400,
            details: toErrorMessage(error),
            resolution:
              'YouTube frequently blocks these libraries. Prefer uploading the MP4 file directly.',
          })
        );
      }
    }

    return jsonError(
      new AppError('Unsupported request.', {
        status: 400,
        resolution:
          'Upload a video file as multipart/form-data. YouTube import is disabled unless ENABLE_YT_IMPORT=1.',
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    // listVideos() - the old code called getVideo() with no id, which does not exist.
    const videos = await listVideos();

    return NextResponse.json({ success: true, data: videos });
  } catch (error) {
    return jsonError(error);
  }
}
