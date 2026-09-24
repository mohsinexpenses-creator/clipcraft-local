import { NextResponse } from 'next/server';
import { getVideo, saveClip } from '@/lib/db';
import { detectViralSegments, generateCtaText, generateHookText } from '@/lib/ai';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';
import { ClipRecord } from '@/lib/types';

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

    console.log(`[API Detect Viral] Analyzing transcript with AI for video ${id}...`);
    const viralSegments = await detectViralSegments(video.transcript, video.duration);

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
      const hookText = segment.hookText || (await generateHookText(overlayTranscript));
      const ctaText = await generateCtaText(overlayTranscript);

      if (!hookText.trim()) {
        throw new AppError('AI analysis produced a clip without hook text.', {
          status: 502,
          resolution: 'Adjust the hook generation prompt and retry viral analysis.',
        });
      }

      if (!ctaText.trim()) {
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
        hookDuration: 3,
        hookText,
        ctaText,
        ctaDuration: 2.5,
        filterPreset: 'vibrant',
        captionPresetId: 'preset-bold-yellow',
        viralScore: segment.score,
        viralReason: segment.reason,
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
