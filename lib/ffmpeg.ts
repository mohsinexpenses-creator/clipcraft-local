import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  const staticBin = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(staticBin)) {
    return staticBin;
  }

  const installerBin = path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');
  if (fs.existsSync(installerBin)) {
    return installerBin;
  }

  return 'ffmpeg'; // system fallback
}

export interface FfmpegProgress {
  frame?: number;
  fps?: number;
  timeSeconds?: number;
  percent?: number;
}

export function runFfmpeg(
  args: string[],
  options?: {
    totalDurationSeconds?: number;
    onProgress?: (progress: FfmpegProgress) => void;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ffmpegBin = getFfmpegPath();
    console.log(`[FFmpeg] Spawning: ${ffmpegBin} ${args.join(' ')}`);

    const child = spawn(ffmpegBin, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (options?.onProgress) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseFloat(timeMatch[1]);
          const mins = parseFloat(timeMatch[2]);
          const secs = parseFloat(timeMatch[3]);
          const currentSeconds = hours * 3600 + mins * 60 + secs;

          let percent = undefined;
          if (options.totalDurationSeconds && options.totalDurationSeconds > 0) {
            percent = Math.min(100, Math.max(0, (currentSeconds / options.totalDurationSeconds) * 100));
          }

          options.onProgress({
            timeSeconds: currentSeconds,
            percent,
          });
        }
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}.\nFFmpeg log:\n${stderr.slice(-2000)}`));
      }
    });
  });
}

export interface VideoMetadata {
  duration: number; // in seconds
  width: number;
  height: number;
  fps: number;
}

export async function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  const ffmpegBin = getFfmpegPath();

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ['-i', inputPath]);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', () => {
      let duration = 0;
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        const h = parseFloat(durationMatch[1]);
        const m = parseFloat(durationMatch[2]);
        const s = parseFloat(durationMatch[3]);
        duration = h * 3600 + m * 60 + s;
      }

      let width = 1920;
      let height = 1080;
      let fps = 30;

      const resMatch = stderr.match(/, (\d{3,5})x(\d{3,5})[\s,]/);
      if (resMatch) {
        width = parseInt(resMatch[1], 10);
        height = parseInt(resMatch[2], 10);
      }

      const fpsMatch = stderr.match(/, (\d+(?:\.\d+)?) fps/);
      if (fpsMatch) {
        fps = parseFloat(fpsMatch[1]);
      }

      resolve({ duration, width, height, fps });
    });

    child.on('error', (err) => {
      reject(new Error(`Error probing video metadata: ${err.message}`));
    });
  });
}

export async function extractAudio16kMono(inputVideoPath: string, outputWavPath: string): Promise<string> {
  const outputDir = path.dirname(outputWavPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const args = [
    '-y',
    '-i', inputVideoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputWavPath,
  ];

  await runFfmpeg(args);
  return outputWavPath;
}
