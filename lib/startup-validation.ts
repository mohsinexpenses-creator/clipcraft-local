import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { getDatabase, getDatabasePath, listPromptTemplates } from './db';
import { toErrorMessage } from './errors';
import { getFfmpegPath } from './ffmpeg';
import { LLM_PROVIDER_CHAIN, llmKeysFor } from './llm';
import { loadEffectiveSettings } from './app-settings';
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

async function validateSqlite(): Promise<StartupCheck> {
  try {
    const db = getDatabase();
    const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    const busyTimeout = Number(db.pragma('busy_timeout', { simple: true }));
    const original = db.prepare('SELECT version, applied_at FROM schema_version WHERE id = 1').get() as
      | { version: number; applied_at: string }
      | undefined;
    if (!original) throw new Error('The schema_version row is missing.');

    const roundTrip = db.transaction(() => {
      const marker = `startup-check-${Date.now()}`;
      db.prepare('UPDATE schema_version SET applied_at = ? WHERE id = 1').run(marker);
      const readBack = db.prepare('SELECT applied_at FROM schema_version WHERE id = 1').get() as
        | { applied_at: string }
        | undefined;
      db.prepare('UPDATE schema_version SET applied_at = ? WHERE id = 1').run(original.applied_at);
      return readBack?.applied_at === marker;
    })();

    if (journalMode !== 'wal') throw new Error(`Expected WAL mode, found ${journalMode || 'unknown'}.`);
    if (busyTimeout !== 5000) throw new Error(`Expected busy_timeout=5000ms, found ${busyTimeout}ms.`);
    if (!roundTrip) throw new Error('SQLite write/read check did not return the written value.');

    return createCheck({
      id: 'sqlite',
      label: 'SQLite database',
      status: 'ok',
      summary: 'SQLite opened successfully; write/read and WAL checks passed.',
      details: `${getDatabasePath()} • journal_mode=${journalMode} • busy_timeout=${busyTimeout}ms • schema v${original.version}`,
    });
  } catch (error) {
    return createCheck({
      id: 'sqlite',
      label: 'SQLite database',
      status: 'error',
      summary: 'SQLite database is not ready.',
      details: toErrorMessage(error),
      resolution: `Check DATABASE_PATH (${getDatabasePath()}) and ensure the file's parent directory is writable. Restart the web process and worker after changing it.`,
    });
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
    const engine = await getPlannedTranscriptionEngine();

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
  // Keys may live in the app settings instead of the env file, so the chain is asked
  // the same question the LLM layer asks at call time.
  const pool = (await loadEffectiveSettings()).ai.geminiApiKeys;
  const entries = await Promise.all(LLM_PROVIDER_CHAIN.map(async (entry) => ({ entry, keys: await llmKeysFor(entry) })));
  const withKeys = entries.filter(({ keys }) => keys.length > 0).map(({ entry }) => entry);

  if (pool.length > 1 && withKeys.length) {
    return createCheck({
      id: 'ai-provider',
      label: 'AI provider',
      status: 'ok',
      summary:
        `LLM fallback chain ready with a ${pool.length}-key pool - first active: ${withKeys[0].provider} (${withKeys[0].model}).`,
      details: `Keys are managed in Settings -> AI providers; a rate-limited key rotates to the next one before the next model is tried.`,
    });
  }

  if (withKeys.length === 0) {
    return createCheck({
      id: 'ai-provider',
      label: 'AI provider',
      status: 'error',
      summary: 'No LLM API key is configured - the fallback chain would have nothing to call.',
      details: LLM_PROVIDER_CHAIN.map(
        (entry, index) => `${index + 1}. ${entry.provider} ${entry.model} (needs ${entry.apiKeyEnv})`
      ).join(' • '),
      resolution:
        'Add a key under Settings -> AI providers, or set GEMINI_API_KEY in .env.local ' +
        '(see .env.example) - the chain runs on Google AI Studio slots only.',
    });
  }

  const details = entries.map(
    ({ entry, keys }, index) =>
      `${index + 1}. ${entry.provider} (${entry.model}) - ${
        keys.length > 0
          ? `${keys.length} key${keys.length > 1 ? 's' : ''} available`
          : `skipped, no key for ${entry.apiKeyEnv}`
      }`
  );

  return createCheck({
    id: 'ai-provider',
    label: 'AI provider',
    status: 'ok',
    summary:
      `LLM fallback chain ready - first active: ${withKeys[0].provider} (${withKeys[0].model}); ` +
      `${withKeys.length} of ${LLM_PROVIDER_CHAIN.length} chain slots have a key.`,
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
    const templates = await listPromptTemplates();
    const foundIds = new Set(templates.map((template) => template._id));
    const missing = requiredIds.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      return createCheck({
        id: 'prompt-templates',
        label: 'Prompt templates',
        status: 'warning',
        summary: 'Some required prompt templates are missing in SQLite.',
        details: `Missing: ${missing.join(', ')}`,
        resolution: 'Restart the app or refresh this page so default templates can be seeded into SQLite.',
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
      resolution: 'Fix SQLite database access and refresh this page.',
    });
  }
}

/**
 * YuNet face-detection model for active-speaker tracking. Its absence is a
 * WARNING (renders still work with a static center crop), not an error.
 */
async function validateYunetModel(): Promise<StartupCheck> {
  const modelPath = path.join(
    process.cwd(),
    'models',
    'yunet',
    'face_detection_yunet_2023mar.onnx'
  );
  try {
    const stat = fs.statSync(modelPath);
    if (stat.isFile() && stat.size > 100_000) {
      return createCheck({
        id: 'yunet-model',
        label: 'YuNet face detection model',
        status: 'ok',
        summary: 'YuNet model present - active-speaker tracking is enabled.',
        details: modelPath,
      });
    }
    throw new Error(`file at ${modelPath} is unexpectedly small (${stat.size} bytes)`);
  } catch {
    return createCheck({
      id: 'yunet-model',
      label: 'YuNet face detection model',
      status: 'warning',
      summary: 'YuNet model not found - clips will use a static center crop instead of speaker tracking.',
      resolution: 'Run "npm run setup:yunet" to download face_detection_yunet_2023mar.onnx.',
    });
  }
}

/**
 * `createRequire` that works in both ways this code can run:
 * - the worker (tsx): `__filename` is a real path, so use it;
 * - Next.js dev (Turbopack): `__filename` is a VIRTUAL path like
 *   `/ROOT/lib/startup-validation.ts` that does not exist on disk, so requiring
 *   from it can never find node_modules (both Remotion packages were falsely
 *   reported as "not installed").
 * `process.cwd()` is the project root in every supported invocation, so it is
 * the safe fallback base.
 */
function projectRequire(): NodeJS.Require {
  if (typeof __filename === 'string' && __filename.startsWith(process.cwd())) {
    return createRequire(__filename);
  }
  return createRequire(path.join(process.cwd(), 'noop.js'));
}
/**
 * The Remotion render stage needs `@remotion/bundler` (bundling) and a writable
 * output directory. Both used to fail only minutes into a render.
 */
async function validateRemotion(): Promise<StartupCheck> {
  const problems: string[] = [];
  const nodeRequire = projectRequire();

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
    validateSqlite(),
    validateFfmpeg(),
    validateTranscription(),
    validateAiProvider(),
    validatePromptTemplates(),
    validateYunetModel(),
    validateRemotion(),
  ]);

  return {
    ready: checks.every((check) => check.status !== 'error'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}
