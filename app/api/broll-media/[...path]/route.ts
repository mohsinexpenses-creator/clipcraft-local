import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { brollImageDir } from '@/lib/broll/cache';

export const runtime = 'nodejs';

/**
 * Serves one prepared B-roll image from the cache so the clip tile can show the
 * plan's thumbnails (the cache lives outside `public/`, and nothing else exposes
 * it). Only file names are accepted - never a path - so a crafted URL cannot read
 * anything outside the cache directory.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path;
  const name = segments[segments.length - 1] ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'Invalid image name.' }, { status: 400 });
  }

  const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];
  if (!contentType) {
    return NextResponse.json({ error: 'Not an image.' }, { status: 415 });
  }

  try {
    const filePath = path.join(brollImageDir(), name);
    const data = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.byteLength),
        // The name is a content hash: the bytes never change for a given name.
        'Cache-Control': 'private, max-age=86400, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Image not found in the cache.' }, { status: 404 });
  }
}
