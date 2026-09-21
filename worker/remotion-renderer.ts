import path from 'path';
import fs from 'fs';
import { CaptionPreset, WordTimestamp } from '../lib/types';
import { runFfmpeg, getVideoMetadata } from '../lib/ffmpeg';

export interface RenderCaptionsOptions {
  videoPath: string; // The ffmpeg-processed video path
  outputPath: string;
  hookText: string;
  hookDuration: number;
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
    words,
    preset,
    onProgress,
  } = options;

  console.log(`[Remotion Renderer] Rendering captions & overlays for ${videoPath}...`);
  if (onProgress) onProgress(82);

  try {
    const { bundle } = require('@remotion/bundler');
    const { renderMedia, selectComposition } = require('@remotion/renderer');

    const entryPoint = path.join(process.cwd(), 'remotion', 'index.tsx');
    const bundled = await bundle({
      entryPoint,
      webpackOverride: (config: any) => config,
    });

    const meta = await getVideoMetadata(videoPath);
    const durationFrames = Math.max(30, Math.ceil(meta.duration * 30));

    const composition = await selectComposition({
      serveUrl: bundled,
      id: 'CaptionComposition',
      inputProps: {
        videoUrl: `file://${videoPath}`,
        hookText,
        hookDuration,
        words,
        preset,
      },
    });

    await renderMedia({
      composition,
      serveUrl: bundled,
      outputLocation: outputPath,
      codec: 'h264',
      onProgress: ({ progress }: { progress: number }) => {
        if (onProgress) {
          onProgress(82 + Math.floor(progress * 0.16)); // 82% -> 98%
        }
      },
    });

    if (onProgress) onProgress(100);
    console.log(`[Remotion Renderer] Successfully rendered media to ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.warn('[Remotion Renderer] Remotion headless render encountered an issue, falling back to FFmpeg subtitling overlay:', err);
    return renderFfmpegCaptionsFallback(options);
  }
}

async function renderFfmpegCaptionsFallback(options: RenderCaptionsOptions): Promise<string> {
  const {
    videoPath,
    outputPath,
    hookText,
    hookDuration,
    words,
    preset,
    onProgress,
  } = options;

  const tempDir = path.dirname(outputPath);
  const srtPath = path.join(tempDir, `subtitles_${Date.now()}.srt`);

  // Generate SRT subtitle file from shifted transcript words
  let srtContent = '';
  let subIndex = 1;

  if (hookDuration > 0 && hookText) {
    srtContent += `${subIndex++}\n00:00:00,000 --> ${formatSrtTime(hookDuration)}\n${hookText.toUpperCase()}\n\n`;
  }

  const chunkSize = 4;
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const startTime = chunk[0].start + hookDuration;
    const endTime = chunk[chunk.length - 1].end + hookDuration;
    const text = chunk.map((w) => w.word).join(' ');

    srtContent += `${subIndex++}\n${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n${preset.uppercase ? text.toUpperCase() : text}\n\n`;
  }

  fs.writeFileSync(srtPath, srtContent, 'utf-8');

  const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fontColor = preset.textColor.replace('#', '0x');
  const strokeColor = preset.strokeColor.replace('#', '0x');

  const vfFilter = `subtitles='${escapedSrtPath}':force_style='FontSize=${Math.floor(preset.fontSize * 0.6)},PrimaryColour=&H00${fontColor.slice(-6)}&,OutlineColour=&H00${strokeColor.slice(-6)}&,BorderStyle=1,Outline=${preset.strokeWidth},Alignment=2,MarginV=120'`;

  const meta = await getVideoMetadata(videoPath);

  const args = [
    '-y',
    '-i', videoPath,
    '-vf', vfFilter,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-c:a', 'copy',
    outputPath,
  ];

  await runFfmpeg(args, {
    totalDurationSeconds: meta.duration,
    onProgress: (p) => {
      if (onProgress && p.percent) {
        onProgress(82 + Math.floor(p.percent * 0.16));
      }
    },
  });

  try {
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
  } catch (e) {
    // ignore
  }

  if (onProgress) onProgress(100);
  console.log(`[FFmpeg Captions Fallback] Rendered final clip with burned captions to ${outputPath}`);
  return outputPath;
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
