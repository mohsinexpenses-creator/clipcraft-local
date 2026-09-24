import { NextResponse } from 'next/server';
import { listVideos } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export async function GET() {
  try {
    const videos = await listVideos();
    return NextResponse.json({ videos });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load videos.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
