import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { extractAudio16kMono } from './ffmpeg';
import { AppError, toErrorMessage } from './errors';
import { transcribeWithDeepgram } from './deepgram';
import { TranscriptData, TranscriptSegment, WordTimestamp } from './types';

export interface TranscriptionEngineInfo {
  provider: 'deepgram' | 'whisper.cpp';
  label: string;
  model: string;
  modelPath?: string;
}

export function getWhisperCliPath(): string | null {
  const customPath = process.env.WHISPER_CLI_PATH?.trim();
  if (customPath) {
    return fs.existsSync(customPath) ? customPath : null;
  }

  const localBin = path.join(process.cwd(), 'bin', 'whisper-cli.exe');
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  return null;
}

export function getWhisperModelPath(): string | null {
  const configuredPath = process.env.WHISPER_MODEL_PATH?.trim();
  if (configuredPath) {
    return fs.existsSync(configuredPath) ? configuredPath : null;
  }

  const defaultModels = [
    path.join(process.cwd(), 'models', 'ggml-base.en.bin'),
    path.join(process.cwd(), 'models', 'ggml-tiny.en.bin'),
    path.join(process.cwd(), 'models', 'ggml-base.bin'),
    path.join(process.cwd(), 'models', 'ggml-tiny.bin'),
  ];

  for (const modelPath of defaultModels) {
    if (fs.existsSync(modelPath)) return modelPath;
  }

  return null;
}

export function getPlannedTranscriptionEngine(): TranscriptionEngineInfo {
  if (process.env.DEEPGRAM_API_KEY?.trim()) {
    return {
      provider: 'deepgram',
      label: 'Deepgram',
      model: 'nova-2',
    };
  }

  const whisperBin = getWhisperCliPath();
  const modelPath = getWhisperModelPath();

  if (!whisperBin) {
    throw new AppError('Local whisper.cpp binary is missing.', {
      status: 500,
      resolution:
        'Set WHISPER_CLI_PATH to a valid whisper-cli binary, place bin/whisper-cli in the repo, or configure DEEPGRAM_API_KEY instead.',
    });
  }

  if (!modelPath) {
    throw new AppError('No Whisper model file was found for local transcription.', {
      status: 500,
      resolution:
        'Set WHISPER_MODEL_PATH to a valid ggml model file or add a model under ./models, or configure DEEPGRAM_API_KEY instead.',
    });
  }

  return {
    provider: 'whisper.cpp',
    label: 'whisper.cpp',
    model: path.basename(modelPath),
    modelPath,
  };
}

export async function transcribeVideo(videoPath: string): Promise<TranscriptData> {
  const videoDir = path.dirname(videoPath);
  const audioWavPath = path.join(videoDir, 'audio_16k.wav');
  const jsonOutBase = path.join(videoDir, 'transcript_out');
  const engine = getPlannedTranscriptionEngine();

  console.log(`[Transcription] Extracting 16kHz audio from ${videoPath}...`);
  await extractAudio16kMono(videoPath, audioWavPath);

  if (engine.provider === 'deepgram') {
    console.log(`[Transcription] Using ${engine.label} (${engine.model}) for speech-to-text...`);
    return transcribeWithDeepgram(audioWavPath);
  }

  const whisperBin = getWhisperCliPath();
  const modelPath = getWhisperModelPath();

  if (!whisperBin || !modelPath) {
    throw new AppError('whisper.cpp was selected but the local binary or model path is unavailable.', {
      status: 500,
      resolution:
        'Provide a valid whisper-cli binary and model file, or configure DEEPGRAM_API_KEY instead.',
    });
  }

  console.log(`[Whisper] Executing local whisper-cli with model ${modelPath}...`);

  try {
    const args = [
      '-m', modelPath,
      '-f', audioWavPath,
      '-ojf',
      '-of', jsonOutBase,
      '-ml', '1',
      '-sow',
      '-t', '4',
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(whisperBin, args);
      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new AppError('whisper-cli exited with a non-zero status.', {
            details: `Exit code ${code}. ${stderr}`.trim(),
            resolution:
              'Verify WHISPER_CLI_PATH, WHISPER_MODEL_PATH, and that the model matches your whisper.cpp binary version.',
          })
        );
      });

      child.on('error', (error) => {
        reject(
          new AppError('Failed to start whisper-cli.', {
            details: toErrorMessage(error),
            resolution:
              'Make sure the whisper-cli binary exists and is executable, then retry transcription.',
          })
        );
      });
    });

    const jsonPath = `${jsonOutBase}.json`;
    if (!fs.existsSync(jsonPath)) {
      throw new AppError('whisper-cli completed without creating transcript_out.json.', {
        resolution:
          'Inspect the whisper.cpp logs, confirm the output directory is writable, and retry transcription.',
      });
    }

    const rawContent = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const transcript = parseWhisperJsonOutput(parsed);

    if (!transcript.text.trim() || transcript.words.length === 0 || transcript.segments.length === 0) {
      throw new AppError('whisper.cpp returned an incomplete transcript.', {
        details: `text=${transcript.text.length} chars, words=${transcript.words.length}, segments=${transcript.segments.length}`,
        resolution:
          'Try a different Whisper model, inspect the source audio quality, or switch to Deepgram transcription.',
      });
    }

    return transcript;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Local whisper transcription failed.', {
      details: toErrorMessage(error),
      resolution:
        'Verify the whisper.cpp binary, model path, and extracted audio file, then retry transcription.',
    });
  }
}

function parseWhisperJsonOutput(raw: Record<string, unknown>): TranscriptData {
  const words: WordTimestamp[] = [];
  const segments: TranscriptSegment[] = [];
  let fullText = '';

  const rawSegments = raw.transcription || raw.segments || [];
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new AppError('whisper.cpp JSON did not contain any transcript segments.', {
      resolution:
        'Inspect the transcript_out.json file and confirm whisper.cpp was run with JSON output enabled.',
    });
  }

  rawSegments.forEach((rawSegment: unknown, idx: number) => {
    const segment = rawSegment as Record<string, unknown>;
    const timestamps = (segment.timestamps || {}) as Record<string, unknown>;
    const offsets = (segment.offsets || {}) as Record<string, unknown>;
    const segStart =
      (timestamps.from ? parseTimeMs(timestamps.from) : Number(segment.from || offsets.from || 0)) / 1000;
    const segEnd =
      (timestamps.to ? parseTimeMs(timestamps.to) : Number(segment.to || offsets.to || 0)) / 1000;
    const text = String(segment.text || '').trim();

    if (!text) return;

    fullText += (fullText ? ' ' : '') + text;
    segments.push({
      id: idx,
      start: segStart,
      end: segEnd,
      text,
    });

    const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
    if (tokens.length > 0) {
      tokens.forEach((rawToken: unknown) => {
        const token = rawToken as Record<string, unknown>;
        const tokenTimestamps = (token.timestamps || {}) as Record<string, unknown>;
        const wordText = String(token.text || token.word || '').trim();
        if (!wordText || wordText.startsWith('[')) return;

        const wordStart =
          (tokenTimestamps.from
            ? parseTimeMs(tokenTimestamps.from)
            : Number(token.from || segStart * 1000)) / 1000;
        const wordEnd =
          (tokenTimestamps.to ? parseTimeMs(tokenTimestamps.to) : Number(token.to || segEnd * 1000)) /
          1000;
        words.push({
          word: wordText,
          start: wordStart,
          end: Math.max(wordStart + 0.1, wordEnd),
        });
      });
    } else {
      const wordList = text.split(/\s+/).filter(Boolean);
      if (wordList.length === 0) return;

      const duration = Math.max(0.5, segEnd - segStart);
      const timePerWord = duration / wordList.length;
      wordList.forEach((word: string, index: number) => {
        words.push({
          word,
          start: segStart + index * timePerWord,
          end: segStart + (index + 1) * timePerWord,
        });
      });
    }
  });

  return {
    text: fullText,
    segments,
    words: words.length > 0 ? words : synthesizeWordsFromSegments(segments),
  };
}

function parseTimeMs(value: unknown): number {
  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const match = value.match(/(\d+):(\d+):(\d+)[\.,](\d+)/);
    if (match) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const s = parseInt(match[3], 10);
      const ms = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10);
      return h * 3600000 + m * 60000 + s * 1000 + ms;
    }
  }

  return 0;
}

function synthesizeWordsFromSegments(segments: TranscriptSegment[]): WordTimestamp[] {
  const words: WordTimestamp[] = [];

  segments.forEach((seg) => {
    const list = seg.text.split(/\s+/).filter(Boolean);
    if (list.length === 0) return;

    const segDuration = Math.max(0.5, seg.end - seg.start);
    const perWord = segDuration / list.length;
    list.forEach((word, index) => {
      words.push({
        word,
        start: seg.start + index * perWord,
        end: seg.start + (index + 1) * perWord,
      });
    });
  });

  return words;
}
