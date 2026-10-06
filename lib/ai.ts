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
 *   - handing the model's JSON to the normalization layer
 *     (lib/viral-response.ts - the one place that knows the AI response
 *     shape) and applying the clip-count / length / overlap rules to what
 *     comes back (ViralSegment[]), and validating the short hook / CTA text.
 *
 * Everything downstream of these functions (clip records, SQLite, the render
 * pipeline) is untouched by which provider answered.
 */

import { getPromptTemplate } from './db';
import { AppError, toErrorMessage } from './errors';
import { log } from './logger';
import { completeWithFallback } from './llm';
import {
  DEFAULT_VIRAL_OPTIONS,
  PromptTemplate,
  TranscriptData,
  ViralDetectionOptions,
  ViralSegment,
} from './types';
import { extractViralClips, normalizeViralClips } from './viral-response';

/**
 * Baseline output budget for viral detection (kept for reference; the real
 * budget comes from `detectionMaxTokens`).
 */
export const DETECT_VIRAL_MAX_TOKENS = 4096;

/**
 * Output budget for one detection pass. Every clip in the response carries the
 * full analysis block (hook, retention, trigger, safety incl. risky words,
 * packaging, scores) - roughly 1,500-2,000 tokens per clip, more than twice the
 * old flat format. A response cut off mid-JSON (or Gemini's MAX_TOKENS finish,
 * which spends part of this budget on thinking) fails every provider in the
 * chain, so the budget is generous: it is only an upper bound, never billed
 * unless used. 40K stays well under the 65K max-output of the Flash models; a
 * request for more clips than fit is completed by the top-up passes.
 */
export function detectionMaxTokens(clipBudget: number): number {
  return Math.min(40_000, 3_000 + Math.max(1, clipBudget) * 2_000);
}

/**
 * Last-resort prompts for the hook / CTA fallback generators. They are used only
 * when the database holds no template of that type (the default database no
 * longer seeds them), so the "AI left it out -> generate it" fallback still works
 * on a fresh install. A template saved on the Prompt Templates page always wins.
 */
const BUILT_IN_OVERLAY_TEMPLATES: Record<'hook_generation' | 'cta_generation', Pick<PromptTemplate, 'systemPrompt' | 'template'>> = {
  hook_generation: {
    systemPrompt:
      'You are a master social media copywriter. You create viral, punchy, curiosity-inducing on-screen text overlays for short-form videos.',
    template: `Generate a short, high-impact on-screen hook overlay (MAX 8 WORDS) for this video clip transcript segment.
The hook must create a "wait, what? - I need to see the rest" feeling: a curiosity gap, a cliffhanger, a shocking claim, or a tease of what is about to happen - NOT a summary of the content and NOT generic excitement.
Use ALL CAPS or strong action words. Return ONLY the hook text string without quotes.

Clip Transcript:
{{clipTranscript}}`,
  },
  cta_generation: {
    systemPrompt:
      'You are a short-form video strategist. You write concise end-of-video calls to action that feel natural, boost engagement, and fit as on-screen text overlays.',
    template: `Generate one short end-of-video CTA overlay (MAX 10 WORDS) for this clip transcript.
The CTA should encourage engagement such as follow, comment, save, share, or watch the next clip.
It must feel punchy, platform-native, and safe to place in the final 2 to 3 seconds.
Use ALL CAPS or strong action phrasing. Return ONLY the CTA text string without quotes.

Clip Transcript:
{{clipTranscript}}`,
  },
};

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
 *  - clips are ordered by the AI's own `rank` (1 = most viral; unranked clips
 *    fall back to highest score first),
 *  - no two clips overlap (and never overlap an already-kept `taken` window),
 *  - at most `options.clipCount` NEW clips survive, and they are numbered
 *    1, 2, 3... (continuing after `taken`) so ranks stay gap-free even when
 *    a clip was dropped or a top-up pass added more.
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

  // Order by the AI's rank (score breaks ties and orders unranked clips), then
  // greedily keep non-overlapping clips so the "no overlapping timestamps" rule
  // survives imperfect model output. Already-kept windows (`taken`) always win;
  // new clips must dodge them.
  const ranked = [...withinBounds].sort(byRankThenScore);
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

  return kept
    .slice(taken.length, taken.length + options.clipCount)
    .map((segment, index) => ({ ...segment, rank: taken.length + index + 1 }));
}

/** AI rank first (lower = better); clips without one, or tied, go by score. */
function byRankThenScore(a: ViralSegment, b: ViralSegment): number {
  const rankA = a.rank ?? Number.POSITIVE_INFINITY;
  const rankB = b.rank ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  return b.score - a.score;
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
   * One LLM detection pass: complete -> extract the clip JSON -> normalize.
   * `soft` turns model failures into an empty result (used by the top-up
   * passes, where "no more clips" just means the transcript is exhausted).
   *
   * Tolerance: a clip whose time window cannot be trusted is skipped with a
   * warning and the rest are kept - the pass only throws when NOTHING usable
   * came back.
   */
  const runDetectionPass = async (
    prompt: string,
    clipBudget: number,
    label: string,
    soft: boolean
  ): Promise<ViralSegment[]> => {
    let contentText: string;
    try {
      const result = await completeWithFallback({
        task: 'viral segment detection',
        system: templateDoc.systemPrompt,
        prompt,
        maxTokens: detectionMaxTokens(clipBudget),
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

    const extracted = extractViralClips(contentText);
    if (!extracted) {
      if (soft) {
        log.warn(`Top-up viral pass${label} returned no parseable clip JSON.`);
        return [];
      }
      const looksTruncated = /[[{]/.test(contentText) && !/[\]}]\s*$/.test(contentText.trimEnd());
      throw new AppError(
        looksTruncated
          ? 'The model\'s viral clip JSON was cut off before it could be completed (likely the output token budget ran out).'
          : 'The model did not return viral clips as JSON (expected an object with a "clips" array).',
        {
          status: 502,
          details: contentText,
          resolution: looksTruncated
            ? 'Retry the analysis - on repeated failures lower the number of clips in the AI clip options or shorten the transcript window.'
            : 'Tighten the viral detection prompt so the model returns only strict JSON in the documented { "clips": [...] } shape.',
        }
      );
    }

    if (extracted.clips.length === 0) {
      if (soft) return [];
      throw new AppError('The model returned an empty viral clip list.', {
        status: 502,
        resolution: 'Adjust the transcript or prompt template and retry viral detection.',
      });
    }

    if (extracted.truncated) {
      log.warn(
        `Viral response${label} was cut off by the output limit - kept the ${extracted.clips.length} clip(s) that finished.`
      );
    }

    const { segments, issues } = normalizeViralClips(extracted.clips, { videoDuration });
    for (const issue of issues) {
      log.warn(`Skipping AI clip #${issue.index + 1}${label}: ${issue.message}`);
    }

    if (!segments.length) {
      if (soft) return [];
      throw new AppError(`None of the ${extracted.clips.length} clip(s) the model returned has a usable time window.`, {
        status: 502,
        details: issues.map((issue) => `clip #${issue.index + 1}: ${issue.message}`).join(' • '),
        resolution:
          'The prompt must use only timestamps taken from the transcript (seconds, mm:ss or hh:mm:ss) - check the viral detection prompt rules.',
      });
    }

    return segments;
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
      `Return EXACTLY ${missing} MORE clip${missing === 1 ? '' : 's'} in the SAME JSON format and ` +
      `top-level structure as your first answer (no markdown fences, no commentary). ` +
      `This overrides any clip count stated above: the answer holds exactly ${missing} clip${missing === 1 ? '' : 's'}, ` +
      `ranked 1 to ${missing} among themselves. They must:\n` +
      `- lie COMPLETELY OUTSIDE and non-overlapping with every selected window above ` +
      `(different moments - never the same moment re-framed),\n` +
      `- each be between ${resolved.minClipDuration}s and ${resolved.maxClipDuration}s long,\n` +
      `- follow ALL the same rules and the same per-clip JSON schema as before.\n` +
      `Do NOT return the selected clips again. Return ONLY the JSON with the ${missing} new clip${missing === 1 ? '' : 's'}.`;

    const more = await runDetectionPass(topUpPrompt, missing, ` (top-up ${pass + 1}, want ${missing})`, true);
    if (!more.length) break;

    // `enforceViralConstraints` returns only the NEW clips (already numbered
    // after the ones in `valid`), so they are appended, never swapped in.
    const added = enforceViralConstraints(more, { ...enforceOptions, clipCount: missing }, valid);
    if (!added.length) break; // nothing new survived the rules
    valid = [...valid, ...added];
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

  const templateDoc =
    (await getPromptTemplate(options.templateType)) ?? BUILT_IN_OVERLAY_TEMPLATES[options.templateType];

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
