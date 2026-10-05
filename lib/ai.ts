/**
 * ClipCraft's AI surface: viral segment detection + hook/CTA overlay text.
 *
 * The actual LLM calls live in lib/llm.ts — `completeWithFallback()` walks a
 * configurable multi-provider chain (Groq → Cerebras → OpenRouter → Google AI
 * Studio → Mistral → 8B backups) and hands the request to the first provider
 * that answers. This file keeps only the ClipCraft-specific parts, which are
 * deliberately provider-agnostic:
 *
 *   - loading the prompt templates from SQLite ({{transcript}} /
 *     {{clipTranscript}} placeholders — unchanged),
 *   - filling in the placeholders with the transcript data,
 *   - parsing + validating the model's JSON / short-text output into the
 *     same shapes the rest of the app already consumes (ViralSegment[],
 *     hook text, CTA text).
 *
 * Everything downstream of these functions (clip records, SQLite, the render
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
    throw new AppError(`The ${type} prompt template was not found in SQLite.`, {
      status: 500,
      resolution:
        'Restart the app so default prompt templates seed into SQLite, or recreate the template in the Prompt Templates page.',
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

/**
 * Post-parse rule enforcement, mirroring the prompt's hard constraints:
 *  - clip length stays within [minClipDuration, maxClipDuration] (over-long
 *    clips are trimmed to the max; SHORT clips are EXTENDED to the minimum so
 *    the user gets the exact clip count and the 60s-90s length rule both),
 *  - clips are ranked by viral potential (highest score first),
 *  - no two clips overlap (and never overlap an already-kept `taken` window),
 *  - at most `options.clipCount` NEW clips survive.
 */
function enforceViralConstraints(
  segments: ViralSegment[],
  options: Required<ViralDetectionOptions> & { videoDuration: number },
  taken: ViralSegment[] = []
): ViralSegment[] {
  const withinBounds: ViralSegment[] = [];

  for (const segment of segments) {
    let end = segment.end;
    const duration = end - segment.start;

    if (duration < options.minClipDuration) {
      // Extend to the minimum instead of dropping - a 55s model pick is still
      // a valid moment, and dropping it would silently shrink the clip count.
      // (A clip that cannot reach the minimum before the VIDEO ends is a
      // genuine "the video cannot support it" case and is still dropped.)
      if (segment.start + options.minClipDuration > options.videoDuration) {
        log.warn(
          `Dropping viral segment ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s ` +
            `(${options.minClipDuration}s minimum does not fit before the video ends)`
        );
        continue;
      }
      end = segment.start + options.minClipDuration;
      log.detail(
        `Extending viral segment ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s ` +
          `to ${end.toFixed(1)}s (the ${options.minClipDuration}s minimum)`
      );
    } else if (duration > options.maxClipDuration) {
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
  // Already-kept windows (`taken`) always win; new clips must dodge them.
  const ranked = [...withinBounds].sort((a, b) => b.score - a.score);
  const kept: ViralSegment[] = [...taken];

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

  return kept.slice(taken.length, taken.length + options.clipCount);
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

  /**
   * One LLM detection pass: complete -> extract JSON -> sanitize.
   * `soft` turns model failures into an empty result (used by the top-up
   * passes, where "no more clips" just means the transcript is exhausted).
   */
  const runDetectionPass = async (
    prompt: string,
    clipBudget: number,
    label: string,
    soft: boolean
  ): Promise<ViralSegment[]> => {
    // Scale the output budget with the number of clips: each clip object
    // carries the full packaging block (title/hook/CTA/hashtags/scores) at
    // ~500-800 tokens. The 16K cap stays far below Gemini Flash's 65K max.
    const maxTokens = Math.min(16384, 1500 + clipBudget * 1200);

    let contentText: string;
    try {
      const result = await completeWithFallback({
        task: 'viral segment detection',
        system: templateDoc.systemPrompt,
        prompt,
        maxTokens,
        temperature: 0.5,
      });
      contentText = result.text;
      console.log(`[AI] Raw response (${result.entry.provider}/${result.entry.model})${label}:`, contentText);
    } catch (error) {
      if (soft) {
        log.warn(`Top-up viral pass${label} failed: ${toErrorMessage(error)}`);
        return [];
      }
      if (error instanceof AppError) throw error;
      throw new AppError('Viral segment detection failed.', {
        status: 502,
        details: toErrorMessage(error),
        resolution: 'Check the LLM fallback chain keys in .env.local (see lib/llm.ts) and retry.',
      });
    }

    const parsed = extractViralSegmentArray(contentText);
    if (!parsed) {
      if (soft) {
        log.warn(`Top-up viral pass${label} returned no parseable JSON array.`);
        return [];
      }
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
      if (soft) return [];
      throw new AppError('The model returned an empty viral segment list.', {
        status: 502,
        resolution: 'Adjust the transcript or prompt template and retry viral detection.',
      });
    }

    return parsed.map((item: unknown, index: number) => sanitizeSegment(item, index, videoDuration));
  };

  const enforceOptions = { ...resolved, videoDuration };

  const firstBatch = await runDetectionPass(userPrompt, resolved.clipCount, '', false);
  let valid = enforceViralConstraints(firstBatch, enforceOptions, []);

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

  // EXACT-CLIP-COUNT top-up: models often return fewer clips than requested.
  // Ask again for the missing count with the already-taken windows excluded
  // (the viral_detection template itself stays untouched), until the user's
  // number is reached or the transcript genuinely runs out of material.
  for (let pass = 0; pass < 2 && valid.length < resolved.clipCount; pass += 1) {
    const missing = resolved.clipCount - valid.length;
    const takenWindows = valid
      .map((segment) => `- ${segment.start.toFixed(1)}s - ${segment.end.toFixed(1)}s`)
      .join('\n');
    const topUpPrompt =
      `${userPrompt}\n\n---\n` +
      `FOLLOW-UP REQUEST - MORE CLIPS ONLY:\n` +
      `${valid.length} clip(s) were ALREADY selected at these exact windows:\n${takenWindows}\n\n` +
      `Return EXACTLY ${missing} MORE clip${missing === 1 ? '' : 's'} as a strict JSON array ` +
      `(no markdown fences, no commentary) that:\n` +
      `- lie COMPLETELY OUTSIDE and non-overlapping with every selected window above ` +
      `(different moments - never the same moment re-framed),\n` +
      `- are each between ${resolved.minClipDuration}s and ${resolved.maxClipDuration}s long,\n` +
      `- follow ALL the same rules and the same per-clip JSON schema as before.\n` +
      `Do NOT return the selected clips again. Return ONLY the JSON array of ${missing} new clip${missing === 1 ? '' : 's'}.`;

    const more = await runDetectionPass(topUpPrompt, missing, ` (top-up ${pass + 1}, want ${missing})`, true);
    if (!more.length) break;

    const merged = enforceViralConstraints(more, { ...enforceOptions, clipCount: missing }, valid);
    if (merged.length <= valid.length) break; // nothing new survived the rules
    valid = merged;
  }

  return valid;
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
