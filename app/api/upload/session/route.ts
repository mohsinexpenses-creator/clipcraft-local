import { NextRequest, NextResponse } from 'next/server';
import { AppError } from '../../../../lib/errors';
import { getChunkSizeBytes, getMaxUploadBytes, jsonError } from '../../../../lib/upload';
import { createUploadSession, getSessionTtlMs } from '../../../../lib/upload-session';

export const runtime = 'nodejs';

/**
 * POST /api/upload/session
 *
 * Starts a resumable upload. There is no size limit by default (a 3-hour podcast is a
 * normal input); `MAX_UPLOAD_MB` in .env.local adds an optional guard rail.
 *
 * Body: { "fileName": "episode-42.mp4", "fileSize": 2147483648 }
 * Reply: { success, id, chunkSize, receivedBytes, declaredSize, ... }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      fileName?: unknown;
      fileSize?: unknown;
    };

    if (typeof body.fileName !== 'string' || !body.fileName.trim()) {
      throw new AppError('fileName is required to start an upload.', {
        status: 400,
        details: JSON.stringify(body).slice(0, 200),
        resolution: 'Send { "fileName": "video.mp4", "fileSize": 1234 } as JSON.',
      });
    }

    const session = await createUploadSession({
      fileName: body.fileName,
      fileSize:
        typeof body.fileSize === 'number' && Number.isFinite(body.fileSize)
          ? body.fileSize
          : undefined,
    });

    return NextResponse.json({
      success: true,
      ...session,
      maxUploadBytes: getMaxUploadBytes(), // 0 = unlimited
      sessionTtlMs: getSessionTtlMs(),
      chunkSize: session.chunkSize || getChunkSizeBytes(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
