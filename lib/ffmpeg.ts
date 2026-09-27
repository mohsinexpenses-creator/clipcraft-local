import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { AppError, toErrorMessage } from "./errors";
import { log } from "./logger";

/**
 * Static import (replaces the old `eval('require')('ffmpeg-static')` hack, which
 * trips `no-eval` and is fragile under Turbopack). `ffmpeg-static` is listed in
 * `serverExternalPackages` in next.config.ts so Next never tries to bundle it,
 * and its postinstall failure (common behind proxies) is tolerated: we verify the
 * binary actually exists before using it and fall back to PATH otherwise.
 */
import ffmpegStaticPath from "ffmpeg-static";

/**
 * Warning shown at most ONCE per process. The old code re-printed it before
 * every single ffmpeg invocation, which turned the worker log into a wall of
 * the same yellow line even when a perfectly good ffmpeg was being used.
 */
let ffmpegWarnedOnce = false;
function warnFfmpegOnce(message: string): void {
  if (ffmpegWarnedOnce) return;
  ffmpegWarnedOnce = true;
  log.warn(message);
}

export function getFfmpegPath(): string {
  const isWin = process.platform === "win32";
  const exeExt = isWin ? ".exe" : "";

  // 1) Explicit user override (no warnings - this is what the user asked for).
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured && configured.toLowerCase() !== "your_ffmpeg_path") {
    if (fs.existsSync(configured)) return configured;
    warnFfmpegOnce(
      `FFMPEG_PATH="${configured}" does not exist - falling back to bundled/PATH ffmpeg.`,
    );
  }

  // 2) The binary bundled with ffmpeg-static.
  try {
    if (
      typeof ffmpegStaticPath === "string" &&
      ffmpegStaticPath &&
      fs.existsSync(ffmpegStaticPath)
    ) {
      return ffmpegStaticPath;
    }
  } catch {
    // Fall through to the other candidates.
  }

  // 3) Well-known local locations.
  const candidates = [
    path.join(process.cwd(), "bin", "ffmpeg", `ffmpeg.exe`),
    path.join(
      process.cwd(),
      "node_modules",
      "ffmpeg-static",
      `ffmpeg${exeExt}`,
    ),
    path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg"),
    path.join(
      process.cwd(),
      "node_modules",
      "@ffmpeg-installer",
      "win32-x64",
      "ffmpeg.exe",
    ),
    path.join(
      process.cwd(),
      "node_modules",
      "@ffmpeg-installer",
      "linux-x64",
      "ffmpeg",
    ),
    path.join(
      process.cwd(),
      "node_modules",
      "@ffmpeg-installer",
      "darwin-x64",
      "ffmpeg",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 4) Last resort: whatever is on PATH (Windows: `winget install Gyan.FFmpeg`).
  //    Only when NO binary could be found anywhere do we warn (once).
  warnFfmpegOnce(
    "No usable FFmpeg binary found - ffmpeg-static's postinstall downloads it from GitHub, which can fail behind proxies. " +
      "Install ffmpeg (`winget install Gyan.FFmpeg`), set FFMPEG_PATH in .env.local, or re-run `npm install` with network access. " +
      "Trying bare `ffmpeg` on PATH.",
  );
  return isWin ? "ffmpeg.exe" : "ffmpeg";
}

export interface FfmpegProgress {
  frame?: number;
  fps?: number;
  timeSeconds?: number;
  percent?: number;
}

export interface RunFfmpegOptions {
  totalDurationSeconds?: number;
  onProgress?: (progress: FfmpegProgress) => void;
  /** Kill the process after this many ms. Default: 30 minutes. */
  timeoutMs?: number;
  /** Label used in logs/errors, e.g. "trim+crop". */
  label?: string;
  /** Working directory for the process (used to feed libass a plain file name). */
  cwd?: string;
}

const DEFAULT_FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

export function runFfmpeg(
  args: string[],
  options?: RunFfmpegOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ffmpegBin = getFfmpegPath();
    const label = options?.label ? ` ${options.label}` : "";
    log.detail(`⚙ ffmpeg${label}: ${ffmpegBin} ${args.join(" ")}`);

    const child = spawn(ffmpegBin, args, {
    windowsHide: true,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (options?.onProgress) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseFloat(timeMatch[1]);
          const mins = parseFloat(timeMatch[2]);
          const secs = parseFloat(timeMatch[3]);
          const currentSeconds = hours * 3600 + mins * 60 + secs;

          let percent: number | undefined;
          if (
            options.totalDurationSeconds &&
            options.totalDurationSeconds > 0
          ) {
            percent = Math.min(
              100,
              Math.max(
                0,
                (currentSeconds / options.totalDurationSeconds) * 100,
              ),
            );
          }

          options.onProgress({ timeSeconds: currentSeconds, percent });
        }
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new AppError("Failed to start FFmpeg.", {
          details: `${ffmpegBin}: ${error.message}`,
          resolution:
            "Install ffmpeg (`winget install Gyan.FFmpeg` on Windows) or set FFMPEG_PATH in .env.local, then retry.",
        }),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new AppError(
            `FFmpeg was killed after exceeding the timeout${label}.`,
            {
              details: `timeout=${Math.round(timeoutMs / 60000)} minutes`,
              resolution:
                "Shorten the clip, or raise the timeout for this step.",
            },
          ),
        );
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new AppError(`FFmpeg exited with a non-zero status${label}.`, {
          details: `Exit code ${code}. ${stderr.slice(-2000)}`,
          resolution:
            "Inspect the FFmpeg command printed above, confirm the input file exists and is a readable video, and retry.",
        }),
      );
    });
  });
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** True when the file has at least one audio stream. */
  hasAudio: boolean;
  /** Display rotation in degrees (0/90/180/270) when the container stores one. */
  rotation: number;
}

/**
 * Parse `ffmpeg -i` stderr.
 *
 * The old implementation matched the FIRST `, WxH` in the whole output, which
 * picks up audio/sample-rate lines or a second stream on some files. We now
 * anchor on the `Video:` line, fall back to `tbr` when `fps` is absent, and also
 * report whether an audio stream exists (the render pipeline needs that to decide
 * whether to mux in silence).
 */
export function parseFfmpegProbeOutput(stderr: string): Partial<VideoMetadata> {
  const videoLine = stderr.match(/Stream[^\n]*?\bVideo:[^\n]*/i)?.[0] ?? "";
  const audioLine = stderr.match(/Stream[^\n]*?\bAudio:[^\n]*/i)?.[0] ?? "";

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  let duration: number | undefined;
  if (durationMatch) {
    duration =
      parseInt(durationMatch[1], 10) * 3600 +
      parseInt(durationMatch[2], 10) * 60 +
      parseFloat(durationMatch[3]);
  }

  // 1920x1080 [SAR 1:1 DAR 16:9]  |  1080x1920, yuv420p  |  720x1280 (320x568)
  const resolutionMatch =
    videoLine.match(/(\d{2,5})x(\d{2,5})(?![\dx])/) ??
    stderr.match(/,\s*(\d{2,5})x(\d{2,5})[\s,(]/);

  const fpsMatch =
    videoLine.match(/(\d+(?:\.\d+)?)\s+fps/i) ??
    videoLine.match(/(\d+(?:\.\d+)?)\s+tbr/i) ??
    stderr.match(/(\d+(?:\.\d+)?)\s+fps/i);

  const rotationMatch =
    stderr.match(/rotate\s*:\s*(-?\d+)/i) ??
    stderr.match(/displaymatrix:[^\n]*?(-?\d+(?:\.\d+)?)\s*degrees/i);

  return {
    duration,
    width: resolutionMatch ? parseInt(resolutionMatch[1], 10) : undefined,
    height: resolutionMatch ? parseInt(resolutionMatch[2], 10) : undefined,
    fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
    hasAudio: Boolean(audioLine),
    rotation: rotationMatch
      ? Math.abs(Math.round(parseFloat(rotationMatch[1]))) % 360
      : 0,
  };
}

export async function getVideoMetadata(
  inputPath: string,
): Promise<VideoMetadata> {
  if (!fs.existsSync(inputPath)) {
    throw new AppError(
      "Video metadata could not be read because the file does not exist.",
      {
        status: 404,
        details: inputPath,
        resolution: "Upload the source video again and retry.",
      },
    );
  }

  const ffmpegBin = getFfmpegPath();

  return new Promise((resolve, reject) => {
    // `ffmpeg -i` with no output always exits non-zero, so we parse stderr on close.
    const child = spawn(ffmpegBin, ["-hide_banner", "-i", inputPath], {
      windowsHide: true,
    });
    let stderr = "";

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(
        new AppError("FFmpeg failed while probing video metadata.", {
          details: `${ffmpegBin}: ${toErrorMessage(error)}`,
          resolution:
            "Install ffmpeg (`winget install Gyan.FFmpeg` on Windows) or set FFMPEG_PATH in .env.local.",
        }),
      );
    });

    child.on("close", () => {
      try {
        const parsed = parseFfmpegProbeOutput(stderr);

        if (!parsed.duration || parsed.duration <= 0) {
          throw new AppError("FFmpeg could not detect the video duration.", {
            details: stderr.slice(-1000),
            resolution:
              "Confirm the uploaded file is a valid readable video and retry.",
          });
        }

        if (
          !parsed.width ||
          !parsed.height ||
          parsed.width <= 0 ||
          parsed.height <= 0
        ) {
          throw new AppError("FFmpeg could not detect the video resolution.", {
            details: stderr.slice(-1000),
            resolution:
              "Confirm the uploaded file is a valid readable video and retry.",
          });
        }

        if (!parsed.fps || parsed.fps <= 0 || parsed.fps > 240) {
          throw new AppError(
            "FFmpeg could not detect a sane video frame rate.",
            {
              details: `fps=${String(parsed.fps)} | ${stderr.slice(-600)}`,
              resolution:
                "Use a standard video file with a detectable frame rate and retry.",
            },
          );
        }

        resolve({
          duration: parsed.duration,
          width: parsed.width,
          height: parsed.height,
          fps: parsed.fps,
          hasAudio: Boolean(parsed.hasAudio),
          rotation: parsed.rotation ?? 0,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function extractAudio16kMono(
  inputVideoPath: string,
  outputWavPath: string,
): Promise<string> {
  const outputDir = path.dirname(outputWavPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-stats",
    "-i",
    inputVideoPath,
    "-vn",
    "-sn",
    "-dn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    outputWavPath,
  ];

  await runFfmpeg(args, { label: "extract-audio-16k-mono" });

  if (!fs.existsSync(outputWavPath) || fs.statSync(outputWavPath).size < 1024) {
    throw new AppError("Audio extraction produced an empty WAV file.", {
      details: outputWavPath,
      resolution:
        "Confirm the source video actually contains an audio track, then retry.",
    });
  }

  return outputWavPath;
}
