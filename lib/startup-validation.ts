import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { resolveAiProvider } from './ai';
import { getDb } from './db';
import { toErrorMessage } from './errors';
import { getFfmpegPath } from './ffmpeg';
import { getClaudeModel, getGeminiModelName } from './models';
import {
  getPlannedTranscriptionEngine,
  getWhisperCliPath,
  getWhisperModelPath,
  getWhisperThreads,
} from './whisper';

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

function hasConfiguredValue(name: string): boolean {
  const value = process.env[name]?.trim();
  return Boolean(value && !value.includes('your_api_key'));
}

function createCheck(check: StartupCheck): StartupCheck {
  return check;
}

function spawnForOutput(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} did not respond within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

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
      resolution: 'Copy .env.example to .env.local, set MONGODB_URI, and run `npm run db:up`.',
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
      details: toErrorMessage(error),
      resolution:
        'Run `npm run db:up` (Docker) or start your local MongoDB. On Windows with Docker Desktop, use 127.0.0.1 - not localhost from inside WSL2.',
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
      resolution: 'Set REDIS_URL in .env.local and run `npm run db:up` before rendering clips.',
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
        pong === 'PONG'
          ? 'Keep the worker running with `npm run worker` - both the clip and the transcription queues need it.'
          : 'Verify your Redis instance and retry.',
    });
  } catch (error) {
    return createCheck({
      id: 'redis',
      label: 'Redis / BullMQ',
      status: 'error',
      summary: 'Redis connection failed.',
      details: toErrorMessage(error),
      resolution: 'Run `npm run db:up` and confirm REDIS_URL points at it (redis://127.0.0.1:6379).',
    });
  } finally {
    redis?.disconnect();
  }
}

async function validateFfmpeg(): Promise<StartupCheck> {
  let ffmpegBin = '';

  try {
    ffmpegBin = getFfmpegPath();
    const versionOutput = await spawnForOutput(ffmpegBin, ['-version']);
    const firstLine = versionOutput.split('\n')[0] || 'ffmpeg';

    return createCheck({
      id: 'ffmpeg',
      label: 'FFmpeg',
      status: 'ok',
      summary: 'FFmpeg is available.',
      details: `${firstLine} • ${ffmpegBin}`,
    });
  } catch (error) {
    return createCheck({
      id: 'ffmpeg',
      label: 'FFmpeg',
      status: 'error',
      summary: 'FFmpeg is not available.',
      details: `${ffmpegBin ? `${ffmpegBin} • ` : ''}${toErrorMessage(error)}`,
      resolution:
        'Re-run `npm install` so ffmpeg-static can download its binary, or set FFMPEG_PATH in .env.local to a valid ffmpeg executable.',
    });
  }
}

/**
 * Uses the SAME discovery logic as the transcription code (lib/whisper.ts).
 *
 * The old check hard-coded `bin/whisper-cli` and `models/*.bin`, so on Windows it
 * reported a green check while the real run needed `bin/whisper-win-x64/whisper-cli.exe`
 * and failed later with a confusing error.
 */
async function validateTranscription(): Promise<StartupCheck> {
  const binaryPath = getWhisperCliPath();
  const modelPath = getWhisperModelPath();

  try {
    const engine = getPlannedTranscriptionEngine();

    if (engine.provider === 'deepgram') {
      return createCheck({
        id: 'transcription',
        label: 'Transcription engine',
        status: 'ok',
        summary: `Transcription will use ${engine.label} (${engine.model}).`,
        details:
          'DEEPGRAM_API_KEY is set, so cloud transcription wins over local whisper.cpp. ' +
          `Local whisper.cpp would use: ${binaryPath || 'not found'} • ${modelPath || 'no model'}`,
      });
    }

    return createCheck({
      id: 'transcription',
      label: 'Transcription engine',
      status: 'ok',
      summary: `Transcription will use ${engine.label} (${engine.model}).`,
      details: [
        `Binary: ${engine.binaryPath}`,
        `Model: ${engine.modelPath}`,
        `Language: ${engine.language || 'auto'}`,
        `Threads: ${getWhisperThreads()}`,
        `Platform: ${process.platform}/${process.arch}`,
      ].join(' • '),
      resolution: 'Start the worker (`npm run worker`) - transcription runs in the queue now.',
    });
  } catch (error) {
    const missing: string[] = [];
    if (!binaryPath) missing.push('whisper.cpp binary');
    if (!modelPath) missing.push('ggml model file');

    return createCheck({
      id: 'transcription',
      label: 'Transcription engine',
      status: 'error',
      summary: `No usable transcription engine (${missing.join(' + ') || 'not configured'}).`,
      details: [
        toErrorMessage(error),
        `Binary search result: ${binaryPath || 'not found'}`,
        `Model search result: ${modelPath || 'not found'}`,
        `Looked for the binary at: WHISPER_CLI_PATH, ${path.join('bin', 'whisper-win-x64', 'whisper-cli.exe')}, ${path.join('bin', 'whisper-cli')}`,
        `Looked for models in: WHISPER_MODEL_PATH, ${path.join(process.cwd(), 'models')}\\ggml-*.bin`,
      ].join(' • '),
      resolution:
        'Run `npm run setup:whisper` (or `npm run setup:whisper:ps` on Windows) to download a whisper.cpp build and a ggml model, ' +
        'or set DEEPGRAM_API_KEY to transcribe in the cloud instead.',
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
      resolution: 'Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local (see .env.example).',
    });
  }

  const active = resolveAiProvider();
  const override = process.env.AI_PROVIDER?.trim();
  const details: string[] = [];

  if (hasGemini) details.push(`Gemini key present (model: ${getGeminiModelName()})`);
  if (hasClaude) details.push(`Anthropic key present (model: ${getClaudeModel()})`);
  if (override) details.push(`AI_PROVIDER override: ${override}`);
  details.push(`Active: ${active || 'none'}`);

  return createCheck({
    id: 'ai-provider',
    label: 'AI provider',
    status: active ? 'ok' : 'warning',
    summary: active
      ? `AI provider ready (${active}).`
      : 'AI keys are set but no provider could be selected.',
    details: details.join(' • '),
    resolution: active
      ? undefined
      : 'Check that AI_PROVIDER is either unset, "gemini" or "anthropic", and that the matching key is not a placeholder.',
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
      details: toErrorMessage(error),
      resolution: 'Fix MongoDB connectivity and refresh this page.',
    });
  }
}

/**
 * The Remotion render stage needs `@remotion/bundler` (bundling) and a writable
 * output directory. Both used to fail only minutes into a render.
 */
async function validateRemotion(): Promise<StartupCheck> {
  const problems: string[] = [];
  // createRequire keeps this working under both CJS and ESM execution (tsx/Next).
  const nodeRequire = createRequire(__filename);

  for (const pkg of ['@remotion/bundler', '@remotion/renderer']) {
    try {
      nodeRequire.resolve(pkg);
    } catch {
      problems.push(`${pkg} is not installed (run \`npm install\`)`);
    }
  }

  const entryPoint = path.join(process.cwd(), 'remotion', 'index.tsx');
  if (!fs.existsSync(entryPoint)) {
    problems.push(`missing Remotion entry point: ${entryPoint}`);
  }

  const outputDir = path.join(process.cwd(), 'generated-clips');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.accessSync(outputDir, fs.constants.W_OK);
  } catch (error) {
    problems.push(`generated-clips/ is not writable (${toErrorMessage(error)})`);
  }

  if (problems.length > 0) {
    return createCheck({
      id: 'remotion',
      label: 'Remotion renderer',
      status: 'error',
      summary: 'Remotion rendering is not ready.',
      details: problems.join(' • '),
      resolution:
        'Run `npm install` (it fetches @remotion/bundler and the headless browser Remotion needs), then retry.',
    });
  }

  return createCheck({
    id: 'remotion',
    label: 'Remotion renderer',
    status: 'ok',
    summary: 'Remotion bundler/renderer and the output directory are ready.',
    details: [
      `Entry: ${path.relative(process.cwd(), entryPoint)}`,
      `Output: ${path.relative(process.cwd(), outputDir)}`,
      `Concurrency: ${process.env.REMOTION_CONCURRENCY?.trim() || 'auto (half the CPU threads)'}`,
    ].join(' • '),
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
    validateRemotion(),
  ]);

  return {
    ready: checks.every((check) => check.status !== 'error'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}
