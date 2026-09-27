import { spawn } from 'child_process';
import { getFfmpegPath } from '../../lib/ffmpeg';
import { AppError } from '../../lib/errors';

/**
 * Audio side of Active Speaker Detection (ASD).
 *
 * We do NOT try to recognise voices. We only answer one question per video
 * frame: "is SOMEONE talking right now, and how loudly?" That voice-activity
 * envelope is what gates the visual cues (mouth movement, face prominence)
 * into a speaker decision - a still face can never be the active speaker in
 * a silent window, no matter how big it is.
 *
 * The DSP here is deliberately model-free (energy + robust normalisation) so
 * it is fast, free, and immune to the exact failure modes the mouth cue has:
 * a microphone over the mouth, a hand, a beard, a side profile, low quality.
 */

/**
 * Per-frame voice energy in [0,1].
 *
 * @param samples   mono PCM samples, roughly float-scale (Int16 range is fine)
 * @param sampleRate e.g. 16000
 * @param fps       video frame rate to resample the envelope to
 */
export function computeVoiceEnvelope(
  samples: ArrayLike<number>,
  sampleRate: number,
  fps: number
): { voice: number[]; frames: number; voicedRatio: number } {
  const frames = Math.max(1, Math.round((samples.length / sampleRate) * fps));
  const voice = new Array<number>(frames).fill(0);
  if (samples.length === 0) {
    return { voice, frames, voicedRatio: 0 };
  }

  // Window of ~110 ms centered on each video frame. 110 ms is long enough to
  // be a stable energy estimate, short enough to follow speech onsets.
  const winSamples = Math.max(64, Math.round(sampleRate * 0.11));

  // Pass 1: per-frame RMS energy.
  const rms = new Array<number>(frames).fill(0);
  for (let i = 0; i < frames; i += 1) {
    const center = ((i + 0.5) / frames) * samples.length;
    const startI = Math.max(0, Math.floor(center - winSamples / 2));
    const endI = Math.min(samples.length, startI + winSamples);
    let sum = 0;
    let n = 0;
    for (let j = startI; j < endI; j += 1) {
      const v = samples[j] / 32768; // normalise Int16 -> [-1,1]
      sum += v * v;
      n += 1;
    }
    rms[i] = n > 0 ? Math.sqrt(sum / n) : 0;
  }

  // Pass 2: robust normalisation. The floor sits at ~half the MEDIAN energy
  // (so ambient hum/noise maps to ~0), and 1.0 sits at the 90th percentile
  // (so actual speech saturates). This makes the envelope comparable across
  // quiet podcasts and loud interviews without any per-clip tuning.
  const sorted = [...rms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
  const absFloor = 0.004; // ~ -48 dBFS digital silence floor
  const floor = Math.max(absFloor, median * 0.5);
  const top = Math.max(floor * 1.6, p90);
  const span = Math.max(1e-6, top - floor);

  let voiced = 0;
  for (let i = 0; i < frames; i += 1) {
    voice[i] = Math.max(0, Math.min(1, (rms[i] - floor) / span));
    if (voice[i] >= 0.2) voiced += 1;
  }

  // Light temporal smoothing (3-tap) so single-frame spikes/dips don't create
  // speaker flicker downstream.
  const smoothed = new Array<number>(frames).fill(0);
  for (let i = 0; i < frames; i += 1) {
    const a = voice[Math.max(0, i - 1)];
    const b = voice[i];
    const c = voice[Math.min(frames - 1, i + 1)];
    smoothed[i] = (a + 2 * b + c) / 4;
  }

  return { voice: smoothed, frames, voicedRatio: voiced / frames };
}

/**
 * Decode the clip window to mono 16 kHz PCM (s16le) by piping FFmpeg stdout.
 * Returns an empty Int16Array when the source has no usable audio - the caller
 * treats that as "no voice information" and falls back to visual-only ASD.
 */
export function extractPcmMono(
  videoPath: string,
  start: number,
  duration: number,
  sampleRate = 16000
): Promise<Int16Array> {
  const ffmpegBin = getFfmpegPath();

  return new Promise((resolve) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', Math.max(0, start).toFixed(3),
      '-t', Math.max(0.1, duration).toFixed(3),
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1',
    ];

    const child = spawn(ffmpegBin, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });

    const finish = () => {
      const buf = Buffer.concat(chunks);
      // s16le -> Int16Array (little-endian on x86/ARM; drop a trailing odd byte).
      const usable = buf.length - (buf.length % 2);
      const out = new Int16Array(usable / 2);
      const dv = new DataView(buf.buffer, buf.byteOffset, usable);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = dv.getInt16(i * 2, true);
      }
      resolve(out);
    };

    child.on('error', () => resolve(new Int16Array(0)));
    child.on('close', () => finish());
  });
}

/** Convenience: full envelope in one call. Throws ONLY if ffmpeg cannot start. */
export async function computeVoiceEnvelopeForClip(
  videoPath: string,
  start: number,
  duration: number,
  fps: number
): Promise<{ voice: number[]; frames: number; voicedRatio: number }> {
  const pcm = await extractPcmMono(videoPath, start, duration);
  if (pcm.length === 0) {
    throw new AppError('No decodable audio track found in the clip window.', {
      status: 400,
      details: `${videoPath} @ ${start}s +${duration}s`,
      resolution: 'Check that the source video has an audio track, or re-upload it.',
    });
  }
  return computeVoiceEnvelope(pcm, 16000, fps);
}
