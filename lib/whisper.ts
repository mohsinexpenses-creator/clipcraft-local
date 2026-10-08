import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractAudio16kMono } from './ffmpeg';
import { AppError, toErrorMessage } from './errors';
import { transcribeWithDeepgram } from './deepgram';
import { loadEffectiveSettings } from './app-settings';
import { TranscriptData, TranscriptSegment, WordTimestamp } from './types';

export interface TranscriptionEngineInfo {
  provider: 'deepgram' | 'whisper.cpp';
  label: string;
  model: string;
  modelPath?: string;
  binaryPath?: string;
  language?: string;
}

/**
 * Every place a whisper.cpp CLI binary may live, in priority order.
 *
 * `bin/whisper-win-x64/` is committed to the repo (whisper-cli.exe + whisper.dll,
 * x64, MIT-licensed build published as the `whisper-cpp-static` npm package) so a
 * fresh Windows clone can transcribe without building anything.
 *
 * `.whisper/` is where `npm run setup:whisper` puts a modern official build
 * (needed for GPU, newer models and non-English languages).
 */
const BINARY_CANDIDATES: string[] = [
  path.join('bin', 'whisper-win-x64', 'whisper-cli.exe'),
  path.join('bin', 'whisper-cli.exe'),
  path.join('bin', 'whisper-cli'),
  path.join('.whisper', 'whisper-cli.exe'),
  path.join('.whisper', 'whisper-cli'),
];

const MODEL_CANDIDATES: string[] = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3.bin',
  'ggml-medium.en.bin',
  'ggml-medium.bin',
  'ggml-small.en.bin',
  'ggml-small.bin',
  'ggml-base.en.bin',
  'ggml-base.bin',
  'ggml-tiny.en.bin',
  'ggml-tiny.bin',
];

function isWindows(): boolean {
  return process.platform === 'win32';
}

function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return !v || v.includes('your_') || v.includes('changeme') || v === 'null' || v === 'undefined';
}

function existsAndIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the whisper.cpp CLI for the current OS.
 *
 * The previous implementation only ever looked for `bin/whisper-cli.exe`, so on
 * Linux/macOS it returned null unless WHISPER_CLI_PATH was set, while the startup
 * validation page checked `bin/whisper-cli` - the two disagreed and the UI could
 * show a green check for a transcription engine that could never start.
 */
export function getWhisperCliPath(): string | null {
  const customPath = process.env.WHISPER_CLI_PATH?.trim();
  if (customPath && !looksLikePlaceholder(customPath)) {
    if (existsAndIsFile(customPath)) return customPath;

    // Keep going instead of dying here: a stale path from another machine is a
    // very common .env.local leftover, and a bundled binary may still work.
    console.warn(
      `[Whisper] WHISPER_CLI_PATH="${customPath}" does not exist - falling back to the bundled/searchable locations.`
    );
  }

  for (const candidate of BINARY_CANDIDATES) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
    // On Windows never pick the extension-less Linux build, and vice versa.
    if (isWindows() && !absolute.toLowerCase().endsWith('.exe')) continue;
    if (!isWindows() && absolute.toLowerCase().endsWith('.exe')) continue;
    if (existsAndIsFile(absolute)) return absolute;
  }

  return null;
}

export function getWhisperModelPath(): string | null {
  const configuredPath = process.env.WHISPER_MODEL_PATH?.trim();
  if (configuredPath && !looksLikePlaceholder(configuredPath)) {
    if (existsAndIsFile(configuredPath)) return configuredPath;
    console.warn(
      `[Whisper] WHISPER_MODEL_PATH="${configuredPath}" does not exist - falling back to ./models.`
    );
  }

  const modelsDir = path.join(process.cwd(), 'models');
  for (const name of MODEL_CANDIDATES) {
    const candidate = path.join(modelsDir, name);
    if (existsAndIsFile(candidate)) return candidate;
  }

  return null;
}

/** `auto` keeps whisper.cpp's language detection (needed for Urdu/Hindi content). */
export function getWhisperLanguage(): string {
  const raw = process.env.WHISPER_LANGUAGE?.trim().toLowerCase();
  if (!raw || looksLikePlaceholder(raw)) return 'auto';
  return raw.replace(/^--?/, '');
}

export function getWhisperThreads(): number {
  const raw = Number(process.env.WHISPER_THREADS?.trim());
  if (!Number.isFinite(raw) || raw <= 0) {
    // Sensible default: half the cores, at least 2, at most 8.
    const cores = Math.max(2, os.cpus()?.length || 4);
    return Math.min(8, Math.max(2, Math.floor(cores / 2)));
  }
  return Math.min(32, Math.floor(raw));
}

/** Transcription can take many minutes; never let it hang the worker forever. */
function getWhisperTimeoutMs(audioSeconds: number): number {
  const configured = Number(process.env.WHISPER_TIMEOUT_MINUTES?.trim());
  if (Number.isFinite(configured) && configured > 0) return configured * 60_000;

  // Rough budget: 20x realtime for tiny/base on CPU, with a floor and a ceiling.
  const estimated = Math.max(10, Math.min(180, (audioSeconds / 60) * 20)) * 60_000;
  return estimated;
}

/**
 * Which engine a transcription would use, decided the same way the run itself decides:
 * Settings -> AI providers first, `.env.local` second. `transcriptionProvider` lets the
 * user force one engine - forced means a missing setup surfaces as an error instead of
 * quietly falling back.
 */
export async function getPlannedTranscriptionEngine(): Promise<TranscriptionEngineInfo> {
  const settings = await loadEffectiveSettings();
  const choice = settings.ai.transcriptionProvider;
  const deepgramKey = settings.ai.deepgramApiKey;

  if (choice === 'deepgram' || (choice === 'auto' && deepgramKey)) {
    if (!deepgramKey) {
      throw new AppError('Transcription is forced to Deepgram, but no Deepgram API key is configured.', {
        status: 500,
        resolution:
          'Add a key under Settings -> AI providers (or DEEPGRAM_API_KEY in .env.local), or set the provider back to "auto".',
      });
    }
    return {
      provider: 'deepgram',
      label: 'Deepgram',
      model: settings.ai.deepgramModel || 'nova-2',
    };
  }

  const whisperBin = getWhisperCliPath();
  const modelPath = getWhisperModelPath();

  if (!whisperBin) {
    throw new AppError('Local whisper.cpp binary is missing.', {
      status: 500,
      details: `platform=${process.platform} arch=${process.arch} cwd=${process.cwd()}`,
      resolution:
        'Run `npm run setup:whisper` to download a build for your OS, or set WHISPER_CLI_PATH in .env.local, ' +
        'or set DEEPGRAM_API_KEY to transcribe in the cloud instead.',
    });
  }

  if (!modelPath) {
    throw new AppError('No Whisper model file was found for local transcription.', {
      status: 500,
      details: `looked in ${path.join(process.cwd(), 'models')}`,
      resolution:
        'Run `npm run setup:whisper` (downloads a ggml model into ./models), or set WHISPER_MODEL_PATH ' +
        'in .env.local, or set DEEPGRAM_API_KEY instead.',
    });
  }

  return {
    provider: 'whisper.cpp',
    label: 'whisper.cpp',
    model: path.basename(modelPath),
    modelPath,
    binaryPath: whisperBin,
    language: getWhisperLanguage(),
  };
}

export async function transcribeVideo(videoPath: string): Promise<TranscriptData> {
  const videoDir = path.dirname(videoPath);
  const audioWavPath = path.join(videoDir, 'audio_16k.wav');
  const jsonOutBase = path.join(videoDir, 'transcript_out');
  const engine = await getPlannedTranscriptionEngine();

  console.log(`[Transcription] Extracting 16kHz mono audio from ${videoPath}...`);
  await extractAudio16kMono(videoPath, audioWavPath);

  if (engine.provider === 'deepgram') {
    console.log(`[Transcription] Using ${engine.label} (${engine.model}) for speech-to-text...`);
    return transcribeWithDeepgram(audioWavPath);
  }

  const whisperBin = engine.binaryPath ?? getWhisperCliPath();
  const modelPath = engine.modelPath ?? getWhisperModelPath();

  if (!whisperBin || !modelPath) {
    throw new AppError('whisper.cpp was selected but the local binary or model path is unavailable.', {
      status: 500,
      resolution:
        'Run `npm run setup:whisper`, or provide WHISPER_CLI_PATH + WHISPER_MODEL_PATH, or set DEEPGRAM_API_KEY.',
    });
  }

  const language = getWhisperLanguage();
  const threads = getWhisperThreads();
  const audioSeconds = await probeAudioDurationSeconds(audioWavPath);
  const timeoutMs = getWhisperTimeoutMs(audioSeconds);

  console.log(
    `[Whisper] ${whisperBin}\n` +
    `[Whisper]   model=${modelPath} language=${language} threads=${threads} audio=${audioSeconds.toFixed(1)}s`
  );

  // whisper-cli writes its JSON next to `-of`; remove a stale one first so a failed
  // run can never be mistaken for a fresh transcript.
  for (const stale of [`${jsonOutBase}.json`, audioWavPath.replace(/\.wav$/, '.wav.tmp')]) {
    try {
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    } catch {
      // Ignore - a leftover file is not fatal, we re-check the output below.
    }
  }

  try {
    const args = [
      '-m', modelPath,
      '-f', audioWavPath,
      '-l', language,
      '-ojf', // full JSON, includes per-token timestamps
      '-of', jsonOutBase,
      '-ml', '1',
      '-sow', // split on word boundaries -> cleaner karaoke captions
      '-wt', '0.01', // word-timestamp probability threshold
      '-t', String(threads),
      '-pp', // print progress so a stuck run is visible in the worker log
    ];

    await runWhisperCli(whisperBin, args, timeoutMs);

    const jsonPath = `${jsonOutBase}.json`;
    if (!fs.existsSync(jsonPath)) {
      throw new AppError('whisper-cli completed without creating transcript_out.json.', {
        resolution:
          'Inspect the whisper.cpp output in the worker log, confirm the output directory is writable, and retry. ' +
          'Older whisper.cpp builds need `-oj` instead of `-ojf`.',
      });
    }

    const rawContent = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const transcript = parseWhisperJsonOutput(parsed);

    if (!transcript.text.trim() || transcript.words.length === 0 || transcript.segments.length === 0) {
      throw new AppError('whisper.cpp returned an incomplete transcript.', {
        details: `text=${transcript.text.length} chars, words=${transcript.words.length}, segments=${transcript.segments.length}`,
        resolution:
          'Try a bigger model (`npm run setup:whisper -- --model small`), check the source audio actually contains speech, ' +
          'set WHISPER_LANGUAGE=en if the content is English, or switch to Deepgram.',
      });
    }

    console.log(
      `[Whisper] Transcript ready: ${transcript.segments.length} segments, ${transcript.words.length} words.`
    );
    return transcript;
  } catch (error) {
    if (error instanceof AppError) throw error;

    throw new AppError('Local whisper transcription failed.', {
      details: toErrorMessage(error),
      resolution:
        'Verify the whisper.cpp binary runs on this machine (Windows also needs the VC++ 2015-2022 x64 redistributable ' +
        'and whisper.dll next to whisper-cli.exe), check the model path, and retry.',
    });
  }
}

function runWhisperCli(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // whisper.cpp logs progress on stderr; surface it so long jobs are not silent.
      const progressLine = text.match(/whisper_print_progress.*?(\d+)%/);
      if (progressLine) process.stdout.write(`\r[Whisper] progress ${progressLine[1]}%   `);
    });

    child.stdout.on('data', () => {
      // Discard: the transcript is read from the JSON file, not stdout.
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new AppError('Failed to start whisper-cli.', {
          details: `${binary}: ${toErrorMessage(error)}`,
          resolution:
            'On Windows this is usually a missing whisper.dll/ggml.dll next to whisper-cli.exe or a missing ' +
            'VC++ redistributable. Run `npm run setup:whisper` to install a complete build.',
        })
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (killedByTimeout) {
        reject(
          new AppError('whisper-cli was killed because it exceeded the transcription timeout.', {
            details: `timeout=${Math.round(timeoutMs / 60000)} minutes`,
            resolution:
              'Use a smaller/faster model (`npm run setup:whisper -- --model base.en`), raise WHISPER_THREADS, ' +
              'or set WHISPER_TIMEOUT_MINUTES in .env.local.',
          })
        );
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new AppError('whisper-cli exited with a non-zero status.', {
          details: `Exit code ${code}. ${stderr.slice(-2000)}`.trim(),
          resolution:
            'Confirm the model file matches this whisper.cpp build (ggml models only), that WHISPER_LANGUAGE is valid, ' +
            'and that the extracted 16kHz WAV exists.',
        })
      );
    });
  });
}

/** Cheap duration probe so the timeout can scale with the input length. */
async function probeAudioDurationSeconds(wavPath: string): Promise<number> {
  try {
    const { size } = fs.statSync(wavPath);
    // 16kHz, mono, 16-bit PCM = 32000 bytes/second + a 44 byte header.
    return Math.max(1, (size - 44) / 32000);
  } catch {
    return 60;
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
        'Inspect transcript_out.json and confirm whisper.cpp was run with JSON output enabled (-ojf).',
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
        // Skip special tokens like [BLANK_AUDIO] / [ _TT_ ].
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
