import fs from 'node:fs';
import path from 'node:path';
import {
  parseVideoMetadataFromFfprobe,
  probeMediaWithFfprobe,
  type FfprobeStreamMetadata,
} from '../lib/ffmpeg';

function seconds(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(3)} s`;
}

function bitrate(value: number | null): string {
  return value === null ? 'n/a' : `${(value / 1_000_000).toFixed(2)} Mbps (${Math.round(value).toLocaleString()} bps)`;
}

function streamDetails(label: string, stream: FfprobeStreamMetadata | null): void {
  if (!stream) {
    console.log(`${label}: none`);
    return;
  }
  console.log(
    `${label}: start=${seconds(stream.startTime)}, duration=${seconds(stream.duration)}, ` +
    `bitrate=${bitrate(stream.bitRate)}${stream.codecName ? `, codec=${stream.codecName}` : ''}`
  );
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (!argument) {
    console.error('Usage: npm run verify:clip -- <video-file>');
    process.exitCode = 2;
    return;
  }

  const filePath = path.resolve(process.cwd(), argument);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 2;
    return;
  }

  try {
    const probe = await probeMediaWithFfprobe(filePath);
    const metadata = parseVideoMetadataFromFfprobe(probe);
    const video = probe.streams.find((stream) => stream.codecType === 'video') ?? null;
    const audio = probe.streams.find((stream) => stream.codecType === 'audio') ?? null;
    const vfr = metadata.isVariableFrameRate === null
      ? 'unknown (FFprobe did not report both frame rates)'
      : metadata.isVariableFrameRate
        ? 'yes'
        : 'no';

    console.log(`File: ${filePath}`);
    console.log(`Resolution: ${metadata.width}x${metadata.height}`);
    console.log(
      `Frame rate: avg=${metadata.averageFrameRate ?? 'n/a'}, ` +
      `r=${metadata.nominalFrameRate ?? 'n/a'}; VFR=${vfr}`
    );
    console.log(`Format: start=${seconds(probe.formatStartTime)}, duration=${seconds(probe.formatDuration)}, bitrate=${bitrate(probe.formatBitRate)}`);
    streamDetails('Video', video);
    streamDetails('Audio', audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not run ffprobe for ${filePath}: ${message}`);
    console.error('Install a full local FFmpeg build with ffprobe, or set FFPROBE_PATH in .env.local.');
    process.exitCode = 1;
  }
}

void main();
