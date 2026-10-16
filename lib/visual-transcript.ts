import crypto from 'node:crypto';
import type { TranscriptData } from './types';

export function numberedVisualSegments(transcript: TranscriptData, start: number, end: number) {
  return transcript.segments.map((segment, index) => ({
    id: index + 1, start: Math.max(start, segment.start), end: Math.min(end, segment.end), text: segment.text,
  })).filter((segment) => segment.end > segment.start);
}

export const hashVisualTranscript = (transcript: TranscriptData, start: number, end: number): string =>
  crypto.createHash('sha256').update(JSON.stringify(numberedVisualSegments(transcript, start, end))).digest('hex');
