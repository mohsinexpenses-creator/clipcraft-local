import {ClipVisualOverlay, VisualAssetAttribution, VisualMomentCategory, VisualMomentPlacement, VisualMomentPlan, VisualTimelineWindow} from './types';

import { parseTimestamp } from './viral-response';

 const HOOK_TRANSITION_SECONDS = 0.5;

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



 interface HookTimelineInfo {
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

/**
 * Extracts a short, punchy 1-6 word callout headline (`text`) and optional `subtext`
 * for rendering a `keyword-pop` beat (photos never fall back to text pops).
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

/** Keep generic word/number pops only. Photo planning is exclusively sentence/entity based. */
export function normalizeGenericVisualPops(params: {
  rawMoments: unknown; clipStart: number; clipEnd: number; hookTiming?: HookTimelineInfo;
  enabled: boolean; max: number;
}): ClipVisualOverlay[] {
  if (!params.enabled || !Array.isArray(params.rawMoments)) return [];
  const result: ClipVisualOverlay[] = [];
  for (const raw of params.rawMoments as Partial<VisualMomentPlan>[]) {
    if (!raw || (raw.kind !== 'keyword-pop' && raw.kind !== 'zoom-beat') || raw.category === 'person') continue;
    const start = Math.max(params.clipStart + 0.5, parseTimestamp(raw.timestamp?.start ?? '') ?? Infinity);
    const end = Math.min(params.clipEnd, start + 3, parseTimestamp(raw.timestamp?.end ?? '') ?? -Infinity);
    if (!Number.isFinite(start) || end - start < 1 || (raw.confidence ?? 0) < 0.65) continue;
    if (result.some((ov) => start < ov.sourceEnd + 1 && end + 1 > ov.sourceStart)) continue;
    const { effectivePlacement, outputWindows } = mapVisualMomentToOutputTimeline({ sourceStart: start, sourceEnd: end,
      clipStart: params.clipStart, clipEnd: params.clipEnd, placement: 'main', hookTiming: params.hookTiming });
    if (!outputWindows.length) continue;
    result.push({ id: `pop-${result.length}-${Math.round(start * 10)}`, quote: raw.quote ?? '',
      sourceStart: start, sourceEnd: end, clipRelativeStart: start - params.clipStart, clipRelativeEnd: end - params.clipStart,
      displayDuration: end - start, outputWindows, category: raw.category ?? 'situation', entityName: raw.entity_name ?? '',
      visualIntent: raw.visual_intent ?? raw.quote ?? '', emotionalPolarity: raw.emotional_polarity ?? 'neutral',
      searchQueries: [], negativeCues: [], confidence: raw.confidence ?? 0, animation: 'pop', placement: effectivePlacement,
      framing: 'illustrative', kind: raw.kind, status: 'resolved' });
    if (result.length >= params.max) break;
  }
  return result;
}

 interface ClipCreditsManifest {
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
