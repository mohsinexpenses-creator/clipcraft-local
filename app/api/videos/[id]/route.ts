import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { deleteVideo, getVideo, listClips } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

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

    const clips = await listClips(id);
    return NextResponse.json({ video, clips });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load video details.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    await deleteVideo(id);

    const uploadDir = path.join(process.cwd(), 'uploads', id);
    const clipsDir = path.join(process.cwd(), 'generated-clips', id);

    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
    if (fs.existsSync(clipsDir)) {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete video.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
