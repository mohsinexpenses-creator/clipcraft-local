import fs from "node:fs";

const SAMPLE_RATE = 44_100;
const WAV_HEADER_BYTES = 44;

interface PcmWav {
  bytes: Buffer;
  dataOffset: number;
  sampleCount: number;
}

export interface SfxAudioCue {
  filePath: string;
  atSeconds: number;
  volume?: number;
}

function readMonoPcmWav(filePath: string): PcmWav {
  const bytes = fs.readFileSync(filePath);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Unsupported sound effect WAV: ${filePath}`);
  }

  let format: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataOffset: number | undefined;
  let dataSize: number | undefined;

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkName = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > bytes.length) break;

    if (chunkName === "fmt " && chunkSize >= 16) {
      format = bytes.readUInt16LE(chunkStart);
      channels = bytes.readUInt16LE(chunkStart + 2);
      sampleRate = bytes.readUInt32LE(chunkStart + 4);
      bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
    } else if (chunkName === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== SAMPLE_RATE ||
    bitsPerSample !== 16 ||
    dataOffset === undefined ||
    dataSize === undefined ||
    dataSize % 2 !== 0
  ) {
    throw new Error(`Sound effect must be mono 16-bit PCM at ${SAMPLE_RATE} Hz: ${filePath}`);
  }

  return { bytes, dataOffset, sampleCount: dataSize / 2 };
}

function writeMonoPcmWav(samples: Float32Array): Buffer {
  const dataSize = samples.length * 2;
  if (dataSize > 0xffffffff - 36) throw new Error("Mixed sound effects exceed WAV size limits.");
  const output = Buffer.alloc(WAV_HEADER_BYTES + dataSize);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    output.writeInt16LE(Math.round(sample * 32767), WAV_HEADER_BYTES + index * 2);
  }
  return output;
}

/** Mix short B-roll cues into one compact PCM track before the video graph runs. */
export function buildBrollSfxWav(cues: readonly SfxAudioCue[], durationSeconds: number): Buffer {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const sampleCount = Math.ceil(duration * SAMPLE_RATE);
  if (!Number.isSafeInteger(sampleCount) || sampleCount * 2 > 0xffffffff - 36) {
    throw new Error("B-roll sound-effect mix exceeds WAV size limits.");
  }

  const mixed = new Float32Array(sampleCount);
  const sourceCache = new Map<string, PcmWav>();
  for (const cue of cues) {
    if (!Number.isFinite(cue.atSeconds) || cue.atSeconds < 0 || cue.atSeconds >= duration) continue;
    let source = sourceCache.get(cue.filePath);
    if (!source) {
      source = readMonoPcmWav(cue.filePath);
      sourceCache.set(cue.filePath, source);
    }

    const startSample = Math.round(cue.atSeconds * SAMPLE_RATE);
    const volume = Math.max(0, Math.min(1, cue.volume ?? 1));
    const sampleEnd = Math.min(sampleCount, startSample + source.sampleCount);
    for (let sample = startSample; sample < sampleEnd; sample += 1) {
      const sourceSample = source.bytes.readInt16LE(
        source.dataOffset + (sample - startSample) * 2,
      ) / 32768;
      mixed[sample] += sourceSample * volume;
    }
  }

  return writeMonoPcmWav(mixed);
}
