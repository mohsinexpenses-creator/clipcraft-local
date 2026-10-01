#!/usr/bin/env node
/**
 * ClipCraft local transcription setup.
 *
 * Downloads (on YOUR machine, not in CI):
 *   1. a whisper.cpp CLI binary for your platform   -> .whisper/
 *   2. a ggml model (default: ggml-small.bin)       -> models/
 * and then writes WHISPER_CLI_PATH / WHISPER_MODEL_PATH into .env.local.
 *
 * Usage:
 *   node scripts/setup-whisper.mjs                      # defaults
 *   node scripts/setup-whisper.mjs --model base.en      # smaller/faster English-only model
 *   node scripts/setup-whisper.mjs --model large-v3-turbo # best quality, ~1.6GB
 *   node scripts/setup-whisper.mjs --skip-binary        # only download the model
 *   node scripts/setup-whisper.mjs --hf-mirror          # use hf-mirror.com (China/blocked HF)
 *
 * No npm dependencies: uses Node 18+ built-in fetch.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHISPER_DIR = path.join(ROOT, '.whisper');
const MODELS_DIR = path.join(ROOT, 'models');
const ENV_FILE = path.join(ROOT, '.env.local');

const GITHUB_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_MIRROR_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';

/** Approximate model sizes, used only for the progress message. */
const MODEL_SIZES_MB = {
  tiny: 75, 'tiny.en': 75, 'tiny-q5_1': 57,
  base: 142, 'base.en': 142, 'base-q5_1': 91,
  small: 466, 'small.en': 466, 'small-q5_1': 181,
  medium: 1460, 'medium.en': 1460, 'medium-q5_0': 515,
  'large-v1': 2900, 'large-v2': 2900, 'large-v3': 2900, 'large-v3-turbo': 1620,
};

function log(msg) {
  process.stdout.write(`[setup-whisper] ${msg}\n`);
}

function fail(msg, hint) {
  process.stderr.write(`\n[setup-whisper] ERROR: ${msg}\n`);
  if (hint) process.stderr.write(`[setup-whisper] ${hint}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { model: 'small', skipBinary: false, hfMirror: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') { out.model = argv[i + 1]; i += 1; }
    else if (arg === '--skip-binary') out.skipBinary = true;
    else if (arg === '--hf-mirror') out.hfMirror = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') {
      log('See the comment block at the top of scripts/setup-whisper.mjs for all flags.');
      process.exit(0);
    }
  }
  if (!out.model) fail('--model needs a value, e.g. --model base.en');
  out.model = String(out.model).replace(/^ggml-/, '').replace(/\.bin$/, '');
  return out;
}

/** Stream a URL to disk with a simple progress readout. Works through proxies that break HEAD. */
async function downloadToFile(url, dest, label) {
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  log(`Downloading ${label}...\n           ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    fail(
      `Network request failed: ${error.message}`,
      'If you are behind a corporate proxy/VPN, download the file manually (the URL is printed above) ' +
      'and set WHISPER_CLI_PATH / WHISPER_MODEL_PATH in .env.local to point at it.'
    );
  }

  if (!res.ok || !res.body) {
    fail(`HTTP ${res.status} for ${url}`, 'Check the URL/model name and your network connection.');
  }

  const total = Number(res.headers.get('content-length') || 0);
  const expectedMb = total ? (total / 1024 / 1024).toFixed(1) : null;
  const started = Date.now();
  let received = 0;
  let lastPrint = 0;

  const fileStream = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      received += buf.length;
      fileStream.write(buf);

      const now = Date.now();
      if (now - lastPrint > 1000) {
        lastPrint = now;
        const mb = (received / 1024 / 1024).toFixed(1);
        const secs = Math.max(1, (now - started) / 1000);
        const speed = (received / 1024 / 1024 / secs).toFixed(1);
        const pct = total ? ` (${Math.round((received / total) * 100)}%)` : '';
        process.stdout.write(`\r[setup-whisper]   ${mb}${expectedMb ? `/${expectedMb}` : ''} MB${pct} @ ${speed} MB/s   `);
      }
    }
  } finally {
    await new Promise((resolve) => fileStream.end(resolve));
  }
  process.stdout.write('\n');

  if (received === 0) fail(`Downloaded 0 bytes from ${url}`);
  fs.renameSync(tmp, dest);
  log(`Saved ${dest} (${(received / 1024 / 1024).toFixed(1)} MB)`);
  return dest;
}

function isWindows() {
  return process.platform === 'win32';
}

/** Find the whisper CLI executable inside an extracted release folder. */
function findWhisperBinary(dir) {
  const wanted = isWindows() ? 'whisper-cli.exe' : 'whisper-cli';
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === wanted) return full;
    }
  }
  return null;
}

async function installWindowsBinary() {
  let release;
  try {
    const res = await fetch(GITHUB_API, {
      redirect: 'follow',
      headers: { 'user-agent': 'clipcraft-setup', accept: 'application/vnd.github+json' },
    });
    if (!res.ok) fail(`GitHub API returned HTTP ${res.status}`, 'Try again later or download whisper.cpp manually.');
    release = await res.json();
  } catch (error) {
    fail(`Could not reach the GitHub API: ${error.message}`, 'Download whisper.cpp manually and set WHISPER_CLI_PATH.');
  }

  const tag = release.tag_name;
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const asset = (release.assets || []).find((a) =>
    a.name.toLowerCase().includes('windows') && a.name.toLowerCase().includes(arch) && a.name.toLowerCase().endsWith('.zip')
  );

  if (!asset) {
    fail(
      `Release ${tag} has no windows-${arch} zip asset.`,
      `Open https://github.com/ggml-org/whisper.cpp/releases/tag/${tag} and download the Windows build manually.`
    );
  }

  const zipPath = path.join(WHISPER_DIR, `whisper-${tag}-windows-${arch}.zip`);
  await downloadToFile(asset.browser_download_url, zipPath, `whisper.cpp ${tag} (windows-${arch})`);

  const extractDir = path.join(WHISPER_DIR, `whisper-${tag}-windows-${arch}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  log('Extracting with PowerShell Expand-Archive...');
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
    { stdio: 'inherit' }
  );
  if (ps.status !== 0) {
    fail('Expand-Archive failed.', `Extract ${zipPath} manually into ${extractDir} and re-run with --skip-binary.`);
  }

  const bin = findWhisperBinary(extractDir);
  if (!bin) fail(`whisper-cli.exe was not found inside ${extractDir}`, 'Inspect the zip and set WHISPER_CLI_PATH manually.');

  // whisper-cli.exe needs its sibling DLLs (ggml.dll / whisper.dll) -> keep the whole folder.
  log(`Found binary: ${bin}`);
  fs.rmSync(zipPath, { force: true });
  return bin;
}

async function installUnixBinary() {
  // whisper.cpp does not publish prebuilt macOS/Linux binaries, so building from
  // source is the reliable route. (The repo ships a Windows x64 build only.)
  // Escape hatch: if you built whisper.cpp yourself and dropped `whisper-cli`
  // into bin/, use it as-is.
  const bundled = path.join(ROOT, 'bin', 'whisper-cli');
  if (fs.existsSync(bundled)) {
    log(`Using the local binary: ${bundled}`);
    log('If it fails to run (glibc/CPU mismatch), rebuild whisper.cpp and set WHISPER_CLI_PATH.');
    return bundled;
  }

  log('No prebuilt whisper.cpp binary is published for this platform.');
  log('Build it once with:');
  log('  git clone https://github.com/ggml-org/whisper.cpp');
  log('  cd whisper.cpp && cmake -B build && cmake --build build --config Release -j');
  log('Then point WHISPER_CLI_PATH at build/bin/whisper-cli');
  return null;
}

/** Insert or replace a KEY=VALUE line in .env.local without touching anything else. */
function upsertEnvVar(key, value) {
  let content = '';
  if (fs.existsSync(ENV_FILE)) content = fs.readFileSync(ENV_FILE, 'utf-8');

  const line = `${key}=${value}`;
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(line);
  }

  fs.writeFileSync(ENV_FILE, `${lines.join(os.EOL)}${os.EOL}`, 'utf-8');
  log(`.env.local -> ${line}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  log(`Platform: ${process.platform} ${os.arch()} | Node ${process.version}`);
  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // ---- 1. binary -------------------------------------------------------
  let binaryPath = null;
  if (!opts.skipBinary) {
    binaryPath = isWindows() ? await installWindowsBinary() : await installUnixBinary();
    if (binaryPath) {
      if (!isWindows() && !fs.existsSync(binaryPath)) binaryPath = null;
      else {
        try { fs.chmodSync(binaryPath, 0o755); } catch { /* windows */ }
      }
    }
  } else {
    log('--skip-binary: keeping whatever WHISPER_CLI_PATH already points at.');
  }

  // ---- 2. model --------------------------------------------------------
  const modelName = `ggml-${opts.model}.bin`;
  const modelPath = path.join(MODELS_DIR, modelName);
  const sizeHint = MODEL_SIZES_MB[opts.model] ? `~${MODEL_SIZES_MB[opts.model]} MB` : 'size unknown';

  if (fs.existsSync(modelPath) && !opts.force) {
    log(`Model already present, skipping download: ${modelPath} (use --force to re-download)`);
  } else {
    log(`Model ${modelName} (${sizeHint})`);
    const base = opts.hfMirror ? HF_MIRROR_BASE : HF_BASE;
    try {
      await downloadToFile(`${base}/${modelName}`, modelPath, modelName);
    } catch (error) {
      if (!opts.hfMirror) {
        log(`huggingface.co failed (${error.message}); retrying via hf-mirror.com...`);
        await downloadToFile(`${HF_MIRROR_BASE}/${modelName}`, modelPath, `${modelName} (mirror)`);
      } else throw error;
    }
  }

  // ---- 3. .env.local ---------------------------------------------------
  if (binaryPath) upsertEnvVar('WHISPER_CLI_PATH', binaryPath);
  upsertEnvVar('WHISPER_MODEL_PATH', modelPath);

  log('');
  log('Done. Verify with:');
  log('  npm run worker   (or) open http://localhost:3000/startup-validation');
  if (!binaryPath) {
    log('NOTE: no binary was configured - set WHISPER_CLI_PATH in .env.local, or set DEEPGRAM_API_KEY instead.');
  }
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
