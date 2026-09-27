import { NextResponse } from 'next/server';
import { getVideo, saveClip } from '@/lib/db';
import { detectViralSegments, generateCtaText, generateHookText, resolveViralOptions } from '@/lib/ai';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { ClipRecord, DEFAULT_VIRAL_OPTIONS, ViralDetectionOptions } from '@/lib/types';

/** Hard UI/API bounds for the per-run viral detection options.
 * maxClipDuration is intentionally NOT user-configurable anymore: it is fixed
 * at DEFAULT_VIRAL_OPTIONS.maxClipDuration (600s) - the UI only exposes the
 * minimum.
 */
const OPTION_LIMITS = {
  clipCount: { min: 1, max: 25 },
  minClipDuration: { min: 5, max: 600 },
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Reads the per-run options from the request body. Values are clamped (never
 * trusted raw) and every field falls back to the shared defaults so an empty
 * body still produces a valid run.
 */
function readViralOptions(body: Record<string, unknown>): Required<ViralDetectionOptions> {
  const raw = (body.options ?? body) as Record<string, unknown>;
  return resolveViralOptions({
    clipCount: clampNumber(
      raw.clipCount,
      10,
      OPTION_LIMITS.clipCount.min,
      OPTION_LIMITS.clipCount.max
    ),
    minClipDuration: clampNumber(
      raw.minClipDuration,
      60,
      OPTION_LIMITS.minClipDuration.min,
      OPTION_LIMITS.minClipDuration.max
    ),
    // Fixed internal bound - ignore whatever the client sends (stale
    // localStorage values from the old UI included a max input).
    maxClipDuration: DEFAULT_VIRAL_OPTIONS.maxClipDuration,
    includeHookText:
      typeof raw.includeHookText === 'boolean' ? raw.includeHookText : raw.includeHookText === 'false' ? false : true,
    includeCta:
      typeof raw.includeCta === 'boolean' ? raw.includeCta : raw.includeCta === 'false' ? false : true,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideo(id);

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    if (!video.transcript) {
      return NextResponse.json(
        { error: 'Video has no transcript available yet. Please transcribe first.' },
        { status: 400 }
      );
    }

    if (!video.transcript.segments.length || !video.transcript.words.length) {
      throw new AppError('The saved transcript is incomplete and cannot be used for viral analysis.', {
        status: 400,
        resolution: 'Re-run transcription so the video has timestamped transcript segments and words.',
      });
    }

    if (!video.duration || video.duration <= 0) {
      throw new AppError('Video duration is missing, so viral analysis cannot be timed correctly.', {
        status: 500,
        resolution: 'Re-upload the source video so FFmpeg can extract valid metadata.',
      });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // Empty body is fine - every option falls back to its default.
    }
    const options = readViralOptions(body);

    if (video.duration < options.minClipDuration) {
      throw new AppError(
        `The video (${Math.round(video.duration)}s) is shorter than the minimum clip length (${options.minClipDuration}s).`,
        {
          status: 400,
          resolution: 'Lower the minimum clip length in the AI clip options, or upload a longer video.',
        }
      );
    }

    console.log(
      `[API Detect Viral] Analyzing transcript with AI for video ${id} ` +
        `(up to ${options.clipCount} clips, min ${options.minClipDuration}s, max ${options.maxClipDuration}s ` +
        `(fixed), hook text ${options.includeHookText ? 'on' : 'off'}, ` +
        `CTA ${options.includeCta ? 'on' : 'off'})...`
    );
    const viralSegments = await detectViralSegments(video.transcript, video.duration, options);

    if (!viralSegments.length) {
      throw new AppError('AI analysis returned zero viral segments.', {
        status: 502,
        resolution: 'Adjust the prompt template or retry with a transcript that contains clearer spoken content.',
      });
    }

    const createdClips: ClipRecord[] = [];

    for (const segment of viralSegments) {
      const clipId = `clip_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const segmentTranscript = video.transcript.segments
        .filter((entry) => entry.start >= segment.start - 1 && entry.end <= segment.end + 1)
        .map((entry) => entry.text)
        .join(' ')
        .trim();

      const overlayTranscript = segmentTranscript || video.transcript.text;

      // Hook text: skipped entirely when the option is off. When on, the viral
      // prompt's own hookText is preferred (it already passed the packaging
      // analysis) and the dedicated hook template is only the fallback.
      const hookText = options.includeHookText
        ? segment.hookText || (await generateHookText(overlayTranscript))
        : '';

      if (options.includeHookText && !hookText.trim()) {
        throw new AppError('AI analysis produced a clip without hook text.', {
          status: 502,
          resolution: 'Adjust the hook generation prompt and retry viral analysis.',
        });
      }

      // Same idea for the CTA: the viral prompt returns `ctaText` per clip, so
      // the separate CTA call only runs when the model left it out. When the
      // CTA switch is off we skip generation entirely and mark the clip with
      // ctaDuration 0 (the renderer then skips the CTA overlay).
      const ctaText = options.includeCta
        ? segment.ctaText || (await generateCtaText(overlayTranscript))
        : '';

      if (options.includeCta && !ctaText.trim()) {
        throw new AppError('AI analysis produced a clip without CTA text.', {
          status: 502,
          resolution: 'Adjust the CTA generation prompt and retry viral analysis.',
        });
      }

      const clipRecord: ClipRecord = {
        _id: clipId,
        videoId: id,
        videoTitle: video.originalName,
        start: segment.start,
        end: segment.end,
        // hookDuration 0 means "no hook intro / no hook overlay" downstream.
        hookDuration: options.includeHookText ? 3 : 0,
        hookText,
        ctaText,
        // 0 = no CTA overlay (CTA switch was off for this run).
        ctaDuration: options.includeCta ? 2.5 : 0,
        filterPreset: 'vibrant',
        captionPresetId: 'preset-bold-yellow',
        viralScore: segment.score,
        viralReason: segment.reason,
        title: segment.title,
        hookLine: segment.hookLine,
        hashtags: segment.hashtags,
        retentionStrength: segment.retentionStrength,
        psychologicalTrigger: segment.psychologicalTrigger,
        safetyRisk: segment.safetyRisk,
        safetyNotes: segment.safetyNotes,
        scores: segment.scores,
        status: 'pending',
        progress: 0,
        error: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveClip(clipRecord);
      createdClips.push(clipRecord);
    }

    return NextResponse.json({
      success: true,
      clips: createdClips,
    });
  } catch (error) {
    console.error('[API Detect Viral] Error:', error);
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to detect viral segments.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
