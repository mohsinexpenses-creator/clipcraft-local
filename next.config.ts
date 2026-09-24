import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Native / CJS packages that must never be bundled by webpack or turbopack:
   * - ffmpeg-static resolves a binary path at runtime and breaks when bundled (this is
   *   why lib/ffmpeg.ts used to contain an eval'd require). Keeping it external lets
   *   that file use a plain top-level `import ffmpegStaticPath from 'ffmpeg-static'`.
   * - mongodb, ioredis, bullmq and @vladmandic/face-api are CJS/native with dynamic requires.
   * They are only used from server/worker code, never from the browser bundle.
   */
  serverExternalPackages: [
    'ffmpeg-static',
    'mongodb',
    'ioredis',
    'bullmq',
    '@vladmandic/face-api',
    'ytdl-core',
  ],

  /**
   * Dev-only: `next dev` refuses cross-origin requests for its own dev assets, which
   * breaks the page (no hydration, no HMR) when the app is opened through a hosted
   * preview, a tunnel or a LAN hostname. `localhost` and the hostname the server was
   * started with are always allowed; add your tunnel with a comma-separated
   * ALLOWED_DEV_ORIGINS="*.ngrok-free.app,my-box.local" in .env.local.
   */
  allowedDevOrigins: ['*.e2b.app', ...allowedDevOriginsFromEnv()],
};

function allowedDevOriginsFromEnv(): string[] {
  return (process.env.ALLOWED_DEV_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export default nextConfig;
