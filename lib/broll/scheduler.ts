/**
 * The B-roll scheduler - pure, no I/O, no network.
 *
 * It turns "these images are relevant around these moments" into the final,
 * non-overlapping timeline that the renderer paints. Every rule the product needs
 * lives here so it can be unit-tested without a single provider call:
 *
 *  - every candidate already carries an EXACT start (its anchor word, floored to
 *    the frame grid). The scheduler never moves a start: an image that appears a
 *    second after the word it illustrates is the bug this whole pipeline exists
 *    to avoid;
 *  - so a conflict is resolved by TRUNCATING the earlier item (never below
 *    `minDuration`, always leaving `exitGap` before the next start) or by
 *    dropping the lower-relevance item (ties keep the earlier one);
 *  - a full-screen item always wins a conflict with a landscape card, because
 *    the named thing is what the sentence is about;
 *  - nothing is ever placed inside the hook replay window;
 *  - the per-minute image budget is a SOFT cap: when the exact starts cannot fit
 *    the maximum the extra items are dropped, and when they cannot reach the
 *    minimum that is reported rather than fixed by moving pictures around;
 *  - only `maxCount` items come out, ranked by relevance then mention time.
 *
 * The scheduler never invents images: it returns what fits and reports the rest.
 */

import type { BrollItemKind } from "../types";

export const SCHEDULE_RULES = {
  /** Seconds a single image stays on screen (full-screen items). */
  minDuration: 2.5,
  maxDuration: 4,
  /** Minimum breathing room after an item, before anything else may start. */
  minGap: 1.5,
  /**
   * Exact-sync rules: the shortest an item may be truncated to, and the gap
   * left between one item's truncation point and the next item's exact start.
   */
  minTrimmedDuration: 1.2,
  exitGap: 0.2,
  /** Keep this far away from the very end of the clip. */
  tailMargin: 0.15,
  /** Cards should live on the same 2.5-4s timeframe as any other B-roll item. */
  cardDuration: 2.5,
  cardGap: 1.5,
} as const;

export interface BrollCandidateInput {
  id: string;
  kind: BrollItemKind;
  /** The EXACT render-timeline start (anchor word, floored to the frame grid). */
  desiredStart: number;
  /** Desired mention window, CLIP-relative (before the hook replay). */
  desiredEnd: number;
  /** Higher wins when two candidates want the same slot. */
  priority: number;
  /**
   * 1-5 relevance. Absent means "derived from priority" (full-screen entities
   * are 5, cards 3), so old callers keep working.
   */
  relevance?: number;
}

export interface ScheduleInput {
  /** Base clip length in seconds (without the hook replay). */
  clipDuration: number;
  /** Length of the duplicated hook prepended to the clip. */
  hookDuration: number;
  minCount: number;
  maxCount: number;
  /** Frame grid the starts are already snapped to (used for frame-exact trims). */
  fps?: number;
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
  relevance: number;
  /** "exact" = the item starts on its anchor word, as asked. */
  action: "exact" | "truncated-prev";
}

export interface ScheduleResult {
  items: ScheduledBrollItem[];
  /** Human-readable account of everything that had to be trimmed or dropped. */
  notes: string[];
  /** True when fewer than `minCount` items could be placed. */
  belowMinimum: boolean;
  /** Every candidate the scheduler refused, so the caller does not re-report it. */
  droppedIds: Set<string>;
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

/** Relevance of a candidate: explicit, else derived from the kind. */
export function candidateRelevance(candidate: BrollCandidateInput): number {
  if (typeof candidate.relevance === "number" && Number.isFinite(candidate.relevance)) {
    return clamp(Math.round(candidate.relevance), 1, 5);
  }
  return candidate.kind === "fullscreen" ? 5 : 3;
}

function itemDuration(candidate: BrollCandidateInput): number {
  if (candidate.kind === "landscape") return SCHEDULE_RULES.cardDuration;
  const desired = candidate.desiredEnd - candidate.desiredStart;
  const length = Number.isFinite(desired) && desired > 0 ? desired : SCHEDULE_RULES.maxDuration;
  return Number(clamp(length, SCHEDULE_RULES.minDuration, SCHEDULE_RULES.maxDuration).toFixed(3));
}

/**
 * The final timeline. Starts are taken as given (they are exact); only the END
 * of an item may be early, and only to make room for the next exact start.
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
  const fps = input.fps && input.fps > 0 ? input.fps : 30;
  const frame = (seconds: number) => Math.floor(seconds * fps + 1e-6) / fps;

  if (maxCount === 0 || windowEnd - windowStart < SCHEDULE_RULES.minDuration) {
    return {
      items: [],
      notes: [
        maxCount === 0
          ? "The image budget is 0, so no B-roll is scheduled."
          : `The clip (${clipDuration.toFixed(1)}s) is too short for a ${SCHEDULE_RULES.minDuration}s image.`,
      ],
      belowMinimum: minCount > 0,
      droppedIds: new Set(input.candidates.map((candidate) => candidate.id)),
    };
  }

  // Order of preference for a contested slot:
  //   1. full-screen before landscape (the named thing IS the sentence);
  //   2. higher relevance;
  //   3. the earlier mention (ties keep the earlier item), then the stable id.
  const ranked = [...input.candidates].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "fullscreen" ? -1 : 1;
    const relevance = candidateRelevance(b) - candidateRelevance(a);
    if (relevance !== 0) return relevance;
    if (Math.abs(a.desiredStart - b.desiredStart) > 1e-6) return a.desiredStart - b.desiredStart;
    return a.id.localeCompare(b.id);
  });

  const placed: ScheduledBrollItem[] = [];

  /** Ids already dropped, so one candidate is never reported twice. */
  const droppedIds = new Set<string>();

  /** The exact start, clipped to the render window; null inside the hook. */
  const exactStart = (candidate: BrollCandidateInput): number | null => {
    const start = Number(frame(candidate.desiredStart + hookDuration).toFixed(3));
    if (start < windowStart - 1e-6) return null;
    if (start > windowEnd - SCHEDULE_RULES.minTrimmedDuration) return null;
    return Math.max(windowStart, start);
  };

  for (const candidate of ranked) {
    if (placed.length >= maxCount) break;
    const start = exactStart(candidate);
    if (start === null) {
      notes.push(
        `Dropped ${candidate.kind} "${candidate.id}": its anchor word (${candidate.desiredStart.toFixed(2)}s) is inside the hook replay or past the clip end.`,
      );
      droppedIds.add(candidate.id);
      continue;
    }

    const duration = Math.min(itemDuration(candidate), windowEnd - start);
    let action: ScheduledBrollItem["action"] = "exact";
    let pending: ScheduledBrollItem = {
      id: candidate.id,
      kind: candidate.kind,
      start,
      end: Number((start + duration).toFixed(3)),
      desiredStart: candidate.desiredStart,
      desiredEnd: candidate.desiredEnd,
      relevance: candidateRelevance(candidate),
      action,
    };

    // Resolve against everything that is already there. A start is never moved:
    // the earlier picture's END gives way, and when it cannot (below 1.2 s) the
    // loser is dropped instead.
    let dropped = false;
    const conflicting = placed
      .filter(
        (item) =>
          item.start < pending.end + SCHEDULE_RULES.exitGap - 1e-6 &&
          item.end > pending.start - SCHEDULE_RULES.exitGap + 1e-6,
      )
      .sort((a, b) => a.start - b.start);

    for (const other of conflicting) {
      const sameStart = Math.abs(other.start - pending.start) <= 1e-6;
      if (sameStart) {
        if (pickWinner(pending, other) === pending) {
          placed.splice(placed.indexOf(other), 1);
          droppedIds.add(other.id);
          notes.push(
            `Dropped ${other.kind} "${other.id}": same frame as "${pending.id}" (${pending.start.toFixed(3)}s).`,
          );
          continue;
        }
        dropped = true;
        droppedIds.add(candidate.id);
        notes.push(
          `Dropped ${candidate.kind} "${candidate.id}": "${other.id}" already owns the ${pending.start.toFixed(3)}s frame.`,
        );
        break;
      }

      if (other.start < pending.start) {
        // The earlier picture may end early, never start later.
        const trimmed = Number(
          (pending.start - SCHEDULE_RULES.exitGap).toFixed(3),
        );
        if (trimmed - other.start >= SCHEDULE_RULES.minTrimmedDuration - 1e-6) {
          if (other.end > trimmed) {
            other.end = trimmed;
            notes.push(
              `Truncated ${other.kind} "${other.id}" to ${trimmed.toFixed(2)}s for "${pending.id}".`,
            );
          }
          continue;
        }
        if (pickWinner(pending, other) === pending) {
          placed.splice(placed.indexOf(other), 1);
          droppedIds.add(other.id);
          notes.push(
            `Dropped ${other.kind} "${other.id}" (${other.start.toFixed(2)}s): no ${SCHEDULE_RULES.minTrimmedDuration}s left before "${pending.id}".`,
          );
          continue;
        }
        dropped = true;
        droppedIds.add(candidate.id);
        notes.push(
          `Dropped ${candidate.kind} "${candidate.id}": "${other.id}" starts ${other.start.toFixed(2)}s and wins the conflict.`,
        );
        break;
      }

      // The other picture starts LATER, so this one must end before it.
      const trimmed = Number(
        (other.start - SCHEDULE_RULES.exitGap).toFixed(3),
      );
      if (trimmed - pending.start >= SCHEDULE_RULES.minTrimmedDuration - 1e-6) {
        if (pending.end > trimmed) {
          pending = { ...pending, end: trimmed, action: "truncated-prev" };
          action = "truncated-prev";
        }
        continue;
      }
      if (pickWinner(pending, other) === pending) {
        placed.splice(placed.indexOf(other), 1);
        droppedIds.add(other.id);
        notes.push(
          `Dropped ${other.kind} "${other.id}" (${other.start.toFixed(2)}s): "${pending.id}" wins the conflict.`,
        );
        continue;
      }
      dropped = true;
      droppedIds.add(candidate.id);
      notes.push(
        `Dropped ${candidate.kind} "${candidate.id}": "${other.id}" owns ${other.start.toFixed(2)}s and there is no room for ${SCHEDULE_RULES.minTrimmedDuration}s.`,
      );
      break;
    }
    if (dropped) continue;

    pending = { ...pending, action };
    if (pending.end - pending.start < SCHEDULE_RULES.minTrimmedDuration - 1e-6) {
      notes.push(
        `Dropped ${candidate.kind} "${candidate.id}": only ${(pending.end - pending.start).toFixed(2)}s of room at ${start.toFixed(2)}s.`,
      );
      droppedIds.add(candidate.id);
      continue;
    }
    placed.push(pending);
  }

  placed.sort((a, b) => a.start - b.start);

  // Defence in depth: the product rule is absolute, so assert it on the OUTPUT.
  // Overlaps can only survive on the frame grid when two anchors share a frame.
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const overlaps =
        placed[i].start < placed[j].end - 1e-6 &&
        placed[i].end > placed[j].start + 1e-6;
      if (overlaps) {
        const keep = pickWinner(placed[i], placed[j]);
        const drop = keep === placed[i] ? placed[j] : placed[i];
        notes.push(`Dropped overlapping item "${drop.id}" (rule violation guard).`);
        placed.splice(placed.indexOf(drop), 1);
        j = i;
      }
    }
  }

  // A full-screen image is never covered by a card: exit gaps are already
  // enforced above, this guards hand-built candidates.
  const fullscreen = placed.filter((item) => item.kind === "fullscreen");
  for (const card of placed.filter((item) => item.kind === "landscape")) {
    const hidden = fullscreen.some(
      (shot) =>
        card.start < shot.end + SCHEDULE_RULES.exitGap - 1e-6 &&
        card.end > shot.start - SCHEDULE_RULES.exitGap + 1e-6,
    );
    if (hidden) {
      notes.push(`Dropped landscape card "${card.id}": too close to a full-screen image.`);
      placed.splice(placed.indexOf(card), 1);
    }
  }

  const belowMinimum = placed.length < minCount;
  if (belowMinimum) {
    notes.push(
      `Only ${placed.length} image(s) could be placed; the target minimum is ${minCount}. ` +
        "Starts are exact anchor words, so pictures are never moved to fill the count.",
    );
  }

  return { items: placed, notes, belowMinimum, droppedIds };
}

/**
 * A start never moves, so a conflict's winner is decided by what the picture is:
 * full-screen over landscape, then relevance, then the EARLIER start (a tie keeps
 * whichever item was already on the timeline).
 */
function pickWinner(
  pending: ScheduledBrollItem,
  other: ScheduledBrollItem,
): ScheduledBrollItem {
  if (pending.kind !== other.kind) return pending.kind === "fullscreen" ? pending : other;
  if (pending.relevance !== other.relevance) {
    return pending.relevance > other.relevance ? pending : other;
  }
  return other.start <= pending.start ? other : pending;
}
