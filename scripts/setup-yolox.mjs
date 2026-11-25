#!/usr/bin/env node
/**
 * ClipCraft local PERSON-detection setup (optional).
 *
 * Downloads the official Megvii YOLOX-nano ONNX detector (`yolox_nano.onnx`,
 * Apache-2.0) into `models/yolox/`. The worker uses it for ONE job: when a face
 * that was being tracked disappears (the person turned away, looked down, or a
 * hand/mic covered their face), it checks whether the same person is still on
 * screen, so their framing is held instead of jumping to someone else.
 *
 * The model does NOT run on ordinary frames, and is never committed.
 *
 * Usage:
 *   node scripts/setup-yolox.mjs            # download + verify
 *   npm run setup:yolox                     # same
 *
 * No npm dependencies: Node 18+ built-in fetch + crypto.
 *
 * Why this file verifies by SIZE and prints the SHA-256:
 *   Megvii publishes no digest for the release asset, so a hard-coded hash here
 *   would be a guess. The size is exact (3,659,407 bytes) and is checked against
 *   every download; the SHA-256 of the file we kept is printed so a cautious user
 *   can compare it with a manual download, and `YOLOX_ONNX_SHA256` lets the worker
 *   pin it permanently (see SETUP.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'models', 'yolox');
const OUT_FILE = path.join(OUT_DIR, 'yolox_nano.onnx');

const FILE_NAME = 'yolox_nano.onnx';
const EXPECTED_SIZE = 3_659_407;

/** Official Megvii release (tag 0.1.1rc0) plus mirrors of the same file. */
const MIRRORS = [
  `https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/${FILE_NAME}`,
  `https://cdn.jsdelivr.net/gh/Megvii-BaseDetection/YOLOX@main/${FILE_NAME}`,
  `https://huggingface.co/Megvii-BaseDetection/YOLOX/resolve/main/${FILE_NAME}`,
];

/** Pinned digest, when the user set one (env or a previous verified download). */
const PINNED_SHA256 = (process.env.YOLOX_ONNX_SHA256 ?? '').trim().toLowerCase();

function log(msg) {
  process.stdout.write(`[setup-yolox] ${msg}\n`);
}

function fail(msg, hint) {
  process.stderr.write(`\n[setup-yolox] ERROR: ${msg}\n`);
  if (hint) process.stderr.write(`[setup-yolox] ${hint}\n`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'clipcraft-local-setup' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function accept(buffer, label) {
  const hash = sha256(buffer);
  if (PINNED_SHA256 && hash !== PINNED_SHA256) {
    log(`  ${label}: sha256 ${hash} does not match YOLOX_ONNX_SHA256=${PINNED_SHA256} - trying next mirror`);
    return false;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, buffer);
  log(`saved ${path.relative(ROOT, OUT_FILE)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  log(`sha256 ${hash}`);
  log('person detection is now enabled - restart the worker if it is running.');
  return true;
}

async function main() {
  // Idempotent: a verified copy is left alone.
  if (fs.existsSync(OUT_FILE)) {
    const existing = fs.readFileSync(OUT_FILE);
    const hash = sha256(existing);
    if (
      existing.length === EXPECTED_SIZE &&
      (!PINNED_SHA256 || hash === PINNED_SHA256)
    ) {
      log(`already present: ${path.relative(ROOT, OUT_FILE)}`);
      log(`sha256 ${hash}`);
      return;
    }
    log('existing file failed verification - re-downloading');
    fs.rmSync(OUT_FILE, { force: true });
  }

  for (const url of MIRRORS) {
    log(`downloading ${url}`);
    let data;
    try {
      data = await download(url);
    } catch (error) {
      log(`  failed: ${error.message}`);
      continue;
    }
    if (data.length !== EXPECTED_SIZE) {
      log(`  wrong size (${data.length} bytes, expected ${EXPECTED_SIZE}) - trying next mirror`);
      continue;
    }
    if (accept(data, url)) return;
  }

  fail(
    'could not download yolox_nano.onnx from any mirror.',
    'Download it manually from https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0 ' +
      `and place it at ${path.relative(ROOT, OUT_FILE)} (expected ${EXPECTED_SIZE} bytes). ` +
      'Person detection stays off until then; everything else works unchanged.'
  );
}

main();
