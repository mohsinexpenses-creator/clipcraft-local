import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { deleteClip, getClip, updateClip } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { sanitizeClipEdits } from '@/lib/clip-edits';

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

/**
 * PATCH /api/clips/[id]
 *
 * Save edits to a clip without rendering it - the "Save changes" half of the
 * clip editor. `POST /api/clips` (queue a render) applies the same fields and
 * then renders, which is the "Save & re-render" path. Validation lives in
 * `sanitizeClipEdits` so both endpoints accept exactly the same shape and
 * reject exactly the same nonsense.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const clip = await getClip(id);
    if (!clip) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const edits = sanitizeClipEdits(body);
    const merged = { ...clip, ...edits };

    if (!(await updateClip(merged))) {
      return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    }

    const saved = await getClip(id);
    return NextResponse.json({ success: true, clip: saved ?? merged });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to save clip.') },
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
