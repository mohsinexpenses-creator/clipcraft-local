import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { getVideoMetadata } from '../lib/ffmpeg';
import { CaptionPreset, WordTimestamp } from '../lib/types';

export interface RenderCaptionsOptions {
  videoPath: string;
  outputPath: string;
  hookText: string;
  hookDuration: number;
  ctaText: string;
  ctaDuration: number;
  words: WordTimestamp[];
  preset: CaptionPreset;
  onProgress?: (progress: number) => void;
}

export async function renderCaptionsAndOverlays(options: RenderCaptionsOptions): Promise<string> {
  const {
    videoPath,
    outputPath,
    hookText,
    hookDuration,
    ctaText,
    ctaDuration,
    words,
    preset,
    onProgress,
  } = options;

  console.log(`[Remotion Renderer] Rendering captions & overlays for ${videoPath}...`);
  if (onProgress) onProgress(82);

  if (!hookText.trim()) {
    throw new AppError('Caption rendering cannot start without hook text.', {
      status: 400,
      resolution: 'Generate hook text again or enter a non-empty hook text before rendering.',
    });
  }

  if (words.length === 0) {
    throw new AppError('Caption rendering cannot start without transcript words.', {
      status: 400,
      resolution: 'Re-run transcription or select a segment that overlaps spoken transcript text.',
    });
  }

  if (!ctaText.trim()) {
    throw new AppError('Caption rendering cannot start without CTA text.', {
      status: 400,
      resolution: 'Generate a CTA or enter one manually before rendering.',
    });
  }

  try {
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    const entryPoint = path.join(process.cwd(), 'remotion', 'index.tsx');
    const bundled = await bundle({ entryPoint });

    const meta = await getVideoMetadata(videoPath);
    const durationFrames = Math.max(30, Math.ceil(meta.duration * 30));

    const composition = await selectComposition({
      serveUrl: bundled,
      id: 'CaptionComposition',
      inputProps: {
        videoUrl: `file://${videoPath}`,
        hookText,
        hookDuration,
        ctaText,
        ctaDuration,
        words,
        preset,
      },
    });

    if (!composition) {
      throw new AppError('Remotion could not find the CaptionComposition.', {
        resolution: 'Verify remotion/index.tsx exports the CaptionComposition with the expected id.',
      });
    }

    await renderMedia({
      composition: {
        ...composition,
        durationInFrames: durationFrames,
      },
      serveUrl: bundled,
      outputLocation: outputPath,
      codec: 'h264',
      onProgress: ({ progress }: { progress: number }) => {
        if (onProgress) {
          onProgress(82 + Math.floor(progress * 0.16));
        }
      },
    });

    if (onProgress) onProgress(100);
    console.log(`[Remotion Renderer] Successfully rendered media to ${outputPath}`);
    return outputPath;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Remotion caption rendering failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the Remotion render logs, confirm the composition props are valid, and retry the clip render.',
    });
  }
}
