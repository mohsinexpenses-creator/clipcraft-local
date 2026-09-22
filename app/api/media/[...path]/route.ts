import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;
    const relativePath = pathSegments.join('/');
    
    // Resolve absolute path safely within workspace
    const absolutePath = path.resolve(process.cwd(), relativePath);

    // Prevent path traversal outside allowed directories
    const allowedDirs = [
      path.resolve(process.cwd(), 'uploads'),
      path.resolve(process.cwd(), 'generated-clips'),
      path.resolve(process.cwd(), 'public'),
    ];

    const isAllowed = allowedDirs.some((dir) => absolutePath.startsWith(dir));
    if (!isAllowed || !fs.existsSync(absolutePath)) {
      return new NextResponse('File not found', { status: 404 });
    }

    const stat = fs.statSync(absolutePath);
    const fileSize = stat.size;
    const range = request.headers.get('range');

    let contentType = 'video/mp4';
    if (relativePath.endsWith('.wav')) contentType = 'audio/wav';
    else if (relativePath.endsWith('.mp3')) contentType = 'audio/mpeg';
    else if (relativePath.endsWith('.jpg') || relativePath.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (relativePath.endsWith('.png')) contentType = 'image/png';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const fileStream = fs.createReadStream(absolutePath, { start, end });
      
      const stream = new ReadableStream({
        start(controller) {
          fileStream.on('data', (chunk) => controller.enqueue(chunk));
          fileStream.on('end', () => controller.close());
          fileStream.on('error', (err) => controller.error(err));
        },
      });

      return new NextResponse(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': contentType,
        },
      });
    } else {
      const fileStream = fs.createReadStream(absolutePath);
      
      const stream = new ReadableStream({
        start(controller) {
          fileStream.on('data', (chunk) => controller.enqueue(chunk));
          fileStream.on('end', () => controller.close());
          fileStream.on('error', (err) => controller.error(err));
        },
      });

      return new NextResponse(stream, {
        status: 200,
        headers: {
          'Content-Length': fileSize.toString(),
          'Content-Type': contentType,
        },
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to stream media file';
    return new NextResponse(message, { status: 500 });
  }
}
