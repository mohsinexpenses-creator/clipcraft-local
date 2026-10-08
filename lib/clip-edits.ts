import { AppError } from './errors';
import { CaptionEngine, ClipLayout, ClipRecord } from './types';
import { DEFAULT_FILTER_PRESETS } from './presets';

/**
 * The one validator for "the user edited this clip".
 *
 * `PATCH /api/clips/[id]` (save) and `POST /api/clips` (save + render) both run
 * the request body through here, so a saved edit and a re-render can never
 * disagree about what is legal - and a hand-written curl request is held to the
 * same rules as the editor UI.
 *
 * Rules that are quietly enforced in code rather than trusted from the client:
 *  - `start` / `end` are numbers inside the source video, `end > start`;
 *  - durations are clamped to what the renderer can actually do;
 *  - empty hook text means "no hook" (`hookDuration = 0`), which is the
 *    convention `worker/processor.ts` already follows;
 *  - unknown filter / layout / engine values fall back to the defaults.
 */

const MAX_TEXT_LENGTH = 200;
const HOOK_DURATION_LIMITS = { min: 0, max: 30 };
const CTA_DURATION_LIMITS = { min: 0, max: 30 };
const LAYOUTS: ClipLayout[] = ['speaker-focus', 'split-screen'];
const CAPTION_ENGINES: CaptionEngine[] = ['remotion', 'native'];
const FILTER_IDS = new Set(DEFAULT_FILTER_PRESETS.map((preset) => preset.id));

type ClipEditField =
  | 'start'
  | 'end'
  | 'hookText'
  | 'ctaText'
  | 'hookDuration'
  | 'ctaDuration'
  | 'filterPreset'
  | 'captionPresetId'
  | 'layout'
  | 'captionEngine'
  | 'hookStylePresetId'
  | 'ctaStylePresetId';

export type ClipEdits = Pick<ClipRecord, ClipEditField>;

function readNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError(`Clip field "${field}" is not a number.`, {
      status: 400,
      details: String(value),
      resolution: 'Send the timestamp in seconds (e.g. 12.5).',
    });
  }
  return n;
}

function clampDuration(value: number, limits: { min: number; max: number }, label: string): number {
  if (value < limits.min) {
    throw new AppError(`${label} cannot be negative.`, { status: 400, details: String(value) });
  }
  return Math.min(limits.max, value);
}

function readText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AppError(`Clip field "${field}" must be text.`, { status: 400 });
  }
  const trimmed = value.trim();
  return trimmed.slice(0, MAX_TEXT_LENGTH);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * @param bounds.duration source length, when known - used to keep the window
 *   inside the video instead of letting a typo produce an unrenderable clip.
 */
export function sanitizeClipEdits(
  body: Record<string, unknown>,
  bounds: { duration?: number } = {}
): Partial<ClipEdits> {
  const edits: Partial<ClipEdits> = {};

  const start = readNumber(body.start, 'start');
  const end = readNumber(body.end, 'end');
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined) {
      throw new AppError('A clip window needs both "start" and "end".', { status: 400 });
    }
    if (start < 0) {
      throw new AppError('Clip start time cannot be negative.', { status: 400, details: String(start) });
    }
    if (end <= start) {
      throw new AppError('Clip end time must be after its start time.', {
        status: 400,
        details: `start=${start}s, end=${end}s`,
        resolution: 'Widen the window - the clip needs a positive length.',
      });
    }
    if (end - start < 1) {
      throw new AppError('Clips shorter than 1 second cannot be rendered.', { status: 400 });
    }
    if (bounds.duration && bounds.duration > 0 && end > bounds.duration + 0.5) {
      throw new AppError('The clip window runs past the end of the source video.', {
        status: 400,
        details: `video=${bounds.duration.toFixed(1)}s, clip end=${end.toFixed(1)}s`,
        resolution: 'Move the end time inside the video duration.',
      });
    }
    edits.start = Number(start.toFixed(3));
    edits.end = Number(end.toFixed(3));
  }

  const hookText = readText(body.hookText, 'hookText');
  if (hookText !== undefined) edits.hookText = hookText;

  const ctaText = readText(body.ctaText, 'ctaText');
  if (ctaText !== undefined) edits.ctaText = ctaText;

  const hookDuration = readNumber(body.hookDuration, 'hookDuration');
  if (hookDuration !== undefined) {
    edits.hookDuration = clampDuration(hookDuration, HOOK_DURATION_LIMITS, 'Hook duration');
  }

  const ctaDuration = readNumber(body.ctaDuration, 'ctaDuration');
  if (ctaDuration !== undefined) {
    edits.ctaDuration = clampDuration(ctaDuration, CTA_DURATION_LIMITS, 'CTA duration');
  }

  // The renderer treats hookDuration 0 as "no hook intro, no hook overlay".
  // Keep that in one place so saving empty text and rendering nothing agree.
  if (edits.hookText !== undefined && !edits.hookText.trim()) edits.hookDuration = 0;
  else if (edits.hookText?.trim() && edits.hookDuration === undefined) edits.hookDuration = 3;

  if (edits.ctaText !== undefined && !edits.ctaText.trim()) edits.ctaDuration = 0;

  if (typeof body.filterPreset === 'string') {
    edits.filterPreset = FILTER_IDS.has(body.filterPreset) ? body.filterPreset : 'vibrant';
  }
  if (typeof body.captionPresetId === 'string') edits.captionPresetId = body.captionPresetId.trim();
  if ('layout' in body) edits.layout = readEnum(body.layout, LAYOUTS, 'speaker-focus');
  if ('captionEngine' in body) edits.captionEngine = readEnum(body.captionEngine, CAPTION_ENGINES, 'remotion');
  if (typeof body.hookStylePresetId === 'string') edits.hookStylePresetId = body.hookStylePresetId.trim();
  if (typeof body.ctaStylePresetId === 'string') edits.ctaStylePresetId = body.ctaStylePresetId.trim();

  return edits;
}
