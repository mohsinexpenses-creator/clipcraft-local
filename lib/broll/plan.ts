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
import { deriveFallbackKeywords, transcriptSentenceAt, type BrollAnalysis } from "./analysis";
import { planCardRect, type FaceZoneRect } from "./card";
import { brollImageBudget, scheduleBroll, type BrollCandidateInput } from "./scheduler";
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

/** An image that is downloaded, prepared and ready to be painted. */
export interface PreparedBrollImage {
  cacheKey: string;
  /** Original download in the cache dir (file name only). */
  sourceFile: string;
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
  }): Promise<BrollAnalysis>;
  searchEntity(query: string): Promise<BrollCandidate[]>;
  searchStock(query: string): Promise<StockSearchResult>;
  download(candidate: BrollCandidate): Promise<{ cacheKey: string; sourceFile: string; bytes: Buffer }>;
  prepareFullscreen(
    bytes: Buffer,
    entityType: BrollEntityType,
    cacheKey: string
  ): Promise<PreparedBrollImage>;
  prepareCard(bytes: Buffer, cacheKey: string): Promise<PreparedBrollImage>;
  thumbnail(bytes: Buffer): Promise<{ data: string; mime: string }>;
  verify(input: VisionRequestInput): Promise<VisionVerdict>;
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
export const ENTITY_CANDIDATES_PER_SEARCH = 4;

function toVerification(verdict: VisionVerdict, now: Date): BrollVerificationSummary {
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
  deps: BrollPlanDeps
): Promise<BrollPlan> {
  const now = deps.now ?? (() => new Date());
  const options = input.options;
  const notes: string[] = [];
  const skipped: BrollSkip[] = [];
  const budget = brollImageBudget(input.clipDuration, options.minImages, options.maxImages);

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
    });
    console.log(
      `[broll] Analysis: ${analysis.entities.length} entit(ies), ${analysis.broll.length} keyword moment(s).`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`AI analysis failed (${message}); fell back to keywords from the transcript.`);
    skipped.push({ stage: "analysis", reason: message });
    analysis = deriveFallbackKeywords(input.words, input.clipDuration, keywordBudget);
  }

  // A provider that answers with nothing usable still leaves the clip without
  // cards; top the keyword list up from the transcript when it is short.
  if (options.enableLandscape && analysis.broll.length < budget.targetMin) {
    const fallback = deriveFallbackKeywords(
      input.words,
      input.clipDuration,
      budget.targetMax - analysis.broll.length
    );
    const existing = new Set(analysis.broll.map((moment) => moment.visualKeywords[0]?.toLowerCase()));
    const extra = fallback.broll.filter(
      (moment) => !existing.has(moment.visualKeywords[0]?.toLowerCase())
    );
    if (extra.length > 0) {
      analysis = { ...analysis, broll: [...analysis.broll, ...extra] };
      notes.push(`Topped up ${extra.length} keyword moment(s) from the transcript.`);
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
      "No Gemini key is configured, so named entities are skipped: an unverified full-screen image is never shown."
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

  for (const entity of entities) {
    const context = transcriptSentenceAt(input.words, entity.start);
    let candidates: BrollCandidate[];
    try {
      candidates = (await deps.searchEntity(entity.searchQuery)).slice(0, ENTITY_CANDIDATES_PER_SEARCH);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`Wikimedia Commons search failed for "${entity.name}": ${reason}`);
      skipped.push({ stage: "search", entity: entity.name, reason });
      continue;
    }

    if (candidates.length === 0) {
      skipped.push({ stage: "search", entity: entity.name, reason: "No usable image on Wikimedia Commons." });
      continue;
    }

    // Download + thumbnail the candidates for the single vision request.
    const downloaded: Array<{ candidate: BrollCandidate; bytes: Buffer; data: string; mime: string }> = [];
    for (const candidate of candidates.slice(0, VISION_CANDIDATE_COUNT)) {
      try {
        const file = await deps.download(candidate);
        const thumb = await deps.thumbnail(file.bytes);
        downloaded.push({ candidate, bytes: file.bytes, data: thumb.data, mime: thumb.mime });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notes.push(`Could not download a "${entity.name}" candidate: ${reason}`);
      }
    }

    if (downloaded.length === 0) {
      skipped.push({ stage: "download", entity: entity.name, reason: "No candidate could be downloaded." });
      continue;
    }

    let verdict: VisionVerdict;
    try {
      verdict = await deps.verify({
        entityName: entity.name,
        entityType: entity.type,
        context,
        commonsTitle: downloaded[0].candidate.title,
        commonsDescription: downloaded[0].candidate.description,
        commonsCategories: downloaded[0].candidate.categories,
        images: downloaded.map((item, index) => ({ index, data: item.data, mime: item.mime })),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`Gemini Vision failed for "${entity.name}": ${reason}`);
      skipped.push({ stage: "verify", entity: entity.name, reason });
      continue;
    }

    console.log(
      `[broll] Vision "${entity.name}": pick=${verdict.pickIndex} confidence=${verdict.confidence.toFixed(2)} ` +
        `text=${verdict.hasTextOrWatermark} safe=${verdict.isSafe} - ${verdict.reason}`
    );

    if (!verdictAccepts(verdict) || verdict.pickIndex === null) {
      skipped.push({
        stage: "verify",
        entity: entity.name,
        reason: verdictRejectionReason(verdict),
      });
      continue;
    }

    const chosen = downloaded[verdict.pickIndex];
    if (!chosen) {
      skipped.push({ stage: "verify", entity: entity.name, reason: "The verified candidate was not downloaded." });
      continue;
    }

    try {
      const file = await deps.download(chosen.candidate);
      const preparedImage = {
        ...(await deps.prepareFullscreen(file.bytes, entity.type, file.cacheKey)),
        sourceFile: file.sourceFile,
      };
      prepared.push({
        id: `entity-${entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        kind: "fullscreen",
        priority: ENTITY_PRIORITY,
        desiredStart: entity.start,
        desiredEnd: entity.end,
        candidate: chosen.candidate,
        alternatives: downloaded
          .filter((_entry, index) => index !== verdict.pickIndex)
          .map((entry) => attributionFor(entry.candidate)),
        prepared: preparedImage,
        verification: toVerification(verdict, now()),
        entityName: entity.name,
        entityType: entity.type,
        query: entity.searchQuery,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ stage: "download", entity: entity.name, reason });
    }
  }

  /* --------------------------- 3. landscapes ---------------------------- */

  if (keywordBudget > 0) {
    const moments = analysis.broll.slice(0, budget.targetMax + 2);
    const usedQueries = new Set<string>();
    for (const moment of moments) {
      const query = moment.visualKeywords.join(" ").trim();
      if (!query || usedQueries.has(query.toLowerCase())) continue;
      usedQueries.add(query.toLowerCase());

      let result: StockSearchResult;
      try {
        result = await deps.searchStock(query);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notes.push(`Stock search failed for "${query}": ${reason}`);
        skipped.push({ stage: "search", reason: `${query}: ${reason}` });
        continue;
      }
      if (result.notes.length > 0) notes.push(...result.notes.map((note) => `${query}: ${note}`));

      const candidate = result.candidates[0];
      if (!candidate) {
        skipped.push({ stage: "search", reason: `No stock result for "${query}".` });
        continue;
      }

      try {
        const file = await deps.download(candidate);
        const preparedImage = {
          ...(await deps.prepareCard(file.bytes, file.cacheKey)),
          sourceFile: file.sourceFile,
        };
        prepared.push({
          id: `card-${query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
          kind: "landscape",
          priority: CARD_PRIORITY,
          desiredStart: moment.start,
          desiredEnd: moment.end,
          candidate,
          // The other search hits let the clip tile swap the card without a new
          // provider search; they are downloaded on demand.
          alternatives: result.candidates.slice(1, 3).map((entry) => attributionFor(entry)),
          prepared: preparedImage,
          query,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ stage: "download", reason: `${query}: ${reason}` });
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
    minCount: options.enableLandscape || options.enableFullscreen ? budget.targetMin : 0,
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
      ...(source.prepared.sourceFile ? { sourceFile: source.prepared.sourceFile } : {}),
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
      `(target ${counts.targetMin}-${counts.targetMax}), ${skipped.length} skipped.`
  );

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
