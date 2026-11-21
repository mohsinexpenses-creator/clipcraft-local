/**
 * `npm run bench:render` - the Phase 7 concurrency benchmark.
 *
 * Renders the SAME sample clip three times at three Remotion tab counts (50 %,
 * 75 % and 100 % of the core-aware default) and prints a side-by-side comparison
 * of the worker's own `[JOB-TIMING]` stages, so "more tabs" is judged on a
 * measurement instead of a guess.
 *
 *   npm run bench:render
 *   npm run bench:render -- --video /path/to/clip.mp4 --start 1665.8 --end 1753.3
 *   npm run bench:render -- --profile 50,100
 *   npm run bench:render -- --resume 50,75    (re-attach to an interrupted run)
 *
 * It uses a THROWAWAY database inside its own output directory: the clip and
 * video records are created there, so an ordinary database is never touched (the
 * worker's render itself is the only heavy part). Results are streamed to
 * `bench-render/results.jsonl` after every profile, so an interrupted benchmark
 * keeps the runs that already finished.
 *
 * Without `--video` the bundled sample is used if one exists; otherwise the
 * benchmark reports the profile it WOULD use instead of inventing timings.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { coreAwareRemotionTabs, formatRenderBudget, logicalThreads } from "../lib/core-defaults";
import {
  DEFAULT_PIPELINE_OPTIONS,
  type PipelineOptions,
  type WordTimestamp,
} from "../lib/types";
import { benchmarkEnvironment } from "../lib/render-benchmark";

interface Args {
  video?: string;
  start: number;
  end: number;
  profiles: number[];
  layout: "speaker-focus" | "split-screen";
  out: string;
  resumeOnly?: number[];
  faceImage?: string;
  keepVideo: boolean;
  timeoutSeconds: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    start: 0,
    end: 12,
    profiles: [50, 75, 100],
    layout: "speaker-focus",
    out: path.join(process.cwd(), "bench-render"),
    keepVideo: false,
    timeoutSeconds: 1800,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--video") args.video = argv[++index];
    else if (arg === "--face-image") args.faceImage = argv[++index];
    else if (arg === "--start") args.start = Number(argv[++index]);
    else if (arg === "--end") args.end = Number(argv[++index]);
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--layout") {
      const value = argv[++index];
      if (value === "split-screen" || value === "speaker-focus") args.layout = value;
    } else if (arg === "--timeout") args.timeoutSeconds = Number(argv[++index]) || args.timeoutSeconds;
    else if (arg === "--keep-video") args.keepVideo = true;
    else if (arg === "--profile" || arg === "--resume") {
      const parsed = (argv[++index] ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= 100);
      if (parsed.length === 0) continue;
      if (arg === "--profile") args.profiles = parsed;
      else {
        args.profiles = parsed;
        args.resumeOnly = parsed;
      }
    }
  }
  return args;
}

/** The bundled sample, or the seeded demo, or nothing. */
function findSampleVideo(explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  return (
    [
      path.join(process.cwd(), "public", "sample.mp4"),
      path.join(process.cwd(), "data", "sample.mp4"),
      path.join(process.cwd(), "public", "demo.mp4"),
    ].find((candidate) => fs.existsSync(candidate)) ?? null
  );
}

/**
 * A deterministic ~20 s test source: one still frame (a face, when the caller
 * supplies one) plus real motion, so ASD, the locked camera, captions and the
 * final encode all do real work. A drawn disc is NOT a face to YuNet - the
 * detector correctly refuses to find one - so the source must be an image.
 */
function makeSyntheticSource(file: string, faceImage?: string, seconds = 20): boolean {
  if (fs.existsSync(file)) return true;
  const filter = faceImage
    ? // A face that drifts and slowly breathes, which is what the camera lock and
      // ASD are built to react to. `zoompan` keeps the subject's own pixels.
      `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
      `zoompan=z='1.02+0.004*sin(2*PI*on/90)':x='iw/2-(iw/zoom/2)+6*sin(2*PI*on/75)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,` +
      `trim=duration=${seconds},setpts=PTS-STARTPTS,` +
      `drawtext=text='render benchmark':x=60:y=60:fontsize=40:fontcolor=white@0.55[v]`
    : [
        `color=c=0x1b2430:s=1920x1080:r=30:d=${seconds}`,
        `drawtext=text='benchmark source':x=60:y=60:fontsize=42:fontcolor=white@0.5`,
      ].join(",");
  const inputArgs = faceImage
    ? ["-loop", "1", "-framerate", "30", "-i", faceImage, "-filter_complex", filter]
    : ["-f", "lavfi", "-i", filter];
  const result = spawnSync(
    ffmpegPath as unknown as string,
    [
      "-y",
      "-v",
      "error",
      ...inputArgs,
      ...(faceImage ? ["-map", "[v]"] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      ...(faceImage ? ["-t", String(seconds)] : []),
      file,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    console.error(`  could not generate a test source: ${(result.stderr ?? "").slice(0, 200)}`);
    return false;
  }
  return true;
}

interface Timings {
  wallMs?: number;
  stages: Record<string, number>;
  lines: string[];
}

/** Run one render and capture its `[JOB-TIMING]` line. */
async function runProfile(options: {
  videoPath: string;
  start: number;
  end: number;
  layout: "speaker-focus" | "split-screen";
  tabs: number;
  dbPath: string;
  timeoutSeconds: number;
}): Promise<Timings> {
  process.env.CLIPCRAFT_DB_PATH = options.dbPath;
  process.env.REMOTION_CONCURRENCY = String(options.tabs);
  const { saveVideo, saveClip } = await import("../lib/db");
  const { processClipJob } = await import("../worker/processor");

  const now = new Date().toISOString();
  const videoId = `bench-video-${crypto.randomBytes(4).toString("hex")}`;
  // Captions need word timings, and a synthetic source has no speech, so the
  // benchmark seeds a deterministic transcript over the rendered window. Every
  // stage below (ASD, camera, captions, B-roll, encode) then does real work.
  const words: WordTimestamp[] = [];
  const script = "so this is the benchmark clip we use to compare render settings across profiles".split(" ");
  const from = Math.max(0, options.start);
  const to = Math.max(from + 1, options.end);
  for (let t = from, index = 0; t < to; t += 0.36, index += 1) {
    const word = script[index % script.length];
    words.push({ word, start: Number(t.toFixed(2)), end: Number(Math.min(t + 0.3, to).toFixed(2)) });
  }
  await saveVideo({
    _id: videoId,
    originalName: path.basename(options.videoPath),
    fileName: path.basename(options.videoPath),
    filePath: options.videoPath,
    duration: Math.max(options.end, 20),
    width: 1920,
    height: 1080,
    fileSize: fs.statSync(options.videoPath).size,
    status: "transcribed",
    transcript: {
      text: script.join(" "),
      segments: [{ id: 0, text: script.join(" "), start: from, end: to }],
      words,
    },
    createdAt: now,
    updatedAt: now,
    pipeline: { ...DEFAULT_PIPELINE_OPTIONS, autoDetect: false, autoRender: false } as PipelineOptions,
  });

  const clipId = `bench-clip-${crypto.randomBytes(4).toString("hex")}`;
  await saveClip({
    _id: clipId,
    videoId,
    start: options.start,
    end: options.end,
    hookDuration: 0,
    hookText: "",
    ctaText: "",
    filterPreset: "none",
    layout: options.layout,
    status: "pending",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  });

  const lines: string[] = [];
  const originalLog = console.log;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  console.log = (...values: unknown[]) => {
    const text = values.map(String).join(" ");
    if (text.includes("[JOB-TIMING]")) lines.push(text);
    originalLog(...values);
  };
  const startedAt = Date.now();
  try {
    await processClipJob({
      clipId,
      videoId,
      start: options.start,
      end: options.end,
      hookDuration: 0,
      hookText: "",
      ctaText: "",
      ctaDuration: 0,
      filterPreset: "none",
      captionPresetId: "caption-theme-kinetic-01",
      layout: options.layout,
    }, undefined, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    console.log = originalLog;
  }
  const wallMs = Date.now() - startedAt;

  const stages: Record<string, number> = {};
  const summaryLine = lines[lines.length - 1] ?? "";
  const match = summaryLine.match(/stages: (.*)$/);
  if (match) {
    for (const entry of match[1].split(", ")) {
      const stageMatch = entry.match(/^([^=]+)=([\d.]+)(ms|s)(?:×\d+)?$/);
      if (!stageMatch) continue;
      stages[stageMatch[1]] = stageMatch[3] === "s" ? Number(stageMatch[2]) * 1000 : Number(stageMatch[2]);
    }
  }
  return { wallMs, stages, lines };
}

function readResults(file: string): Array<{ profile: number; tabs: number; wallMs?: number; stages: Record<string, number> }> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { profile: number; tabs: number; wallMs?: number; stages: Record<string, number> };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { profile: number; tabs: number; wallMs?: number; stages: Record<string, number> } => entry !== null);
}

function printComparison(results: ReturnType<typeof readResults>): void {
  const stageNames = [...new Set(results.flatMap((entry) => Object.keys(entry.stages)))];
  console.log("");
  console.log("  [JOB-TIMING] comparison");
  console.log(`  ${"stage".padEnd(22)}${results.map((entry) => `${entry.profile}%`.padStart(12)).join("")}`);
  console.log(`  ${"wall".padEnd(22)}${results.map((entry) => `${(entry.wallMs ?? 0)}ms`.padStart(12)).join("")}`);
  for (const stage of stageNames) {
    console.log(
      `  ${stage.padEnd(22)}${results.map((entry) => `${Math.round(entry.stages[stage] ?? 0)}ms`.padStart(12)).join("")}`,
    );
  }
  const best = [...results].sort((a, b) => (a.wallMs ?? Infinity) - (b.wallMs ?? Infinity))[0];
  if (best?.wallMs) {
    console.log(`  fastest: ${best.profile}% at ${best.wallMs}ms (${best.tabs} tab(s))`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const budget = benchmarkEnvironment();
  console.log("Render concurrency benchmark");
  console.log(`  ${formatRenderBudget(budget)}  benchmark=${budget.benchmarkId}`);
  console.log(`  host threads=${logicalThreads()} default tabs=${coreAwareRemotionTabs()} layout=${args.layout}`);

  fs.mkdirSync(args.out, { recursive: true });
  const resultsFile = path.join(args.out, "results.jsonl");
  const dbPath = path.join(args.out, "bench-render.db");
  if (!args.resumeOnly && fs.existsSync(resultsFile)) fs.rmSync(resultsFile);

  let video = findSampleVideo(args.video);
  let synthetic = false;
  if (!video) {
    const candidate = path.join(args.out, "synthetic-source.mp4");
    // `--face-image` (or bench-render/face-source.png) makes the source contain a
    // real face, which ASD requires; without one the benchmark cannot render.
    const faceImage = [args.faceImage, path.join(args.out, "face-source.png")].find(
      (entry): entry is string => Boolean(entry) && fs.existsSync(entry as string),
    );
    console.log(
      `  no --video given: generating a deterministic 20 s test source${faceImage ? ` from ${path.basename(faceImage)}` : " (no face image!)"}`,
    );
    if (!faceImage) {
      console.log("  WARNING: without --video or --face-image the generated source has no face,");
      console.log("           ASD will reject it (a drawn shape is not a person) and no timing is recorded.");
    }
    if (!makeSyntheticSource(candidate, faceImage)) {
      console.log("  NEEDS MANUAL VERIFICATION: pass --video to benchmark a real clip.");
      process.exitCode = 2;
      return;
    }
    video = candidate;
    synthetic = true;
  }
  console.log(`  source: ${video}${synthetic ? " (synthetic)" : ""} window=${args.start}-${args.end}s`);

  const results = readResults(resultsFile);
  const threads = logicalThreads();
  for (const profile of args.profiles) {
    if (results.some((entry) => entry.profile === profile)) {
      console.log(`  ${profile}%: already recorded, skipping`);
      continue;
    }
    const tabs = Math.max(1, Math.round((threads * profile) / 100));
    console.log("");
    console.log(`  --- profile ${profile}% (REMOTION_CONCURRENCY=${tabs}) ---`);
    try {
      const timings = await runProfile({
        videoPath: video,
        start: args.start,
        end: args.end,
        layout: args.layout,
        tabs,
        dbPath,
        timeoutSeconds: args.timeoutSeconds,
      });
      const record = {
        profile,
        tabs,
        wallMs: timings.wallMs,
        stages: timings.stages,
        threads: budget.threads,
        budget: budget.note,
        benchmarkId: budget.benchmarkId,
        layout: args.layout,
        window: [args.start, args.end],
      };
      results.push(record);
      fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
      for (const line of timings.lines) console.log(`  ${line}`);
      if (!timings.wallMs) console.log("  (no [JOB-TIMING] line: the job did not finish)");
    } catch (error) {
      console.error(`  profile ${profile}% failed: ${error instanceof Error ? error.message : String(error)}`);
      fs.appendFileSync(
        resultsFile,
        `${JSON.stringify({ profile, tabs, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  }

  printComparison(results.filter((entry) => entry.wallMs));
  if (!args.keepVideo && synthetic && video) fs.rmSync(video, { force: true });
  console.log("");
  console.log(`  results: ${resultsFile}`);
}

// Remotion rejects its bundle asynchronously when the headless browser cannot be
// downloaded (an offline or restricted host). Without a trap that surfaces as an
// unhandled rejection with no context; turn it into a readable note instead.
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("");
  console.error("  The Remotion bundle rejected in the background:");
  console.error(`    ${message.split("\n")[0]}`);
  if (/chromium|chrome-headless|ECONNRESET|ENOTFOUND|certificate/i.test(message)) {
    console.error("  Chromium is not available on this host, so no render can be timed.");
    console.error("  NEEDS MANUAL VERIFICATION: run this benchmark on the render machine.");
  }
  process.exitCode = 1;
});

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
