import type { BrollFetch } from "../http";
import { BrollHttpError, fetchJson } from "../http";
import type { BrollCandidate } from "./types";
import { ACCEPTED_IMAGE_MIME, extMetadataValue } from "./types";

const SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKI_API = "https://en.wikipedia.org/w/api.php";

interface Summary {
  type?: string; // "standard" | "disambiguation" | ...
  title?: string;
  description?: string;
  content_urls?: { desktop?: { page?: string } };
  originalimage?: { source: string; width: number; height: number };
}

interface ImageInfoResponse {
  query?: {
    pages?: Array<{
      imageinfo?: Array<{
        mime?: string;
        thumburl?: string;
        extmetadata?: Record<string, unknown>;
      }>;
    }>;
  };
}

type ImageInfo = NonNullable<
  NonNullable<NonNullable<ImageInfoResponse["query"]>["pages"]>[number]["imageinfo"]
>[number];

async function summaryFor(title: string, fetcher: BrollFetch): Promise<Summary | null> {
  try {
    return (await fetchJson(SUMMARY_URL + encodeURIComponent(title.trim().replace(/\s+/g, "_")), {
      fetcher,
      provider: "Wikipedia",
    })) as Summary;
  } catch (e) {
    if (e instanceof BrollHttpError && e.statusCode === 404) return null;
    throw e;
  }
}

/** Resolve a name that is not itself an exact article title. */
async function resolveTitle(name: string, fetcher: BrollFetch): Promise<string | null> {
  const url = `${WIKI_API}?action=opensearch&search=${encodeURIComponent(name)}&limit=1&format=json`;
  const payload = (await fetchJson(url, { fetcher, provider: "Wikipedia" })) as [string, string[]];
  return payload?.[1]?.[0] ?? null;
}

async function imageInfoFor(
  source: string,
  fetcher: BrollFetch,
): Promise<ImageInfo | undefined> {
  const fileName = decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    iiurlwidth: "1600",
    titles: `File:${fileName}`,
  });
  const payload = (await fetchJson(`${WIKI_API}?${params.toString()}`, {
    fetcher,
    provider: "Wikipedia",
  })) as ImageInfoResponse;
  return payload.query?.pages?.[0]?.imageinfo?.[0];
}

export async function findWikipediaImage(
  title: string,
  opts: { fetcher: BrollFetch },
): Promise<BrollCandidate | null> {
  const name = title.trim();
  if (!name) return null;
  let summary = await summaryFor(name, opts.fetcher);
  if (!summary || summary.type === "disambiguation") {
    const title = await resolveTitle(name, opts.fetcher);
    summary = title ? await summaryFor(title, opts.fetcher) : null;
  }
  if (!summary || summary.type === "disambiguation" || !summary.originalimage) return null;

  const img = summary.originalimage;
  const info = await imageInfoFor(img.source, opts.fetcher);
  const ext = info?.extmetadata;
  if (["true", "1", "yes"].includes(extMetadataValue(ext, "NonFree")?.toLowerCase() ?? ""))
    return null;
  const mime = info?.mime?.toLowerCase();
  if (!mime || !ACCEPTED_IMAGE_MIME.has(mime)) return null;
  const pageUrl = summary.content_urls?.desktop?.page;
  if (!pageUrl) return null;
  const imageUrl = info?.thumburl ?? img.source;

  return {
    provider: "wikipedia",
    providerId: summary.title ?? name,
    pageUrl,
    imageUrl,
    thumbUrl: imageUrl,
    width: img.width,
    height: img.height,
    mime,
    title: summary.title,
    description: summary.description,
    categories: [],
    author: extMetadataValue(ext, "Artist") ?? extMetadataValue(ext, "Credit"),
    license: extMetadataValue(ext, "LicenseShortName"),
    licenseUrl: extMetadataValue(ext, "LicenseUrl"),
  };
}