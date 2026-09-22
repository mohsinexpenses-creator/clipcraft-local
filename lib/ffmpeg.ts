import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from './errors';

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  try {
    const ffmpegStatic = eval('require')('ffmpeg-static');
    if (ffmpegStatic && typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch {
    // Ignore: we'll continue checking other install locations and PATH.
  }

  const isWin = process.platform === 'win32';
  const exeExt = isWin ? '.exe' : '';

  const candidates = [
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', `ffmpeg${exeExt}`),
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg'),
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'darwin-x64', 'ffmpeg'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'ffmpeg';
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

    child.on('error', (error) => {
      reject(
        new AppError('Failed to start FFmpeg.', {
          details: `${ffmpegBin}: ${error.message}`,
          resolution:
            'Install ffmpeg or set FFMPEG_PATH in .env.local to a valid ffmpeg binary, then retry.',
        })
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new AppError('FFmpeg exited with a non-zero status.', {
          details: `Exit code ${code}. ${stderr.slice(-2000)}`,
          resolution:
            'Inspect the FFmpeg command in the server logs, confirm the input file exists, and retry.',
        })
      );
    });
  });
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export async function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  if (!fs.existsSync(inputPath)) {
    throw new AppError('Video metadata could not be read because the file does not exist.', {
      status: 404,
      details: inputPath,
      resolution: 'Upload the source video again and retry.',
    });
  }

  const ffmpegBin = getFfmpegPath();

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ['-i', inputPath]);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', () => {
      try {
        const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (!durationMatch) {
          throw new AppError('FFmpeg could not detect the video duration.', {
            details: stderr.slice(-1000),
            resolution: 'Confirm the uploaded file is a valid readable video and retry.',
          });
        }

        const resolutionMatch = stderr.match(/, (\d{2,5})x(\d{2,5})[\s,]/);
        if (!resolutionMatch) {
          throw new AppError('FFmpeg could not detect the video resolution.', {
            details: stderr.slice(-1000),
            resolution: 'Confirm the uploaded file is a valid readable video and retry.',
          });
        }

        const fpsMatch = stderr.match(/, (\d+(?:\.\d+)?) fps/);
        if (!fpsMatch) {
          throw new AppError('FFmpeg could not detect the video frame rate.', {
            details: stderr.slice(-1000),
            resolution: 'Use a standard video file with a detectable frame rate and retry.',
          });
        }

        const h = parseFloat(durationMatch[1]);
        const m = parseFloat(durationMatch[2]);
        const s = parseFloat(durationMatch[3]);
        const duration = h * 3600 + m * 60 + s;
        const width = parseInt(resolutionMatch[1], 10);
        const height = parseInt(resolutionMatch[2], 10);
        const fps = parseFloat(fpsMatch[1]);

        if (duration <= 0 || width <= 0 || height <= 0 || fps <= 0) {
          throw new AppError('FFmpeg returned invalid video metadata.', {
            details: `duration=${duration}, width=${width}, height=${height}, fps=${fps}`,
            resolution: 'Confirm the uploaded file is a valid readable video and retry.',
          });
        }

        resolve({ duration, width, height, fps });
      } catch (error) {
        reject(error);
      }
    });

    child.on('error', (error) => {
      reject(
        new AppError('FFmpeg failed while probing video metadata.', {
          details: `${ffmpegBin}: ${toErrorMessage(error)}`,
          resolution:
            'Install ffmpeg or set FFMPEG_PATH in .env.local to a valid ffmpeg binary, then retry.',
        })
      );
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
