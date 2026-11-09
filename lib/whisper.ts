import fs from 'fs';
import path from 'path';
import { extractAudio16kMono } from './ffmpeg';
import { AppError, RenderCancelledError } from './errors';
import { loadEffectiveSettings } from './app-settings';
import {
  deepgramAudioFileExtension,
  getDeepgramAudioFormat,
  transcribeWithDeepgram,
} from './deepgram';
import { TranscriptData } from './types';

export interface TranscriptionEngineInfo {
  provider: 'deepgram';
  label: 'Deepgram';
  model: string;
}

/**
 * Deepgram is the only supported transcription engine in this build.
 */
export async function getPlannedTranscriptionEngine(): Promise<TranscriptionEngineInfo> {
  const settings = await loadEffectiveSettings();
  const choice = settings.ai.transcriptionProvider;
  const deepgramKey = settings.ai.deepgramApiKey;

  if (choice === 'deepgram' || (choice === 'auto' && deepgramKey)) {
    if (!deepgramKey) {
      throw new AppError('Transcription is forced to Deepgram, but no API key is configured.', {
        status: 500,
        resolution:
          'Add a Deepgram key under Settings -> AI providers, or switch the provider back to "auto" to use Deepgram when a key exists.',
      });
    }

    return {
      provider: 'deepgram',
      label: 'Deepgram',
      model: settings.ai.deepgramModel || 'nova-2',
    };
  }

  throw new AppError('No Deepgram API key is configured for transcription.', {
    status: 500,
    resolution: 'Add a Deepgram key under Settings -> AI providers before uploading a video.',
  });
}

export async function transcribeVideo(
  videoPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<TranscriptData> {
  if (options.signal?.aborted) throw new RenderCancelledError();
  const videoDir = path.dirname(videoPath);
  // Raw 16 kHz WAV is about 1.9 MB/minute. Use compact speech MP3 by default
  // so long uploads do not trip Deepgram's pre-recorded SLOW_UPLOAD limit; WAV
  // remains a documented diagnostic fallback through DEEPGRAM_AUDIO_FORMAT=wav.
  const audioFormat = getDeepgramAudioFormat();
  const audioPath = path.join(
    videoDir,
    `audio_16k.${deepgramAudioFileExtension(audioFormat)}`,
  );

  await extractAudio16kMono(videoPath, audioPath, {
    signal: options.signal,
    format: audioFormat,
  });
  if (options.signal?.aborted) throw new RenderCancelledError();

  const engine = await getPlannedTranscriptionEngine();
  if (engine.provider === 'deepgram') {
    return transcribeWithDeepgram(audioPath, { ...options, audioFormat });
  }

  throw new AppError('Unsupported transcription engine.', {
    status: 500,
    resolution: 'This build only supports Deepgram transcription.',
  });
}

export function getWhisperCliPath(): string | null {
  return null;
}

export function getWhisperModelPath(): string | null {
  return null;
}

export function getWhisperLanguage(): string {
  return 'auto';
}

export function getWhisperThreads(): number {
  return 2;
}

export function getWhisperTimeoutMs(): number {
  return 60_000;
}

export function getWhisperTranscriptFile(): string {
  return path.join(process.cwd(), 'transcript_out.json');
}

// Keep a small cleanup helper for any legacy artifact paths left behind.
export function cleanupLegacyWhisperArtifacts(basePath: string): void {
  for (const suffix of ['.json', '.wav.tmp']) {
    const candidate = `${basePath}${suffix}`;
    try {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
