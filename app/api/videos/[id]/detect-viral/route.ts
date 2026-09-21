import { NextResponse } from 'next/server';
import { getVideo, saveClip } from '@/lib/db';
import { detectViralSegments, generateHookText } from '@/lib/gemini';
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

    console.log(`[API Detect Viral] Analyzing transcript with Gemini AI for video ${id}...`);
    const viralSegments = await detectViralSegments(
      video.transcript,
      video.duration || 60
    );

    const createdClips: ClipRecord[] = [];

    for (const seg of viralSegments) {
      const clipId = `clip_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const segText = video.transcript.segments
        .filter((s) => s.start >= seg.start - 1 && s.end <= seg.end + 1)
        .map((s) => s.text)
        .join(' ');

      const hookText = seg.hookText || (await generateHookText(segText || video.originalName));

      const clipRecord: ClipRecord = {
        _id: clipId,
        videoId: id,
        videoTitle: video.originalName,
        start: seg.start,
        end: seg.end,
        hookDuration: 3,
        hookText,
        filterPreset: 'vibrant',
        captionPresetId: 'preset-bold-yellow',
        viralScore: seg.score,
        viralReason: seg.reason,
        status: 'pending',
        progress: 0,
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
  } catch (err: any) {
    console.error('[API Detect Viral] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
