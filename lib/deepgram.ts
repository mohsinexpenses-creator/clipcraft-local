import fs from 'fs';
import path from 'path';
import type { TranscriptionAudioFormat } from './ffmpeg';
import { TranscriptData, TranscriptSegment, WordTimestamp } from './types';
import { AppError, RenderCancelledError, toErrorMessage } from './errors';
import { resolveDeepgram } from './app-settings';

export interface DeepgramTranscriptionOptions {
  signal?: AbortSignal;
  /** Explicit only for callers that generated an extensionless temporary file. */
  audioFormat?: TranscriptionAudioFormat;
}

/**
 * Read for each transcription job. MP3 keeps pre-recorded uploads small enough
 * for normal residential uplinks; FLAC is lossless and WAV retains the exact
 * legacy PCM behavior for diagnostics or a custom encoder issue.
 */
export function getDeepgramAudioFormat(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TranscriptionAudioFormat {
  switch (env.DEEPGRAM_AUDIO_FORMAT?.trim().toLowerCase()) {
    case 'wav':
      return 'wav';
    case 'flac':
      return 'flac';
    case 'mp3':
    case 'mpeg':
      return 'mp3';
    default:
      return 'mp3';
  }
}

export function deepgramAudioFileExtension(format: TranscriptionAudioFormat): string {
  return format;
}

export function deepgramAudioContentType(format: TranscriptionAudioFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
  }
}

/** Prefer an actual file extension so direct legacy callers keep sending WAV. */
export function deepgramAudioFormatForPath(
  audioPath: string,
  fallback = getDeepgramAudioFormat(),
): TranscriptionAudioFormat {
  switch (path.extname(audioPath).toLowerCase()) {
    case '.mp3':
    case '.mpeg':
      return 'mp3';
    case '.flac':
      return 'flac';
    case '.wav':
    case '.wave':
      return 'wav';
    default:
      return fallback;
  }
}

function formatBytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024 / 1024).toFixed(2)} MB`;
}

/** HTTP 408 SLOW_UPLOAD is transport throughput, not an API-key verdict. */
export function isDeepgramSlowUpload(status: number, details: string): boolean {
  return status === 408 && /\bSLOW_UPLOAD\b/i.test(details);
}

export function deepgramRequestFailureResolution(status: number, details: string): string {
  if (isDeepgramSlowUpload(status, details)) {
    return (
      'Deepgram timed out while receiving the audio upload. This is usually an upload-bandwidth, VPN, proxy, or very-large-audio problem — not an API-key failure. ' +
      'Retry on a stable connection. ClipCraft now extracts compact 16 kHz mono MP3 by default; set DEEPGRAM_AUDIO_FORMAT=flac for lossless input or set DEEPGRAM_AUDIO_FORMAT=wav only to restore the legacy raw-WAV path.'
    );
  }
  return 'Verify DEEPGRAM_API_KEY, account quota, and network access to api.deepgram.com, then retry.';
}

export async function transcribeWithDeepgram(
  audioPath: string,
  options: DeepgramTranscriptionOptions = {},
): Promise<TranscriptData> {
  if (options.signal?.aborted) throw new RenderCancelledError();
  // Key and model come from Settings -> AI providers, with `.env.local` underneath.
  const { apiKey, model } = await resolveDeepgram();
  if (!apiKey) {
    throw new AppError('DEEPGRAM_API_KEY is not configured.', {
      status: 500,
      resolution:
        'Add a key under Settings -> AI providers to transcribe with Deepgram.',
    });
  }

  const audioFormat = options.audioFormat ?? deepgramAudioFormatForPath(audioPath);

  try {
    const audioStat = await fs.promises.stat(audioPath);
    if (!audioStat.isFile() || audioStat.size < 1024) {
      throw new AppError('Deepgram transcription audio is missing or empty.', {
        status: 400,
        details: `${audioPath} (${audioStat.size} bytes)`,
        resolution: 'Confirm FFmpeg can extract audio from the uploaded video, then retry.',
      });
    }
    const audioBuffer = await fs.promises.readFile(audioPath);
    if (options.signal?.aborted) throw new RenderCancelledError();

    console.log(
      `[Deepgram] Sending ${formatBytes(audioStat.size)} ${audioFormat.toUpperCase()} audio ` +
        `to Deepgram REST API (${model} model)...`,
    );

    const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true&punctuate=true&paragraphs=true`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': deepgramAudioContentType(audioFormat),
        // A Buffer normally produces this automatically, but making the size
        // explicit avoids a chunked request through proxy/VPN paths.
        'Content-Length': String(audioBuffer.byteLength),
      },
      body: audioBuffer,
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new AppError('Deepgram transcription request failed.', {
        status: 502,
        details:
          `HTTP ${response.status}: ${errText} ` +
          `(upload=${formatBytes(audioStat.size)}, format=${audioFormat})`,
        resolution: deepgramRequestFailureResolution(response.status, errText),
      });
    }

    const result = await response.json();
    const channel = result?.results?.channels?.[0]?.alternatives?.[0];
    if (!channel) {
      throw new AppError('Deepgram did not return any transcription alternatives.', {
        status: 502,
        resolution:
          'Retry the upload or inspect the audio track to confirm the file contains readable speech.',
      });
    }

    const fullText = String(channel.transcript || '').trim();
    const rawWords = Array.isArray(channel.words) ? channel.words : [];

    const words: WordTimestamp[] = rawWords
      .map((rawWord: unknown) => {
        const word = rawWord as Record<string, unknown>;
        return {
          word: String(word.punctuated_word || word.word || '').trim(),
          start: Number(word.start) || 0,
          end: Number(word.end) || Number(word.start) + 0.3,
          confidence: Number(word.confidence) || 0,
        } satisfies WordTimestamp;
      })
      .filter((word: WordTimestamp) => Boolean(word.word));

    const paragraphs = result?.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];
    const segments: TranscriptSegment[] = [];

    if (paragraphs.length > 0) {
      paragraphs.forEach((rawParagraph: unknown, idx: number) => {
        const paragraph = rawParagraph as Record<string, unknown>;
        const sentences = Array.isArray(paragraph.sentences)
          ? paragraph.sentences.map((rawSentence) => {
              const sentence = rawSentence as Record<string, unknown>;
              return String(sentence.text || '').trim();
            }).filter(Boolean)
          : [];
        const segText = sentences.join(' ');
        if (!segText.trim()) return;

        segments.push({
          id: idx,
          start: Number(paragraph.start) || 0,
          end: Number(paragraph.end) || 0,
          text: segText.trim(),
        });
      });
    } else {
      const chunkSize = 15;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        if (chunk.length === 0) continue;

        segments.push({
          id: Math.floor(i / chunkSize),
          start: chunk[0].start,
          end: chunk[chunk.length - 1].end,
          text: chunk.map((w) => w.word).join(' '),
        });
      }
    }

    if (!fullText || words.length === 0 || segments.length === 0) {
      throw new AppError('Deepgram returned an incomplete transcript.', {
        status: 502,
        details: `text=${fullText.length} chars, words=${words.length}, segments=${segments.length}`,
        resolution:
          'Retry the transcription or inspect whether the uploaded file has clear spoken audio.',
      });
    }

    console.log(`[Deepgram] Successfully transcribed audio. Total words: ${words.length}`);

    return {
      text: fullText,
      segments,
      words,
    };
  } catch (error) {
    if (error instanceof RenderCancelledError || options.signal?.aborted) throw new RenderCancelledError();
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Deepgram transcription failed unexpectedly.', {
      status: 502,
      details: toErrorMessage(error),
      resolution:
        'Verify network access to api.deepgram.com and that the uploaded file contains valid audio, then retry.',
    });
  }
}
