/**
 * The B-roll analysis contract: what the LLM is asked for, and what is accepted.
 *
 * The prompt asks for one JSON document:
 *
 *   { "entities": [ { "type": "person|place|event", "name": "...",
 *                     "searchQuery": "...", "start": 12.4, "end": 15.2 } ],
 *     "broll":    [ { "visualKeywords": ["rocket launch", ...],
 *                     "start": 18.0, "end": 22.5 } ] }
 *
 * Validation is strict in the same style as `lib/viral-response.ts`: structural
 * nonsense is an error naming the offending field, never a silent empty plan.
 * The one difference is deliberate - individual *keywords* that are abstract
 * ("success", "growth") are dropped instead of failing the run, because a
 * photographable word list is a quality bar, not a schema.
 *
 * Times are CLIP-RELATIVE seconds (0 = the clip's first frame, before the hook
 * replay). The worker adds the hook duration when the scheduler places items.
 */

import { AppError } from "../errors";
import type { BrollEntityType, WordTimestamp } from "../types";
import { parseTimestamp } from "../viral-response";

export const MAX_ENTITIES = 6;
export const MAX_KEYWORD_MOMENTS = 20;
const MAX_NAME_LENGTH = 80;
const MAX_QUERY_LENGTH = 120;
const MAX_KEYWORD_LENGTH = 48;

export interface BrollEntity {
  type: BrollEntityType;
  name: string;
  searchQuery: string;
  /** Name + what the speaker is talking about, e.g. "Elon Musk Tesla factory". */
  contextQuery?: string;
  start: number;
  end: number;
}

export interface BrollKeywordMoment {
  visualKeywords: string[];
  /** Clip-relative seconds. */
  start: number;
  end: number;
}

export interface BrollAnalysis {
  entities: BrollEntity[];
  broll: BrollKeywordMoment[];
}

const ENTITY_TYPES: ReadonlySet<string> = new Set(["person", "place", "event"]);

/**
 * Words that describe an idea rather than something a camera can photograph.
 * The LLM is told to avoid them; this is the enforcement.
 */
const ABSTRACT_WORDS = new Set([
  "success",
  "successful",
  "growth",
  "motivation",
  "motivational",
  "inspiration",
  "inspirational",
  "mindset",
  "journey",
  "potential",
  "opportunity",
  "value",
  "values",
  "quality",
  "effort",
  "focus",
  "discipline",
  "consistency",
  "belief",
  "mind",
  "thought",
  "thoughts",
  "idea",
  "ideas",
  "concept",
  "strategy",
  "future",
  "change",
  "improvement",
  "productivity",
  "happiness",
  "freedom",
  "power",
  "energy",
  "vibes",
  "content",
  "business",
  "wealth",
  "love",
  "trust",
  "respect",
  "leadership",
  "teamwork",
  "life",
  "time",
  "people",
  "everyone",
  "something",
  "anything",
  "nothing",
  "everything",
  "stuff",
  "things",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Concrete phrases only: 1-4 words, no abstract idea words. */
export function isConcreteKeyword(phrase: string): boolean {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (words.every((word) => ABSTRACT_WORDS.has(word))) return false;
  if (words.some((word) => ABSTRACT_WORDS.has(word)) && words.length === 1)
    return false;
  // A single abstract word is never photographable on its own.
  if (words.length === 1 && words[0].length < 3) return false;
  return true;
}

function readTime(value: unknown, field: string, clipDuration: number): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string"
        ? parseTimestamp(value)
        : null;
  if (parsed === null || parsed < 0) {
    throw invalidBrollResponse(
      `${field} must be a timestamp in seconds (got ${show(value)})`,
    );
  }
  return Math.min(clipDuration, parsed);
}

function readWindow(
  entry: Record<string, unknown>,
  field: string,
  clipDuration: number,
): { start: number; end: number } {
  const start = readTime(entry.start, `${field}.start`, clipDuration);
  const end = readTime(entry.end, `${field}.end`, clipDuration);
  if (end <= start) {
    // A zero-length mention is not usable; give it the shortest window that can
    // still be scheduled instead of failing the whole analysis.
    return { start, end: Math.min(clipDuration, start + 2.5) };
  }
  return { start, end };
}

/** Start time from the transcript word the model pointed at (never from model-guessed seconds). */
function windowFromWord(
  entry: Record<string, unknown>,
  words: readonly WordTimestamp[],
  clipDuration: number,
  span: number,
): { start: number; end: number } | null {
  const raw = entry.wordIndex ?? entry.word_index;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw >= words.length
  )
    return null;
  const start = Math.min(clipDuration, Math.max(0, words[raw].start));
  return { start, end: Math.min(clipDuration, start + span) };
}

const invalidBrollResponse = (summary: string, details?: string) =>
  new AppError(summary, {
    status: 502,
    details,
    resolution:
      "Retry the B-roll step. If it keeps failing, check the settings that feed the LLM chain.",
  });

/**
 * Parse + validate the model's answer. Entities keep the model's search query
 * (falling back to the name); keyword moments keep only concrete phrases.
 */
export function parseBrollAnalysis(
  text: string,
  clipDuration: number,
  words: readonly WordTimestamp[] = [],
): BrollAnalysis {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidBrollResponse(
      "The B-roll response is not valid JSON.",
      text.slice(0, 300),
    );
  }
  if (!isRecord(data)) {
    throw invalidBrollResponse(
      'The B-roll response must be a JSON object: { "entities": [...], "broll": [...] }.',
      text.slice(0, 300),
    );
  }

  const entitiesRaw = data.entities ?? [];
  const brollRaw = data.broll ?? [];
  if (!Array.isArray(entitiesRaw)) {
    throw invalidBrollResponse(
      '"entities" must be an array.',
      show(data.entities),
    );
  }
  if (!Array.isArray(brollRaw)) {
    throw invalidBrollResponse('"broll" must be an array.', show(data.broll));
  }

  const entities: BrollEntity[] = [];
  for (const [index, entry] of entitiesRaw.slice(0, MAX_ENTITIES).entries()) {
    const where = `entities[${index}]`;
    if (!isRecord(entry))
      throw invalidBrollResponse(`${where} must be an object.`, show(entry));

    const type =
      typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
    if (!ENTITY_TYPES.has(type)) {
      throw invalidBrollResponse(
        `${where}.type must be person, place or event.`,
        show(entry.type),
      );
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw invalidBrollResponse(
        `${where}.name must be a non-empty string.`,
        show(entry.name),
      );
    }
    const name = entry.name.trim().slice(0, MAX_NAME_LENGTH);
    const query =
      typeof entry.searchQuery === "string" && entry.searchQuery.trim()
        ? entry.searchQuery.trim().slice(0, MAX_QUERY_LENGTH)
        : name;
    const window =
      windowFromWord(entry, words, clipDuration, 3) ??
      readWindow(entry, where, clipDuration);

    const contextQuery =
      typeof entry.contextQuery === "string"
        ? entry.contextQuery.trim().slice(0, MAX_QUERY_LENGTH)
        : "";

    entities.push({
      type: type as BrollEntityType,
      name,
      searchQuery: query,
      ...(contextQuery ? { contextQuery } : {}),
      ...window,
    });
  }

  const broll: BrollKeywordMoment[] = [];
  for (const [index, entry] of brollRaw
    .slice(0, MAX_KEYWORD_MOMENTS)
    .entries()) {
    const where = `broll[${index}]`;
    if (!isRecord(entry))
      throw invalidBrollResponse(`${where} must be an object.`, show(entry));
    const keywordsRaw = entry.visualKeywords ?? entry.visual_keywords;
    if (!Array.isArray(keywordsRaw)) {
      throw invalidBrollResponse(
        `${where}.visualKeywords must be an array of strings.`,
        show(keywordsRaw),
      );
    }
    const keywords = [
      ...new Set(
        keywordsRaw
          .filter((word): word is string => typeof word === "string")
          .map((word) => word.trim().slice(0, MAX_KEYWORD_LENGTH))
          .filter((word) => word && isConcreteKeyword(word)),
      ),
    ].slice(0, 4);
    if (keywords.length === 0) continue; // Nothing photographable in this moment.
    const window =
      windowFromWord(entry, words, clipDuration, 1.3) ??
      (entry.start !== undefined
        ? readWindow(entry, where, clipDuration)
        : null);
    if (!window) continue; // No usable timing for this moment.
    broll.push({ visualKeywords: keywords, ...window });
  }

  return { entities, broll };
}

/**
 * The words of the sentence around one moment, for the Gemini prompt ("does this
 * image fit what the speaker is saying"). Pure, and tolerant of messy timing.
 */
export function transcriptSentenceAt(
  words: readonly WordTimestamp[],
  at: number,
  options: { maxWords?: number } = {},
): string {
  const maxWords = options.maxWords ?? 24;
  if (words.length === 0) return "";
  const index = words.findIndex((word) => word.end >= at);
  const anchor = index === -1 ? words.length - 1 : index;
  const start = Math.max(0, anchor - Math.floor(maxWords / 2));
  return words
    .slice(start, start + maxWords)
    .map((word) => word.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keyword moments from the transcript itself. Used when the LLM call fails (the
 * pipeline continues with stock cards) and to top up the count when the model
 * returned fewer moments than the clip needs.
 */
export function deriveFallbackKeywords(
  words: readonly WordTimestamp[],
  clipDuration: number,
  targetMoments: number,
): BrollAnalysis {
  const usable = words
    .filter((word) => word.end > word.start)
    .map((word) => ({
      ...word,
      clean: word.word
        .replace(/[^A-Za-z0-9'-]/g, "")
        .trim()
        .toLowerCase(),
    }))
    .filter(
      (word) => word.clean.length >= 4 && !ABSTRACT_WORDS.has(word.clean),
    );

  const seen = new Set<string>();
  const picks: Array<{ keyword: string; start: number; end: number }> = [];
  for (const word of usable) {
    if (seen.has(word.clean)) continue;
    seen.add(word.clean);
    picks.push({ keyword: word.clean, start: word.start, end: word.end });
  }

  const moments: BrollKeywordMoment[] = [];
  const slots = Math.max(1, targetMoments);
  for (let index = 0; index < slots; index += 1) {
    const pick = picks.length
      ? picks[
      Math.min(
        picks.length - 1,
        Math.floor(((index + 0.5) * picks.length) / slots),
      )
      ]
      : undefined;
    const centre = pick ? pick.start : ((index + 0.5) / slots) * clipDuration;
    const start = Math.max(0, Math.min(clipDuration - 1.5, centre));
    const end = Math.min(clipDuration, start + 1.5);
    moments.push({
      visualKeywords: [pick?.keyword ?? "abstract background"],
      start,
      end,
    });
  }
  return { entities: [], broll: moments };
}

/** The prompt sent through `completeWithFallback` with `json: true`. */
export function buildBrollPrompt(input: {
  clipDuration: number;
  words: readonly WordTimestamp[];
  entityBudget: number;
  keywordBudget: number;
  keywordMin?: number;
}): string {
  const transcript = transcriptForPrompt(input.words);
  const min = Math.min(input.keywordMin ?? 0, input.keywordBudget);
  return [
    "You are planning B-roll for a vertical short clip.",
    `The clip is ${input.clipDuration.toFixed(1)} seconds long. The transcript lines look like "#index start-end word".`,
    "",
    "Return ONE JSON object, no markdown, no commentary:",
    '{ "entities": [ { "type": "person" | "place" | "event", "name": "…", "searchQuery": "…", "contextQuery": "…", "wordIndex": 0 } ],',
    '  "broll": [ { "visualKeywords": ["…"], "wordIndex": 0 } ] }',
    "",
    "wordIndex is the #index of the exact transcript word where the thing is spoken. NEVER invent timestamps.",
    "",
    "entities:",
    "- ONLY real, specific, named things a stock/Wikimedia photo could show: a public figure, a brand, a landmark, a city, a stadium, a named event.",
    `- At most ${input.entityBudget}. Leave the array empty when nothing is named.`,
    '- searchQuery is the full name ONLY, e.g. "Elon Musk", "Eiffel Tower", "2024 Summer Olympics".',
    '- contextQuery is the full name PLUS what is being said about it, 2-4 extra words, e.g. "Elon Musk Tesla factory", "Eiffel Tower at night", "Messi World Cup trophy". It must start with the full name.',
    '- name and searchQuery MUST be the full, unambiguous name: "Alex Cooper", never just "Alex". If the speaker only says a first name, complete it from the rest of the transcript; if you cannot, leave that entity out.',
    "- Skip private individuals nobody would have a public photo of, and skip podcast or show logos.",
    "",
    "broll:",
    `- Between ${min} and ${input.keywordBudget} moments, in chronological order, spread across the WHOLE clip (never leave more than 6 seconds without one).`,
    '- ONE concrete, PHOTOGRAPHABLE English noun phrase (1-3 words) per moment, taken from what is being talked about: "city skyline", "coffee cup", "courtroom", "cash".',
    '- NEVER abstract ideas: no "success", "growth", "mindset", "motivation", "value", "journey".',
    "- Never repeat the same keyword.",
    "",
    "Transcript (clip-relative seconds):",
    transcript,
  ].join("\n");
}

function transcriptForPrompt(words: readonly WordTimestamp[]): string {
  if (!words.length) return "(no words in this clip)";
  return words
    .map(
      (word, index) =>
        `#${index} ${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.word}`,
    )
    .join("\n")
    .slice(0, 12_000);
}
