#!/usr/bin/env node
/**
 * ClipCraft local ACTIVE-SPEAKER model setup (optional).
 *
 * Downloads the official LR-ASD weights (MIT license - code AND weights, see
 * docs/licenses/LR-ASD-LICENSE.txt), runs scripts/export-asd-onnx.py ONCE to
 * produce the two ONNX graphs the worker uses, and verifies ONNX against
 * PyTorch before telling you it worked. The app itself never runs Python.
 *
 * What it buys you: when two people are both on screen and the cheap
 * audio+motion cues cannot tell them apart, LR-ASD looks at the mouth region of
 * each face AND listens to the audio, and breaks the tie.
 *
 * Requirements (developer machine, ONE time):
 *   Python 3.9+ with:  py -m pip install torch onnx onnxruntime numpy python_speech_features
 *   (a CPU-only torch build is fine; the export takes ~10 seconds)
 *
 * Usage:
 *   node scripts/setup-lr-asd.mjs                 # Python on PATH
 *   node scripts/setup-lr-asd.mjs --python "py -3"  # Windows launcher
 *   npm run setup:asd
 *
 * The worker keeps working without this: it logs one warning and uses the
 * existing audio+motion cues.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'models', 'lr-asd');
const FRONTEND = path.join(OUT_DIR, 'lr-asd-frontend.onnx');
const BACKEND = path.join(OUT_DIR, 'lr-asd-backend.onnx');
const WEIGHTS = path.join(OUT_DIR, 'lr-asd-weights.pt');
const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'export-asd-onnx.py');

/** Official MIT weights (fine-tuned on TalkSet, the stronger of the two). */
const WEIGHTS_URL =
  'https://github.com/Junhua-Liao/LR-ASD/raw/main/weight/finetuning_TalkSet.model';
const WEIGHTS_BYTES = 3_426_337;

function log(msg) {
  process.stdout.write(`[setup-asd] ${msg}\n`);
}

function fail(msg, hint) {
  process.stderr.write(`\n[setup-asd] ERROR: ${msg}\n`);
  if (hint) process.stderr.write(`[setup-asd] ${hint}\n`);
  process.exit(1);
}

/** Split a --python value like `py -3` into command + fixed args. */
function parsePython(value) {
  const parts = value.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

async function download(url, target, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'clipcraft-local-setup' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, data);
    return data.length;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pythonIndex = args.indexOf('--python');
  const python = parsePython(
    pythonIndex >= 0 && args[pythonIndex + 1] ? args[pythonIndex + 1] : 'python3',
  );

  // Already exported and sane: do nothing (idempotent).
  if (fs.existsSync(FRONTEND) && fs.existsSync(BACKEND)) {
    const sizes = [FRONTEND, BACKEND].map((file) => fs.statSync(file).size);
    if (sizes.every((size) => size > 100_000)) {
      log(`already present: ${path.relative(ROOT, FRONTEND)}, ${path.relative(ROOT, BACKEND)}`);
      log('restart the worker if it is running.');
      return;
    }
    log('existing ONNX files look incomplete - re-exporting');
  }

  // Fail early with a human message when the developer tools are missing.
  const probe = spawnSync(python.command, [...python.args, '-c', 'import torch, onnx, onnxruntime, numpy'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    fail(
      'Python with torch + onnx + onnxruntime + numpy was not found.',
      `Install them once, then re-run:\n` +
        `   ${python.command} ${python.args.join(' ')} -m pip install torch onnx onnxruntime numpy python_speech_features\n` +
        `(on Windows the Python launcher is usually: npm run setup:asd -- --python "py -3")`
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!fs.existsSync(WEIGHTS) || fs.statSync(WEIGHTS).size !== WEIGHTS_BYTES) {
    log(`downloading MIT weights ${WEIGHTS_URL}`);
    try {
      const size = await download(WEIGHTS_URL, WEIGHTS);
      if (size !== WEIGHTS_BYTES) {
        log(`  note: downloaded ${size} bytes (expected ${WEIGHTS_BYTES})`);
      }
    } catch (error) {
      fail(
        `could not download the LR-ASD weights: ${error.message}`,
        `Download finetuning_TalkSet.model manually from\n` +
          `   https://github.com/Junhua-Liao/LR-ASD/tree/main/weight\n` +
          `and save it as ${path.relative(ROOT, WEIGHTS)}, then re-run this script.`
      );
    }
  } else {
    log(`using existing weights ${path.relative(ROOT, WEIGHTS)}`);
  }

  log('exporting ONNX (one time, ~10 s) and verifying it against PyTorch...');
  try {
    execFileSync(
      python.command,
      [...python.args, EXPORT_SCRIPT, '--weights', WEIGHTS],
      { stdio: 'inherit', cwd: ROOT }
    );
  } catch (error) {
    fail(
      `the ONNX export failed: ${error.message}`,
      'Check the Python output above. Nothing was left half-written: re-run this script after fixing it.'
    );
  }

  for (const file of [FRONTEND, BACKEND]) {
    if (!fs.existsSync(file) || fs.statSync(file).size < 100_000) {
      fail(`the export did not produce ${path.relative(ROOT, file)}.`);
    }
  }
  log('LR-ASD is enabled - ambiguous two-person windows now get an audio-visual verdict.');
  log('restart the worker so it loads the new model.');
}

main();
