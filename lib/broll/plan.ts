/**
 * Build one clip's B-roll plan.
 *
 * This is the orchestration layer: analysis -> Wikipedia/stock search -> download ->
 * preparation -> scheduling. Every side effect is injected as a small function,
 * so the whole flow is unit-tested offline.
 *
 * Order matters and follows the brief:
 *   1. named entities use their Wikipedia article image (a stock lookalike would
 *      be a different person/place, so it is never substituted);
 *   2. keyword moments are filled from stock providers, with the configured
 *      provider order and quota fall-through;
 *   3. the scheduler places what survived on the render timeline.
 *
 * The renderer only ever reads the resulting plan.
 */

import { RenderCancelledError } from "../errors";
import type {
  BrollEntityType,
  BrollItem,
  BrollOptions,
  BrollPlan,
  BrollSkip,
  WordTimestamp,
} from "../types";
import {
  deriveFallbackKeywords,
  type BrollAnalysis,
} from "./analysis";
import { planCardRect, type FaceZoneRect } from "./card";
import {
  brollImageBudget,
  scheduleBroll,
  type BrollCandidateInput,
} from "./scheduler";
import type { BrollCandidate } from "./providers/types";
import {
  attributionFor,
  candidateChoiceScore,
  isUsableCardImage,
  looksTextHeavy,
} from "./providers/types";
import { frameDeltaMs } from "./sync";
import type { StockSearchResult } from "./providers/stock";
import {
  getBrollImagePreparationConcurrency,
  mapWithConcurrency,
} from "./preparation";
import { log } from "../logger";

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

export interface BrollPlanDeps {
  analyze(input: {
    clipDuration: number;
    words: WordTimestamp[];
    entityBudget: number;
    keywordBudget: number;
    keywordMin: number;
  }): Promise<BrollAnalysis>;
  findEntityImage(title: string): Promise<BrollCandidate | null>;
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
  /** Output frame rate, so an anchor start lands on the frame grid (Phase 4a). */
  fps?: number;
  /** Worker-owned cancellation signal for CPU/network planning stages. */
  signal?: AbortSignal;
}

/** Full-screen images are worth more than a stock card (used for slot priority). */
export const ENTITY_PRIORITY = 100;
export const CARD_PRIORITY = 50;
/** Cards whose relevance is below this are not illustrated at all (Phase 4c). */
export const MIN_CARD_RELEVANCE = 3;
/** Limit named-entity images per clip. */
export const MAX_ENTITIES_PER_CLIP = 4;
/** Stock candidates kept per keyword (the first is used, the rest are replacements). */
export const CARD_CANDIDATES_PER_KEYWORD = 3;

/**
 * Build the plan. Provider failures skip only the affected item; the rest of the
 * clip still gets its B-roll.
 */
export async function buildBrollPlan(
  input: BrollPlanInput,
  deps: BrollPlanDeps,
): Promise<BrollPlan> {
  const throwIfCancelled = (): void => {
    if (input.signal?.aborted) throw new RenderCancelledError();
  };
  throwIfCancelled();
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
  let analysisFailed = false;
  const analyzeOnce = () =>
    deps.analyze({
      clipDuration: input.clipDuration,
      words: input.words,
      entityBudget,
      keywordBudget,
      keywordMin: keywordBudget > 0 ? budget.targetMin : 0,
    });
  try {
    analysis = await analyzeOnce();
    log.tagged(
      `[broll] Analysis: ${analysis.entities.length} entit(ies), ${analysis.broll.length} keyword moment(s).`,
    );
  } catch (error) {
    if (error instanceof RenderCancelledError || input.signal?.aborted) throw new RenderCancelledError();
    const message = error instanceof Error ? error.message : String(error);
    // Phase 4d: ONE retry on the next model in the chain. `completeWithFallback`
    // walks the chain per request, but a parse failure or a truncated JSON answer
    // can still be model-specific, and a second try is far cheaper than a clip
    // with no B-roll.
    let retried: BrollAnalysis | null = null;
    try {
      log.tagged(`[broll] Analysis failed (${message}); retrying once on the next model.`);
      retried = await analyzeOnce();
    } catch (retryError) {
      if (retryError instanceof RenderCancelledError || input.signal?.aborted) {
        throw new RenderCancelledError();
      }
    }
    if (retried) {
      analysis = retried;
      notes.push(`AI analysis needed a retry (${message}).`);
      log.tagged(
        `[broll] Analysis (retry): ${retried.entities.length} entit(ies), ${retried.broll.length} keyword moment(s).`,
      );
    } else {
      analysisFailed = true;
      notes.push(
        `AI analysis failed twice (${message}); using concrete transcript nouns only.`,
      );
      skipped.push({ stage: "analysis", reason: message });
      analysis = deriveFallbackKeywords(
        input.words,
        input.clipDuration,
        keywordBudget,
      );
    }
  }

  if (analysisFailed && analysis.broll.length === 0) {
    log.tagged(
      `[broll] no relevant cards (analysis unavailable): ${
        input.words.length === 0 ? "no transcript words" : "no concrete noun in the clip"
      }.`,
    );
  }

  // A provider that answers with nothing usable still leaves the clip without
  // cards; top the keyword list up from the transcript when it is short.
  if (options.enableLandscape && analysis.broll.length < budget.targetMin) {
    const fallback = deriveFallbackKeywords(
      input.words,
      input.clipDuration,
      budget.targetMax - analysis.broll.length,
      { minSpacingSeconds: 10 },
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
    entityName?: string;
    entityType?: BrollEntityType;
    query: string;
    /** The transcript words this picture illustrates (Phase 4a). */
    anchorText: string;
    wordIndex?: number;
    wordStart: number;
    relevance: number;
    /** The model's own start, kept only for the delta_ms log line. */
    modelStart: number;
  }> = [];

  const seenEntities = new Set<string>();
  const entities = analysis.entities
    .filter((entity) => {
      const key = entity.name.toLowerCase();
      if (seenEntities.has(key)) return false;
      seenEntities.add(key);
      return true;
    })
    .slice(0, entityBudget);

  const resolveEntity = async (
    entity: (typeof entities)[number],
  ): Promise<{ item?: (typeof prepared)[number]; skip?: BrollSkip }> => {
    throwIfCancelled();
    const query = entity.wikipediaTitle ?? entity.name;
    let candidate: BrollCandidate | null;
    try {
      candidate = await deps.findEntityImage(query);
    } catch (error) {
      return {
        skip: {
          stage: "search",
          entity: entity.name,
          reason: `Wikipedia image lookup failed: ${describe(error)}`.slice(0, 600),
        },
      };
    }
    if (!candidate) {
      return { skip: { stage: "search", entity: entity.name, reason: "No usable Wikipedia image." } };
    }

    let file: Awaited<ReturnType<BrollPlanDeps["download"]>>;
    try {
      file = await deps.download(candidate);
    } catch (error) {
      return {
        skip: {
          stage: "download",
          entity: entity.name,
          reason: `Could not download the Wikipedia image: ${describe(error)}`.slice(0, 600),
        },
      };
    }
    try {
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
          candidate,
          prepared: preparedImage,
          entityName: entity.name,
          entityType: entity.type,
          query,
          anchorText: entity.anchorText ?? entity.name,
          ...(typeof entity.wordIndex === "number" ? { wordIndex: entity.wordIndex } : {}),
          wordStart: entity.start,
          relevance: entity.relevance ?? 5,
          modelStart: entity.start,
        },
      };
    } catch (error) {
      return {
        skip: {
          stage: "download",
          entity: entity.name,
          reason: `Could not prepare the Wikipedia image: ${describe(error)}`.slice(0, 600),
        },
      };
    }
  };

  // All entities in parallel (the limiters in broll-sources.ts keep the APIs polite).
  const entityResults = await Promise.all(entities.map(resolveEntity));
  throwIfCancelled();
  for (const result of entityResults) {
    if (result.item) prepared.push(result.item);
    if (result.skip) skipped.push(result.skip);
  }

  /* --------------------------- 3. landscapes ---------------------------- */

  if (keywordBudget > 0) {
    // Relevance is a HARD bar: 1-2 is filler ("a phone", "some people") and a
    // picture for it is worse than no picture. Phase 4c.
    const moments = analysis.broll
      .filter(
        (moment) =>
          moment.synthetic === true || (moment.relevance ?? 3) >= MIN_CARD_RELEVANCE,
      )
      .slice(0, budget.targetMax + 2);
    const usedQueries = new Set<string>();

    interface CardEntry {
      id: string;
      query: string;
      start: number;
      end: number;
      anchorText: string;
      wordIndex?: number;
      relevance: number;
      candidates: BrollCandidate[];
      cursor: number;
      file?: { cacheKey: string; sourceFile: string; bytes: Buffer };
    }
    const entries: CardEntry[] = [];

    // 3a. Search every keyword (cached), and choose WHICH returned photo to
    // show by token overlap with the keyword rather than by provider ranking.
    for (const moment of moments) {
      throwIfCancelled();
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

      const scored = result.candidates
        .filter((candidate) => isUsableCardImage(candidate) && !looksTextHeavy(candidate))
        .map((candidate) => ({
          candidate,
          ...candidateChoiceScore(candidate, query),
        }))
        .sort((a, b) => b.score - a.score);

      // No photo shares a single meaningful word with the keyword: the card
      // would be a lie, so this moment is skipped rather than illustrated.
      if (scored.length === 0 || scored[0].overlap === 0) {
        skipped.push({
          stage: "search",
          reason: `No image relevant enough for "${query}" (best overlap ${
            scored.length > 0 ? Math.round(scored[0].overlap * 100) : 0
          }%).`,
        });
        continue;
      }

      const chosen = scored.slice(0, CARD_CANDIDATES_PER_KEYWORD).map((entry) => entry.candidate);
      entries.push({
        id: `card-${query
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40)}`,
        query,
        start: moment.start,
        end: moment.end,
        anchorText: moment.anchorText ?? moment.visualKeywords[0] ?? query,
        ...(typeof moment.wordIndex === "number" ? { wordIndex: moment.wordIndex } : {}),
        relevance: moment.relevance ?? 3,
        candidates: chosen,
        cursor: 0,
      });
    }

    // 3b. Download the current candidate of each entry (next one on failure), in
    // parallel. An image may only be used ONCE per clip, so a duplicate source
    // falls through to that entry's next candidate.
    const usedUrls = new Set<string>();
    const load = async (entry: CardEntry): Promise<boolean> => {
      while (entry.cursor < entry.candidates.length) {
        throwIfCancelled();
        const candidate = entry.candidates[entry.cursor];
        if (usedUrls.has(candidate.imageUrl)) {
          entry.cursor += 1;
          continue;
        }
        try {
          const file = await deps.download(candidate);
          entry.file = file;
          usedUrls.add(candidate.imageUrl);
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
    throwIfCancelled();
    const loaded = entries.filter((entry) => entry.file);
    for (const entry of entries) {
      if (!entry.file) {
        skipped.push({
          stage: "download",
          reason: `${entry.query}: no candidate could be downloaded.`,
        });
      }
    }

    // 3c. Prepare final cards with bounded Jimp concurrency. Downloading is
    // already parallel above, but serial decode/crop/JPEG encoding left a large
    // gap on a 10–15-image plan. Keep result order deterministic for scheduling
    // and share duplicate cache-key work so concurrent writes never collide.
    const imagePrepConcurrency = getBrollImagePreparationConcurrency();
    const preparedByCacheKey = new Map<string, Promise<PreparedBrollImage>>();
    log.tagged(
      `[broll] Preparing ${loaded.length} card image(s) with concurrency ${imagePrepConcurrency}.`,
    );
    const preparationResults = await mapWithConcurrency(
      loaded,
      imagePrepConcurrency,
      async (entry) => {
        throwIfCancelled();
        const file = entry.file;
        if (!file) return { entry, skip: undefined };
        try {
          let preparation = preparedByCacheKey.get(file.cacheKey);
          if (!preparation) {
            preparation = deps.prepareCard(file.bytes, file.cacheKey);
            preparedByCacheKey.set(file.cacheKey, preparation);
          }
          const preparedImage = {
            ...(await preparation),
            sourceFile: file.sourceFile,
          };
          throwIfCancelled();
          return {
            entry,
            item: {
              id: entry.id,
              kind: "landscape" as const,
              priority: CARD_PRIORITY + (entry.relevance - 3) * 5,
              desiredStart: entry.start,
              desiredEnd: entry.end,
              candidate: entry.candidates[entry.cursor],
              alternatives: entry.candidates
                .filter((_candidate, index) => index !== entry.cursor)
                .slice(0, 2)
                .map((candidate) => attributionFor(candidate)),
              prepared: preparedImage,
              query: entry.query,
              anchorText: entry.anchorText,
              ...(typeof entry.wordIndex === "number" ? { wordIndex: entry.wordIndex } : {}),
              wordStart: entry.start,
              relevance: entry.relevance,
              modelStart: entry.start,
            },
          };
        } catch (error) {
          if (error instanceof RenderCancelledError || input.signal?.aborted) {
            throw new RenderCancelledError();
          }
          const reason = error instanceof Error ? error.message : String(error);
          return {
            entry,
            skip: {
              stage: "download" as const,
              reason: `${entry.query}: ${reason}`,
            },
          };
        }
      },
      input.signal,
    );
    for (const result of preparationResults) {
      if (result.item) prepared.push(result.item);
      if (result.skip) skipped.push(result.skip);
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
    relevance: item.relevance,
  }));

  const scheduled = scheduleBroll({
    clipDuration: input.clipDuration,
    hookDuration: input.hookDuration,
    minCount:
      options.enableLandscape || options.enableFullscreen
        ? budget.targetMin
        : 0,
    maxCount: budget.targetMax,
    fps: input.fps,
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
      ...(source.entityName ? { entityName: source.entityName } : {}),
      ...(source.entityType ? { entityType: source.entityType } : {}),
      anchorText: source.anchorText,
      ...(typeof source.wordIndex === "number" ? { wordIndex: source.wordIndex } : {}),
      wordStart: source.wordStart,
      relevance: source.relevance,
      syncAction: slot.action,
    };
    if (slot.kind === "landscape") {
      item.card = planCardRect({
        captionBand: input.captionBand,
        faceZones: input.faceZones,
      });
    }
    items.push(item);
  }

  // Anything prepared but not placed is reported, so the UI can explain a low
  // count. The scheduler already logged the ones IT refused; this only covers a
  // plan that dropped an item for another reason.
  for (const item of prepared) {
    if (scheduled.droppedIds.has(item.id)) continue;
    if (!items.some((placed) => placed.id === item.id)) {
      skipped.push({
        stage: "schedule",
        ...(item.entityName ? { entity: item.entityName } : {}),
        reason: `No exact-start slot for "${item.query}" (another picture owns its anchor frame).`,
      });
    }
  }

  for (const note of scheduled.notes) notes.push(note);

  /* ------------------------- 5. exact-sync log -------------------------- */

  // One line per placed card, machine-readable: the render's picture #id starts
  // on `anchorText` (#wordIndex, wordStart) and is drawn at finalStart. A large
  // |delta_ms| means the model's own timing was wrong and the anchor saved it.
  if (syncLogEnabled()) {
    for (const item of items) {
      const source = byId.get(item.id);
      log.tagged(
        `[BROLL-SYNC] id=${item.id} keyword="${item.query}" anchorText="${
          item.anchorText ?? ""
        }" wordIndex=${item.wordIndex ?? "-"} wordStart=${
          item.wordStart !== undefined ? item.wordStart.toFixed(3) : "-"
        } finalStart=${item.start.toFixed(3)} delta_ms=${frameDeltaMs(
          source?.modelStart ?? item.start,
          item.start,
        )} action=${item.syncAction ?? "exact"} relevance=${item.relevance ?? "-"}`,
      );
    }
    const startedExactly = items.filter((item) => (item.syncAction ?? "exact") === "exact").length;
    const maxDelta = items.reduce(
      (worst, item) =>
        Math.max(
          worst,
          Math.abs(
            frameDeltaMs(
              (byId.get(item.id)?.modelStart ?? item.start) + input.hookDuration,
              item.start,
            ),
          ),
        ),
      0,
    );
    log.tagged(
      `[BROLL-SYNC] summary cards=${items.length} exact=${startedExactly} truncated=${
        items.length - startedExactly
      } dropped=${prepared.length - items.length} max_delta_ms=${maxDelta} target=${
        budget.targetMin
      }-${budget.targetMax} below_min=${scheduled.belowMinimum}`,
    );
  }

  const counts = {
    targetMin: budget.targetMin,
    targetMax: budget.targetMax,
    fullscreen: items.filter((item) => item.kind === "fullscreen").length,
    landscape: items.filter((item) => item.kind === "landscape").length,
  };

  log.tagged(
    `[broll] Plan: ${counts.fullscreen} full-screen + ${counts.landscape} card(s) ` +
    `(target ${counts.targetMin}-${counts.targetMax}), ${skipped.length} skipped.`,
  );

  for (const skip of skipped) {
    log.tagged(
      `[broll] skipped (${skip.stage})${skip.entity ? ` "${skip.entity}"` : ""}: ${skip.reason}`,
    );
  }
  for (const note of notes) log.tagged(`[broll] note: ${note}`);

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

/** `BROLL_SYNC_LOG=0` silences the per-card lines (the summary stays useful). */
function syncLogEnabled(): boolean {
  const raw = process.env.BROLL_SYNC_LOG;
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}
