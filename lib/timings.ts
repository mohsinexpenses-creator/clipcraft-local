import fs from 'fs';
import path from 'path';

export interface ClipRenderTimingRecord {
  timestamp: string;
  clipId: string;
  videoId: string;
  durationSeconds: number;
  encoder: 'x264' | 'nvenc' | 'qsv';
  preset: string;
  prepMs: number;
  visualsResolveMs: number;
  remotionOverlayMs: number;
  ffmpegEncodeMs: number;
  totalMs: number;
}

export function resolveTimingsLogPath(customPath?: string): string {
  if (customPath?.trim()) return path.resolve(customPath.trim());
  const envPath = process.env.CLIPCRAFT_TIMINGS_PATH?.trim();
  if (envPath) return path.resolve(envPath);
  return path.resolve(process.cwd(), 'data', 'timings.jsonl');
}

export function formatClipTimingSummary(record: ClipRenderTimingRecord): string {
  return (
    `[timings] clip=${record.clipId} video=${record.videoId} dur=${record.durationSeconds.toFixed(1)}s ` +
    `encoder=${record.encoder}(${record.preset}) ` +
    `total=${Math.round(record.totalMs)}ms ` +
    `(prep=${Math.round(record.prepMs)}ms, visuals=${Math.round(record.visualsResolveMs)}ms, ` +
    `remotion=${Math.round(record.remotionOverlayMs)}ms, ffmpeg=${Math.round(record.ffmpegEncodeMs)}ms)`
  );
}

export function appendClipTimingRecord(
  record: ClipRenderTimingRecord,
  customPath?: string
): string {
  const targetPath = resolveTimingsLogPath(customPath);
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const normalized: ClipRenderTimingRecord = {
    ...record,
    prepMs: Math.round(record.prepMs),
    visualsResolveMs: Math.round(record.visualsResolveMs),
    remotionOverlayMs: Math.round(record.remotionOverlayMs),
    ffmpegEncodeMs: Math.round(record.ffmpegEncodeMs),
    totalMs: Math.round(record.totalMs),
  };
  fs.appendFileSync(targetPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return targetPath;
}
