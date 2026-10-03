import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { AppError, RenderCancelledError, toErrorMessage } from "./errors";
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

let ffprobeWarnedOnce = false;
function warnFfprobeOnce(message: string): void {
  if (ffprobeWarnedOnce) return;
  ffprobeWarnedOnce = true;
  log.warn(message);
}

function findExecutableOnPath(command: string): string | null {
  const extension = process.platform === "win32" && !/\.exe$/i.test(command) ? ".exe" : "";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, `${command}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve ffprobe from an explicit setting, beside FFmpeg, or from PATH. */
export function getFfprobePath(): string {
  const isWin = process.platform === "win32";
  const executable = isWin ? "ffprobe.exe" : "ffprobe";
  const configured = process.env.FFPROBE_PATH?.trim();
  if (configured && configured.toLowerCase() !== "your_ffprobe_path") {
    if (fs.existsSync(configured) || !/[\\/]/.test(configured)) return configured;
    warnFfprobeOnce(`FFPROBE_PATH="${configured}" does not exist - searching beside FFmpeg and on PATH.`);
  }

  const siblingDirs: string[] = [];
  const ffmpegOverride = process.env.FFMPEG_PATH?.trim();
  if (ffmpegOverride && /[\\/]/.test(ffmpegOverride)) siblingDirs.push(path.dirname(ffmpegOverride));
  if (typeof ffmpegStaticPath === "string" && ffmpegStaticPath) siblingDirs.push(path.dirname(ffmpegStaticPath));
  siblingDirs.push(path.join(process.cwd(), "bin", "ffmpeg"));
  siblingDirs.push(path.join(process.cwd(), "node_modules", "ffmpeg-static"));
  for (const directory of siblingDirs) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }

  return findExecutableOnPath("ffprobe") ?? executable;
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
  /**
   * Poll for a user-requested cancellation (checked at most once per second
   * while FFmpeg is running). When it returns true the child is killed and the
   * promise rejects with RenderCancelledError.
   */
  isCancelled?: () => boolean;
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

    // Windows CreateProcess caps the full command line at ~32,767 chars
    // (Linux is much higher). Warn well below that so an over-long filter
    // graph (e.g. hundreds of keyframes in a pan expression) is visible in
    // the log instead of surfacing as an opaque spawn ENAMETOOLONG.
    const commandLength = args.join(" ").length;
    if (commandLength > 20000) {
      log.warn(
        `FFmpeg command line is ${commandLength.toLocaleString()} chars - close to the OS limit; layout output should be reduced.`,
      );
    }

    const child = spawn(ffmpegBin, args, {
    windowsHide: true,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Cancellation: poll at most once per second; when the user asked to stop,
    // kill the child and reject with RenderCancelledError (never retried).
    let cancelTimer: NodeJS.Timeout | null = null;
    if (options?.isCancelled) {
      const pollCancel = options.isCancelled;
      cancelTimer = setInterval(() => {
        if (settled || cancelled) return;
        let wantsCancel = false;
        try {
          wantsCancel = pollCancel() === true;
        } catch {
          wantsCancel = false;
        }
        if (!wantsCancel) return;
        cancelled = true;
        settled = true;
        clearTimeout(timer);
        if (cancelTimer) clearInterval(cancelTimer);
        child.kill("SIGKILL");
        reject(new RenderCancelledError());
      }, 1000);
    }

    const finishSettled = () => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
    };

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
      if (settled) return;
      settled = true;
      finishSettled();
      reject(
        new AppError("Failed to start FFmpeg.", {
          details: `${ffmpegBin}: ${error.message}`,
          resolution:
            "Install ffmpeg (`winget install Gyan.FFmpeg` on Windows) or set FFMPEG_PATH in .env.local, then retry.",
        }),
      );
    });

    child.on("close", (code) => {
      finishSettled();

      if (settled) return; // cancelled path already rejected
      settled = true;

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

export interface FfprobeStreamMetadata {
  index: number | null;
  codecType: string | null;
  codecName: string | null;
  width: number | null;
  height: number | null;
  averageFrameRate: string | null;
  nominalFrameRate: string | null;
  startTime: number | null;
  duration: number | null;
  bitRate: number | null;
  sampleRate: number | null;
  channels: number | null;
  rotation: number | null;
}

export interface FfprobeMetadata {
  formatDuration: number | null;
  formatStartTime: number | null;
  formatBitRate: number | null;
  streams: FfprobeStreamMetadata[];
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  /** Average frame rate, which is the correct nominal output rate for VFR input. */
  fps: number;
  /** True when the file has at least one audio stream. */
  hasAudio: boolean;
  /** Display rotation in degrees (0/90/180/270) when the container stores one. */
  rotation: number;
  averageFrameRate: string | null;
  nominalFrameRate: string | null;
  /** Null means ffprobe was unavailable or did not report both rates. */
  isVariableFrameRate: boolean | null;
  videoStartTime: number;
  videoDuration: number;
  audioStartTime: number | null;
  audioDuration: number | null;
  formatBitRate: number | null;
  videoBitRate: number | null;
  audioBitRate: number | null;
}

interface RawFfprobeStream {
  index?: number | string;
  codec_type?: string;
  codec_name?: string;
  width?: number | string;
  height?: number | string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  start_time?: string;
  duration?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number | string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface RawFfprobeOutput {
  streams?: RawFfprobeStream[];
  format?: { duration?: string; start_time?: string; bit_rate?: string };
}

function nullableNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "N/A") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a rational or decimal FFprobe frame-rate field. */
export function parseFrameRate(value: string | null | undefined): number | null {
  if (!value || value === "N/A") return null;
  const parts = value.split("/");
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * FFprobe reports the average and nominal/base rates. A material difference is
 * evidence of variable frame pacing; the 1% tolerance avoids classifying small
 * container/time-base rounding differences (for example 29.97 vs 30) as VFR.
 */
export function detectVariableFrameRate(
  averageFrameRate: string | null | undefined,
  nominalFrameRate: string | null | undefined,
  relativeTolerance = 0.01
): boolean | null {
  const average = parseFrameRate(averageFrameRate);
  const nominal = parseFrameRate(nominalFrameRate);
  if (average === null || nominal === null) return null;
  return Math.abs(average - nominal) / Math.max(average, nominal) > relativeTolerance;
}

export function parseFfprobeJsonOutput(stdout: string): FfprobeMetadata {
  const raw = JSON.parse(stdout) as RawFfprobeOutput;
  const streams = (raw.streams ?? []).map((stream): FfprobeStreamMetadata => {
    const sideDataRotation = stream.side_data_list?.find((item) => Number.isFinite(item.rotation))?.rotation;
    const taggedRotation = nullableNumber(stream.tags?.rotate);
    const rawRotation = sideDataRotation ?? taggedRotation;
    return {
      index: nullableNumber(stream.index),
      codecType: stream.codec_type ?? null,
      codecName: stream.codec_name ?? null,
      width: nullableNumber(stream.width),
      height: nullableNumber(stream.height),
      averageFrameRate: stream.avg_frame_rate ?? null,
      nominalFrameRate: stream.r_frame_rate ?? null,
      startTime: nullableNumber(stream.start_time),
      duration: nullableNumber(stream.duration),
      bitRate: nullableNumber(stream.bit_rate),
      sampleRate: nullableNumber(stream.sample_rate),
      channels: nullableNumber(stream.channels),
      rotation: rawRotation === null || rawRotation === undefined
        ? null
        : Math.abs(Math.round(rawRotation)) % 360,
    };
  });
  return {
    formatDuration: nullableNumber(raw.format?.duration),
    formatStartTime: nullableNumber(raw.format?.start_time),
    formatBitRate: nullableNumber(raw.format?.bit_rate),
    streams,
  };
}

export function parseVideoMetadataFromFfprobe(probe: FfprobeMetadata): VideoMetadata {
  const video = probe.streams.find((stream) => stream.codecType === "video");
  if (!video) throw new Error("ffprobe reported no video stream.");
  const audio = probe.streams.find((stream) => stream.codecType === "audio") ?? null;
  const averageFrameRate = video.averageFrameRate;
  const nominalFrameRate = video.nominalFrameRate;
  const fps = parseFrameRate(averageFrameRate) ?? parseFrameRate(nominalFrameRate) ?? 0;
  const duration = probe.formatDuration ?? video.duration ?? 0;
  return {
    duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    hasAudio: audio !== null,
    rotation: video.rotation ?? 0,
    averageFrameRate,
    nominalFrameRate,
    isVariableFrameRate: detectVariableFrameRate(averageFrameRate, nominalFrameRate),
    videoStartTime: video.startTime ?? probe.formatStartTime ?? 0,
    videoDuration: video.duration ?? duration,
    audioStartTime: audio?.startTime ?? null,
    audioDuration: audio?.duration ?? null,
    formatBitRate: probe.formatBitRate,
    videoBitRate: video.bitRate,
    audioBitRate: audio?.bitRate ?? null,
  };
}

/** Parse `ffmpeg -i` stderr for installations without a standalone ffprobe. */
export function parseFfmpegProbeOutput(stderr: string): Partial<VideoMetadata> {
  const videoLine = stderr.match(/Stream[^\n]*?\bVideo:[^\n]*/i)?.[0] ?? "";
  const audioLine = stderr.match(/Stream[^\n]*?\bAudio:[^\n]*/i)?.[0] ?? "";
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durationMatch
    ? parseInt(durationMatch[1], 10) * 3600 +
      parseInt(durationMatch[2], 10) * 60 +
      parseFloat(durationMatch[3])
    : undefined;
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
    rotation: rotationMatch ? Math.abs(Math.round(parseFloat(rotationMatch[1]))) % 360 : 0,
  };
}

/** Capture a structured FFprobe report for a local media file. */
export async function probeMediaWithFfprobe(inputPath: string): Promise<FfprobeMetadata> {
  if (!fs.existsSync(inputPath)) throw new Error(`Media file does not exist: ${inputPath}`);
  const ffprobeBin = getFfprobePath();
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      inputPath,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => reject(new Error(`${ffprobeBin}: ${toErrorMessage(error)}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with status ${String(code)}: ${stderr.slice(-1500)}`));
        return;
      }
      try {
        resolve(parseFfprobeJsonOutput(stdout));
      } catch (error) {
        reject(new Error(`Could not parse ffprobe JSON: ${toErrorMessage(error)}`));
      }
    });
  });
}

function isValidVideoMetadata(metadata: VideoMetadata): boolean {
  return Number.isFinite(metadata.duration) && metadata.duration > 0 &&
    Number.isFinite(metadata.width) && metadata.width > 0 &&
    Number.isFinite(metadata.height) && metadata.height > 0 &&
    Number.isFinite(metadata.fps) && metadata.fps > 0 && metadata.fps <= 240;
}

export async function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  if (!fs.existsSync(inputPath)) {
    throw new AppError("Video metadata could not be read because the file does not exist.", {
      status: 404,
      details: inputPath,
      resolution: "Upload the source video again and retry.",
    });
  }

  try {
    const metadata = parseVideoMetadataFromFfprobe(await probeMediaWithFfprobe(inputPath));
    if (!isValidVideoMetadata(metadata)) throw new Error("ffprobe returned incomplete video metadata.");
    return metadata;
  } catch (error) {
    warnFfprobeOnce(
      `ffprobe metadata unavailable (${toErrorMessage(error)}). VFR detection and stream timing diagnostics are unavailable; install a full FFmpeg build with ffprobe or set FFPROBE_PATH. Falling back to FFmpeg text probing.`
    );
  }

  const ffmpegBin = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ["-hide_banner", "-i", inputPath], { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      reject(new AppError("FFmpeg failed while probing video metadata.", {
        details: `${ffmpegBin}: ${toErrorMessage(error)}`,
        resolution: "Install FFmpeg and ffprobe or set FFMPEG_PATH / FFPROBE_PATH in .env.local.",
      }));
    });
    child.on("close", () => {
      const parsed = parseFfmpegProbeOutput(stderr);
      const metadata: VideoMetadata = {
        duration: parsed.duration ?? 0,
        width: parsed.width ?? 0,
        height: parsed.height ?? 0,
        fps: parsed.fps ?? 0,
        hasAudio: Boolean(parsed.hasAudio),
        rotation: parsed.rotation ?? 0,
        averageFrameRate: null,
        nominalFrameRate: null,
        isVariableFrameRate: null,
        videoStartTime: 0,
        videoDuration: parsed.duration ?? 0,
        audioStartTime: parsed.hasAudio ? 0 : null,
        audioDuration: parsed.hasAudio ? parsed.duration ?? null : null,
        formatBitRate: null,
        videoBitRate: null,
        audioBitRate: null,
      };
      if (!isValidVideoMetadata(metadata)) {
        reject(new AppError("FFmpeg could not detect complete video metadata.", {
          details: `duration=${metadata.duration}, size=${metadata.width}x${metadata.height}, fps=${metadata.fps} | ${stderr.slice(-1000)}`,
          resolution: "Confirm the uploaded file is a valid readable video and retry.",
        }));
        return;
      }
      resolve(metadata);
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
