import dns from 'node:dns';

/**
 * Next.js server entry hook. Runs once at startup, before any route handler.
 * Prefer IPv4 for every outbound request the server makes (Settings -> Verify
 * probes and anything else server-side): on a broken/absent IPv6 route Node
 * otherwise fails with "fetch failed". The worker sets the same order in
 * worker/index.ts for its own process.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    dns.setDefaultResultOrder('ipv4first');
  }
}
