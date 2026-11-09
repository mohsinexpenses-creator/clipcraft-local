import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { getCustomFont } from '@/lib/db';
import { customFontFilePath } from '@/lib/custom-fonts';
import { assertLocalFolderBrowserRequest } from '@/lib/folder-browser';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Byte endpoint used by the direct-local caption preview. This is deliberately
 * not a public asset route: a configured font folder may live anywhere on the
 * machine, and only a loopback browser is allowed to read its registered bytes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    const { id } = await params;
    const font = await getCustomFont(id);
    if (!font) return NextResponse.json({ error: 'Custom font not found.' }, { status: 404 });
    const filePath = customFontFilePath(font);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // A manually removed file has the same safe behavior as a deleted font:
      // it cannot be served, and saved presets fall back to their next CSS font.
      return NextResponse.json({ error: 'Custom font file is no longer available.' }, { status: 404 });
    }
    return new NextResponse(fs.readFileSync(filePath), {
      headers: {
        'Content-Type': font.mimeType,
        'Cache-Control': 'private, no-store',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not load that custom font.') },
      { status: toErrorStatus(error, 400) },
    );
  }
}
