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
import { PromptTemplate, TranscriptData, ViralSegment, WordTimestamp } from './types';

/**
 * Output budget for viral detection. The segment JSON (timestamps + reason +
 * hookText per segment) easily exceeds 1,500 tokens for a medium-length video,
 * and a response cut off mid-JSON is what caused the "model did not return a
 * JSON array" failures. 4,096 stays within the max-output limits of every
 * provider in the chain (Cerebras free: 8K, Mistral small: 8K, Gemini/Groq/
 * OpenRouter: far higher).
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

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  if (!transcript.segments.length) {
    throw new AppError('Cannot run viral detection without transcript segments.', {
      status: 400,
      resolution: 'Re-run transcription first and make sure the transcript contains timestamped segments.',
    });
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

  const userPrompt = templateDoc.template.replace('{{transcript}}', formattedTranscript);

  let contentText: string;
  try {
    const result = await completeWithFallback({
      task: 'viral segment detection',
      system: templateDoc.systemPrompt,
      prompt: userPrompt,
      maxTokens: DETECT_VIRAL_MAX_TOKENS,
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
          ? 'Retry the analysis - on repeated failures raise DETECT_VIRAL_MAX_TOKENS in lib/ai.ts or shorten the transcript window.'
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

  return parsed.map((item, index) => sanitizeSegment(item, index, videoDuration));
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

  return {
    start: Math.max(0, start),
    end: Math.min(videoDuration, end),
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 8,
    reason,
    hookText,
  };
}
