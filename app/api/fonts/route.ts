import { NextResponse } from 'next/server';
import { assertLocalFolderBrowserRequest } from '@/lib/folder-browser';
import { registerCustomFont, removeCustomFont } from '@/lib/custom-fonts';
import { listCustomFonts } from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The registry reveals local folder metadata, so it shares the loopback boundary. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    return NextResponse.json({ fonts: await listCustomFonts() });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not load custom fonts.') },
      { status: toErrorStatus(error, 500) },
    );
  }
}

/**
 * POST multipart/form-data { file, family?, weight? }
 *
 * Font files are local machine assets. The same localhost-only boundary used by
 * the folder picker prevents a browser reached through a tunnel/LAN hostname
 * from changing where the worker writes or what Chrome later loads.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      throw new AppError('Choose one font file before uploading.', { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const font = await registerCustomFont({
      originalName: file.name,
      family: typeof form.get('family') === 'string' ? String(form.get('family')) : undefined,
      weight: typeof form.get('weight') === 'string' ? String(form.get('weight')) as 'normal' | 'bold' | 'extra-bold' | 'black' : undefined,
      bytes,
    });
    return NextResponse.json({ font }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not upload that custom font.') },
      { status: toErrorStatus(error, 400) },
    );
  }
}

/**
 * DELETE /api/fonts?id=<registry id>
 *
 * Presets that mention this family intentionally remain untouched; their CSS
 * fallback handles an old queued render or a saved style after removal.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (!id) throw new AppError('Missing custom font id.', { status: 400 });
    const font = await removeCustomFont(id);
    if (!font) return NextResponse.json({ success: true, deleted: false });
    return NextResponse.json({ success: true, deleted: true, font });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not delete that custom font.') },
      { status: toErrorStatus(error, 400) },
    );
  }
}
