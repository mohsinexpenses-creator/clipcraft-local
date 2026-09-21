import { NextResponse } from 'next/server';
import { getVideo, deleteVideo, listClips } from '@/lib/db';
import fs from 'fs';
import path from 'path';

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
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
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

    // Remove video uploads folder and generated clips folder
    const uploadDir = path.join(process.cwd(), 'uploads', id);
    const clipsDir = path.join(process.cwd(), 'generated-clips', id);

    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
    if (fs.existsSync(clipsDir)) {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
