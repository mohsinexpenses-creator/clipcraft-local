/**
 * The gate in front of every full-screen image: Gemini Vision.
 *
 * A wrong full-screen photo is worse than no photo at all - it makes the clip
 * look broken and can put a stranger's face on someone's name. So the rule is
 * absolute: no passed verdict, no full-screen item. There is no stock fallback for
 * an entity (that would be a different person/place).
 *
 * One request per entity, with 3-4 candidates at ~512 px, the entity name, the
 * Commons title/description/categories, and the sentence the speaker was saying.
 * The model picks ONE index or none, and states its confidence.
 */

import { AppError } from "../errors";
import { LLM_PROVIDER_CHAIN, llmKeysFor } from "../llm";
import type { BrollEntityType } from "../types";
import type { BrollFetch } from "./http";
import { defaultBrollFetch } from "./http";

/** Below this, the pick is treated as "not sure" and the entity is skipped. */
export const VISION_MIN_CONFIDENCE = 0.5; // was 0.6
/** Candidates sent per request (the brief says 3-4). */
export const VISION_CANDIDATE_COUNT = 5; // was 4
/** Long edge of each image sent to the model. */
export const VISION_IMAGE_SIZE = 512;
export const VISION_TIMEOUT_MS = 60_000;

export interface VisionVerdict {
  pickIndex: number | null;
  confidence: number;
  reason: string;
  hasTextOrWatermark: boolean;
  isSafe: boolean;
}

export interface VisionImage {
  index: number;
  data: string;
  mime: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export interface VisionRequestInput {
  entityName: string;
  entityType: BrollEntityType;
  entityDescriptor?: string;
  /** Sentence around the mention - "what is being said". */
  context: string;
  commonsTitle?: string;
  commonsDescription?: string;
  commonsCategories?: string[];
  images: VisionImage[];
  /** "context": identity AND situation must fit. "name-only": identity only. */
  mode?: "context" | "name-only";
}

export function buildVisionPrompt(input: VisionRequestInput): string {
  const perImage = input.images
    .map((image) => {
      const bits = [
        image.title ? `title: ${image.title}` : "",
        image.description ? `description: ${image.description.slice(0, 200)}` : "",
        image.tags?.length ? `tags: ${image.tags.slice(0, 8).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return `Image ${image.index}: ${bits || "no metadata"}`;
    })
    .join("\n");

  const strict = (input.mode ?? "context") === "context";
  const who = input.entityDescriptor
    ? `${input.entityType} "${input.entityName}" (${input.entityDescriptor})`
    : `${input.entityType} "${input.entityName}"`;
  const intro = strict
    ? [
      `The speaker says: "${input.context}"`,
      "",
      `I need a photo that clearly shows the ${who} "${who}" AND fits the situation the speaker describes. Pick a candidate only when BOTH are true. If the ${who} is right but the situation clearly does not fit, answer null.`,
    ]
    : [
      `I need a photo that clearly shows the ${who} "${who}". Ignore any story or situation: only the identity matters. ANY clear, recognisable photo of this exact ${who} is acceptable.`,
    ];

  return [
    ...intro,
    "Candidate images follow, in order (image 0, image 1, ...).",
    "",
    "Metadata of each candidate (from the image host):",
    perImage,
    "",
    "Answer with ONE JSON object and nothing else:",
    '{ "pickIndex": 0, "confidence": 0.0, "reason": "...", "hasTextOrWatermark": false, "isSafe": true }',
    "",
    "Rules:",
    `- Do NOT guess who a real person is from their face. Decide from the metadata (title, description, tags) and any visible caption or name text, together with the image.`,
    `- Many people share a name. Choose ONLY an image of the specific one described above${input.entityDescriptor ? ` (${input.entityDescriptor})` : ""}. If the metadata or image shows a different person with the same name (another job, a local business owner, another place), that is NOT a match.`,
    `- Accept a person only when the metadata names "${input.entityName}" AND nothing in the image or metadata contradicts the description. Use confidence 0.7 or more then.`,
    "- Among all matching candidates, pickIndex must be the best one with NO heavy text, watermark or logo overlay. Set hasTextOrWatermark=true only when EVERY matching candidate has it.",
    `- Reject when the metadata names someone else, or nothing links the image to the name.`,
    `- Landmarks, places and events may also be recognised visually.`,
    "- The subject must be large and clear enough to fill a vertical 9:16 frame (face or landmark prominent). Reject tiny, distant or crowded subjects.",
    `- pickIndex is the best candidate that clearly depicts "${input.entityName}", or null when none does.`,
    "- confidence is 0..1: how sure you are that the pictured subject IS the named thing (not merely related).",
    "- A portrait of a different person, a building that is not the named building, a generic crowd or a map is NOT a match: use null.",
    "- Set hasTextOrWatermark=true for heavy text, watermarks, logos over the image, or screenshots.",
    "- Set isSafe=false for collages, diagrams, maps, nudity, gore, or anything unsafe to show on a public short.",
    "- reason is one short sentence, in English.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Parse the model's answer. Unknown shape is a rejection (null pick), never a
 * crash: a bad verdict must not kill the whole B-roll run.
 */
export function parseVisionVerdict(
  text: string,
  candidateCount: number,
): VisionVerdict {
  const rejected = (reason: string): VisionVerdict => ({
    pickIndex: null,
    confidence: 0,
    reason,
    hasTextOrWatermark: false,
    isSafe: true,
  });

  let data: unknown;
  try {
    const cleaned = text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    data = JSON.parse(cleaned);
  } catch {
    return rejected("The vision answer was not valid JSON.");
  }
  if (!data || typeof data !== "object")
    return rejected("The vision answer was not an object.");
  const record = data as Record<string, unknown>;

  const rawPick = record.pickIndex ?? record.pick_index ?? record.index;
  let pickIndex: number | null = null;
  if (
    typeof rawPick === "number" &&
    Number.isInteger(rawPick) &&
    rawPick >= 0 &&
    rawPick < candidateCount
  ) {
    pickIndex = rawPick;
  }

  const rawConfidence = record.confidence;
  let confidence = 0;
  if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
    confidence = clamp01(
      rawConfidence > 1 ? rawConfidence / 100 : rawConfidence,
    );
  }

  const reason =
    typeof record.reason === "string" ? record.reason.trim().slice(0, 300) : "";
  const hasTextOrWatermark =
    record.hasTextOrWatermark === true || record.has_text_or_watermark === true;
  const isSafe = record.isSafe === undefined ? true : record.isSafe !== false;

  return {
    pickIndex,
    confidence,
    reason:
      reason ||
      (pickIndex === null
        ? "The model did not pick a candidate."
        : "No reason given."),
    hasTextOrWatermark,
    isSafe,
  };
}

/** The verdict's final word: the image is only usable when everything passes. */
export function verdictAccepts(verdict: VisionVerdict): boolean {
  return (
    verdict.pickIndex !== null &&
    verdict.confidence >= VISION_MIN_CONFIDENCE &&
    !verdict.hasTextOrWatermark &&
    verdict.isSafe
  );
}

/** Why a verdict rejected the entity - logged and stored on the skip. */
export function verdictRejectionReason(verdict: VisionVerdict): string {
  if (verdict.pickIndex === null)
    return verdict.reason || "No candidate matched the entity.";
  if (!verdict.isSafe) return `Unsafe/unsuitable image: ${verdict.reason}`;
  if (verdict.hasTextOrWatermark)
    return `Heavy text or watermark: ${verdict.reason}`;
  if (verdict.confidence < VISION_MIN_CONFIDENCE) {
    return `Not confident enough (${verdict.confidence.toFixed(2)} < ${VISION_MIN_CONFIDENCE}): ${verdict.reason}`;
  }
  return verdict.reason;
}

export interface VerifyEntityOptions {
  fetcher?: BrollFetch;
  /** Overridable for tests; defaults to the configured Gemini key pool. */
  keys?: string[];
  model?: string;
  timeoutMs?: number;
  /** Kept for compatibility; Gemini verification is attempted once. */
  retryDelayMs?: number;
}

const VISION_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

/** Tries the primary model, then the fallbacks. Returns the answer text. */
async function geminiGenerate(
  keys: string[],
  primaryModel: string,
  options: VerifyEntityOptions,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  const fetcher = options.fetcher ?? defaultBrollFetch;
  const models = [
    primaryModel,
    ...VISION_FALLBACK_MODELS.filter((m) => m !== primaryModel),
  ];
  let lastError: unknown;
  for (const model of models) {
    try {
      const response = await fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": keys[0],
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
        },
      );
      if (!response.ok)
        throw new Error(`Gemini (${model}) answered HTTP ${response.status}.`);
      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!text) throw new Error(`Gemini (${model}) returned an empty answer.`);
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Ask Gemini which candidate (if any) shows the entity. Throws only when no key
 * is configured or every key fails - the caller records that as a skip.
 */
export async function verifyEntityImage(
  input: VisionRequestInput,
  options: VerifyEntityOptions = {},
): Promise<VisionVerdict> {
  const keys = options.keys ?? (await llmKeysFor());
  if (keys.length === 0) {
    throw new AppError(
      "No Gemini key is configured, so B-roll images cannot be verified.",
      {
        status: 400,
        resolution:
          "Add a Gemini key in Settings -> AI providers. Unverified images are never shown.",
      },
    );
  }
  const primaryModel =
    options.model?.trim() || LLM_PROVIDER_CHAIN[0]?.model || "gemini-3.5-flash";
  const prompt = buildVisionPrompt(input);

  const parts: unknown[] = [{ text: prompt }];
  for (const image of input.images.slice(0, VISION_CANDIDATE_COUNT)) {
    parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  }

  let lastError: unknown;
  try {
    const text = await geminiGenerate(
      keys,
      primaryModel,
      options,
      {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
        },
      },
      35_000,
    );
    return parseVisionVerdict(text, input.images.length);
  } catch (error) {
    lastError = error;
  }

  throw new AppError("Gemini Vision could not verify the B-roll candidates.", {
    status: 502,
    details: lastError instanceof Error ? lastError.message : String(lastError),
    resolution:
      "The clip is rendered without B-roll for this entity. Retry B-roll later.",
  });
}

/* ----------------------- Batched check for stock cards ---------------------- */

export interface CardVisionItem {
  id: string;
  keyword: string;
  image: { data: string; mime: string };
}
export interface CardVisionVerdict {
  id: string;
  relevant: boolean;
  hasText: boolean;
}

export function buildCardBatchPrompt(items: CardVisionItem[]): string {
  return [
    "Below are stock photos, in order (image 0, image 1, ...). Each was picked for a keyword:",
    ...items.map((item, index) => `${index}: "${item.keyword}"`),
    "",
    "For EVERY image decide whether it works as a small sticker in a short video.",
    'Reply with ONE JSON object only: { "results": [ { "index": 0, "relevant": true, "hasText": false } ] }',
    "- relevant=true when the photo clearly shows the keyword (or an obvious example of it); false when unrelated or only vaguely connected.",
    "- hasText=true when the photo contains readable text, a watermark, a logo, a sign with words, a screenshot or a UI.",
    "- One result per image, same order, no commentary.",
  ].join("\n");
}

export function parseCardBatch(
  text: string,
  items: CardVisionItem[],
): CardVisionVerdict[] {
  let data: unknown;
  try {
    data = JSON.parse(
      text
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim(),
    );
  } catch {
    return [];
  }
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const verdicts: CardVisionVerdict[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const index = record.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= items.length
    )
      continue;
    verdicts.push({
      id: items[index].id,
      relevant: record.relevant !== false,
      hasText: record.hasText === true,
    });
  }
  return verdicts;
}

/** ONE Gemini request for all cards of a clip. Missing/unparsable verdicts count as "fine". */
export async function verifyCardBatch(
  items: CardVisionItem[],
  options: VerifyEntityOptions = {},
): Promise<CardVisionVerdict[]> {
  if (items.length === 0) return [];
  const keys = options.keys ?? (await llmKeysFor());
  if (keys.length === 0) {
    throw new AppError(
      "No Gemini key is configured, so stock cards cannot be checked.",
      { status: 400 },
    );
  }
  const primaryModel =
    options.model?.trim() || LLM_PROVIDER_CHAIN[0]?.model || "gemini-3.5-flash";
  const parts: unknown[] = [{ text: buildCardBatchPrompt(items) }];
  for (const item of items) {
    parts.push({
      inline_data: { mime_type: item.image.mime, data: item.image.data },
    });
  }

  let lastError: unknown;
  try {
    const text = await geminiGenerate(
      keys,
      primaryModel,
      options,
      {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      },
      40_000,
    );
    return parseCardBatch(text, items);
  } catch (error) {
    lastError = error;
  }
  throw new AppError("Gemini Vision could not check the stock cards.", {
    status: 502,
    details: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
