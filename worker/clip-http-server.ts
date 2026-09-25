import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

export interface ClipMediaServer {
  /** Absolute http:// URL (loopback) that headless Chrome can load. */
  url: string;
  /** The port the OS actually assigned (bound on 127.0.0.1:0). */
  port: number;
  /** Stops serving; resolves once the socket is closed (forced after 2 s). */
  close: () => Promise<void>;
}

function contentTypeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Remotion renders compositions inside headless Chrome, which CANNOT read the
 * filesystem. Passing a raw absolute path as a video src reaches Remotion's
 * asset downloader, which only accepts http(s)/data: URLs, and the render dies
 * with `Can only download URLs starting with http:// or https://` (on Windows
 * the path is mangled into a bogus `d:\...` / `file:///...` URL on the way).
 *
 * This is the workaround Remotion's own docs recommend (serve the file over
 * HTTP): a throwaway server on 127.0.0.1 that streams exactly one clip file.
 * It lives only for the duration of a single Remotion render (select +
 * renderMedia) and is closed in the renderer's finally-block, so no port is
 * ever held and nothing is reachable from outside the machine.
 */
export async function startClipMediaServer(filePath: string): Promise<ClipMediaServer> {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = contentTypeFor(filePath);
  const sockets = new Set<import('net').Socket>();

  const server = http.createServer((req, res) => {
    // Cross-origin: the page runs on Remotion's own bundle-server port, so the
    // browser's fetch() for this URL is cross-origin and needs CORS.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }

    // Single-range support, same semantics as the app's /api/media route.
    // (Remotion's own downloader issues a plain GET; Range covers the media
    // element's seeking in case a code path ever uses it.)
    const match = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    let start = 0;
    let end = fileSize - 1;
    let status = 200;

    if (match) {
      const parsedStart = match[1] ? parseInt(match[1], 10) : 0;
      const parsedEnd = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (Number.isNaN(parsedStart) || Number.isNaN(parsedEnd) || parsedStart < 0 || parsedStart >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        res.end();
        return;
      }
      start = parsedStart;
      end = Math.min(parsedEnd, fileSize - 1);
      status = 206;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {}),
    });

    if (req.method === 'HEAD') {
      stream.destroy();
      res.end();
      return;
    }

    stream.on('data', (chunk) => {
      if (!res.write(chunk)) {
        // Slow consumer (shouldn't happen on loopback): pause disk reads.
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => res.end());
    stream.on('error', () => {
      res.destroy();
    });
    // Browser closed the connection (render cancelled/failed): stop reading disk.
    req.on('close', () => stream.destroy());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/clip.mp4`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Kill any in-flight/keep-alive sockets so close() can't hang, then
        // resolve as soon as the port is released (2 s hard ceiling).
        for (const socket of sockets) socket.destroy();
        const bail = setTimeout(resolve, 2000);
        bail.unref?.();
        server.close(() => {
          clearTimeout(bail);
          resolve();
        });
      }),
  };
}
