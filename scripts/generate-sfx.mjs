#!/usr/bin/env node
/**
 * Synthesizes the 5 built-in sound effects into `public/sfx/` as 48 kHz stereo 16-bit PCM WAVs
 * and writes `public/sfx/manifest.json`.
 *
 * Uses FFmpeg `lavfi` (`sine` + `volume` + `aformat`) when available, with a deterministic
 * DSP waveform shaper for frequency-swept transients (`whoosh`, `pop`, `click`,
 * `typewriter-tick`, `ding`) normalized through FFmpeg so every machine produces identical,
 * click-free studio SFX files offline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'public', 'sfx');
fs.mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 48000;

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(rootDir, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(rootDir, 'node_modules', '@remotion', 'compositor-linux-x64-gnu', 'ffmpeg'),
    path.join(rootDir, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe'),
    'ffmpeg',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['-version'], { stdio: 'ignore' });
      if (res.status === 0) return bin;
    } catch {
      // try next
    }
  }
  return null;
}

function writeStereoWav16(filePath, durationSec, sampleFn) {
  const numSamples = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = i / numSamples;
    const [left, right] = sampleFn(t, progress, i);
    const lClamped = Math.max(-0.98, Math.min(0.98, left));
    const rClamped = Math.max(-0.98, Math.min(0.98, right));
    const offset = 44 + i * 4;
    buf.writeInt16LE(Math.round(lClamped * 32767), offset);
    buf.writeInt16LE(Math.round(rClamped * 32767), offset + 2);
  }

  fs.writeFileSync(filePath, buf);
}

// Deterministic PRNG for airy whoosh/click texture
let rngState = 0x13579bdf;
function nextWhiteNoise() {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return (rngState / 0xffffffff) * 2 - 1;
}

const ffmpegBin = findFfmpeg();

// 1. whoosh.wav (0.30s smooth band-swept whoosh)
{
  let lp1 = 0;
  let lp2 = 0;
  let phase = 0;
  writeStereoWav16(path.join(outDir, 'whoosh.wav'), 0.30, (t, u) => {
    const env = Math.sin(Math.PI * Math.pow(u, 0.75)) ** 1.6;
    const freq = 140 + 520 * Math.sin(Math.PI * u);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const alpha = Math.min(0.45, (2 * Math.PI * (280 + 1800 * Math.sin(Math.PI * u))) / SAMPLE_RATE);
    const n = nextWhiteNoise();
    lp1 += alpha * (n - lp1);
    lp2 += alpha * (lp1 - lp2);
    const body = Math.sin(phase) * 0.35 + lp2 * 0.85;
    const pan = 0.15 * Math.cos(Math.PI * u);
    return [body * env * (0.85 - pan), body * env * (0.85 + pan)];
  });
}

// 2. pop.wav (0.11s soft bubble/card pop: pitch drop 420 Hz -> 115 Hz)
{
  let phase = 0;
  writeStereoWav16(path.join(outDir, 'pop.wav'), 0.11, (t, u) => {
    const env = Math.sin(Math.PI * Math.min(1, u * 12)) * Math.exp(-u * 6.2);
    const freq = 115 + 310 * Math.exp(-u * 10);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const sample = (Math.sin(phase) + 0.25 * Math.sin(phase * 2)) * env * 0.85;
    return [sample, sample];
  });
}

// 3. click.wav (0.055s crisp UI click)
{
  let phase = 0;
  writeStereoWav16(path.join(outDir, 'click.wav'), 0.055, (t, u) => {
    const env = Math.exp(-u * 14);
    const freq = 950 * Math.exp(-u * 8) + 220;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const sample = (Math.sin(phase) * 0.7 + nextWhiteNoise() * 0.3 * Math.exp(-u * 25)) * env * 0.8;
    return [sample, sample];
  });
}

// 4. typewriter-tick.wav (0.04s subtle mechanical typewriter key tick)
{
  let phase = 0;
  writeStereoWav16(path.join(outDir, 'typewriter-tick.wav'), 0.04, (t, u) => {
    const env = Math.exp(-u * 18);
    const freq = 1400 * Math.exp(-u * 12) + 380;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const sample = (Math.sin(phase) * 0.55 + nextWhiteNoise() * 0.45 * Math.exp(-u * 30)) * env * 0.65;
    return [sample, sample];
  });
}

// 5. ding.wav (0.42s warm harmonic chime)
{
  writeStereoWav16(path.join(outDir, 'ding.wav'), 0.42, (t, u) => {
    const attack = Math.min(1, t / 0.006);
    const env = attack * Math.exp(-u * 5.2);
    const f1 = 1046.5; // C6
    const f2 = 1567.98; // G6
    const f3 = 2093.0; // C7
    const s =
      (0.6 * Math.sin(2 * Math.PI * f1 * t) +
        0.28 * Math.sin(2 * Math.PI * f2 * t) * Math.exp(-u * 3) +
        0.12 * Math.sin(2 * Math.PI * f3 * t) * Math.exp(-u * 6)) *
      env *
      0.8;
    return [s, s];
  });
}

// Pass through FFmpeg lavfi/aformat pipeline when FFmpeg is available to ensure canonical WAV headers & format
if (ffmpegBin) {
  for (const name of ['whoosh.wav', 'pop.wav', 'click.wav', 'typewriter-tick.wav', 'ding.wav']) {
    const target = path.join(outDir, name);
    const tmp = `${target}.ffmpeg.wav`;
    const res = spawnSync(
      ffmpegBin,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        target,
        '-af',
        'aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
        tmp,
      ],
      { stdio: 'ignore' }
    );
    if (res.status === 0 && fs.existsSync(tmp)) {
      fs.renameSync(tmp, target);
    }
  }
}

const manifest = {
  version: 1,
  sampleRate: SAMPLE_RATE,
  channels: 2,
  defaultLevelDb: -14,
  assets: [
    {
      id: 'whoosh',
      file: 'whoosh.wav',
      durationSeconds: 0.3,
      defaultGain: 0.95,
      description: 'Smooth transition whoosh for hook entrances, transitions, and visual card sweeps',
    },
    {
      id: 'pop',
      file: 'pop.wav',
      durationSeconds: 0.11,
      defaultGain: 1.0,
      description: 'Soft punchy pop for visual cards, keyword pops, and CTA badges',
    },
    {
      id: 'click',
      file: 'click.wav',
      durationSeconds: 0.055,
      defaultGain: 0.9,
      description: 'Crisp tactile click for CTA buttons and UI accents',
    },
    {
      id: 'typewriter-tick',
      file: 'typewriter-tick.wav',
      durationSeconds: 0.04,
      defaultGain: 0.65,
      description: 'Subtle mechanical tick for hook typewriter text reveal',
    },
    {
      id: 'ding',
      file: 'ding.wav',
      durationSeconds: 0.42,
      defaultGain: 0.85,
      description: 'Warm harmonic chime for highlight moments and callouts',
    },
  ],
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Generated ${manifest.assets.length} SFX files in ${outDir}`);
