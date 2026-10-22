#!/usr/bin/env node
/**
 * Regenerate the two bundled B-roll sound effects.
 *
 * They are synthesised here rather than downloaded: the project must not depend
 * on a stock-library licence for something it ships in `public/`. Running this
 * script rewrites `public/sfx/whoosh.wav` and `public/sfx/pop.wav`; the files are
 * committed so a fresh clone does not have to run it.
 *
 *   node scripts/generate-broll-sfx.mjs
 *
 * Both effects are CC0 (dedicated to the public domain) - see public/sfx/README.md.
 */

import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 44_100;

function writeWav(filePath, samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return dataSize;
}

/** A soft airy sweep: band-limited noise whose brightness rises then falls. */
function whoosh(seconds = 0.55) {
  const length = Math.round(SAMPLE_RATE * seconds);
  const samples = new Float32Array(length);
  let low = 0;
  let high = 0;
  // Deterministic noise so regenerating produces byte-identical files.
  let seed = 0x1a2b3c4d;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };

  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    // Envelope: fast attack, long tail.
    const envelope = Math.min(1, t / 0.12) * (1 - t) ** 2.2;
    // One-pole low pass whose cutoff opens at the start of the sweep.
    const cutoff = 0.02 + 0.18 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    low += (random() - low) * cutoff;
    high = low - high * 0.35;
    samples[index] = Math.tanh(high * 2.4) * envelope * 0.55;
  }
  return samples;
}

/** A short low pop: a quickly falling sine with a click-free envelope. */
function pop(seconds = 0.16) {
  const length = Math.round(SAMPLE_RATE * seconds);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    const frequency = 220 * (1 - t) ** 2 + 70;
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    const envelope = Math.min(1, t / 0.02) * (1 - t) ** 3;
    samples[index] = Math.sin(phase) * envelope * 0.6;
  }
  return samples;
}

const outDir = path.join(process.cwd(), 'public', 'sfx');
const whooshBytes = writeWav(path.join(outDir, 'whoosh.wav'), whoosh());
const popBytes = writeWav(path.join(outDir, 'pop.wav'), pop());
console.log(`whoosh.wav: ${(whooshBytes / 1024).toFixed(1)} KB`);
console.log(`pop.wav: ${(popBytes / 1024).toFixed(1)} KB`);
