import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { getDb } from './db';
import { getFfmpegPath } from './ffmpeg';
import { getPlannedTranscriptionEngine } from './whisper';

export type StartupCheckStatus = 'ok' | 'warning' | 'error';

export interface StartupCheck {
  id: string;
  label: string;
  status: StartupCheckStatus;
  summary: string;
  details?: string;
  resolution?: string;
}

export interface StartupValidationResult {
  ready: boolean;
  generatedAt: string;
  checks: StartupCheck[];
}

function hasConfiguredValue(name: string) {
  const value = process.env[name]?.trim();
  return Boolean(value && !value.includes('your_api_key'));
}

function createCheck(check: StartupCheck): StartupCheck {
  return check;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

async function spawnForOutput(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve((stdout || stderr).trim());
        return;
      }

      reject(new Error((stderr || stdout || `Exit code ${code}`).trim()));
    });
  });
}

async function validateMongo(): Promise<StartupCheck> {
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri) {
    return createCheck({
      id: 'mongodb',
      label: 'MongoDB',
      status: 'error',
      summary: 'MONGODB_URI is missing.',
      resolution: 'Set MONGODB_URI in .env.local and make sure MongoDB is running.',
    });
  }

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });

  try {
    await client.connect();
    await client.db('clipcraft').command({ ping: 1 });

    return createCheck({
      id: 'mongodb',
      label: 'MongoDB',
      status: 'ok',
      summary: 'MongoDB connection succeeded.',
      details: mongoUri,
    });
  } catch (error) {
    return createCheck({
      id: 'mongodb',
      label: 'MongoDB',
      status: 'error',
      summary: 'MongoDB connection failed.',
      details: getErrorMessage(error),
      resolution: 'Start MongoDB locally or point MONGODB_URI to a reachable MongoDB instance.',
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function validateRedis(): Promise<StartupCheck> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return createCheck({
      id: 'redis',
      label: 'Redis / BullMQ',
      status: 'error',
      summary: 'REDIS_URL is missing.',
      resolution: 'Set REDIS_URL in .env.local and start Redis before rendering clips.',
    });
  }

  let redis: Redis | null = null;

  try {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    await redis.connect();
    const pong = await redis.ping();

    return createCheck({
      id: 'redis',
      label: 'Redis / BullMQ',
      status: pong === 'PONG' ? 'ok' : 'warning',
      summary: pong === 'PONG' ? 'Redis connection succeeded.' : 'Redis responded unexpectedly.',
      details: `REDIS_URL=${redisUrl}`,
      resolution:
        pong === 'PONG' ? 'Start the worker with `npm run worker` before rendering clips.' : 'Verify your Redis instance and retry.',
    });
  } catch (error) {
    return createCheck({
      id: 'redis',
      label: 'Redis / BullMQ',
      status: 'error',
      summary: 'Redis connection failed.',
      details: getErrorMessage(error),
      resolution: 'Start Redis and confirm REDIS_URL points to it.',
    });
  } finally {
    redis?.disconnect();
  }
}

async function validateFfmpeg(): Promise<StartupCheck> {
  const ffmpegBin = getFfmpegPath();

  try {
    const versionOutput = await spawnForOutput(ffmpegBin, ['-version']);
    const firstLine = versionOutput.split('\n')[0] || ffmpegBin;

    return createCheck({
      id: 'ffmpeg',
      label: 'FFmpeg',
      status: 'ok',
      summary: 'FFmpeg is available.',
      details: firstLine,
    });
  } catch (error) {
    return createCheck({
      id: 'ffmpeg',
      label: 'FFmpeg',
      status: 'error',
      summary: 'FFmpeg is not available.',
      details: getErrorMessage(error),
      resolution: 'Install ffmpeg or set FFMPEG_PATH to a valid ffmpeg binary in .env.local.',
    });
  }
}

async function validateTranscription(): Promise<StartupCheck> {
  try {
    const engine = getPlannedTranscriptionEngine();

    if (engine.provider === 'deepgram') {
      return createCheck({
        id: 'transcription',
        label: 'Transcription engine',
        status: 'ok',
        summary: `Transcription will use ${engine.label}.`,
        details: `Model: ${engine.model}`,
      });
    }

    const whisperPath = process.env.WHISPER_CLI_PATH?.trim() || path.join(process.cwd(), 'bin', 'whisper-cli');
    const modelPath = process.env.WHISPER_MODEL_PATH?.trim() || engine.modelPath || '';

    const details = [
      `Binary: ${whisperPath}`,
      `Model: ${modelPath}`,
    ].join(' • ');

    return createCheck({
      id: 'transcription',
      label: 'Transcription engine',
      status: 'ok',
      summary: `Transcription will use ${engine.label}.`,
      details,
    });
  } catch (error) {
    return createCheck({
      id: 'transcription',
      label: 'Transcription engine',
      status: 'error',
      summary: 'No working transcription engine is configured.',
      details: getErrorMessage(error),
      resolution:
        'Configure DEEPGRAM_API_KEY or provide both WHISPER_CLI_PATH/bin/whisper-cli and WHISPER_MODEL_PATH/models/*.bin.',
    });
  }
}

async function validateAiProvider(): Promise<StartupCheck> {
  const hasGemini = hasConfiguredValue('GEMINI_API_KEY');
  const hasClaude = hasConfiguredValue('ANTHROPIC_API_KEY');

  if (!hasGemini && !hasClaude) {
    return createCheck({
      id: 'ai-provider',
      label: 'AI provider',
      status: 'error',
      summary: 'No AI provider is configured.',
      resolution: 'Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local.',
    });
  }

  const details: string[] = [];
  if (hasGemini) {
    details.push(`Gemini (${process.env.GEMINI_MODEL?.trim() || 'gemini-1.5-flash'})`);
  }
  if (hasClaude) {
    details.push('Claude (Anthropic API key configured)');
  }

  return createCheck({
    id: 'ai-provider',
    label: 'AI provider',
    status: 'ok',
    summary: `AI provider ready. Priority order: ${hasGemini ? 'Gemini first' : 'Claude first'}.`,
    details: details.join(' • '),
  });
}

async function validatePromptTemplates(): Promise<StartupCheck> {
  const requiredIds = [
    'prompt-viral-detection',
    'prompt-hook-generation',
    'prompt-cta-generation',
  ];

  try {
    const db = await getDb();
    const docs = await db
      .collection<{ _id: string }>('promptTemplates')
      .find({ _id: { $in: requiredIds } })
      .project({ _id: 1 })
      .toArray();

    const foundIds = new Set(docs.map((doc) => String(doc._id)));
    const missing = requiredIds.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      return createCheck({
        id: 'prompt-templates',
        label: 'Prompt templates',
        status: 'warning',
        summary: 'Some required prompt templates are missing in MongoDB.',
        details: `Missing: ${missing.join(', ')}`,
        resolution: 'Refresh the app or restart the server so the missing default templates can be seeded.',
      });
    }

    return createCheck({
      id: 'prompt-templates',
      label: 'Prompt templates',
      status: 'ok',
      summary: 'All required prompt templates are present.',
      details: requiredIds.join(' • '),
    });
  } catch (error) {
    return createCheck({
      id: 'prompt-templates',
      label: 'Prompt templates',
      status: 'warning',
      summary: 'Prompt templates could not be validated.',
      details: getErrorMessage(error),
      resolution: 'Fix MongoDB connectivity and refresh this page.',
    });
  }
}

async function validateWhisperAssets(): Promise<StartupCheck> {
  const customWhisper = process.env.WHISPER_CLI_PATH?.trim();
  const hasLocalWhisper = customWhisper ? fs.existsSync(customWhisper) : fs.existsSync(path.join(process.cwd(), 'bin', 'whisper-cli'));
  const modelDir = path.join(process.cwd(), 'models');
  const hasModel =
    Boolean(process.env.WHISPER_MODEL_PATH?.trim()) ||
    (fs.existsSync(modelDir) && fs.readdirSync(modelDir).some((file) => file.endsWith('.bin')));

  if (!hasLocalWhisper && !hasModel) {
    return createCheck({
      id: 'whisper-assets',
      label: 'Local Whisper assets',
      status: 'warning',
      summary: 'Local whisper.cpp assets are not present.',
      resolution: 'This is fine if you plan to use Deepgram. Otherwise add whisper-cli and a ggml model file.',
    });
  }

  return createCheck({
    id: 'whisper-assets',
    label: 'Local Whisper assets',
    status: hasLocalWhisper && hasModel ? 'ok' : 'warning',
    summary: hasLocalWhisper && hasModel ? 'Local whisper.cpp assets were found.' : 'Whisper assets are only partially configured.',
    details: `Binary found: ${hasLocalWhisper ? 'yes' : 'no'} • Model found: ${hasModel ? 'yes' : 'no'}`,
    resolution: hasLocalWhisper && hasModel ? undefined : 'Provide both whisper-cli and a compatible ggml model file to use local transcription.',
  });
}

export async function runStartupValidation(): Promise<StartupValidationResult> {
  const checks = await Promise.all([
    validateMongo(),
    validateRedis(),
    validateFfmpeg(),
    validateTranscription(),
    validateAiProvider(),
    validatePromptTemplates(),
    validateWhisperAssets(),
  ]);

  return {
    ready: checks.every((check) => check.status !== 'error'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}
