import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getUploadDirValue } from '@/lib/upload';
import { getClipsDirValue } from '@/lib/paths';

/**
 * Streams files that live inside the project (uploads/, generated-clips/, public/)
 * to the browser.
 *
 * This route is what makes clip playback work: a <video> served from a normal HTTP
 * origin, instead of a `file://` path that headless Chrome refuses to load.
 *
 * `uploads` and `generated-clips` are LOGICAL prefixes: they resolve to wherever
 * the Settings page currently points them (lib/upload.ts, lib/paths.ts), so a
 * changed directory never breaks URLs stored on clip records.
 */

export const runtime = 'nodejs';

const ALLOWED_DIRS = ['uploads', 'generated-clips', 'public'];

function rootForAllowedDir(dir: string): string {
  if (dir === 'uploads') return path.resolve(getUploadDirValue());
  if (dir === 'generated-clips') return path.resolve(getClipsDirValue());
  return path.resolve(process.cwd(), dir);
}

function contentTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();

  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Maps a request path onto its directory root and refuses anything that could
 * escape it. The first URL segment selects the root; `..` segments are resolved
 * FIRST and then checked against the root with a separator-terminated prefix,
 * otherwise a sibling directory with a shared prefix would pass too
 * (`generated-clips-evil/x.mp4` passes a plain `startsWith('…/generated-clips')`).
 */
function resolveInsideAllowedDir(pathSegments: string[]): string | null {
  const [first, ...rest] = pathSegments;
  if (!first || !ALLOWED_DIRS.includes(first)) return null;

  const root = rootForAllowedDir(first);
  const absolutePath = path.resolve(root, rest.join('/'));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSep)) return null;
  return absolutePath;
}

function streamFile(
  absolutePath: string,
  status: number,
  headers: Record<string, string>,
  start?: number,
  end?: number
): NextResponse {
  const fileStream = fs.createReadStream(absolutePath, start !== undefined ? { start, end } : undefined);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // ReadStream emits Buffer here, but the typings allow string too.
      fileStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      fileStream.on('end', () => controller.close());
      fileStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      // The browser closed the connection (seek, tab close) - stop reading from disk.
      fileStream.destroy();
    },
  });

  return new NextResponse(body, { status, headers });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  let absolutePath = '';

  try {
    const { path: pathSegments } = await params;

    if (!pathSegments || pathSegments.length === 0) {
      return new NextResponse('Bad request', { status: 400 });
    }

    const resolved = resolveInsideAllowedDir(pathSegments);
    if (!resolved) {
      return new NextResponse('Forbidden', { status: 403 });
    }
    absolutePath = resolved;

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return new NextResponse('File not found', { status: 404 });
    }

    const stat = fs.statSync(absolutePath);
    const fileSize = stat.size;
    const contentType = contentTypeFor(absolutePath);
    const baseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      // Let the browser cache the finished clip but always revalidate it.
      'Cache-Control': 'private, max-age=3600, must-revalidate',
    };

    const range = request.headers.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? parseInt(match[1], 10) : 0;
      let end = match?.[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= fileSize) {
        return new NextResponse('Requested range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }

      end = Math.min(end, fileSize - 1);
      if (end < start) end = fileSize - 1;

      const chunkSize = end - start + 1;

      return streamFile(
        absolutePath,
        206,
        {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunkSize.toString(),
        },
        start,
        end
      );
    }

    return streamFile(absolutePath, 200, {
      ...baseHeaders,
      'Content-Length': fileSize.toString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to stream media file';
    console.error(`[Media Route] Failed to stream ${absolutePath || '(unknown path)'}:`, message);
    return new NextResponse('Failed to stream media file', { status: 500 });
  }
}
