import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

export interface ClipMediaServer {
  /** Absolute http:// URL (loopback) that headless Chrome can load. */
  url: string;
  /** Base URL for the other files (`<base>/<route>`). */
  baseUrl: string;
  /** The port the OS actually assigned (bound on 127.0.0.1:0). */
  port: number;
  /** Stops serving; resolves once the socket is closed (forced after 2 s). */
  close: () => Promise<void>;
}

/** One file exposed to the renderer under a route segment. */
export interface MediaServerFile {
  /** URL segment, e.g. `clip.mp4` or `broll/fs-ab12.jpg`. */
  route: string;
  filePath: string;
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
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Remotion renders compositions inside headless Chrome, which CANNOT read the
 * filesystem. Passing a raw absolute path as an `Img src` or video src reaches
 * Remotion's asset downloader, which only accepts http(s)/data: URLs, and the
 * render dies. This throwaway loopback server is the workaround Remotion's own
 * docs recommend: it streams exactly the files the current render needs (the
 * clip, and the B-roll images) and is closed in the renderer's finally-block, so
 * no port is ever held and nothing is reachable from outside the machine.
 *
 * B-roll images are served from the same server on purpose: the browser never
 * resolves a remote URL, which would make the render depend on someone else's
 * CDN.
 */
export async function startMediaServer(files: MediaServerFile[]): Promise<ClipMediaServer> {
  const byRoute = new Map<string, { filePath: string; size: number }>();
  for (const file of files) {
    const stat = fs.statSync(file.filePath);
    byRoute.set(`/${file.route.replace(/^\/+/, '')}`, { filePath: file.filePath, size: stat.size });
  }

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

    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const entry = byRoute.get(pathname);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    // Single-range support, same semantics as the app's /api/media route.
    // (Remotion's own downloader issues a plain GET; Range covers the media
    // element's seeking in case a code path ever uses it.)
    const match = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    const fileSize = entry.size;
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

    const stream = fs.createReadStream(entry.filePath, { start, end });
    res.writeHead(status, {
      'Content-Type': contentTypeFor(entry.filePath),
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
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: `${baseUrl}/${files[0]?.route ?? 'clip.mp4'}`,
    baseUrl,
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

/** Convenience wrapper for the common "one video file" case. */
export async function startClipMediaServer(filePath: string): Promise<ClipMediaServer> {
  return startMediaServer([{ route: 'clip.mp4', filePath }]);
}
