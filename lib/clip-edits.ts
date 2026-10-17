import { AppError } from './errors';
import {
  ClipLayout,
  ClipRecord,
  ClipVisualOverlay,
  VISUAL_EMOTIONAL_POLARITIES,
  VISUAL_MOMENT_CATEGORIES,
  VISUAL_MOMENT_PLACEMENTS,
  VISUAL_OVERLAY_ANIMATIONS,
} from './types';
import { DEFAULT_FILTER_PRESETS } from './presets';
import { mapVisualMomentToOutputTimeline } from './contextual-visuals';

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
 *  - unknown filter / layout values fall back to the defaults.
 */

const MAX_TEXT_LENGTH = 200;
const HOOK_DURATION_LIMITS = { min: 0, max: 30 };
const CTA_DURATION_LIMITS = { min: 0, max: 30 };
const LAYOUTS: ClipLayout[] = ['speaker-focus', 'split-screen'];
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
  | 'hookStylePresetId'
  | 'ctaStylePresetId'
  | 'autoVisuals'
  | 'visualOverlays';

 type ClipEdits = Pick<ClipRecord, ClipEditField>;

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
  if (typeof body.hookStylePresetId === 'string') edits.hookStylePresetId = body.hookStylePresetId.trim();
  if (typeof body.ctaStylePresetId === 'string') edits.ctaStylePresetId = body.ctaStylePresetId.trim();

  if (typeof body.autoVisuals === 'boolean') {
    edits.autoVisuals = body.autoVisuals;
  }

  if (Array.isArray(body.visualOverlays)) {
    const sanitizedOverlays: ClipVisualOverlay[] = [];
    for (let i = 0; i < Math.min(body.visualOverlays.length, 16); i++) {
      const item = body.visualOverlays[i];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const raw = item as Partial<ClipVisualOverlay> & Record<string, unknown>;
      const sourceStart = Number(raw.sourceStart);
      const sourceEnd = Number(raw.sourceEnd);
      if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) {
        continue;
      }
      const clipStartVal = edits.start ?? Number(sourceStart - (raw.clipRelativeStart ?? 0));
      const clipEndVal = edits.end ?? clipStartVal + 65;
      const placement = readEnum(raw.placement, VISUAL_MOMENT_PLACEMENTS, 'main');
      const animation = readEnum(raw.animation, VISUAL_OVERLAY_ANIMATIONS, 'subtle-zoom');
      const category = readEnum(raw.category, VISUAL_MOMENT_CATEGORIES, 'situation');
      const emotionalPolarity = readEnum(raw.emotionalPolarity, VISUAL_EMOTIONAL_POLARITIES, 'neutral');
      const status =
        raw.status === 'resolved' || raw.status === 'skipped' || raw.status === 'removed'
          ? raw.status
          : 'planned';

      const { effectivePlacement, outputWindows } = mapVisualMomentToOutputTimeline({
        sourceStart,
        sourceEnd,
        clipStart: Number.isFinite(clipStartVal) ? clipStartVal : sourceStart,
        clipEnd: Number.isFinite(clipEndVal) && clipEndVal > clipStartVal ? clipEndVal : sourceEnd + 30,
        placement,
        hookTiming: {
          start: 0,
          duration: edits.hookDuration ?? 0,
        },
        allowDuplicateHookReplay: placement === 'both',
      });

      sanitizedOverlays.push({
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `vm-${i + 1}`,
        quote: typeof raw.quote === 'string' ? raw.quote.trim().slice(0, 300) : '',
        sourceStart: Math.round(sourceStart * 100) / 100,
        sourceEnd: Math.round(sourceEnd * 100) / 100,
        clipRelativeStart: Math.max(0, Math.round((sourceStart - clipStartVal) * 100) / 100),
        clipRelativeEnd: Math.max(0, Math.round((sourceEnd - clipStartVal) * 100) / 100),
        displayDuration: Math.max(1.5, Math.round((sourceEnd - sourceStart) * 100) / 100),
        outputWindows,
        category,
        entityName: typeof raw.entityName === 'string' ? raw.entityName.trim().slice(0, 120) : '',
        visualIntent: typeof raw.visualIntent === 'string' ? raw.visualIntent.trim().slice(0, 300) : '',
        emotionalPolarity,
        searchQueries: Array.isArray(raw.searchQueries)
          ? raw.searchQueries
              .filter((q): q is string => typeof q === 'string' && Boolean(q.trim()))
              .map((q) => q.trim().slice(0, 120))
              .slice(0, 4)
          : [],
        negativeCues: Array.isArray(raw.negativeCues)
          ? raw.negativeCues
              .filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
              .map((c) => c.trim().slice(0, 80))
              .slice(0, 8)
          : [],
        confidence:
          typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
            ? Math.max(0, Math.min(1, raw.confidence))
            : 0.8,
        animation,
        placement: effectivePlacement,
        framing: raw.framing === 'editorial' ? 'editorial' : 'illustrative',
        status,
        ...(raw.kind === 'photo-card' || raw.kind === 'keyword-pop' || raw.kind === 'zoom-beat' ? { kind: raw.kind } : {}),
        ...(Array.isArray(raw.segmentIds) ? { segmentIds: raw.segmentIds.filter((id): id is number => Number.isInteger(id)) } : {}),
        ...(typeof raw.sentenceMeaningEn === 'string' ? { sentenceMeaningEn: raw.sentenceMeaningEn } : {}),
        ...(typeof raw.visualSubjectEn === 'string' ? { visualSubjectEn: raw.visualSubjectEn } : {}),
        ...(raw.visualKind === 'literal' || raw.visualKind === 'metaphor' ? { visualKind: raw.visualKind } : {}),
        ...(typeof raw.visualizableScore === 'number' ? { visualizableScore: raw.visualizableScore } : {}),
        ...(typeof raw.visionScore === 'number' ? { visionScore: raw.visionScore } : {}),
        ...(typeof raw.visualVerificationHash === 'string' ? { visualVerificationHash: raw.visualVerificationHash } : {}),
        ...(typeof raw.chosenQuery === 'string' ? { chosenQuery: raw.chosenQuery } : {}),
        ...(typeof raw.skipReason === 'string' ? { skipReason: raw.skipReason } : {}),
        ...(typeof raw.localFilePath === 'string' ? { localFilePath: raw.localFilePath } : {}),
        ...(typeof raw.mediaUrl === 'string' ? { mediaUrl: raw.mediaUrl } : {}),
        ...(typeof raw.contentHash === 'string' ? { contentHash: raw.contentHash } : {}),
        ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
        ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
        ...(typeof raw.relevanceScore === 'number' ? { relevanceScore: raw.relevanceScore } : {}),
        ...(raw.attribution && typeof raw.attribution === 'object'
          ? { attribution: raw.attribution }
          : {}),
      });
    }
    edits.visualOverlays = sanitizedOverlays;
  }

  return edits;
}

/** Clients edit meaning/timing, not proof of relevance or trusted local media paths. */
export function preserveVerifiedVisualMetadata(existing: ClipVisualOverlay[], edits: ClipVisualOverlay[]): ClipVisualOverlay[] {
  return edits.map((edit) => {
    const previous = existing.find((ov) => ov.id === edit.id);
    if (previous && visualMeaningKey(previous) === visualMeaningKey(edit)) {
      return { ...previous, animation: edit.animation, placement: edit.placement, outputWindows: edit.outputWindows,
        status: edit.status === 'removed' ? 'removed' : previous.status };
    }
    return { ...edit, status: edit.status === 'removed' ? 'removed' : 'planned', localFilePath: undefined, mediaUrl: undefined,
      attribution: undefined, contentHash: undefined, preparedContentHash: undefined, visualVerificationHash: undefined,
      visionScore: undefined, sentenceMeaningEn: undefined, segmentIds: undefined,
      skipReason: 'Visual meaning/timing edited; queue visual prefetch before rendering' };
  });
}

const visualMeaningKey = (ov: ClipVisualOverlay) => JSON.stringify([ov.quote, ov.visualIntent, ov.category, ov.entityName,
  ov.emotionalPolarity, ov.searchQueries, ov.negativeCues, ov.sourceStart, ov.sourceEnd]);
export const hasVisualMeaningChanges = (existing: ClipVisualOverlay[], edits: ClipVisualOverlay[]): boolean =>
  JSON.stringify(existing.map((ov) => [ov.id, visualMeaningKey(ov), ov.status === 'removed'])) !==
  JSON.stringify(edits.map((ov) => [ov.id, visualMeaningKey(ov), ov.status === 'removed']));
