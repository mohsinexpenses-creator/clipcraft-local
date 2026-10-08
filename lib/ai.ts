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
 *   - handing the model's JSON to lib/viral-response.ts (strict parse of the
 *     `{ "clips": [...] }` schema) and applying the clip-count / length /
 *     overlap rules to the validated clips (ViralSegment[]), and validating
 *     the short hook / CTA text.
 *
 * Everything downstream of these functions (clip records, SQLite, the render
 * pipeline) is untouched by which provider answered.
 */

import { getPromptTemplate } from './db';
import { AppError, toErrorMessage } from './errors';
import { log } from './logger';
import { completeWithFallback } from './llm';
import {
  PromptTemplate,
  TranscriptData,
  ViralDetectionOptions,
  ViralSegment,
} from './types';
import { resolveViralOptions } from './pipeline-defaults';
import { parseViralResponse } from './viral-response';

/**
 * Output budget for one detection pass. Every clip in the response carries the
 * full analysis block (hook, retention, trigger, safety incl. risky words,
 * packaging, scores) - roughly 1,500-2,000 tokens per clip. A response cut off
 * mid-JSON (or Gemini's MAX_TOKENS finish, which spends part of this budget on
 * thinking) fails every provider in the chain, so the budget is generous: it is
 * only an upper bound, never billed unless used. 40K stays well under the 65K
 * max-output of the Flash models; a request for more clips than fit is
 * completed by the top-up passes.
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

// `resolveViralOptions` lives in lib/pipeline-defaults.ts - a dependency-free
// module the browser can import too, so the settings panel clamps values exactly
// the way the server does. Re-exported here for the existing callers.
export { resolveViralOptions };

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
 *  - clips are ordered by the AI's own `rank` (1 = most viral; the viral score
 *    breaks ties),
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

  // Order by the AI's rank (viral score breaks ties), then greedily keep
  // non-overlapping clips so the "no overlapping timestamps" rule
  // survives imperfect model output. Already-kept windows (`taken`) always win;
  // new clips must dodge them.
  const ranked = [...withinBounds].sort(byRank);
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
    .map((segment, index) => ({ ...segment, clip: { ...segment.clip, rank: taken.length + index + 1 } }));
}

/** AI rank first (lower = better); the viral score breaks ties. */
function byRank(a: ViralSegment, b: ViralSegment): number {
  return a.clip.rank - b.clip.rank || b.clip.scores.viral_score - a.clip.scores.viral_score;
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
   * One LLM detection pass: ask for raw JSON, then parse + validate it against
   * the clips schema. Any problem is a clear error; `soft` (the top-up passes)
   * turns it into an empty result, since "no more clips" just means the
   * transcript is exhausted.
   */
  const runDetectionPass = async (
    prompt: string,
    clipBudget: number,
    label: string,
    soft: boolean
  ): Promise<ViralSegment[]> => {
    try {
      const result = await completeWithFallback({
        task: 'viral segment detection',
        system: templateDoc.systemPrompt,
        prompt,
        maxTokens: detectionMaxTokens(clipBudget),
        temperature: 0.5,
        json: true,
      });
      console.log(`[AI] Raw response (${result.entry.provider}/${result.entry.model})${label}:`, result.text);
      return parseViralResponse(result.text, videoDuration);
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
