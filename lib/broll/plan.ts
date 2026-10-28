/**
 * Build one clip's B-roll plan.
 *
 * This is the orchestration layer: analysis -> provider search -> download ->
 * verification -> preparation -> scheduling. Every side effect (network, disk,
 * Gemini) is injected as a small function, so the whole flow - including the rule
 * that an unverified entity is never shown - is unit-tested offline.
 *
 * Order matters and follows the brief:
 *   1. named entities are searched on Wikimedia Commons ONLY (a stock lookalike
 *      would be a different person/place, so it is never substituted);
 *   2. every entity candidate is verified by Gemini Vision before it may take the
 *      full screen; a rejection skips the mention (never a fallback image);
 *   3. keyword moments are filled from stock providers, with the configured
 *      provider order and quota fall-through;
 *   4. the scheduler places what survived on the render timeline.
 *
 * The renderer only ever reads the resulting plan.
 */

import type {
  BrollEntityType,
  BrollItem,
  BrollOptions,
  BrollPlan,
  BrollSkip,
  BrollVerificationSummary,
  WordTimestamp,
} from "../types";
import {
  deriveFallbackKeywords,
  transcriptSentenceAt,
  type BrollAnalysis,
} from "./analysis";
import { planCardRect, type FaceZoneRect } from "./card";
import {
  brollImageBudget,
  scheduleBroll,
  type BrollCandidateInput,
} from "./scheduler";
import type { BrollCandidate } from "./providers/types";
import { attributionFor } from "./providers/types";
import type { StockSearchResult } from "./providers/stock";
import {
  VISION_CANDIDATE_COUNT,
  verdictAccepts,
  verdictRejectionReason,
  type VisionRequestInput,
  type VisionVerdict,
} from "./vision";
import {
  buildEntityAttempts,
  candidateKey,
  preferPortrait,
  type EntityAttempt,
} from "./entity-attempts";

/** An image that is downloaded, prepared and ready to be painted. */
export interface PreparedBrollImage {
  cacheKey: string;
  /**
   * Original download in the cache dir (file name only). Filled in from
   * `download()` by the plan builder; a prepare step may omit it.
   */
  sourceFile?: string;
  /** Prepared JPEG the renderer paints (file name only). */
  renderFile: string;
  crop?: import("../types").BrollCropPlan;
}

export interface CardVerdict {
  id: string;
  relevant: boolean;
  hasText: boolean;
}

export interface BrollPlanDeps {
  analyze(input: {
    clipDuration: number;
    words: WordTimestamp[];
    entityBudget: number;
    keywordBudget: number;
    keywordMin: number;
  }): Promise<BrollAnalysis>;
  searchEntity(query: string): Promise<BrollCandidate[]>;
  /** Openverse + Commons in parallel, merged. Preferred over searchEntity when present. */
  searchEntityAll?(query: string): Promise<BrollCandidate[]>;
  /**
   * Second source for an entity, tried only when every Commons candidate failed to
   * download (rate limit / timeout). Absent = no second attempt.
   */
  searchEntityFallback?(query: string): Promise<BrollCandidate[]>;
  searchStock(query: string): Promise<StockSearchResult>;
  download(
    candidate: BrollCandidate,
  ): Promise<{ cacheKey: string; sourceFile: string; bytes: Buffer }>;
  prepareFullscreen(
    bytes: Buffer,
    entityType: BrollEntityType,
    cacheKey: string,
  ): Promise<PreparedBrollImage>;
  prepareCard(bytes: Buffer, cacheKey: string): Promise<PreparedBrollImage>;
  thumbnail(bytes: Buffer): Promise<{ data: string; mime: string }>;
  verify(input: VisionRequestInput): Promise<VisionVerdict>;
  /** One batched vision request over every chosen card. Absent = cards are not checked. */
  verifyCards?(
    items: Array<{
      id: string;
      keyword: string;
      image: { data: string; mime: string };
    }>,
  ): Promise<CardVerdict[]>;
  /** False when no Gemini key is configured - entities are then skipped up front. */
  visionAvailable: boolean;
  now?: () => Date;
}

export interface BrollPlanInput {
  clipDuration: number;
  hookDuration: number;
  words: WordTimestamp[];
  options: BrollOptions;
  trigger: BrollPlan["trigger"];
  /** The caption block, so a card never covers it. */
  captionBand: { top: number; bottom: number };
  /** Face boxes on the canvas, so a card never covers one. */
  faceZones?: FaceZoneRect[];
}

/** Full-screen images are worth more than a stock card (used for slot priority). */
export const ENTITY_PRIORITY = 100;
export const CARD_PRIORITY = 50;
/** Never send more than this many entities per clip to Commons + Gemini. */
export const MAX_ENTITIES_PER_CLIP = 4;
/** Candidate images checked per entity. */
export const ENTITY_CANDIDATES_PER_SEARCH = 4; // was 6
/** Gemini verifications per entity before the mention is skipped. */
export const MAX_VERIFY_ATTEMPTS = 3;
/** Stock candidates kept per keyword (the first is used, the rest are replacements). */
export const CARD_CANDIDATES_PER_KEYWORD = 3;

function toVerification(
  verdict: VisionVerdict,
  now: Date,
): BrollVerificationSummary {
  return {
    confidence: verdict.confidence,
    reason: verdict.reason,
    verifiedAt: now.toISOString(),
  };
}

/**
 * Build the plan. Never throws for a provider/Gemini failure: the affected
 * mentions become `skipped` entries with a reason and the rest of the clip still
 * gets its B-roll - except that a full-screen image without a passed verdict is
 * simply not used.
 */
export async function buildBrollPlan(
  input: BrollPlanInput,
  deps: BrollPlanDeps,
): Promise<BrollPlan> {
  const now = deps.now ?? (() => new Date());
  const options = input.options;
  const notes: string[] = [];
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const skipped: BrollSkip[] = [];
  const budget = brollImageBudget(
    input.clipDuration,
    options.minImages,
    options.maxImages,
  );

  const entityBudget = options.enableFullscreen
    ? Math.min(budget.targetMax, MAX_ENTITIES_PER_CLIP)
    : 0;
  const keywordBudget = options.enableLandscape ? budget.targetMax : 0;

  /* ----------------------------- 1. analysis ---------------------------- */

  let analysis: BrollAnalysis;
  try {
    analysis = await deps.analyze({
      clipDuration: input.clipDuration,
      words: input.words,
      entityBudget,
      keywordBudget,
      keywordMin: keywordBudget > 0 ? budget.targetMin : 0,
    });
    console.log(
      `[broll] Analysis: ${analysis.entities.length} entit(ies), ${analysis.broll.length} keyword moment(s).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(
      `AI analysis failed (${message}); fell back to keywords from the transcript.`,
    );
    skipped.push({ stage: "analysis", reason: message });
    analysis = deriveFallbackKeywords(
      input.words,
      input.clipDuration,
      keywordBudget,
    );
  }

  // A provider that answers with nothing usable still leaves the clip without
  // cards; top the keyword list up from the transcript when it is short.
  if (options.enableLandscape && analysis.broll.length < budget.targetMin) {
    const fallback = deriveFallbackKeywords(
      input.words,
      input.clipDuration,
      budget.targetMax - analysis.broll.length,
    );
    const existing = new Set(
      analysis.broll.map((moment) => moment.visualKeywords[0]?.toLowerCase()),
    );
    const extra = fallback.broll.filter(
      (moment) => !existing.has(moment.visualKeywords[0]?.toLowerCase()),
    );
    if (extra.length > 0) {
      analysis = { ...analysis, broll: [...analysis.broll, ...extra] };
      notes.push(
        `Topped up ${extra.length} keyword moment(s) from the transcript.`,
      );
    }
  }

  /* --------------------------- 2. entities ------------------------------ */

  const prepared: Array<{
    id: string;
    kind: "fullscreen" | "landscape";
    priority: number;
    desiredStart: number;
    desiredEnd: number;
    candidate: BrollCandidate;
    alternatives?: import("../types").BrollAttribution[];
    prepared: PreparedBrollImage;
    verification?: BrollVerificationSummary;
    entityName?: string;
    entityType?: BrollEntityType;
    query: string;
  }> = [];

  if (entityBudget > 0 && !deps.visionAvailable) {
    notes.push(
      "No Gemini key is configured, so named entities are skipped: an unverified full-screen image is never shown.",
    );
    for (const entity of analysis.entities) {
      skipped.push({
        stage: "verify",
        entity: entity.name,
        reason: "Gemini Vision is not configured; images cannot be verified.",
      });
    }
  }

  const seenEntities = new Set<string>();
  const entities = deps.visionAvailable
    ? analysis.entities
      .filter((entity) => {
        const key = entity.name.toLowerCase();
        if (seenEntities.has(key)) return false;
        seenEntities.add(key);
        return true;
      })
      .slice(0, entityBudget)
    : [];

  const searchAll =
    deps.searchEntityAll ??
    (async (q: string) => {
      const first = await deps.searchEntity(q);
      if (first.length > 0 || !deps.searchEntityFallback) return first;
      return deps.searchEntityFallback(q);
    });

  const resolveEntity = async (
    entity: (typeof entities)[number],
  ): Promise<{ item?: (typeof prepared)[number]; skip?: BrollSkip }> => {
    const context = transcriptSentenceAt(input.words, entity.start);
    const attempts = buildEntityAttempts(entity);

    // Searches are cheap JSON calls: the next attempt's search runs while this
    // attempt downloads and waits for Gemini.
    const searches = new Map<string, Promise<BrollCandidate[]>>();
    const search = (attempt: EntityAttempt) => {
      const key = attempt.query.toLowerCase();
      let promise = searches.get(key);
      if (!promise) {
        promise = searchAll(attempt.query).catch((error) => {
          notes.push(`Image search failed for "${entity.name}" (${attempt.label}): ${describe(error)}`);
          return [] as BrollCandidate[];
        });
        searches.set(key, promise);
      }
      return promise;
    };

    const downloadAll = async (list: BrollCandidate[]) => {
      const settled = await Promise.all(
        list.slice(0, VISION_CANDIDATE_COUNT).map(async (candidate) => {
          try {
            const file = await deps.download(candidate);
            const thumb = await deps.thumbnail(file.bytes);
            return { candidate, bytes: file.bytes, data: thumb.data, mime: thumb.mime };
          } catch (error) {
            notes.push(`Could not download a "${entity.name}" candidate: ${describe(error)}`);
            return null;
          }
        }),
      );
      return settled.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    };

    const seen = new Set<string>(); // never show Gemini the same image twice
    const failures: string[] = [];
    let verified = 0;

    for (let i = 0; i < attempts.length && verified < MAX_VERIFY_ATTEMPTS; i += 1) {
      const attempt = attempts[i];
      const current = search(attempt);
      if (attempts[i + 1]) void search(attempts[i + 1]); // prefetch next

      const fresh = (await current).filter((c) => !seen.has(candidateKey(c)));
      const pool = preferPortrait(fresh).slice(0, ENTITY_CANDIDATES_PER_SEARCH);
      pool.forEach((c) => seen.add(candidateKey(c)));
      if (pool.length === 0) {
        failures.push(`${attempt.label}: no new candidate`);
        continue;
      }

      const downloaded = await downloadAll(pool);
      if (downloaded.length === 0) {
        failures.push(`${attempt.label}: nothing could be downloaded`);
        continue;
      }

      verified += 1;
      let verdict: VisionVerdict;
      try {
        verdict = await deps.verify({
          entityName: entity.name,
          entityType: entity.type,
          mode: attempt.mode,
          context: attempt.mode === "context" ? context : "",
          commonsTitle: downloaded[0].candidate.title,
          commonsDescription: downloaded[0].candidate.description,
          commonsCategories: downloaded[0].candidate.categories,
          images: downloaded.map((item, index) => ({ index, data: item.data, mime: item.mime })),
        });
      } catch (error) {
        failures.push(`${attempt.label}: Gemini error - ${describe(error)}`);
        continue;
      }

      console.log(
        `[broll] Vision "${entity.name}" try ${verified}/${MAX_VERIFY_ATTEMPTS} (${attempt.label}): ` +
        `pick=${verdict.pickIndex} confidence=${verdict.confidence.toFixed(2)} - ${verdict.reason}`,
      );

      const chosen = verdict.pickIndex === null ? undefined : downloaded[verdict.pickIndex];
      if (!verdictAccepts(verdict) || !chosen) {
        failures.push(`${attempt.label}: ${verdictRejectionReason(verdict)}`);
        continue;
      }

      try {
        const file = await deps.download(chosen.candidate); // cached
        const preparedImage = {
          ...(await deps.prepareFullscreen(file.bytes, entity.type, file.cacheKey)),
          sourceFile: file.sourceFile,
        };
        return {
          item: {
            id: `entity-${entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            kind: "fullscreen",
            priority: ENTITY_PRIORITY,
            desiredStart: entity.start,
            desiredEnd: entity.end,
            candidate: chosen.candidate,
            alternatives: downloaded
              .filter((_e, index) => index !== verdict.pickIndex)
              .map((e) => attributionFor(e.candidate)),
            prepared: preparedImage,
            verification: toVerification(verdict, now()),
            entityName: entity.name,
            entityType: entity.type,
            query: attempt.query,
          },
        };
      } catch (error) {
        failures.push(`${attempt.label}: prepare failed - ${describe(error)}`);
      }
    }

    return {
      skip: {
        stage: verified === 0 ? "search" : "verify",
        entity: entity.name,
        reason: `Failed ${verified}/${MAX_VERIFY_ATTEMPTS} verification attempt(s) - ${failures.join(" | ")}`.slice(0, 600),
      },
    };
  };

  // All entities in parallel (the limiters in broll-sources.ts keep the APIs polite).
  const entityResults = await Promise.all(entities.map(resolveEntity));
  for (const result of entityResults) {
    if (result.item) prepared.push(result.item);
    if (result.skip) skipped.push(result.skip);
  }

  /* --------------------------- 3. landscapes ---------------------------- */

  if (keywordBudget > 0) {
    const moments = analysis.broll.slice(0, budget.targetMax + 2);
    const usedQueries = new Set<string>();

    interface CardEntry {
      id: string;
      query: string;
      start: number;
      end: number;
      candidates: BrollCandidate[];
      cursor: number;
      file?: { cacheKey: string; sourceFile: string; bytes: Buffer };
      thumb?: { data: string; mime: string };
      flagged: boolean;
    }
    const entries: CardEntry[] = [];

    // 3a. Search every keyword (cached). No result -> retry with the last word only.
    for (const moment of moments) {
      const query = moment.visualKeywords.join(" ").trim();
      if (!query || usedQueries.has(query.toLowerCase())) continue;
      usedQueries.add(query.toLowerCase());

      let result: StockSearchResult;
      try {
        result = await deps.searchStock(query);
        if (result.candidates.length === 0 && query.includes(" ")) {
          const retry = await deps.searchStock(
            query.split(/\s+/).pop() as string,
          );
          if (retry.candidates.length > 0) result = retry;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notes.push(`Stock search failed for "${query}": ${reason}`);
        skipped.push({ stage: "search", reason: `${query}: ${reason}` });
        continue;
      }
      if (result.notes.length > 0)
        notes.push(...result.notes.map((note) => `${query}: ${note}`));
      if (result.candidates.length === 0) {
        skipped.push({
          stage: "search",
          reason: `No stock result for "${query}".`,
        });
        continue;
      }
      entries.push({
        id: `card-${query
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40)}`,
        query,
        start: moment.start,
        end: moment.end,
        candidates: result.candidates.slice(0, CARD_CANDIDATES_PER_KEYWORD),
        cursor: 0,
        flagged: false,
      });
    }

    // 3b. Download the current candidate of each entry (next one on failure), in parallel.
    const load = async (entry: CardEntry): Promise<boolean> => {
      while (entry.cursor < entry.candidates.length) {
        try {
          const file = await deps.download(entry.candidates[entry.cursor]);
          entry.file = file;
          entry.thumb = await deps.thumbnail(file.bytes);
          return true;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          notes.push(
            `Could not download a "${entry.query}" candidate: ${reason}`,
          );
          entry.cursor += 1;
        }
      }
      return false;
    };
    await Promise.all(entries.map((entry) => load(entry)));
    const loaded = entries.filter((entry) => entry.file && entry.thumb);
    for (const entry of entries) {
      if (!entry.file) {
        skipped.push({
          stage: "download",
          reason: `${entry.query}: no candidate could be downloaded.`,
        });
      }
    }

    // 3c. ONE batched vision request; flagged cards (text / unrelated) get the next
    //     candidate and are re-checked once. Nothing is ever skipped here.
    if (deps.verifyCards && deps.visionAvailable && loaded.length > 0) {
      try {
        for (let round = 0; round < 2; round += 1) {
          const pending = loaded.filter(
            (entry) => round === 0 || entry.flagged,
          );
          if (pending.length === 0) break;
          const verdicts = await deps.verifyCards(
            pending.map((entry) => ({
              id: entry.id,
              keyword: entry.query,
              image: entry.thumb as { data: string; mime: string },
            })),
          );
          const byId = new Map(
            verdicts.map((verdict) => [verdict.id, verdict]),
          );
          for (const entry of pending) {
            const verdict = byId.get(entry.id);
            entry.flagged = verdict
              ? verdict.hasText || !verdict.relevant
              : false;
          }
          if (round === 1) break;
          for (const entry of pending.filter(
            (candidate) => candidate.flagged,
          )) {
            const before = {
              cursor: entry.cursor,
              file: entry.file,
              thumb: entry.thumb,
            };
            entry.cursor += 1;
            if (!(await load(entry))) {
              Object.assign(entry, before); // nothing better: keep the current image
              entry.flagged = false;
            }
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notes.push(
          `Card check failed (${reason}); using the top result for each keyword.`,
        );
      }
    } else if (loaded.length > 0 && !deps.visionAvailable) {
      notes.push(
        "No Gemini key: stock cards were not checked for text or relevance.",
      );
    }

    // 3d. Prepare the final pick of every entry.
    for (const entry of loaded) {
      const file = entry.file;
      if (!file) continue;
      try {
        const preparedImage = {
          ...(await deps.prepareCard(file.bytes, file.cacheKey)),
          sourceFile: file.sourceFile,
        };
        prepared.push({
          id: entry.id,
          kind: "landscape",
          priority: CARD_PRIORITY,
          desiredStart: entry.start,
          desiredEnd: entry.end,
          candidate: entry.candidates[entry.cursor],
          alternatives: entry.candidates
            .filter((_candidate, index) => index !== entry.cursor)
            .slice(0, 2)
            .map((candidate) => attributionFor(candidate)),
          prepared: preparedImage,
          query: entry.query,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({
          stage: "download",
          reason: `${entry.query}: ${reason}`,
        });
      }
    }
  }

  /* --------------------------- 4. scheduling ---------------------------- */

  const byId = new Map(prepared.map((item) => [item.id, item]));
  const candidatesForSchedule: BrollCandidateInput[] = prepared.map((item) => ({
    id: item.id,
    kind: item.kind,
    desiredStart: item.desiredStart,
    desiredEnd: item.desiredEnd,
    priority: item.priority,
  }));

  const scheduled = scheduleBroll({
    clipDuration: input.clipDuration,
    hookDuration: input.hookDuration,
    minCount:
      options.enableLandscape || options.enableFullscreen
        ? budget.targetMin
        : 0,
    maxCount: budget.targetMax,
    candidates: candidatesForSchedule,
  });

  const items: BrollItem[] = [];
  for (const slot of scheduled.items) {
    const source = byId.get(slot.id);
    if (!source) continue;
    const item: BrollItem = {
      id: slot.id,
      kind: slot.kind,
      start: slot.start,
      end: slot.end,
      desiredStart: slot.desiredStart,
      desiredEnd: slot.desiredEnd,
      query: source.query,
      attribution: attributionFor(source.candidate),
      cacheKey: source.prepared.cacheKey,
      renderFile: source.prepared.renderFile,
      ...(source.prepared.sourceFile
        ? { sourceFile: source.prepared.sourceFile }
        : {}),
      ...(source.prepared.crop ? { crop: source.prepared.crop } : {}),
      ...(source.alternatives && source.alternatives.length > 0
        ? { alternatives: source.alternatives }
        : {}),
      ...(source.verification ? { verification: source.verification } : {}),
      ...(source.entityName ? { entityName: source.entityName } : {}),
      ...(source.entityType ? { entityType: source.entityType } : {}),
    };
    if (slot.kind === "landscape") {
      item.card = planCardRect({
        captionBand: input.captionBand,
        faceZones: input.faceZones,
      });
    }
    items.push(item);
  }

  // Anything prepared but not placed is reported, so the UI can explain a low count.
  for (const item of prepared) {
    if (!items.some((placed) => placed.id === item.id)) {
      skipped.push({
        stage: "schedule",
        ...(item.entityName ? { entity: item.entityName } : {}),
        reason: `No free ${slotLength()}s slot for "${item.query}".`,
      });
    }
  }

  for (const note of scheduled.notes) notes.push(note);

  const counts = {
    targetMin: budget.targetMin,
    targetMax: budget.targetMax,
    fullscreen: items.filter((item) => item.kind === "fullscreen").length,
    landscape: items.filter((item) => item.kind === "landscape").length,
  };

  console.log(
    `[broll] Plan: ${counts.fullscreen} full-screen + ${counts.landscape} card(s) ` +
    `(target ${counts.targetMin}-${counts.targetMax}), ${skipped.length} skipped.`,
  );

  for (const skip of skipped) {
    console.log(
      `[broll] skipped (${skip.stage})${skip.entity ? ` "${skip.entity}"` : ""}: ${skip.reason}`,
    );
  }
  for (const note of notes) console.log(`[broll] note: ${note}`);

  return {
    version: 1,
    generatedAt: now().toISOString(),
    trigger: input.trigger,
    clipDuration: input.clipDuration,
    hookDuration: input.hookDuration,
    totalDuration: input.clipDuration + input.hookDuration,
    options,
    items,
    skipped,
    counts,
    notes,
  };
}

/** Short helper used in the "not placed" note; the scheduler uses the same bounds. */
function slotLength(): string {
  return "2.5-4";
}
