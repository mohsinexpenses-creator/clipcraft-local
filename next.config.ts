import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Native packages used only by server routes and the local worker. Keep them
   * outside Next's Server Component bundling so their native/dynamic runtime
   * loading continues to work.
   */
  serverExternalPackages: [
    'better-sqlite3',
    'ffmpeg-static',
    'onnxruntime-node',
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
