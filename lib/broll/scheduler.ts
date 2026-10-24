/**
 * The B-roll scheduler - pure, no I/O, no network.
 *
 * It turns "these images are relevant around these moments" into the final,
 * non-overlapping timeline that the renderer paints. Every rule the product needs
 * lives here so it can be unit-tested without a single provider call:
 *
 *  - the rendered clip is `[hook replay][clip]`, so nothing may land inside
 *    `[0, hookDuration)` (the hook is a duplicate of a later moment);
 *  - a full-screen item always beats a landscape card (rule: while a full-screen
 *    image is visible NO landscape card may be visible);
 *  - every item lasts 2.5-4 s, with at least a 1.5 s gap between items;
 *  - the plan respects the per-video min/max image budget;
 *  - at most `maxCount` items come out, ranked by priority then mention time.
 *
 * The scheduler never invents images: when fewer candidates exist than the
 * minimum, it returns what it has and reports the shortfall.
 */

import type { BrollItemKind } from "../types";

export const SCHEDULE_RULES = {
  /** Seconds a single image stays on screen. */
  minDuration: 2.5,
  maxDuration: 4,
  /** Empty screen between two items (any kinds). */
  minGap: 1.5,
  /** Keep this far away from the very end of the clip. */
  tailMargin: 0.15,
  /** Sticker popups: 0.15 pop-in + ~1.0 hold + 0.15 pop-out. */
  cardDuration: 1.3,
  /** Minimum empty time between a sticker and its neighbours. */
  cardGap: 0.4,
} as const;

export interface BrollCandidateInput {
  id: string;
  kind: BrollItemKind;
  /** Desired mention window, CLIP-relative (before the hook replay). */
  desiredStart: number;
  desiredEnd: number;
  /** Higher wins when two candidates want the same slot. */
  priority: number;
}

export interface ScheduleInput {
  /** Base clip length in seconds (without the hook replay). */
  clipDuration: number;
  /** Length of the duplicated hook prepended to the clip. */
  hookDuration: number;
  minCount: number;
  maxCount: number;
  candidates: readonly BrollCandidateInput[];
}

export interface ScheduledBrollItem {
  id: string;
  kind: BrollItemKind;
  /** FINAL render-timeline seconds (hook replay included). */
  start: number;
  end: number;
  /** The mention window this item was placed for, clip-relative. */
  desiredStart: number;
  desiredEnd: number;
}

export interface ScheduleResult {
  items: ScheduledBrollItem[];
  /** Human-readable account of everything that had to move or be dropped. */
  notes: string[];
  /** True when fewer than `minCount` items could be placed. */
  belowMinimum: boolean;
}

/** Total budget for a clip, scaled from "images per 60 s". */
export function brollImageBudget(
  clipDuration: number,
  minPerMinute: number,
  maxPerMinute: number,
): { targetMin: number; targetMax: number } {
  const duration = Number.isFinite(clipDuration)
    ? Math.max(0, clipDuration)
    : 0;
  const lowPerMinute = Math.max(
    1,
    Math.round(Number.isFinite(minPerMinute) ? minPerMinute : 10),
  );
  const highPerMinute = Math.max(
    lowPerMinute,
    Math.round(Number.isFinite(maxPerMinute) ? maxPerMinute : 15),
  );

  // A 60 s clip therefore gets 10-15 images; a 30 s clip 5-8; a 3 min clip 30-45.
  const targetMin = Math.max(
    1,
    Math.ceil((duration * lowPerMinute) / 60 - 1e-9),
  );
  const targetMax = Math.max(
    targetMin,
    Math.floor((duration * highPerMinute) / 60 + 1e-9),
  );
  return { targetMin, targetMax };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Place one candidate as close to its desired window as the free space allows.
 * `blocked` holds intervals already taken (including their gaps).
 */
function findSlot(
  candidate: BrollCandidateInput,
  duration: number,
  windowStart: number,
  windowEnd: number,
  blocked: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  if (windowEnd - windowStart < duration) return null;

  const desiredStart = clamp(
    candidate.desiredStart,
    windowStart,
    windowEnd - duration,
  );
  // Probe outward from the desired start in 0.1 s steps so the image still lands
  // on the mention when it can, and as close to it as possible when it cannot.
  const maxOffset = Math.ceil((windowEnd - windowStart) / 0.1) + 1;
  const starts: number[] = [desiredStart];
  for (let step = 1; step <= maxOffset; step += 1) {
    starts.push(desiredStart + step * 0.1, desiredStart - step * 0.1);
  }

  for (const rawStart of starts) {
    const start = Number(
      clamp(rawStart, windowStart, windowEnd - duration).toFixed(3),
    );
    const end = Number((start + duration).toFixed(3));
    if (end > windowEnd + 1e-6) continue;
    const collides = blocked.some(
      (interval) => start < interval.end - 1e-6 && end > interval.start + 1e-6,
    );
    if (!collides) return { start, end };
  }
  return null;
}

/**
 * The final timeline. Full-screen candidates are placed first (they win any
 * conflict); landscape cards then fill only the free space, so a card can never
 * overlap - or even touch - a full-screen image.
 */
export function scheduleBroll(input: ScheduleInput): ScheduleResult {
  const notes: string[] = [];
  const clipDuration = Number.isFinite(input.clipDuration)
    ? Math.max(0, input.clipDuration)
    : 0;
  const hookDuration = Number.isFinite(input.hookDuration)
    ? Math.max(0, input.hookDuration)
    : 0;
  const windowStart = hookDuration;
  const windowEnd = hookDuration + clipDuration - SCHEDULE_RULES.tailMargin;
  const maxCount = Math.max(0, Math.floor(input.maxCount));
  const minCount = Math.max(0, Math.min(Math.floor(input.minCount), maxCount));

  if (maxCount === 0 || windowEnd - windowStart < SCHEDULE_RULES.minDuration) {
    return {
      items: [],
      notes: [
        maxCount === 0
          ? "The image budget is 0, so no B-roll is scheduled."
          : `The clip (${clipDuration.toFixed(1)}s) is too short for a ${SCHEDULE_RULES.minDuration}s image.`,
      ],
      belowMinimum: minCount > 0,
    };
  }

  const ranked = [...input.candidates]
    // Full-screen wins; inside a kind, the higher priority (then the earlier
    // mention) goes first so the most important images get the best slots.
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "fullscreen" ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.desiredStart - b.desiredStart;
    });

  const items: ScheduledBrollItem[] = [];
  const blocked: Array<{ start: number; end: number }> = [];

  const gap = SCHEDULE_RULES.minGap;
  const canReserve = (start: number, end: number): boolean =>
    start >= windowStart - 1e-6 &&
    end <= windowEnd + 1e-6 &&
    !blocked.some(
      (interval) => start < interval.end - 1e-6 && end > interval.start + 1e-6,
    );

  const reserve = (start: number, end: number, kind: BrollItemKind): void => {
    const pad = kind === "landscape" ? SCHEDULE_RULES.cardGap : gap;
    blocked.push({
      start: Math.max(windowStart, start - pad),
      end: Math.min(windowEnd, end + pad),
    });
  };

  for (const candidate of ranked) {
    if (items.length >= maxCount) break;

    const desiredLength = candidate.desiredEnd - candidate.desiredStart;
    const duration =
      candidate.kind === "landscape"
        ? SCHEDULE_RULES.cardDuration
        : Number(
            clamp(
              Number.isFinite(desiredLength) && desiredLength > 0
                ? desiredLength
                : SCHEDULE_RULES.maxDuration,
              SCHEDULE_RULES.minDuration,
              SCHEDULE_RULES.maxDuration,
            ).toFixed(3),
          );

    // desiredStart is clip-relative; the render timeline starts with the hook replay.
    const slot = findSlot(
      { ...candidate, desiredStart: candidate.desiredStart + hookDuration },
      duration,
      windowStart,
      windowEnd,
      blocked,
    );
    if (!slot) {
      // The candidate could not fit even after the outward search: usually a
      // mention whose window is shorter than a single image.
      notes.push(
        `No free ${duration.toFixed(1)}s slot for ${candidate.kind} "${candidate.id}" ` +
          `(mention ${candidate.desiredStart.toFixed(1)}-${candidate.desiredEnd.toFixed(1)}s).`,
      );
      continue;
    }

    if (!canReserve(slot.start, slot.end)) continue;
    reserve(slot.start, slot.end, candidate.kind);
    items.push({
      id: candidate.id,
      kind: candidate.kind,
      start: slot.start,
      end: slot.end,
      desiredStart: candidate.desiredStart,
      desiredEnd: candidate.desiredEnd,
    });
  }

  items.sort((a, b) => a.start - b.start);

  // Defence in depth: the product rule is absolute, so assert it on the OUTPUT
  // rather than trusting the placement loop.
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const overlaps =
        items[i].start < items[j].end - 1e-6 &&
        items[i].end > items[j].start + 1e-6;
      if (overlaps) {
        notes.push(
          `Dropped overlapping item "${items[j].id}" (rule violation guard).`,
        );
        items.splice(j, 1);
        j -= 1;
      }
    }
  }

  const fullscreen = items.filter((item) => item.kind === "fullscreen");
  const cards = items.filter((item) => item.kind === "landscape");
  for (const card of cards) {
    const hidden = fullscreen.some(
      (shot) =>
        card.start < shot.end + SCHEDULE_RULES.minGap &&
        card.end > shot.start - SCHEDULE_RULES.minGap,
    );
    if (hidden) {
      notes.push(
        `Dropped landscape card "${card.id}": too close to a full-screen image.`,
      );
      items.splice(items.indexOf(card), 1);
    }
  }

  const belowMinimum = items.length < minCount;
  if (belowMinimum) {
    notes.push(
      `Only ${items.length} image(s) could be placed; the target minimum is ${minCount}. ` +
        "Full-screen slots are never filled with a stock image for a named entity.",
    );
  }

  return { items, notes, belowMinimum };
}
