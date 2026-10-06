/**
 * The AI response contract: exactly `{ "clips": [ViralClip, ...] }` (types in
 * lib/types.ts, schema in the viral_detection prompt). The detection call asks
 * the provider for raw JSON, so there is no repair here: the text is parsed
 * as-is, every clip is checked against the schema, and anything else is a clear
 * error that names the offending field.
 */

import { AppError } from './errors';
import {
  PSYCHOLOGICAL_TRIGGERS,
  RETENTION_STRENGTHS,
  RISKY_WORD_ACTIONS,
  SAFETY_RISKS,
  type ViralClip,
  type ViralSegment,
} from './types';

/** A clip shorter than this once clamped to the video is not usable. */
const MIN_CLIP_SECONDS = 1;

/**
 * Seconds from the timestamp strings the prompt asks for: "125.5s" or "125.5"
 * (the transcript's own style) or a clock - "02:05", "00:02:05", "00:02:05.5".
 * Anything else is null.
 */
export function parseTimestamp(value: string): number | null {
  const text = value.trim();
  const plain = /^(\d+(?:\.\d+)?)s?$/.exec(text);
  if (plain) return Number(plain[1]);

  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?(\.\d+)?$/.exec(text);
  if (!clock) return null;
  const [, first, second, third, fraction] = clock;
  const whole =
    third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return whole + (fraction ? Number(fraction) : 0);
}

type Kind = 'string' | 'number' | 'score' | 'boolean' | 'strings' | 'riskyWords' | readonly string[];

/** Every field of a ViralClip and what it must be (nested objects as dotted paths). */
const FIELDS: ReadonlyArray<readonly [path: string, kind: Kind]> = [
  ['rank', 'number'],
  ['timestamp.start', 'string'],
  ['timestamp.end', 'string'],
  ['duration.minutes', 'number'],
  ['duration.seconds', 'number'],
  ['duration.total_seconds', 'number'],
  ['why_this_will_go_viral', 'string'],
  ['hook_line_analysis.hook_line', 'string'],
  // Strings only: the hook moment is read where the renderer needs it and falls back to the clip's first seconds.
  ['hook_line_analysis.hook_timestamp.start', 'string'],
  ['hook_line_analysis.hook_timestamp.end', 'string'],
  ['hook_line_analysis.why_it_works', 'string'],
  ['hook_line_analysis.place_before_clip', 'boolean'],
  ['retention_analysis.curiosity_first_3_seconds', 'string'],
  ['retention_analysis.payoff_location', 'string'],
  ['retention_analysis.open_loop', 'boolean'],
  ['retention_analysis.likely_to_watch_till_end', 'boolean'],
  ['retention_analysis.predicted_retention', RETENTION_STRENGTHS],
  ['psychological_trigger.dominant_trigger', PSYCHOLOGICAL_TRIGGERS],
  ['psychological_trigger.explanation', 'string'],
  ['safety_analysis.risk_level', SAFETY_RISKS],
  ['safety_analysis.monetization_risk', 'string'],
  ['safety_analysis.reused_content_risk', 'string'],
  ['safety_analysis.algorithm_suppression_risk', 'string'],
  ['safety_analysis.ineligible_for_fyf_risk', 'string'],
  ['safety_analysis.risky_words', 'riskyWords'],
  ['viral_packaging.hook_text_on_video', 'string'],
  ['viral_packaging.video_title', 'string'],
  ['viral_packaging.cta_text', 'string'],
  ['viral_packaging.hashtags', 'strings'],
  ['viral_packaging.platform_safe', 'boolean'],
  ['viral_packaging.eligibility_or_reach_concerns', 'string'],
  ['viral_packaging.words_to_change', 'strings'],
  ['scores.viral_score', 'score'],
  ['scores.retention_score', 'score'],
  ['scores.controversy_score', 'score'],
  ['scores.shareability_score', 'score'],
];

const isRiskyWord = (word: unknown): boolean => {
  const entry = word as Record<string, unknown> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.word_or_phrase === 'string' &&
    RISKY_WORD_ACTIONS.includes(entry.action as (typeof RISKY_WORD_ACTIONS)[number]) &&
    typeof entry.safer_replacement === 'string'
  );
};

/** null when `value` is what `kind` requires, otherwise a description of what was required. */
function expected(value: unknown, kind: Kind): string | null {
  if (typeof kind !== 'string') return kind.includes(value as string) ? null : `one of: ${kind.join(', ')}`;
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? null : 'a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'a number';
    case 'score':
      return typeof value === 'number' && value >= 0 && value <= 10 ? null : 'a number from 0 to 10';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true or false';
    case 'strings':
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? null : 'an array of strings';
    case 'riskyWords':
      return Array.isArray(value) && value.every(isRiskyWord)
        ? null
        : `an array of { word_or_phrase, action, safer_replacement } objects (action: ${RISKY_WORD_ACTIONS.join(', ')})`;
  }
}

/** Short rendering of a bad value for error messages. */
function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The first thing wrong with `clip` as a ViralClip, or null when it matches the schema. */
function schemaProblem(clip: unknown, where: string): string | null {
  if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
    return `${where} must be an object (got ${show(clip)})`;
  }
  for (const [path, kind] of FIELDS) {
    const value = path
      .split('.')
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | null | undefined)?.[key], clip);
    const wanted = expected(value, kind);
    if (wanted) return `${where}.${path} must be ${wanted} (got ${show(value)})`;
  }
  return null;
}

const invalid = (summary: string, details?: string) =>
  new AppError(summary, {
    status: 502,
    details,
    resolution:
      'Retry the analysis. If it keeps failing, make sure the viral_detection prompt asks for the documented { "clips": [...] } JSON (Prompt Templates → Reset to defaults restores it).',
  });

/**
 * The model's text -> validated clips with their numeric render windows.
 * Throws a clear AppError if the text is not `{ "clips": [...] }` or any clip
 * does not match the schema; an end a little past the video is clamped to it.
 */
export function parseViralResponse(text: string, videoDuration: number): ViralSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid('The AI response is not valid JSON.', text.slice(0, 300));
  }

  const clips = (data as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(clips)) {
    throw invalid('The AI response must be a JSON object with a "clips" array: { "clips": [...] }.', text.slice(0, 300));
  }
  if (clips.length === 0) throw invalid('The AI response has an empty "clips" array.');

  return clips.map((clip, index) => {
    const where = `clips[${index}]`;
    const problem = schemaProblem(clip, where);
    if (problem) throw invalid(`The AI response does not match the clips schema: ${problem}.`);

    const { timestamp } = clip as ViralClip;
    const start = parseTimestamp(timestamp.start);
    const end = parseTimestamp(timestamp.end);
    if (start === null || end === null) {
      throw invalid(
        `${where}.timestamp must use seconds ("125.5s") or a clock ("02:05", "00:02:05"), got ${show(timestamp)}.`
      );
    }

    const clampedEnd = Math.min(end, videoDuration);
    if (clampedEnd - start < MIN_CLIP_SECONDS) {
      throw invalid(
        `${where}.timestamp ${show(timestamp)} must start before it ends and lie inside the ${Math.round(videoDuration)}s video.`
      );
    }
    return { start, end: clampedEnd, clip: clip as ViralClip };
  });
}
