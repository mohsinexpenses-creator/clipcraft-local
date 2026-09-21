import { NextResponse } from 'next/server';
import { listVideos } from '@/lib/db';

export async function GET() {
  try {
    const videos = await listVideos();
    return NextResponse.json({ videos });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
