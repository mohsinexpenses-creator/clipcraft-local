import { NextRequest, NextResponse } from 'next/server';
import { AppError } from '../../../../../lib/errors';
import { jsonError, QUEUE_MESSAGES } from '../../../../../lib/upload';
import { sanitizePipelineOptions } from '../../../../../lib/pipeline-defaults';
import {
  abortUploadSession,
  appendUploadChunk,
  finalizeUploadSession,
  getSessionInfo,
  UploadOffsetMismatchError,
} from '../../../../../lib/upload-session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * stores the video record and queues transcription - step 1 of the automatic chain.
 *
 * The request may carry the automation the uploader chose
 * (`{ pipeline: { autoDetect, autoRender, viral } }`). It is stored on the video
 * record, so the transcript -> detection -> render chain that the worker runs
 * afterwards uses exactly these settings - including after a reload or restart.
 */
export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const pipeline = isRecord(body) ? sanitizePipelineOptions(body) : undefined;
    const { video, transcriptionQueued } = await finalizeUploadSession(id, pipeline);

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
