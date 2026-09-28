#!/usr/bin/env node
/**
 * ClipCraft local face-detection setup.
 *
 * Downloads the official OpenCV Zoo YuNet face detector
 * (`face_detection_yunet_2023mar.onnx`) into `models/yunet/` and verifies it
 * against the official SHA-256 so a mirror can never hand you a wrong file.
 *
 * The model enables active-speaker tracking: the worker runs YuNet on sampled
 * frames to find faces, tracks them across the clip, and drives the 9:16 crop
 * (speaker-focus and split-screen layouts). Without it, renders still work but
 * fall back to a static center crop.
 *
 * Usage:
 *   node scripts/setup-yunet.mjs            # download + verify
 *   npm run setup:yunet                     # same
 *
 * No npm dependencies: uses Node 18+ built-in fetch + crypto.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'models', 'yunet');
const OUT_FILE = path.join(OUT_DIR, 'face_detection_yunet_2023mar.onnx');

/** Official OpenCV Zoo release (2023mar, v2 - 12-output variant). */
const FILE_NAME = 'face_detection_yunet_2023mar.onnx';
const EXPECTED_SIZE = 232589;
const EXPECTED_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4';

/** Mirrors of the same official file, tried in order. */
const MIRRORS = [
  `https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/${FILE_NAME}`,
  `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/${FILE_NAME}`,
  `https://cdn.jsdelivr.net/gh/opencv/opencv_zoo@main/models/face_detection_yunet/${FILE_NAME}`,
  `https://huggingface.co/opencv/face_detection_yunet/resolve/main/${FILE_NAME}`,
  `https://huggingface.co/spaces/sam749/YuNet-face-detection/resolve/main/${FILE_NAME}`,
  `https://hf-mirror.com/opencv/face_detection_yunet/resolve/main/${FILE_NAME}`,
];

function log(msg) {
  process.stdout.write(`[setup-yunet] ${msg}\n`);
}

function fail(msg, hint) {
  process.stderr.write(`\n[setup-yunet] ERROR: ${msg}\n`);
  if (hint) process.stderr.write(`[setup-yunet] ${hint}\n`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url, timeoutMs = 60_000) {
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
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // Skip when a verified copy already exists (idempotent).
  if (fs.existsSync(OUT_FILE)) {
    const existing = fs.readFileSync(OUT_FILE);
    if (existing.length === EXPECTED_SIZE && sha256(existing) === EXPECTED_SHA256) {
      log(`already present and verified: ${path.relative(ROOT, OUT_FILE)}`);
      return;
    }
    log('existing file failed verification - re-downloading');
    fs.rmSync(OUT_FILE, { force: true });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

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

    const hash = sha256(data);
    if (hash !== EXPECTED_SHA256) {
      log(`  sha256 mismatch (${hash}) - trying next mirror`);
      continue;
    }

    fs.writeFileSync(OUT_FILE, data);
    log(`verified sha256 ${hash}`);
    log(`saved ${path.relative(ROOT, OUT_FILE)} (${(data.length / 1024).toFixed(0)} KB)`);
    log('active-speaker tracking is now enabled for renders (restart the worker if it is running).');
    return;
  }

  fail(
    'could not download the YuNet model from any mirror.',
    'Download face_detection_yunet_2023mar.onnx manually (e.g. from https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) ' +
      `and place it at ${path.relative(ROOT, OUT_FILE)}. Expected sha256: ${EXPECTED_SHA256}`
  );
}

main();
