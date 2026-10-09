import type { ClipCounts, ClipRecord, VideoSummary } from './types';
import type { PipelineStatus } from './pipeline-status';

/**
 * Presentation helpers for the pipeline UI. Pure and dependency-free so both
 * the dashboard and the clip tiles render the same words and the same colours -
 * a stage is never green in one place and amber in another.
 */

/** One row of `GET /api/videos` (transcript-free, with tally + derived stage). */
export interface VideoListItem extends VideoSummary {
  counts: ClipCounts;
  pipelineStatus: PipelineStatus;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = `${h > 0 ? String(m).padStart(2, "0") : m}`;
  return `${h > 0 ? `${h}:` : ""}${mm}:${s < 10 ? "0" : ""}${s}`;
}

/** Compact wall-time for the pipeline counters: "42s", "3m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Tailwind classes for a stage chip: label + the two tokens it paints with. */
export interface StageMeta {
  label: string;
  /** Short line shown next to the label when there is nothing better to say. */
  hint: string;
  /** `text/… bg/… ring/…` classes for the chip. */
  chip: string;
  /** Solid colour used by the progress bar and the stepper rail. */
  bar: string;
  pulse: boolean;
}

export function stageMeta(stage: PipelineStatus["stage"]): StageMeta {
  switch (stage) {
    case "transcribing":
      return {
        label: "Transcribing",
        hint: "Extracting word-level timestamps",
        chip: "text-sky-700 bg-sky-500/10 ring-sky-500/25 dark:text-sky-300",
        bar: "bg-sky-500",
        pulse: true,
      };
    case "analyzing":
      return {
        label: "Detecting clips",
        hint: "AI is scoring the transcript",
        chip: "text-violet-700 bg-violet-500/10 ring-violet-500/25 dark:text-violet-300",
        bar: "bg-violet-500",
        pulse: true,
      };
    case "rendering":
      return {
        label: "Rendering",
        hint: "Cropping, captioning and encoding",
        chip: "text-amber-700 bg-amber-500/10 ring-amber-500/25 dark:text-amber-300",
        bar: "bg-amber-500",
        pulse: true,
      };
    case "queued":
      return {
        label: "Queued",
        hint: "Waiting for the worker",
        chip: "text-muted-foreground bg-muted ring-border",
        bar: "bg-muted-foreground/50",
        pulse: true,
      };
    case "awaiting-detection":
      return {
        label: "Needs detection",
        hint: "Run viral detection to continue",
        chip: "text-muted-foreground bg-muted ring-border",
        bar: "bg-muted-foreground/40",
        pulse: false,
      };
    case "awaiting-render":
      return {
        label: "Needs rendering",
        hint: "Clips are ready to render",
        chip: "text-sky-700 bg-sky-500/10 ring-sky-500/25 dark:text-sky-300",
        bar: "bg-sky-500/70",
        pulse: false,
      };
    case "ready":
      return {
        label: "Ready",
        hint: "All done",
        chip: "text-emerald-700 bg-emerald-500/10 ring-emerald-500/25 dark:text-emerald-300",
        bar: "bg-emerald-500",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        hint: "Open the step for the reason",
        chip: "text-destructive bg-destructive/10 ring-destructive/25",
        bar: "bg-destructive",
        pulse: false,
      };
    default:
      return {
        label: "Idle",
        hint: "",
        chip: "text-muted-foreground bg-muted ring-border",
        bar: "bg-muted-foreground/40",
        pulse: false,
      };
  }
}

/** How a viral score reads, and how it is coloured. */
export function scoreTone(score: number): {
  label: string;
  text: string;
  ring: string;
  fill: string;
} {
  if (score >= 8.5)
    return {
      label: "Breakout",
      text: "text-emerald-600 dark:text-emerald-400",
      ring: "ring-emerald-500/30",
      fill: "bg-emerald-500",
    };
  if (score >= 7)
    return {
      label: "Strong",
      text: "text-lime-600 dark:text-lime-400",
      ring: "ring-lime-500/30",
      fill: "bg-lime-500",
    };
  if (score >= 5.5)
    return {
      label: "Solid",
      text: "text-amber-600 dark:text-amber-400",
      ring: "ring-amber-500/30",
      fill: "bg-amber-500",
    };
  return {
    label: "Weak",
    text: "text-muted-foreground",
    ring: "ring-border",
    fill: "bg-muted-foreground/50",
  };
}

export function clipScore(clip: ClipRecord): number | null {
  const score = clip.aiAnalysis?.scores.viral_score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

/** Grid order: newest detection run first, then the AI's own rank. */
export function sortClipsForGrid<T extends ClipRecord>(
  clips: readonly T[],
  mode: "run" | "score" | "status" = "run"
): T[] {
  const list = [...clips];
  if (mode === "score") {
    return list.sort((a, b) => (clipScore(b) ?? -1) - (clipScore(a) ?? -1));
  }
  if (mode === "status") {
    const weight = { processing: 0, pending: 1, failed: 2, done: 3 } as const;
    return list.sort(
      (a, b) => weight[a.status] - weight[b.status] || (clipScore(b) ?? -1) - (clipScore(a) ?? -1)
    );
  }
  return list.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    const rankA = a.aiAnalysis?.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.aiAnalysis?.rank ?? Number.POSITIVE_INFINITY;
    if (rankA === rankB) return 0;
    return rankA < rankB ? -1 : 1;
  });
}

/** True while anything is still moving - decides whether we keep polling. */
export function isPipelineActive(status: PipelineStatus | undefined): boolean {
  if (!status) return false;
  return status.stage === "transcribing" || status.stage === "analyzing" || status.stage === "rendering";
}

/** A clip that is queued or rendering - the grid shows progress on those. */
export function isClipLive(clip: ClipRecord): boolean {
  return clip.status === "processing" || clip.status === "pending";
}
