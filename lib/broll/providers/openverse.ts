/**
 * Openverse (WordPress's open-licence image index) as the fallback for named
 * entities when Wikimedia Commons is unreachable or has nothing usable.
 *
 * Anonymous access works without a key (low rate limit), so this is only ever
 * called after Commons fails, and its answers are cached by the caller.
 * Results hosted on wikimedia.org are downloaded through Openverse's own thumbnail
 * proxy, because that host is the one that may be blocked on this network.
 */

import type { BrollFetch } from "../http";
import { fetchJson } from "../http";
import { rankCommonsCandidates } from "./commons";
import type { BrollCandidate } from "./types";
import { isUsableImage } from "./types";

export const OPENVERSE_API_URL = "https://api.openverse.org/v1/images/";

export interface OpenverseSearchOptions {
  fetcher: BrollFetch;
  limit?: number;
  timeoutMs?: number;
}

interface OpenverseImage {
  id?: string;
  title?: string;
  creator?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  foreign_landing_url?: string;
  url?: string;
  width?: number | null;
  height?: number | null;
  filetype?: string | null;
  tags?: Array<{ name?: string }>;
}

const MIME_BY_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function buildOpenverseSearchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    q: query,
    page_size: String(Math.min(20, Math.max(1, limit))),
    license_type: "commercial",
    extension: "jpg",
  });
  return `${OPENVERSE_API_URL}?${params.toString()}`;
}

function licenseLabel(license?: string, version?: string): string | undefined {
  if (!license) return undefined;
  const lower = license.toLowerCase();
  if (lower === "cc0") return "CC0";
  if (lower === "pdm") return "Public Domain Mark";
  return `CC ${license.toUpperCase()}${version ? ` ${version}` : ""}`;
}

export function parseOpenverseResponse(payload: unknown): BrollCandidate[] {
  const results = (payload as { results?: OpenverseImage[] } | null)?.results;
  if (!Array.isArray(results)) return [];

  const candidates: BrollCandidate[] = [];
  for (const item of results) {
    if (!item.id || !item.url) continue;
    const width = item.width ?? 0;
    const height = item.height ?? 0;
    const type = item.filetype?.toLowerCase();
    const mime = type ? MIME_BY_TYPE[type] : "image/jpeg";
    if (!mime || !isUsableImage({ width, height, mime })) continue;

    // wikimedia.org may be unreachable from here: let Openverse fetch it for us.
    const imageUrl = item.url.includes("wikimedia.org")
      ? `${OPENVERSE_API_URL}${item.id}/thumb/?full_size=true`
      : item.url;
    const tags = (item.tags ?? [])
      .map((tag) => tag.name?.trim())
      .filter((name): name is string => Boolean(name));
    const license = licenseLabel(item.license, item.license_version);

    candidates.push({
      provider: "openverse",
      providerId: item.id,
      pageUrl: item.foreign_landing_url ?? item.url,
      imageUrl,
      thumbUrl: imageUrl,
      width,
      height,
      mime,
      title: item.title?.trim() || undefined,
      description: tags.length > 0 ? tags.slice(0, 12).join(", ") : undefined,
      categories: tags.slice(0, 8),
      ...(item.creator ? { author: item.creator } : {}),
      ...(license ? { license } : {}),
      ...(item.license_url ? { licenseUrl: item.license_url } : {}),
    });
  }
  return candidates;
}

export async function searchOpenverse(
  query: string,
  options: OpenverseSearchOptions,
): Promise<BrollCandidate[]> {
  const payload = await fetchJson(
    buildOpenverseSearchUrl(query, options.limit ?? 10),
    {
      fetcher: options.fetcher,
      provider: "Openverse",
      timeoutMs: options.timeoutMs,
    },
  );
  return rankCommonsCandidates(parseOpenverseResponse(payload));
}
