import {
  ClipVisualOverlay,
  DEFAULT_RENDER_SETTINGS,
  DEFAULT_VIRAL_OPTIONS,
  TranscriptData,
  VISUAL_BEAT_KINDS,
  VISUAL_EMOTIONAL_POLARITIES,
  VISUAL_MOMENT_CATEGORIES,
  VISUAL_MOMENT_PLACEMENTS,
  VISUAL_OVERLAY_ANIMATIONS,
  VisualAssetAttribution,
  VisualBeatKind,
  VisualEmotionalPolarity,
  VisualMomentCategory,
  VisualMomentPlacement,
  VisualMomentPlan,
  VisualOverlayAnimation,
  VisualTimelineWindow,
} from './types';
import { OPTION_LIMITS } from './pipeline-defaults';
import { parseTimestamp } from './viral-response';

export const HOOK_TRANSITION_SECONDS = 0.5;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'she',
  'so',
  'some',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);



function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function tokenizeContentWords(text: string): string[] {
  return tokenizeWords(text).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}



function isUrlLike(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('ftp://') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('data:')
  );
}

function sanitizeSearchQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || isUrlLike(cleaned) || cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.slice(0, 120));
    if (out.length >= 4) break;
  }
  return out;
}

function sanitizeNegativeCues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.slice(0, 80));
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeConfidence(value: unknown): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < 0 || num > 10) return null;
  const normalized = num > 1 ? num / 10 : num;
  return round2(Math.max(0, Math.min(1, normalized)));
}

function normalizeCategory(value: unknown): VisualMomentCategory | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((VISUAL_MOMENT_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as VisualMomentCategory;
  }
  if (normalized === 'event' || normalized === 'historical_event' || normalized === 'cultural_event') {
    return 'named_event';
  }
  if (normalized === 'location' || normalized === 'city' || normalized === 'country') {
    return 'place';
  }
  if (normalized === 'public_figure' || normalized === 'celebrity') {
    return 'person';
  }
  if (normalized === 'scene' || normalized === 'consequence') {
    return 'situation';
  }
  return null;
}

function normalizePolarity(value: unknown): VisualEmotionalPolarity {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as VisualEmotionalPolarity;
    if ((VISUAL_EMOTIONAL_POLARITIES as readonly string[]).includes(normalized)) {
      return normalized;
    }
  }
  return 'neutral';
}

function normalizeAnimation(value: unknown, fallback: VisualOverlayAnimation): VisualOverlayAnimation {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as VisualOverlayAnimation;
    if ((VISUAL_OVERLAY_ANIMATIONS as readonly string[]).includes(normalized)) {
      return normalized;
    }
  }
  return fallback;
}

function normalizePlacement(value: unknown): VisualMomentPlacement {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as VisualMomentPlacement;
    if ((VISUAL_MOMENT_PLACEMENTS as readonly string[]).includes(normalized)) {
      return normalized;
    }
  }
  return 'main';
}

export interface TranscriptMatchResult {
  matched: boolean;
  start: number;
  end: number;
  wordCount: number;
}

/**
 * Matches a quote or phrase reference against the clip's transcript words and segments.
 * Returns the matched source-video interval and word count so single-word matches never
 * dictate a 1-word display duration.
 */
export function matchQuoteInTranscript(
  quote: string,
  clipStart: number,
  clipEnd: number,
  transcript?: TranscriptData
): TranscriptMatchResult | null {
  if (!transcript) return null;

  const quoteTokens = tokenizeWords(quote);
  const quoteContent = tokenizeContentWords(quote);
  if (quoteTokens.length === 0) return null;

  const clipWords = (transcript.words ?? []).filter(
    (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= clipStart - 1 && w.start <= clipEnd + 1
  );
  const clipSegments = (transcript.segments ?? []).filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > clipStart && s.start < clipEnd
  );

  if (clipWords.length === 0 && clipSegments.length === 0) {
    return null;
  }

  // 1. Try contiguous or sliding-window match over word-level timestamps.
  if (clipWords.length > 0 && quoteTokens.length > 0) {
    const normalizedClipWords = clipWords.map((w) => ({
      raw: w,
      tokens: tokenizeWords(w.word),
    }));

    // Exact sequence match when words are tokenized one-per-word
    const flatWords: Array<{ token: string; start: number; end: number }> = [];
    for (const item of normalizedClipWords) {
      for (const token of item.tokens) {
        flatWords.push({ token, start: item.raw.start, end: item.raw.end });
      }
    }

    if (flatWords.length >= quoteTokens.length) {
      let bestScore = 0;
      let bestStartIdx = -1;
      let bestEndIdx = -1;
      const windowLen = quoteTokens.length;

      for (let i = 0; i <= flatWords.length - windowLen; i++) {
        let matches = 0;
        for (let j = 0; j < windowLen; j++) {
          if (flatWords[i + j].token === quoteTokens[j]) {
            matches += 1;
          }
        }
        const ratio = matches / windowLen;
        if (ratio > bestScore) {
          bestScore = ratio;
          bestStartIdx = i;
          bestEndIdx = i + windowLen - 1;
        }
      }

      if (bestScore >= 0.6 && bestStartIdx >= 0) {
        return {
          matched: true,
          start: Math.max(clipStart, flatWords[bestStartIdx].start),
          end: Math.min(clipEnd, flatWords[bestEndIdx].end),
          wordCount: quoteTokens.length,
        };
      }
    }
  }

  // 2. Try segment-level match (common when word timestamps are coarse or phrase is summarized).
  if (clipSegments.length > 0) {
    const normalizedQuote = quoteTokens.join(' ');
    for (const seg of clipSegments) {
      const segTokens = tokenizeWords(seg.text);
      const segJoined = segTokens.join(' ');
      if (segJoined.includes(normalizedQuote) || normalizedQuote.includes(segJoined)) {
        return {
          matched: true,
          start: Math.max(clipStart, seg.start),
          end: Math.min(clipEnd, seg.end),
          wordCount: Math.max(quoteTokens.length, segTokens.length),
        };
      }
    }

    if (quoteContent.length > 0) {
      let bestSeg: { start: number; end: number; overlap: number; segWordCount: number } | null = null;
      for (const seg of clipSegments) {
        const segSet = new Set(tokenizeContentWords(seg.text));
        const hits = quoteContent.filter((tok) => segSet.has(tok)).length;
        const overlap = hits / quoteContent.length;
        if (overlap >= 0.5 && (!bestSeg || overlap > bestSeg.overlap)) {
          bestSeg = {
            start: Math.max(clipStart, seg.start),
            end: Math.min(clipEnd, seg.end),
            overlap,
            segWordCount: tokenizeWords(seg.text).length,
          };
        }
      }
      if (bestSeg) {
        return {
          matched: true,
          start: bestSeg.start,
          end: bestSeg.end,
          wordCount: Math.max(quoteTokens.length, bestSeg.segWordCount),
        };
      }
    }
  }

  return { matched: false, start: 0, end: 0, wordCount: 0 };
}

export interface HookTimelineInfo {
  /** Offset in seconds from `clipStart` where the replayed hook begins. */
  start: number;
  /** Duration in seconds of the replayed hook (`0` when disabled). */
  duration: number;
}

/**
 * Maps a source-video visual moment `[sourceStart, sourceEnd]` within `[clipStart, clipEnd]`
 * onto the final rendered clip timeline: `[replayed hook][0.5s dip][full segment]`.
 *
 * Defaults to showing visuals in the main segment only unless `placement === 'hook'` or
 * `allowDuplicateHookReplay` is explicitly enabled for `'both'`, preventing jarring duplicate pop-ins.
 */
export function mapVisualMomentToOutputTimeline(params: {
  sourceStart: number;
  sourceEnd: number;
  clipStart: number;
  clipEnd: number;
  placement: VisualMomentPlacement;
  hookTiming?: HookTimelineInfo;
  allowDuplicateHookReplay?: boolean;
}): {
  effectivePlacement: VisualMomentPlacement;
  outputWindows: VisualTimelineWindow[];
} {
  const {
    sourceStart,
    sourceEnd,
    clipStart,
    clipEnd,
    placement,
    hookTiming,
    allowDuplicateHookReplay = false,
  } = params;

  const hookDuration = hookTiming && hookTiming.duration > 0 ? hookTiming.duration : 0;
  const hookStartOffset = hookTiming?.start ?? 0;
  const transition = hookDuration > 0 ? Math.min(HOOK_TRANSITION_SECONDS, hookDuration / 2) : 0;
  const transitionStart = Math.max(0, hookDuration - transition);
  const transitionEnd = hookDuration > 0 ? hookDuration + transition : 0;
  const clipDuration = Math.max(0, clipEnd - clipStart);
  const totalOutputDuration = hookDuration + clipDuration;

  const relStart = Math.max(0, Math.min(clipDuration, sourceStart - clipStart));
  const relEnd = Math.max(relStart, Math.min(clipDuration, sourceEnd - clipStart));
  const beatSpan = Math.max(0, relEnd - relStart);

  const mainStart = Math.max(transitionEnd, hookDuration + relStart);
  const mainEnd = Math.min(totalOutputDuration, Math.max(mainStart + beatSpan, hookDuration + relEnd));

  const mainWindow: VisualTimelineWindow = {
    segment: 'main',
    start: round2(mainStart),
    end: round2(mainEnd),
  };

  if (hookDuration <= 0) {
    return {
      effectivePlacement: 'main',
      outputWindows: [mainWindow],
    };
  }

  const hookSourceStart = clipStart + hookStartOffset;
  const hookSourceEnd = hookSourceStart + hookDuration;

  const computeHookWindow = (): VisualTimelineWindow | null => {
    const overlapStart = Math.max(hookSourceStart, sourceStart);
    const overlapEnd = Math.min(hookSourceEnd, sourceEnd);
    const maxHookEnd = Math.max(0.5, transitionStart);
    if (overlapEnd - overlapStart >= 1.0 && maxHookEnd > 0.5) {
      const startInHook = Math.max(0, Math.min(maxHookEnd - 0.5, overlapStart - hookSourceStart));
      const endInHook = Math.min(maxHookEnd, Math.max(startInHook + 1.0, overlapEnd - hookSourceStart));
      if (endInHook > startInHook) {
        return {
          segment: 'hook',
          start: round2(startInHook),
          end: round2(endInHook),
        };
      }
    }
    if (placement === 'hook' && maxHookEnd >= 1.2) {
      return {
        segment: 'hook',
        start: 0.1,
        end: round2(maxHookEnd),
      };
    }
    return null;
  };

  if (placement === 'hook') {
    const hookWin = computeHookWindow();
    if (hookWin && hookWin.end > hookWin.start) {
      return {
        effectivePlacement: 'hook',
        outputWindows: [hookWin],
      };
    }
    return {
      effectivePlacement: 'main',
      outputWindows: [mainWindow],
    };
  }

  if (placement === 'both' && allowDuplicateHookReplay) {
    const hookWin = computeHookWindow();
    if (hookWin && hookWin.end > hookWin.start) {
      return {
        effectivePlacement: 'both',
        outputWindows: [hookWin, mainWindow],
      };
    }
  }

  return {
    effectivePlacement: 'main',
    outputWindows: [mainWindow],
  };
}

function querySimilarity(a: ClipVisualOverlay, b: ClipVisualOverlay): number {
  if (a.entityName && b.entityName && a.entityName.toLowerCase() === b.entityName.toLowerCase()) {
    return 1;
  }
  const tokensA = new Set(
    tokenizeContentWords(`${a.entityName} ${a.visualIntent} ${a.searchQueries.join(' ')}`)
  );
  const tokensB = new Set(
    tokenizeContentWords(`${b.entityName} ${b.visualIntent} ${b.searchQueries.join(' ')}`)
  );
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

export interface PlanClipVisualMomentsOptions {
  autoVisuals?: boolean;
  maxVisualMoments?: number;
  confidenceThreshold?: number;
  minDuration?: number;
  defaultDuration?: number;
  defaultAnimation?: VisualOverlayAnimation;
  allowDuplicateHookReplay?: boolean;
  /** When true (or when maxVisualMoments >= 8 and transcript is present), fills uncovered ~4.5-5s windows with keyword-pop beats. */
  fillDensityGaps?: boolean;
}

function normalizeBeatKind(value: unknown): VisualBeatKind {
  if (
    typeof value === 'string' &&
    VISUAL_BEAT_KINDS.includes(value as VisualBeatKind)
  ) {
    return value as VisualBeatKind;
  }
  return 'photo-card';
}

/**
 * Extracts a short, punchy 1-6 word callout headline (`text`) and optional `subtext`
 * for rendering a `keyword-pop` beat (or a `photo-card` beat that fell back to a keyword pop).
 */
export function extractKeywordPopCallout(
  overlay: Pick<ClipVisualOverlay, 'entityName' | 'visualIntent' | 'quote' | 'searchQueries'>
): { text: string; subtext?: string } {
  const stripInstructionPrefix = (val: string): string =>
    val
      .replace(
        /^(?:please\s+)?(?:show|display|illustrate|depict|feature|use|render|include|present)\s+(?:something\s+like\s+|a\s+photo\s+of\s+|an?\s+image\s+of\s+|a\s+picture\s+of\s+|a\s+visual\s+of\s+|a\s+scene\s+of\s+|a\s+shot\s+of\s+)?/i,
        ''
      )
      .replace(/^(?:something\s+like|a?\s*photo\s+of|an?\s*image\s+of|a?\s*picture\s+of|visual\s+of)\s+/i, '')
      .trim();

  const entity = stripInstructionPrefix((overlay.entityName ?? '').trim());
  const intent = stripInstructionPrefix((overlay.visualIntent ?? '').trim());
  const quote = (overlay.quote ?? '').trim();
  const query = stripInstructionPrefix((overlay.searchQueries?.[0] ?? '').trim());

  // Prefer short explicit entity/stat if <= 36 chars
  if (entity && entity.length <= 36) {
    const sub =
      quote && quote.toLowerCase() !== entity.toLowerCase()
        ? quote.split(/[.;!?]/)[0].trim().slice(0, 56)
        : undefined;
    return { text: entity.toUpperCase(), subtext: sub };
  }

  // Otherwise condense quote/query/intent into 2-5 high-signal content words
  const source = quote || query || intent;
  const numberMatch = source.match(
    /(?:\$?\d[\d,.]*(?:\s*(?:%|percent|million|billion|thousand|k|m|x|hours|days|years|seconds|minutes))?)/i
  );
  const words = source
    .replace(/[^\p{L}\p{N}$%\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const contentWords = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));

  let headline = '';
  if (numberMatch && contentWords.length > 0) {
    const rest = contentWords
      .filter((w) => !numberMatch[0].toLowerCase().includes(w.toLowerCase()))
      .slice(0, 3)
      .join(' ');
    headline = `${numberMatch[0]} ${rest}`.trim();
  } else if (contentWords.length > 0) {
    headline = contentWords.slice(0, 4).join(' ');
  } else {
    headline = words.slice(0, 4).join(' ');
  }

  const cleanHeadline = (headline || 'KEY MOMENT').slice(0, 36).toUpperCase();
  const cleanSubtext =
    quote && quote.length > cleanHeadline.length + 6
      ? quote.split(/[.;!?]/)[0].trim().slice(0, 64)
      : undefined;

  return { text: cleanHeadline, subtext: cleanSubtext };
}

/**
 * Validates, aligns, deduplicates, and maps Gemini's `visualMoments` plan for a single clip.
 * Invalid, out-of-clip, unmatched, or low-confidence moments are safely skipped without error.
 */
export function planClipVisualMoments(params: {
  rawMoments: unknown;
  clipStart: number;
  clipEnd: number;
  transcript?: TranscriptData;
  hookTiming?: HookTimelineInfo;
  options?: PlanClipVisualMomentsOptions;
}): ClipVisualOverlay[] {
  const { rawMoments, clipStart, clipEnd, transcript, hookTiming, options } = params;

  const autoVisuals = options?.autoVisuals ?? DEFAULT_RENDER_SETTINGS.autoVisuals;
  const maxVisualMoments = Math.min(
    OPTION_LIMITS.maxVisualMoments.max,
    Math.max(
      OPTION_LIMITS.maxVisualMoments.min,
      Math.round(options?.maxVisualMoments ?? DEFAULT_VIRAL_OPTIONS.maxVisualMoments)
    )
  );
  if (!autoVisuals || maxVisualMoments <= 0) return [];
  if (!Array.isArray(rawMoments) || rawMoments.length === 0) return [];

  const clipDuration = clipEnd - clipStart;
  if (!Number.isFinite(clipDuration) || clipDuration < 2) return [];

  const confidenceThreshold = Math.min(
    OPTION_LIMITS.visualConfidence.max,
    Math.max(
      OPTION_LIMITS.visualConfidence.min,
      options?.confidenceThreshold ?? DEFAULT_VIRAL_OPTIONS.visualConfidenceThreshold
    )
  );
  const minDuration = Math.min(
    OPTION_LIMITS.visualDuration.max,
    Math.max(OPTION_LIMITS.visualDuration.min, options?.minDuration ?? DEFAULT_RENDER_SETTINGS.visualMinDuration)
  );
  const defaultDuration = Math.min(
    OPTION_LIMITS.visualDuration.max,
    Math.max(
      minDuration,
      options?.defaultDuration ?? DEFAULT_RENDER_SETTINGS.visualDefaultDuration
    )
  );
  const defaultAnimation = options?.defaultAnimation ?? DEFAULT_RENDER_SETTINGS.visualAnimation;
  const maxAllowedBeatDuration = Math.max(minDuration, Math.min(8, clipDuration * 0.65));

  const candidates: ClipVisualOverlay[] = [];

  for (let idx = 0; idx < rawMoments.length; idx++) {
    const raw = rawMoments[idx];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const item = raw as Partial<VisualMomentPlan> & Record<string, unknown>;

    const category = normalizeCategory(item.category);
    if (!category) continue;

    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const visualIntent = typeof item.visual_intent === 'string' ? item.visual_intent.trim() : '';
    const entityName = typeof item.entity_name === 'string' ? item.entity_name.trim() : '';

    // Named entities (person / place / named_event) require an explicit entity_name.
    if ((category === 'person' || category === 'place' || category === 'named_event') && !entityName) {
      continue;
    }

    // Reject single-word noun triggers that have no sentence/scene context.
    const contextWords = tokenizeContentWords(`${quote} ${visualIntent}`);
    if (contextWords.length < 2) continue;

    const confidence = normalizeConfidence(item.confidence);
    if (confidence === null || confidence < confidenceThreshold) continue;

    let searchQueries = sanitizeSearchQueries(item.search_queries);
    if (searchQueries.length === 0 && (entityName || visualIntent)) {
      const fallbackQuery = [entityName, visualIntent]
        .filter(Boolean)
        .join(' ')
        .replace(/https?:\/\/\S+/gi, '')
        .trim()
        .slice(0, 90);
      if (fallbackQuery && !isUrlLike(fallbackQuery)) {
        searchQueries = [fallbackQuery];
      }
    }
    if (searchQueries.length === 0) continue;

    const negativeCues = sanitizeNegativeCues(item.negative_cues);
    const emotionalPolarity = normalizePolarity(item.emotional_polarity);
    const animation = normalizeAnimation(item.animation, defaultAnimation);
    const requestedPlacement = normalizePlacement(item.placement);

    // Parse AI timestamps
    const tsObj =
      typeof item.timestamp === 'object' && item.timestamp !== null
        ? (item.timestamp as { start?: unknown; end?: unknown })
        : {};
    const parsedStart = typeof tsObj.start === 'string' ? parseTimestamp(tsObj.start) : null;
    const parsedEnd = typeof tsObj.end === 'string' ? parseTimestamp(tsObj.end) : null;

    // Validate against transcript words/segments when transcript is available
    const transcriptMatch = quote ? matchQuoteInTranscript(quote, clipStart, clipEnd, transcript) : null;
    if (transcript && (transcript.words?.length || transcript.segments?.length) && quote) {
      if (!transcriptMatch || !transcriptMatch.matched) {
        // Quote does not appear in this clip's transcript -> reject unmatched moment
        continue;
      }
    }

    let beatStart: number | null = parsedStart;
    let beatEnd: number | null = parsedEnd;

    if (transcriptMatch?.matched) {
      if (
        beatStart === null ||
        beatStart < clipStart - 2 ||
        beatStart > clipEnd + 2 ||
        Math.abs(beatStart - transcriptMatch.start) > 5
      ) {
        beatStart = transcriptMatch.start;
      } else {
        beatStart = Math.max(clipStart, Math.min(beatStart, transcriptMatch.start));
      }
      if (beatEnd === null || beatEnd <= beatStart || beatEnd > clipEnd + 2) {
        beatEnd = transcriptMatch.end;
      } else {
        beatEnd = Math.max(beatEnd, transcriptMatch.end);
      }
    }

    if (beatStart === null || beatEnd === null) continue;

    // Reject moments completely outside the clip window (with 1s tolerance for boundary words)
    if (beatEnd <= clipStart + 0.2 || beatStart >= clipEnd - 0.2) {
      continue;
    }

    beatStart = Math.max(clipStart, beatStart);
    beatEnd = Math.min(clipEnd, beatEnd);

    // Never allow a single-word or 1-second flash duration: expand to a full semantic beat.
    const rawSpan = beatEnd - beatStart;
    const rawSuggested =
      typeof item.suggested_duration === 'number' && Number.isFinite(item.suggested_duration)
        ? item.suggested_duration
        : defaultDuration;
    const targetDuration = Math.min(
      maxAllowedBeatDuration,
      Math.max(
        minDuration,
        rawSuggested >= minDuration ? rawSuggested : Math.max(defaultDuration, rawSpan)
      )
    );

    let finalStart = beatStart;
    let finalEnd = finalStart + targetDuration;
    if (finalEnd > clipEnd) {
      finalEnd = clipEnd;
      finalStart = Math.max(clipStart, finalEnd - targetDuration);
    }

    const displayDuration = round2(finalEnd - finalStart);
    if (displayDuration < Math.min(1.5, minDuration)) {
      continue;
    }

    const { effectivePlacement, outputWindows } = mapVisualMomentToOutputTimeline({
      sourceStart: round2(finalStart),
      sourceEnd: round2(finalEnd),
      clipStart,
      clipEnd,
      placement: requestedPlacement,
      hookTiming,
      allowDuplicateHookReplay: options?.allowDuplicateHookReplay ?? false,
    });

    const framing: 'illustrative' | 'editorial' =
      category === 'person' || category === 'place' || category === 'named_event'
        ? 'editorial'
        : 'illustrative';
    const kind = normalizeBeatKind(item.kind);

    candidates.push({
      id: `vm-${idx + 1}-${Math.round(finalStart * 10)}`,
      quote: quote || visualIntent,
      sourceStart: round2(finalStart),
      sourceEnd: round2(finalEnd),
      clipRelativeStart: round2(finalStart - clipStart),
      clipRelativeEnd: round2(finalEnd - clipStart),
      displayDuration,
      outputWindows,
      category,
      entityName,
      visualIntent: visualIntent || quote,
      emotionalPolarity,
      searchQueries,
      negativeCues,
      confidence,
      animation,
      placement: effectivePlacement,
      framing,
      kind,
      status: kind === 'keyword-pop' ? 'resolved' : 'planned',
    });
  }

  if (candidates.length === 0) return [];

  // Merge repeated mentions of the same idea / entity
  const merged: ClipVisualOverlay[] = [];
  for (const candidate of candidates) {
    const existingIdx = merged.findIndex((other) => {
      const sim = querySimilarity(other, candidate);
      if (sim >= 0.55) return true;
      const timeOverlap =
        Math.min(other.sourceEnd, candidate.sourceEnd) - Math.max(other.sourceStart, candidate.sourceStart);
      if (timeOverlap > -2.5 && other.category === candidate.category && sim >= 0.35) {
        return true;
      }
      return false;
    });

    if (existingIdx === -1) {
      merged.push(candidate);
      continue;
    }

    const existing = merged[existingIdx];
    const primary = candidate.confidence > existing.confidence ? candidate : existing;
    const secondary = primary === candidate ? existing : candidate;

    const combinedQueries = sanitizeSearchQueries([
      ...primary.searchQueries,
      ...secondary.searchQueries,
    ]);
    const combinedNegative = sanitizeNegativeCues([
      ...primary.negativeCues,
      ...secondary.negativeCues,
    ]);

    const mergedStart = primary.sourceStart;
    const mergedEnd = primary.sourceEnd;
    const mergedPlacement: VisualMomentPlacement =
      existing.placement === 'hook' || candidate.placement === 'hook'
        ? 'hook'
        : primary.placement;

    const { effectivePlacement, outputWindows } = mapVisualMomentToOutputTimeline({
      sourceStart: round2(mergedStart),
      sourceEnd: round2(mergedEnd),
      clipStart,
      clipEnd,
      placement: mergedPlacement,
      hookTiming,
      allowDuplicateHookReplay: options?.allowDuplicateHookReplay ?? false,
    });

    merged[existingIdx] = {
      ...primary,
      sourceStart: round2(mergedStart),
      sourceEnd: round2(mergedEnd),
      clipRelativeStart: round2(mergedStart - clipStart),
      clipRelativeEnd: round2(mergedEnd - clipStart),
      displayDuration: round2(mergedEnd - mergedStart),
      outputWindows,
      placement: effectivePlacement,
      searchQueries: combinedQueries.length > 0 ? combinedQueries : primary.searchQueries,
      negativeCues: combinedNegative,
      confidence: Math.max(existing.confidence, candidate.confidence),
    };
  }

  // Rank by confidence descending, then pick up to `maxVisualMoments` non-overlapping beats
  const byConfidence = [...merged].sort(
    (a, b) => b.confidence - a.confidence || a.sourceStart - b.sourceStart
  );

  const selected: ClipVisualOverlay[] = [];
  const MIN_BEAT_GAP_SECONDS = maxVisualMoments > 4 ? 1.0 : 1.5;

  for (const item of byConfidence) {
    if (selected.length >= maxVisualMoments) break;
    const conflicts = selected.some((chosen) => {
      if (chosen.placement === 'hook' && item.placement === 'main') return false;
      if (chosen.placement === 'main' && item.placement === 'hook') return false;
      return (
        item.sourceStart < chosen.sourceEnd + MIN_BEAT_GAP_SECONDS &&
        item.sourceEnd + MIN_BEAT_GAP_SECONDS > chosen.sourceStart
      );
    });
    if (!conflicts) {
      selected.push(item);
    }
  }

  return selected
    .sort((a, b) => a.sourceStart - b.sourceStart)
    .map((item, index) => ({
      ...item,
      id: `vm-${index + 1}-${Math.round(item.sourceStart * 10)}`,
    }));
}

/** Legacy API: normalize existing moments only. Never invent transcript-keyword photos. */
export function ensureDensePhotoMomentsForClip(params: {
  overlays: ClipVisualOverlay[];
  clipStart: number;
  clipEnd: number;
  transcript?: TranscriptData;
  hookTiming?: HookTimelineInfo;
  maxVisualMoments?: number;
  minDuration?: number;
  defaultDuration?: number;
  defaultAnimation?: VisualOverlayAnimation;
}): ClipVisualOverlay[] {
  return params.overlays.slice(0, params.maxVisualMoments ?? DEFAULT_RENDER_SETTINGS.maxVisualMoments);
}

export interface ClipCreditsManifest {
  clipId: string;
  videoId: string;
  clipTitle?: string;
  generatedAt: string;
  usesPexels: boolean;
  pexelsNotice?: {
    text: string;
    url: string;
  };
  credits: Array<{
    overlayId: string;
    outputTimeRange: string;
    sourceTimeRange: string;
    category: VisualMomentCategory;
    framing: 'illustrative' | 'editorial';
    attribution: VisualAssetAttribution;
  }>;
  plainText: string;
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

/**
 * Builds the downloadable and copyable attribution/credits manifest for a clip.
 * Preserves license, creator, title, source URL, and Pexels link requirements.
 */
export function buildClipCreditsManifest(params: {
  clipId: string;
  videoId: string;
  clipTitle?: string;
  visualOverlays?: ClipVisualOverlay[];
}): ClipCreditsManifest {
  const { clipId, videoId, clipTitle, visualOverlays = [] } = params;
  const resolved = visualOverlays.filter(
    (overlay): overlay is ClipVisualOverlay & { attribution: VisualAssetAttribution } =>
      overlay.status === 'resolved' && Boolean(overlay.attribution)
  );

  const usesPexels = resolved.some((item) => item.attribution.provider === 'pexels');
  const credits = resolved.map((overlay) => {
    const mainWin = overlay.outputWindows[0] ?? {
      segment: 'main' as const,
      start: overlay.clipRelativeStart,
      end: overlay.clipRelativeEnd,
    };
    return {
      overlayId: overlay.id,
      outputTimeRange: `${formatSeconds(mainWin.start)} - ${formatSeconds(mainWin.end)}`,
      sourceTimeRange: `${formatSeconds(overlay.sourceStart)} - ${formatSeconds(overlay.sourceEnd)}`,
      category: overlay.category,
      framing: overlay.framing,
      attribution: overlay.attribution,
    };
  });

  const lines: string[] = [];
  lines.push(`ClipCraft Visual Attribution Credits${clipTitle ? ` — ${clipTitle}` : ''}`);
  lines.push(`Clip ID: ${clipId}`);
  lines.push('');

  if (credits.length === 0) {
    lines.push('No external contextual visual assets were used in this clip.');
  } else {
    if (usesPexels) {
      lines.push('Photos provided by Pexels (https://www.pexels.com)');
      lines.push('');
    }
    for (const entry of credits) {
      const attr = entry.attribution;
      lines.push(
        `[${entry.outputTimeRange}] "${attr.title}" by ${attr.creator || 'Unknown Creator'} (${attr.provider})`
      );
      lines.push(`  Attribution: ${attr.attributionText}`);
      lines.push(`  License: ${attr.license}${attr.licenseUrl ? ` (${attr.licenseUrl})` : ''}`);
      lines.push(`  Source: ${attr.sourcePageUrl}`);
      if (attr.creatorUrl) {
        lines.push(`  Creator URL: ${attr.creatorUrl}`);
      }
      if (attr.shareAlike) {
        lines.push('  Note: Licensed under ShareAlike (CC BY-SA). Derivative works must carry a compatible license.');
      }
      lines.push('');
    }
  }

  return {
    clipId,
    videoId,
    ...(clipTitle ? { clipTitle } : {}),
    generatedAt: new Date().toISOString(),
    usesPexels,
    ...(usesPexels
      ? {
          pexelsNotice: {
            text: 'Photos provided by Pexels',
            url: 'https://www.pexels.com',
          },
        }
      : {}),
    credits,
    plainText: lines.join('\n').trim(),
  };
}

/** Generic pops stay; a named person's identity must never become a photo-fallback word pop. */
export function isNamedPersonKeywordPop(overlay: ClipVisualOverlay, moments: ClipVisualOverlay[]): boolean {
  if (overlay.kind !== 'keyword-pop') return false;
  if (overlay.category === 'person' || overlay.primaryEntity?.type === 'person') return true;
  const names = moments.flatMap((moment) => [
    ...(moment.category === 'person' ? [moment.entityName] : []),
    ...(moment.entities ?? []).filter((entity) => entity.type === 'person').map((entity) => entity.name),
  ]).filter(Boolean);
  const words = new Set(`${overlay.quote} ${overlay.visualIntent}`.toLowerCase().match(/[a-z]+/g) ?? []);
  return names.some((name) => name.toLowerCase().split(/\s+/).some((word) => word.length > 2 && words.has(word)));
}
