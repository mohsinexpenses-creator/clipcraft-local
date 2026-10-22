/**
 * Per-item plan edits from the clip tile: swap an image, remove an image.
 *
 * The clip grid is the ONLY review surface (there is deliberately no "render
 * everything" dialog), so these two operations live here rather than in a page.
 * A swap uses one of the alternatives that were already fetched and recorded when
 * the plan was made - it never runs a new provider search, so it cannot silently
 * pick a different subject.
 */

import { AppError } from "../errors";
import { getClip, getClipBrollPlan, saveClipBrollPlan } from "../db";
import type { BrollAttribution, BrollItem, BrollPlan } from "../types";
import { cacheImage } from "./cache";
import { defaultBrollFetch, type BrollFetch } from "./http";
import { prepareCardFile, prepareFullscreenFile } from "./image";
import { planCardRect } from "./card";

export interface PlanEditOptions {
  fetcher?: BrollFetch;
  /** Cache directory override (tests); defaults to `<data>/broll-cache`. */
  root?: string;
}

function requirePlan(plan: BrollPlan | null): BrollPlan {
  if (!plan) {
    throw new AppError("This clip has no B-roll plan.", {
      status: 404,
      resolution: "Run B-roll for this clip first, then edit the images.",
    });
  }
  return plan;
}

function findItem(plan: BrollPlan, itemId: string): BrollItem {
  const item = plan.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new AppError("That B-roll image is not in the plan any more.", { status: 404 });
  }
  return item;
}

/** Map a stored attribution back to the candidate shape the downloader needs. */
function candidateFrom(attribution: BrollAttribution) {
  return {
    provider: attribution.provider,
    providerId: attribution.providerId ?? attribution.imageUrl,
    pageUrl: attribution.sourceUrl,
    imageUrl: attribution.imageUrl,
    thumbUrl: attribution.imageUrl,
    width: 1080,
    height: 1920,
    mime: "image/jpeg",
    ...(attribution.title ? { title: attribution.title } : {}),
    ...(attribution.author ? { author: attribution.author } : {}),
    ...(attribution.license ? { license: attribution.license } : {}),
    ...(attribution.licenseUrl ? { licenseUrl: attribution.licenseUrl } : {}),
  };
}

/**
 * Replace an item's image with the next unused alternative. The old image becomes
 * an alternative, so repeated swaps cycle through the candidates instead of
 * losing them.
 */
export async function swapBrollItem(
  clipId: string,
  itemId: string,
  options: PlanEditOptions = {}
): Promise<BrollPlan> {
  const plan = requirePlan(await getClipBrollPlan(clipId));
  const item = findItem(plan, itemId);
  const alternatives = item.alternatives ?? [];
  if (alternatives.length === 0) {
    throw new AppError("There is no other verified image for this moment.", {
      status: 400,
      resolution: "Re-run B-roll for this clip to fetch fresh candidates.",
    });
  }

  const [next, ...rest] = alternatives;
  const fetcher = options.fetcher ?? defaultBrollFetch;
  const candidate = candidateFrom(next);
  const downloaded = await cacheImage(candidate, {
    fetcher,
    root: options.root,
    provider: candidate.provider === "wikimedia" ? "Wikimedia Commons" : candidate.provider,
  });

  const prepared =
    item.kind === "fullscreen"
      ? {
          ...(await prepareFullscreenFile(downloaded.bytes, {
            cacheKey: downloaded.cacheKey,
            entityType: item.entityType,
            root: options.root,
          })),
        }
      : {
          ...(await prepareCardFile(downloaded.bytes, {
            cacheKey: downloaded.cacheKey,
            root: options.root,
          })),
        };

  const updated: BrollItem = {
    ...item,
    attribution: next,
    cacheKey: downloaded.cacheKey,
    renderFile: prepared.renderFile,
    sourceFile: downloaded.sourceFile,
    // The previous image stays available, so "swap" is always reversible.
    alternatives: [item.attribution, ...rest],
    // A swapped card keeps its position; only the picture changes.
    ...(item.kind === "fullscreen" && prepared.crop ? { crop: prepared.crop } : {}),
    // A new image has no verdict yet. It came from the same verified search and is
    // marked as such, but the plan must not pretend it was checked.
    verification: item.verification
      ? {
          ...item.verification,
          reason: `${item.verification.reason} (image swapped manually; the verdict belongs to the previous photo)`,
        }
      : undefined,
  };

  const nextPlan: BrollPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    items: plan.items.map((entry) => (entry.id === itemId ? updated : entry)),
  };
  await saveClipBrollPlan(clipId, nextPlan);
  return nextPlan;
}

/** Remove one image from the plan. The remaining timeline is untouched. */
export async function removeBrollItem(clipId: string, itemId: string): Promise<BrollPlan> {
  const plan = requirePlan(await getClipBrollPlan(clipId));
  const item = findItem(plan, itemId);
  const items = plan.items.filter((entry) => entry.id !== itemId);
  const nextPlan: BrollPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    items,
    counts: {
      ...plan.counts,
      fullscreen: items.filter((entry) => entry.kind === "fullscreen").length,
      landscape: items.filter((entry) => entry.kind === "landscape").length,
    },
    notes: [
      ...(plan.notes ?? []),
      `Removed "${item.query}" (${item.start.toFixed(1)}-${item.end.toFixed(1)}s) from the plan.`,
    ],
  };
  await saveClipBrollPlan(clipId, nextPlan);
  return nextPlan;
}

/**
 * Recompute the card rectangles of an existing plan (used when the caption preset
 * changed and a card would now sit on the captions).
 */
export async function refreshCardPlacement(
  clipId: string,
  captionBand: { top: number; bottom: number },
  faceZones?: Array<{ x: number; y: number; width: number; height: number }>
): Promise<BrollPlan | null> {
  const plan = await getClipBrollPlan(clipId);
  if (!plan) return null;
  const items = plan.items.map((item) =>
    item.kind === "landscape" ? { ...item, card: planCardRect({ captionBand, faceZones }) } : item
  );
  const nextPlan: BrollPlan = { ...plan, items };
  await saveClipBrollPlan(clipId, nextPlan);
  return nextPlan;
}

/** Public shape the tile needs; loading the whole clip is not necessary. */
export async function getClipBrollSummary(clipId: string): Promise<{
  plan: BrollPlan | null;
  status: "none" | "pending" | "running" | "done" | "failed";
  error?: string;
}> {
  const clip = await getClip(clipId);
  if (!clip) throw new AppError("Clip not found.", { status: 404 });
  return {
    plan: clip.broll ?? null,
    status: clip.brollStatus ?? (clip.broll ? "done" : "none"),
    ...(clip.brollError ? { error: clip.brollError } : {}),
  };
}
