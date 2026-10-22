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
export const VISION_MIN_CONFIDENCE = 0.6;
/** Candidates sent per request (the brief says 3-4). */
export const VISION_CANDIDATE_COUNT = 4;
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
  /** base64 (no data: prefix). */
  data: string;
  mime: string;
}

export interface VisionRequestInput {
  entityName: string;
  entityType: BrollEntityType;
  /** Sentence around the mention - "what is being said". */
  context: string;
  commonsTitle?: string;
  commonsDescription?: string;
  commonsCategories?: string[];
  images: VisionImage[];
}

export function buildVisionPrompt(input: VisionRequestInput): string {
  const meta = [
    input.commonsTitle ? `File title: ${input.commonsTitle}` : "",
    input.commonsDescription ? `File description: ${input.commonsDescription.slice(0, 400)}` : "",
    input.commonsCategories?.length ? `Categories: ${input.commonsCategories.slice(0, 8).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `The speaker says: "${input.context}"`,
    "",
    `I need a photo that clearly shows the ${input.entityType} "${input.entityName}" - recognisable and unambiguous.`,
    "Candidate images follow, in order (image 0, image 1, ...).",
    meta ? `\nWhat Wikimedia Commons says about the first candidate:\n${meta}` : "",
    "",
    "Answer with ONE JSON object and nothing else:",
    '{ "pickIndex": 0, "confidence": 0.0, "reason": "...", "hasTextOrWatermark": false, "isSafe": true }',
    "",
    "Rules:",
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
export function parseVisionVerdict(text: string, candidateCount: number): VisionVerdict {
  const rejected = (reason: string): VisionVerdict => ({
    pickIndex: null,
    confidence: 0,
    reason,
    hasTextOrWatermark: false,
    isSafe: true,
  });

  let data: unknown;
  try {
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    data = JSON.parse(cleaned);
  } catch {
    return rejected("The vision answer was not valid JSON.");
  }
  if (!data || typeof data !== "object") return rejected("The vision answer was not an object.");
  const record = data as Record<string, unknown>;

  const rawPick = record.pickIndex ?? record.pick_index ?? record.index;
  let pickIndex: number | null = null;
  if (typeof rawPick === "number" && Number.isInteger(rawPick) && rawPick >= 0 && rawPick < candidateCount) {
    pickIndex = rawPick;
  }

  const rawConfidence = record.confidence;
  let confidence = 0;
  if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
    confidence = clamp01(rawConfidence > 1 ? rawConfidence / 100 : rawConfidence);
  }

  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 300) : "";
  const hasTextOrWatermark =
    record.hasTextOrWatermark === true || record.has_text_or_watermark === true;
  const isSafe = record.isSafe === undefined ? true : record.isSafe !== false;

  return {
    pickIndex,
    confidence,
    reason: reason || (pickIndex === null ? "The model did not pick a candidate." : "No reason given."),
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
  if (verdict.pickIndex === null) return verdict.reason || "No candidate matched the entity.";
  if (!verdict.isSafe) return `Unsafe/unsuitable image: ${verdict.reason}`;
  if (verdict.hasTextOrWatermark) return `Heavy text or watermark: ${verdict.reason}`;
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
}

/**
 * Ask Gemini which candidate (if any) shows the entity. Throws only when no key
 * is configured or every key fails - the caller records that as a skip.
 */
export async function verifyEntityImage(
  input: VisionRequestInput,
  options: VerifyEntityOptions = {}
): Promise<VisionVerdict> {
  const keys = options.keys ?? (await llmKeysFor());
  if (keys.length === 0) {
    throw new AppError("No Gemini key is configured, so B-roll images cannot be verified.", {
      status: 400,
      resolution: "Add a Gemini key in Settings -> AI providers. Unverified images are never shown.",
    });
  }
  const model = options.model?.trim() || LLM_PROVIDER_CHAIN[0]?.model || "gemini-3.5-flash";
  const fetcher = options.fetcher ?? defaultBrollFetch;
  const prompt = buildVisionPrompt(input);

  const parts: unknown[] = [{ text: prompt }];
  for (const image of input.images.slice(0, VISION_CANDIDATE_COUNT)) {
    parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  }

  let lastError: unknown;
  for (const key of keys) {
    try {
      const response = await fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 400,
              responseMimeType: "application/json",
            },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? VISION_TIMEOUT_MS),
        }
      );

      if (response.status === 401 || response.status === 403) {
        lastError = new Error("Gemini rejected the API key (HTTP " + response.status + ").");
        continue; // Another key in the pool may still work.
      }
      if (!response.ok) {
        lastError = new Error(`Gemini answered HTTP ${response.status}.`);
        continue;
      }
      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!text) {
        lastError = new Error("Gemini returned an empty answer.");
        continue;
      }
      return parseVisionVerdict(text, input.images.length);
    } catch (error) {
      lastError = error;
    }
  }

  throw new AppError("Gemini Vision could not verify the B-roll candidates.", {
    status: 502,
    details: lastError instanceof Error ? lastError.message : String(lastError),
    resolution: "The clip is rendered without B-roll for this entity. Retry B-roll later.",
  });
}
