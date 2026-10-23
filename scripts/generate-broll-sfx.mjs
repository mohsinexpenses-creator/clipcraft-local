#!/usr/bin/env node
/**
 * Regenerate the bundled sound effects.
 *
 * They are synthesised here rather than downloaded: the project must not depend
 * on a stock-library licence for something it ships in `public/`. Running this
 * script rewrites the WAVs in `public/sfx/`; the files are
 * committed so a fresh clone does not have to run it.
 *
 *   node scripts/generate-broll-sfx.mjs
 *
 * All effects are CC0 (dedicated to the public domain) - see public/sfx/README.md.
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

function tone(seconds, frequencies, amplitude = 0.45) {
  const length = Math.round(SAMPLE_RATE * seconds);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    const frequency = typeof frequencies === 'function' ? frequencies(t) : frequencies;
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    const envelope = Math.min(1, t / 0.012) * (1 - t) ** 2.4;
    samples[index] = Math.sin(phase) * envelope * amplitude;
  }
  return samples;
}

function mix(length, layers) {
  const samples = new Float32Array(length);
  for (const { audio, start = 0 } of layers) {
    for (let index = 0; index < audio.length && start + index < length; index += 1) {
      samples[start + index] += audio[index];
    }
  }
  return samples;
}

function notification() {
  return mix(Math.round(SAMPLE_RATE * 0.62), [
    { audio: tone(0.22, 880, 0.35), start: 0 },
    { audio: tone(0.28, 1175, 0.32), start: Math.round(SAMPLE_RATE * 0.13) },
  ]);
}

function cameraShutter() {
  const length = Math.round(SAMPLE_RATE * 0.24);
  const samples = new Float32Array(length);
  let seed = 0x24c0ffee;
  let low = 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / SAMPLE_RATE;
    const envelope = Math.exp(-t * 30);
    low += (random() - low) * 0.24;
    const click = index < 130 ? random() * 2 : 0;
    samples[index] = (random() - low * 0.6 + click) * envelope * 0.38;
  }
  return samples;
}

function swipe() {
  const length = Math.round(SAMPLE_RATE * 0.32);
  const samples = new Float32Array(length);
  let seed = 0x51a1e;
  let low = 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    const envelope = Math.sin(Math.PI * t) ** 1.3;
    low += (random() - low) * (0.04 + 0.3 * t);
    samples[index] = (random() - low) * envelope * 0.42;
  }
  return samples;
}

function cash() {
  const length = Math.round(SAMPLE_RATE * 0.72);
  return mix(length, [
    { audio: tone(0.32, 1568, 0.42), start: 0 },
    { audio: tone(0.42, 2093, 0.32), start: Math.round(SAMPLE_RATE * 0.08) },
    { audio: tone(0.16, 520, 0.18), start: Math.round(SAMPLE_RATE * 0.26) },
  ]);
}

function correct() {
  const length = Math.round(SAMPLE_RATE * 0.48);
  return mix(length, [
    { audio: tone(0.24, 660, 0.38), start: 0 },
    { audio: tone(0.3, 990, 0.36), start: Math.round(SAMPLE_RATE * 0.16) },
  ]);
}

function wrongAnswer() {
  return tone(0.42, (t) => 230 - 55 * t, 0.42);
}

function riser() {
  const length = Math.round(SAMPLE_RATE * 1.2);
  const samples = new Float32Array(length);
  let seed = 0x715e2;
  let low = 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    low += (random() - low) * (0.015 + t * 0.22);
    const envelope = t ** 1.4;
    const pitch = Math.sin((2 * Math.PI * (180 + 520 * t) * index) / SAMPLE_RATE);
    samples[index] = (random() - low * 0.65 + pitch * 0.25) * envelope * 0.36;
  }
  return samples;
}

function textReadout() {
  const length = Math.round(SAMPLE_RATE * 0.68);
  const samples = new Float32Array(length);
  let seed = 0x7e87ead;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / SAMPLE_RATE;
    const pulse = Math.floor(t / 0.045) !== Math.floor((t - 1 / SAMPLE_RATE) / 0.045);
    if (!pulse) continue;
    const pulseLength = Math.min(180, length - index);
    const frequency = 1150 + random() * 650;
    for (let offset = 0; offset < pulseLength; offset += 1) {
      const envelope = Math.exp(-offset / 34);
      samples[index + offset] += Math.sin((2 * Math.PI * frequency * offset) / SAMPLE_RATE) * envelope * 0.2;
    }
  }
  return samples;
}

function cameraFlash() {
  const length = Math.round(SAMPLE_RATE * 0.18);
  const samples = new Float32Array(length);
  let seed = 0xf1a5;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    const envelope = Math.exp(-t * 28);
    const snap = index < 90 ? 0.65 : 0;
    const tone = Math.sin((2 * Math.PI * (1250 - t * 500) * index) / SAMPLE_RATE) * 0.35;
    samples[index] = (random() * 0.7 + tone + snap) * envelope * 0.42;
  }
  return samples;
}

function radio() {
  const length = Math.round(SAMPLE_RATE * 0.75);
  const samples = new Float32Array(length);
  let seed = 0x7a11d10;
  let low = 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let index = 0; index < length; index += 1) {
    const t = index / length;
    const staticNoise = random() - low * 0.7;
    low += (random() - low) * 0.035;
    const burst = Math.sin(Math.PI * Math.min(1, t * 5)) ** 2;
    const carrier = Math.sin((2 * Math.PI * 1800 * index) / SAMPLE_RATE);
    samples[index] = (staticNoise * 0.72 + carrier * burst * 0.18) * 0.32;
  }
  return samples;
}

const outDir = path.join(process.cwd(), 'public', 'sfx');
const effects = {
  'whoosh.wav': whoosh(),
  'pop.wav': pop(),
  'notification.wav': notification(),
  'camera-shutter.wav': cameraShutter(),
  'swipe.wav': swipe(),
  'cash.wav': cash(),
  'correct.wav': correct(),
  'wrong-answer.wav': wrongAnswer(),
  'riser.wav': riser(),
  'text-readout.wav': textReadout(),
  'camera-flash.wav': cameraFlash(),
  'radio.wav': radio(),
};

for (const [fileName, samples] of Object.entries(effects)) {
  const bytes = writeWav(path.join(outDir, fileName), samples);
  console.log(`${fileName}: ${(bytes / 1024).toFixed(1)} KB`);
}
