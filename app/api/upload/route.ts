import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { listVideos } from '../../../lib/db';
import { AppError, toErrorMessage } from '../../../lib/errors';
import { sanitizePipelineOptions } from '../../../lib/pipeline-defaults';
import {
  buildStoredFileName,
  formatBytes,
  getMultipartLimitBytes,
  jsonError,
  QUEUE_MESSAGES,
  registerUploadedVideo,
  resolveUploadDir,
  validateUploadFileName,
} from '../../../lib/upload';

export const runtime = 'nodejs';

/**
 * POST /api/upload
 *
 * Compatibility endpoint for small, single-shot uploads (scripts, Postman, the YouTube
 * importer). `request.formData()` has to buffer the whole multipart body in memory -
 * undici has no streaming multipart parser - so this route refuses bodies above
 * MAX_MULTIPART_MB (256 MB by default) and tells the caller to use the resumable,
 * chunked endpoint instead:
 *
 *   POST /api/upload/session          -> start (no size limit)
 *   PUT  /api/upload/session/[id]     -> append a chunk
 *   POST /api/upload/session/[id]     -> finalize
 *
 * The web UI always uses the resumable path, so long podcast recordings never hit the
 * memory guard - and the old hard-coded 512 MB rejection is gone entirely.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // Content-Length is present for any non-streaming browser/curl upload, so refusing
      // early is what keeps a 4 GB multipart POST from exhausting the dev server's RAM.
      const declaredLength = Number(request.headers.get('content-length') || '');
      const multipartLimit = getMultipartLimitBytes();
      if (Number.isFinite(declaredLength) && declaredLength > multipartLimit) {
        throw new AppError(
          `Single-request uploads are limited to ${formatBytes(multipartLimit)} because they are buffered in memory.`,
          {
            status: 413,
            details: `${formatBytes(declaredLength)} was declared`,
            resolution:
              'Use the resumable uploader (POST /api/upload/session - no size limit), which the web UI uses automatically.',
          }
        );
      }

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

      const originalName = validateUploadFileName(file.name);
      const uploadDir = resolveUploadDir();
      const fileName = buildStoredFileName(originalName);
      const filePath = path.join(uploadDir, fileName);

      await writeFileToDisk(file, filePath);

      const pipeline = sanitizePipelineOptions(
        parseMaybeJson(formData.get('pipeline')) ?? parseMaybeJson(formData.get('options'))
      );

      const { video, queued } = await registerUploadedVideo(originalName, fileName, filePath, pipeline);

      // Shape matters: components/video-uploader.tsx reads `data.video._id`.
      return NextResponse.json({
        success: true,
        video,
        transcriptionQueued: queued,
        message: queued ? QUEUE_MESSAGES.queued : QUEUE_MESSAGES.notQueued,
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
        pipeline?: unknown;
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

        const uploadDir = resolveUploadDir();
        const fileName = `${Date.now()}-youtube.mp4`;
        const filePath = path.join(uploadDir, fileName);

        const info = await downloadYoutubeVideo(url, filePath);

        const { video, queued } = await registerUploadedVideo(
          `${info.title}.mp4`,
          fileName,
          filePath,
          sanitizePipelineOptions(body.pipeline ?? body)
        );

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

/** A multipart text field is a string; a JSON body is already an object. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The multipart body is already in memory (`request.formData()`), so this just copies it
 * to disk. Anything that needs to stay memory-flat for multi-GB files goes through
 * lib/upload-session.ts instead.
 */
async function writeFileToDisk(file: File, filePath: string): Promise<void> {
  const fileStream = fs.createWriteStream(filePath);

  try {
    const reader = file.stream().getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (!fileStream.write(Buffer.from(value))) {
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
