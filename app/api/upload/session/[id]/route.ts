import { NextRequest, NextResponse } from 'next/server';
import { AppError } from '../../../../../lib/errors';
import { jsonError, QUEUE_MESSAGES } from '../../../../../lib/upload';
import {
  abortUploadSession,
  appendUploadChunk,
  finalizeUploadSession,
  getSessionInfo,
  UploadOffsetMismatchError,
} from '../../../../../lib/upload-session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/upload/session/[id]
 *
 * Reports how many bytes the server already has, so a client that lost its connection
 * (or a user who reopened the page) can resume instead of starting over.
 */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    return NextResponse.json({ success: true, ...getSessionInfo(id) });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * PUT /api/upload/session/[id]?offset=N
 *
 * Appends the raw request body to the session file, streaming straight to disk. The
 * `offset` query parameter is what the client believes it has already sent; a mismatch
 * answers 409 with the real `receivedBytes` instead of corrupting the file.
 */
export async function PUT(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const offsetParam = request.nextUrl.searchParams.get('offset');

    let expectedOffset: number | null = null;
    if (offsetParam !== null) {
      expectedOffset = Number(offsetParam);
      if (!Number.isInteger(expectedOffset) || expectedOffset < 0) {
        throw new AppError('The `offset` query parameter must be a non-negative integer.', {
          status: 400,
          details: offsetParam,
        });
      }
    }

    const session = await appendUploadChunk(id, expectedOffset, request.body);
    return NextResponse.json({ success: true, ...session });
  } catch (error) {
    if (error instanceof UploadOffsetMismatchError) {
      return NextResponse.json(
        {
          success: false,
          statusCode: 409,
          error: error.summary,
          message: error.summary,
          receivedBytes: error.receivedBytes,
          resolution: error.resolution,
        },
        { status: 409 }
      );
    }

    return jsonError(error);
  }
}

/**
 * POST /api/upload/session/[id]
 *
 * Finishes the upload: moves the assembled file into UPLOAD_DIR, probes it with FFmpeg,
 * stores the video record and queues transcription.
 */
export async function POST(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const { video, transcriptionQueued } = await finalizeUploadSession(id);

    // Shape matters: components/video-uploader.tsx reads `data.video._id`.
    return NextResponse.json({
      success: true,
      video,
      transcriptionQueued,
      message: transcriptionQueued ? QUEUE_MESSAGES.queued : QUEUE_MESSAGES.notQueued,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** DELETE /api/upload/session/[id] - cancel and delete the partial file. */
export async function DELETE(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    await abortUploadSession(id);
    return NextResponse.json({ success: true, message: 'Upload cancelled.' });
  } catch (error) {
    return jsonError(error);
  }
}
