import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { deleteClip, getClip } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const clip = await getClip(id);
    if (!clip) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }
    return NextResponse.json({ clip });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load clip.') },
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
    const clip = await getClip(id);
    if (!clip) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    await deleteClip(id);

    if (clip.outputPath) {
      const fullPath = path.join(process.cwd(), clip.outputPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete clip.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
