/**
 * ClipCraft's AI surface: viral segment detection + hook/CTA overlay text.
 *
 * The actual LLM calls live in lib/llm.ts — `completeWithFallback()` walks a
 * configurable multi-provider chain (Groq → Cerebras → OpenRouter → Google AI
 * Studio → Mistral → 8B backups) and hands the request to the first provider
 * that answers. This file keeps only the ClipCraft-specific parts, which are
 * deliberately provider-agnostic:
 *
 *   - loading the prompt templates from MongoDB ({{transcript}} /
 *     {{clipTranscript}} placeholders — unchanged),
 *   - filling in the placeholders with the transcript data,
 *   - parsing + validating the model's JSON / short-text output into the
 *     same shapes the rest of the app already consumes (ViralSegment[],
 *     hook text, CTA text).
 *
 * Everything downstream of these functions (clip records, MongoDB, the render
 * pipeline) is untouched by which provider answered.
 */

import { getPromptTemplate } from './db';
import { AppError, toErrorMessage } from './errors';
import { log } from './logger';
import { completeWithFallback } from './llm';
import {
  ClipScores,
  DEFAULT_VIRAL_OPTIONS,
  PromptTemplate,
  RetentionStrength,
  SafetyRisk,
  TranscriptData,
  ViralDetectionOptions,
  ViralSegment,
  WordTimestamp,
} from './types';

/**
 * Baseline output budget for viral detection. The real budget now scales with
 * `clipCount` (each clip object carries the full packaging block - timestamps +
 * reason + hook/CTA/title/hashtags/scores - so 10 clips need several times what
 * 3 clips need, and a response cut off mid-JSON is what caused the "model did
 * not return a JSON array" failures). The computed value is capped at 6,144 to
 * stay within the max-output limits of every provider in the chain (Cerebras
 * free: 8K, Mistral small: 8K, Gemini/Groq/OpenRouter: far higher).
 */
export const DETECT_VIRAL_MAX_TOKENS = 4096;

/**
 * Extract the JSON segment array from a model response.
 *
 * Handles, in order of preference:
 *   1. strict JSON (with or without surrounding prose / code fences)
 *   2. TRUNCATED output - the model hit its max-output limit and the closing
 *      `]` is missing. We then salvage every complete top-level `{...}`
 *      object that made it out, so a 2,000-token video still yields its
 *      segments instead of failing the whole detection.
 *
 * Returns null only when no usable JSON objects exist at all.
 */
export function extractViralSegmentArray(text: string): unknown[] | null {
  const cleaned = text.trim();
  const firstBracket = cleaned.indexOf('[');
  if (firstBracket === -1) return null;

  // 1) Strict parse: from the first '[' to the last ']'.
  const lastBracket = cleaned.lastIndexOf(']');
  if (lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not strict JSON (truncated or malformed) - fall through to repair.
    }
  }

  // 2) Repair: walk the text tracking bracket/brace depth (string/escape
  //    aware) and collect every complete top-level object inside the array.
  //    Both '[' and '{' count toward depth, so a '{' seen at depth 1 is
  //    exactly a top-level array element.
  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = firstBracket; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      if (ch === '{' && depth === 1) objectStart = i;
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (ch === '}' && depth === 1 && objectStart !== -1) {
        objects.push(cleaned.slice(objectStart, i + 1));
        objectStart = -1;
      }
      if (ch === ']' && depth === 0) break; // array closed cleanly
    }
  }

  if (objects.length === 0) return null;
  try {
    return JSON.parse(`[${objects.join(',')}]`);
  } catch {
    return null;
  }
}

async function requireTemplate(type: string): Promise<PromptTemplate> {
  const templateDoc = await getPromptTemplate(type);
  if (!templateDoc) {
    throw new AppError(`The ${type} prompt template was not found in MongoDB.`, {
      status: 500,
      resolution:
        'Restart the app so default prompt templates seed into MongoDB, or recreate the template in the Prompt Templates page.',
    });
  }
  return templateDoc;
}

/**
 * Effective options for one detection run: user values with fallbacks.
 * `maxClipDuration` is always >= `minClipDuration`.
 */
export function resolveViralOptions(
  partial?: Partial<ViralDetectionOptions> | null
): Required<ViralDetectionOptions> {
  const clipCount = Math.round(
    Number.isFinite(Number(partial?.clipCount)) && Number(partial?.clipCount) > 0
      ? Number(partial?.clipCount)
      : DEFAULT_VIRAL_OPTIONS.clipCount
  );
  const minClipDuration = Math.max(
    1,
    Number.isFinite(Number(partial?.minClipDuration)) && Number(partial?.minClipDuration) > 0
      ? Number(partial?.minClipDuration)
      : DEFAULT_VIRAL_OPTIONS.minClipDuration
  );
  const maxClipDuration = Math.max(
    minClipDuration,
    Number.isFinite(Number(partial?.maxClipDuration)) && Number(partial?.maxClipDuration) > 0
      ? Number(partial?.maxClipDuration)
      : DEFAULT_VIRAL_OPTIONS.maxClipDuration
  );
  return {
    clipCount,
    minClipDuration,
    maxClipDuration,
    includeHookText: partial?.includeHookText ?? DEFAULT_VIRAL_OPTIONS.includeHookText,
    includeCta: partial?.includeCta ?? DEFAULT_VIRAL_OPTIONS.includeCta,
  };
}

/** Fill every supported {{placeholder}} (all occurrences) in a template. */
function fillTemplate(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number,
  options?: Partial<ViralDetectionOptions> | null
): Promise<ViralSegment[]> {
  const resolved = resolveViralOptions(options);

  if (!transcript.segments.length) {
    throw new AppError('Cannot run viral detection without transcript segments.', {
      status: 400,
      resolution: 'Re-run transcription first and make sure the transcript contains timestamped segments.',
    });
  }

  if (videoDuration < resolved.minClipDuration) {
    throw new AppError(
      `The video (${Math.round(videoDuration)}s) is shorter than the minimum clip length (${resolved.minClipDuration}s).`,
      {
        status: 400,
        resolution: 'Lower the minimum clip length in the AI clip options, or upload a longer video.',
      }
    );
  }

  const templateDoc = await requireTemplate('viral_detection');

  if (!templateDoc.template.includes('{{transcript}}')) {
    throw new AppError('The viral_detection prompt template is missing the {{transcript}} placeholder.', {
      status: 500,
      resolution: 'Edit the prompt template and add {{transcript}} where the transcript should be injected.',
    });
  }

  const formattedTranscript = transcript.segments
    .map((segment) => `[${segment.start.toFixed(1)}s - ${segment.end.toFixed(1)}s]: ${segment.text}`)
    .join('\n');

  const userPrompt = fillTemplate(templateDoc.template, {
    transcript: formattedTranscript,
    clipCount: resolved.clipCount,
    minClipDuration: resolved.minClipDuration,
    maxClipDuration: resolved.maxClipDuration,
  });

  // Scale the output budget with the number of clips: each clip object carries
  // the full packaging block (title/hook/CTA/hashtags/scores) at ~500-800
  // tokens, so a 10-clip run needs 8K+. The old 6K cap truncated the JSON
  // mid-array on 10-clip runs. Note Gemini 3.x also spends part of this budget
  // on "thinking" tokens, so the budget must stay generous; the cap (16K) is
  // far below Gemini Flash's own 65K maxOutputTokens.
  const maxTokens = Math.min(16384, 1500 + resolved.clipCount * 1200);

  let contentText: string;
  try {
    const result = await completeWithFallback({
      task: 'viral segment detection',
      system: templateDoc.systemPrompt,
      prompt: userPrompt,
      maxTokens,
      temperature: 0.5,
    });
    contentText = result.text;
    console.log(`[AI] Raw response (${result.entry.provider}/${result.entry.model}):`, contentText);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Viral segment detection failed.', {
      status: 502,
      details: toErrorMessage(error),
      resolution: 'Check the LLM fallback chain keys in .env.local (see lib/llm.ts) and retry.',
    });
  }

  const parsed = extractViralSegmentArray(contentText);
  if (!parsed) {
    const looksTruncated = contentText.includes('[') && !contentText.trimEnd().endsWith(']');
    throw new AppError(
      looksTruncated
        ? 'The model\'s viral segment JSON was cut off before it could be completed (likely the output token budget ran out).'
        : 'The model did not return a JSON array for viral segments.',
      {
        status: 502,
        details: contentText,
        resolution: looksTruncated
          ? 'Retry the analysis - on repeated failures lower the number of clips in the AI clip options or shorten the transcript window.'
          : 'Tighten the viral detection prompt so the model returns only strict JSON.',
      }
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('The model returned an empty viral segment list.', {
      status: 502,
      resolution: 'Adjust the transcript or prompt template and retry viral detection.',
    });
  }

  const sanitized = parsed.map((item, index) => sanitizeSegment(item, index, videoDuration));
  const valid = enforceViralConstraints(sanitized, resolved);

  if (!valid.length) {
    throw new AppError(
      'No viral segment stayed inside the configured clip length range.',
      {
        status: 502,
        details: `clip length range: ${resolved.minClipDuration}s-${resolved.maxClipDuration}s, video: ${Math.round(videoDuration)}s`,
        resolution:
          'Widen the min/max clip length in the AI clip options, or adjust the viral detection prompt so segments fit the requested range.',
      }
    );
  }

  return valid;
}

/**
 * Post-parse rule enforcement, mirroring the prompt's hard constraints:
 *  - clip length stays within [minClipDuration, maxClipDuration] (over-long
 *    clips are trimmed to the max, under-minimum clips are dropped),
 *  - clips are ranked by viral potential (highest score first),
 *  - no two clips overlap,
 *  - at most `clipCount` clips survive.
 */
function enforceViralConstraints(
  segments: ViralSegment[],
  options: Required<ViralDetectionOptions>
): ViralSegment[] {
  const withinBounds: ViralSegment[] = [];

  for (const segment of segments) {
    let end = segment.end;
    const duration = end - segment.start;

    if (duration < options.minClipDuration) {
      log.warn(
        `Dropping viral segment ${segment.start.toFixed(1)}s-${end.toFixed(1)}s ` +
          `(${duration.toFixed(1)}s is below the ${options.minClipDuration}s minimum)`
      );
      continue;
    }

    if (duration > options.maxClipDuration) {
      end = segment.start + options.maxClipDuration;
      log.detail(
        `Trimming viral segment ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s ` +
          `to the ${options.maxClipDuration}s maximum`
      );
    }

    withinBounds.push({ ...segment, end });
  }

  // Rank by viral potential first, then greedily keep non-overlapping clips so
  // the "no overlapping timestamps" rule survives imperfect model output.
  const ranked = [...withinBounds].sort((a, b) => b.score - a.score);
  const kept: ViralSegment[] = [];

  for (const segment of ranked) {
    const overlaps = kept.some((other) => segment.start < other.end && segment.end > other.start);
    if (overlaps) {
      log.warn(
        `Dropping overlapping viral segment ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s ` +
          `(conflicts with a higher-ranked clip)`
      );
      continue;
    }
    kept.push(segment);
  }

  return kept.slice(0, options.clipCount);
}

export async function generateHookText(clipTranscriptText: string): Promise<string> {
  return generateShortOverlayText({
    transcriptText: clipTranscriptText,
    templateType: 'hook_generation',
    logLabel: 'hook text generation',
    invalidResponseSummary: 'The model returned an invalid hook text response.',
    failureSummary: 'Hook text generation failed.',
  });
}

export async function generateCtaText(clipTranscriptText: string): Promise<string> {
  return generateShortOverlayText({
    transcriptText: clipTranscriptText,
    templateType: 'cta_generation',
    logLabel: 'CTA generation',
    invalidResponseSummary: 'The model returned an invalid CTA response.',
    failureSummary: 'CTA generation failed.',
  });
}

export interface HookMomentInput {
  /** Words of the clip, timestamps RELATIVE to the clip start (0 = clip start). */
  words: WordTimestamp[];
  segmentDuration: number;
  /** Length of the duplicated hook intro, in seconds. */
  hookDuration: number;
}

export interface HookMoment {
  /** Start of the hook window, seconds relative to the clip start. */
  start: number;
  /** End of the hook window (= start + hookDuration, clamped). */
  end: number;
  /** Why the model picked this moment (short). */
  reason: string;
}

const HOOK_MOMENT_TIMEOUT_MS = 45_000;

/**
 * Finds the single most gripping moment inside the clip so the render can
 * duplicate it to the START of the viral segment (a "suspense hook": the
 * viewer sees the best beat first, then watches the clip build back up to it).
 *
 * Deliberately provider-agnostic and failure-tolerant: any problem (no LLM
 * key, timeout, unparsable answer, out-of-range timestamps) returns `null`
 * and the worker falls back to the old behaviour (the first N seconds).
 * This is an internal heuristic - the prompt is hard-coded on purpose so no
 * new MongoDB prompt template is required.
 */
export async function detectHookMoment(input: HookMomentInput): Promise<HookMoment | null> {
  const { words, segmentDuration, hookDuration } = input;
  if (!words.length || !(segmentDuration > 0) || !(hookDuration > 0)) return null;

  // Group the words into readable phrases (one line per ~8 words) so the
  // prompt stays compact and timestamped.
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 8) {
    const slice = words.slice(i, i + 8);
    lines.push(
      `[${slice[0].start.toFixed(1)}s] ${slice.map((w) => w.word).join(' ')}`
    );
  }

  const system =
    'You pick the single best "hook" moment inside a short video clip so it can be ' +
    'replayed at the very start of the clip to create suspense. Choose the moment that ' +
    'makes the viewer most desperate to see what happens: a bold claim, a cliffhanger, ' +
    'a shocking reaction, a question begging an answer, or the peak of the action. ' +
    'Prefer a moment where something important has JUST happened or is ABOUT to happen. ' +
    'Return ONLY minified JSON: {"start":<seconds>,"end":<seconds>,"reason":"<max 8 words>"} ' +
    'using the clip-relative timestamps from the transcript. start must be >= 0 and ' +
    'end-start must be exactly the given hook length.';

  const prompt =
    `Clip length: ${segmentDuration.toFixed(1)}s. Hook length to pick: ${hookDuration.toFixed(1)}s.\n` +
    `Transcript (timestamps relative to clip start):\n${lines.join('\n')}`;

  let text: string;
  try {
    const result = await Promise.race([
      completeWithFallback({
        task: 'hook moment detection',
        system,
        prompt,
        maxTokens: 150,
        temperature: 0.4,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('hook moment detection timed out')), HOOK_MOMENT_TIMEOUT_MS)
      ),
    ]);
    text = result.text;
  } catch (error) {
    log.detail(`Hook moment detection skipped: ${toErrorMessage(error)}`);
    return null;
  }

  // Strict JSON first, then a numeric regex fallback (models love to wrap JSON
  // in prose or fences).
  let start: number | null = null;
  let end: number | null = null;
  let reason = '';

  try {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      const parsed = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
      if (typeof parsed.start === 'number') start = parsed.start;
      if (typeof parsed.end === 'number') end = parsed.end;
      if (typeof parsed.reason === 'string') reason = parsed.reason.trim();
    }
  } catch {
    // fall through to the regex
  }
  if (start === null) {
    const m = /"start"\s*:\s*(\d+(?:\.\d+)?)/.exec(text);
    if (m) start = parseFloat(m[1]);
  }
  if (end === null) {
    const m = /"end"\s*:\s*(\d+(?:\.\d+)?)/.exec(text);
    if (m) end = parseFloat(m[1]);
  }

  if (start === null || !Number.isFinite(start)) return null;

  // The model's window end may disagree with our hook length; honour its
  // centre but keep our (user-configured) length, clamped inside the clip.
  const maxStart = Math.max(0, segmentDuration - hookDuration);
  const modelEnd = end !== null && Number.isFinite(end) ? end : null;
  const startGuess = modelEnd !== null ? (start + modelEnd) / 2 - hookDuration / 2 : start;
  const safeStart = Math.max(0, Math.min(startGuess, maxStart));
  const safeEnd = Math.min(segmentDuration, safeStart + hookDuration);
  if (safeEnd - safeStart < 0.5) return null;

  return { start: safeStart, end: safeEnd, reason };
}

async function generateShortOverlayText(options: {
  transcriptText: string;
  templateType: 'hook_generation' | 'cta_generation';
  logLabel: string;
  invalidResponseSummary: string;
  failureSummary: string;
}): Promise<string> {
  const normalizedTranscript = options.transcriptText.trim();
  if (!normalizedTranscript) {
    throw new AppError('Cannot generate overlay text from an empty clip transcript.', {
      status: 400,
      resolution: 'Choose a clip segment that contains spoken transcript text.',
    });
  }

  const templateDoc = await requireTemplate(options.templateType);

  if (!templateDoc.template.includes('{{clipTranscript}}')) {
    throw new AppError(
      `The ${options.templateType} prompt template is missing the {{clipTranscript}} placeholder.`,
      {
        status: 500,
        resolution: 'Edit the prompt template and add {{clipTranscript}} where the clip transcript should be injected.',
      }
    );
  }

  const userPrompt = templateDoc.template.replace('{{clipTranscript}}', normalizedTranscript);

  let contentText: string;
  try {
    const result = await completeWithFallback({
      task: options.logLabel,
      system: templateDoc.systemPrompt,
      prompt: userPrompt,
      maxTokens: 100,
      temperature: 0.7,
    });
    contentText = result.text;
    console.log(`[AI] Raw ${options.logLabel} response (${result.entry.provider}/${result.entry.model}):`, contentText);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(options.failureSummary, {
      status: 502,
      details: toErrorMessage(error),
      resolution: 'Check the LLM fallback chain keys in .env.local (see lib/llm.ts) and retry.',
    });
  }

  const cleaned = contentText.replace(/^[\"']|[\"']$/g, '').trim().toUpperCase();

  if (!cleaned || cleaned.length >= 80) {
    throw new AppError(options.invalidResponseSummary, {
      status: 502,
      details: contentText,
      resolution: 'Tighten the prompt so the model returns a short plain-text overlay.',
    });
  }

  return cleaned;
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toCleanString(value: unknown, maxLength = 300): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function toStringArray(value: unknown, maxItems = 5): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length ? items : undefined;
}

function toEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return (allowed as readonly string[]).includes(cleaned) ? (cleaned as T) : undefined;
}

const RETENTION_STRENGTHS = ['Weak', 'Medium', 'Strong', 'Extreme'] as const;
const SAFETY_RISKS = ['Low', 'Medium', 'High'] as const;

function toClipScores(value: unknown): ClipScores | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const clamp = (input: unknown) => {
    const n = toFiniteNumber(input);
    return n === undefined ? undefined : Math.min(10, Math.max(1, n));
  };
  const viral = clamp(raw.viral);
  const retention = clamp(raw.retention);
  const controversy = clamp(raw.controversy);
  const shareability = clamp(raw.shareability);
  if (
    viral === undefined ||
    retention === undefined ||
    controversy === undefined ||
    shareability === undefined
  ) {
    return undefined;
  }
  return { viral, retention, controversy, shareability };
}

function sanitizeSegment(item: unknown, index: number, videoDuration: number): ViralSegment {
  const segment = (item || {}) as Record<string, unknown>;
  const start = Number(segment.start);
  const end = Number(segment.end);
  const score = Number(segment.score);
  const reason = String(segment.reason || '').trim();
  const hookText = String(segment.hookText || '').trim().toUpperCase();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError(`The model returned invalid timestamps for viral segment #${index + 1}.`, {
      status: 502,
      details: JSON.stringify(item),
      resolution: 'Update the viral detection prompt so every segment includes numeric start and end values.',
    });
  }

  if (!reason) {
    throw new AppError(`The model returned a viral segment without a reason (#${index + 1}).`, {
      status: 502,
      details: JSON.stringify(item),
      resolution: 'Update the viral detection prompt so every segment includes a reason field.',
    });
  }

  // Timestamps must stay inside the real video window so no model invention
  // can ever create a clip outside the source.
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(videoDuration, end);

  if (clampedEnd - clampedStart < 1) {
    throw new AppError(
      `The model returned viral segment #${index + 1} outside the video bounds (${start}-${end}s vs ${videoDuration}s).`,
      {
        status: 502,
        details: JSON.stringify(item),
        resolution:
          'The prompt must use only timestamps supported by the transcript - check the viral detection prompt rules.',
      }
    );
  }

  const hookLineStart = toFiniteNumber(segment.hookLineStart);
  const hookLineEnd = toFiniteNumber(segment.hookLineEnd);

  return {
    start: clampedStart,
    end: clampedEnd,
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 8,
    reason,
    hookText,
    title: toCleanString(segment.title, 160),
    ctaText: toCleanString(segment.ctaText, 120),
    hookLine: toCleanString(segment.hookLine, 220),
    hookLineStart:
      hookLineStart !== undefined ? Math.min(Math.max(0, hookLineStart), videoDuration) : undefined,
    hookLineEnd:
      hookLineEnd !== undefined ? Math.min(Math.max(0, hookLineEnd), videoDuration) : undefined,
    hashtags: toStringArray(segment.hashtags, 5),
    retentionStrength: toEnum<RetentionStrength>(segment.retentionStrength, RETENTION_STRENGTHS),
    psychologicalTrigger: toCleanString(segment.psychologicalTrigger, 40),
    safetyRisk: toEnum<SafetyRisk>(segment.safetyRisk, SAFETY_RISKS),
    safetyNotes: toCleanString(segment.safetyNotes, 400),
    scores: toClipScores(segment.scores),
  };
}
