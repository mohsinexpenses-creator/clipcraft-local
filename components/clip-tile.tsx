"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  EllipsisVertical,
  Film,
  Loader2,
  PencilLine,
  Play,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react"
import { cn } from "cn"
import type { CaptionPreset, ClipRecord } from "@/lib/types"
import { clipScore, formatTime, scoreTone } from "@/lib/pipeline-ui"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ClipAnalysisPanel } from "@/components/clip-analysis"

/**
 * One clip in the results grid.
 *
 * The tile is mostly the video: a 9:16 canvas that plays a muted preview on
 * hover, with the viral score on top of it and the render state underneath.
 * Everything else (edit, analytics, download, re-render, delete) is one row
 * below, so nothing has to be hovered to be found.
 */

/** Compact 0-10 gauge drawn with SVG so it stays crisp at any tile size. */
function ScoreGauge({ score }: { score: number | null }) {
  const value = score ?? 0;
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const tone = scoreTone(value);

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-full bg-background/85 py-1 pr-2.5 pl-1 shadow-sm ring-1 backdrop-blur-md",
        tone.ring
      )}
      title={score === null ? "No AI score stored for this clip" : `Viral score ${value.toFixed(1)}/10 · ${tone.label}`}
    >
      <span className="relative flex size-8 items-center justify-center">
        <svg viewBox="0 0 36 36" className="absolute inset-0 size-8 -rotate-90">
          <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3" className="stroke-foreground/10" />
          <circle
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(value / 10) * circumference} ${circumference}`}
            className={cn("transition-[stroke-dasharray] duration-700", tone.fill.replace("bg-", "stroke-"))}
          />
        </svg>
        <span className={cn("text-[10px] leading-none font-bold tabular", tone.text)}>
          {score === null ? "—" : value.toFixed(1)}
        </span>
      </span>
      <span className={cn("hidden text-[10px] leading-none font-semibold tracking-wide uppercase sm:block", tone.text)}>
        {score === null ? "unrated" : tone.label}
      </span>
    </div>
  );
}

function StatusChip({ clip }: { clip: ClipRecord }) {
  switch (clip.status) {
    case "done":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-500/25 backdrop-blur-md dark:text-emerald-300">
          <CheckCircle2 className="size-3" />
          Ready
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-500/25 backdrop-blur-md dark:text-amber-300">
          <Loader2 className="size-3 animate-spin" />
          {clip.progress ?? 0}%
        </span>
      );
    case "failed":
      return (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-destructive/12 px-1.5 py-0.5 text-[10px] font-semibold text-destructive ring-1 ring-destructive/25 backdrop-blur-md"
          title={clip.error ?? "Render failed"}
        >
          <AlertCircle className="size-3" />
          Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground ring-1 ring-border backdrop-blur-md">
          <Clock className="size-3" />
          Queued
        </span>
      );
  }
}

export interface ClipTileProps {
  clip: ClipRecord;
  captionPresets: CaptionPreset[];
  busy?: boolean;
  onEdit: (clip: ClipRecord) => void;
  onRender: (clip: ClipRecord) => void;
  onCancel: (clip: ClipRecord) => void;
  onDelete: (clip: ClipRecord) => void;
}

export function ClipTile({ clip, captionPresets, busy, onEdit, onRender, onCancel, onDelete }: ClipTileProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [engaged, setEngaged] = React.useState(false);
  const [analysisOpen, setAnalysisOpen] = React.useState(false);

  const mediaUrl = clip.outputPath ? `/api/media${clip.outputPath}` : null;
  const isDone = clip.status === "done" && Boolean(mediaUrl);
  const isProcessing = clip.status === "processing";
  const isQueued = clip.status === "pending";
  const isFailed = clip.status === "failed";
  const isLive = isProcessing || isQueued;
  const score = clipScore(clip);
  const title = clip.aiAnalysis?.viral_packaging.video_title || clip.hookText || "Untitled clip";
  const captionName =
    clip.captionPreset?.name ||
    captionPresets.find((preset) => preset._id === clip.captionPresetId)?.name ||
    "default captions";
  const rank = clip.aiAnalysis?.rank;

  // Deliberately NO autoplay: a finished clip shows its first frame and waits.
  // Playback starts only from an explicit click on the play button (which then
  // swaps in the native controls) - never from hovering or from the grid
  // re-rendering when the render finishes.
  const startPlayback = () => {
    if (!isDone || engaged) return;
    setEngaged(true);
    queueMicrotask(() => {
      void videoRef.current?.play().catch(() => undefined);
    });
  };

  return (
    <article
      className={cn(
        "group/tile flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[var(--shadow-card)] transition-[transform,box-shadow,border-color] duration-300",
        "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[var(--shadow-lift)]",
        isProcessing && "border-amber-500/40",
        isFailed && "border-destructive/40"
      )}
    >
      {/* ---------------- media ---------------- */}
      <div className="relative aspect-9/16 w-full overflow-hidden bg-muted">
        {isDone ? (
          <video
            ref={videoRef}
            src={mediaUrl ?? undefined}
            controls={engaged}
            playsInline
            muted={!engaged}
            loop
            preload="metadata"
            className="size-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 text-center">
            {isProcessing ? (
              <>
                <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
                  <div
                    className="h-full bg-amber-500 transition-[width] duration-700 ease-out"
                    style={{ width: `${Math.max(4, clip.progress ?? 0)}%` }}
                  />
                </div>
                <Loader2 className="size-6 animate-spin text-primary" />
                <div className="w-32 space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {clip.progress && clip.progress > 0 ? `Rendering · ${clip.progress}%` : "Preparing render"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">crop · captions · hook · encode</p>
                </div>
              </>
            ) : isFailed ? (
              <>
                <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <XCircle className="size-5" />
                </span>
                <p className="max-w-[85%] text-[11px] leading-snug text-destructive">
                  {clip.error?.slice(0, 140) || "Render failed"}
                </p>
              </>
            ) : (
              <>
                <Film className="size-6 text-muted-foreground/50" />
                <p className="text-[11px] text-muted-foreground">
                  {isQueued ? "Waiting for a render slot" : "Not rendered yet"}
                </p>
              </>
            )}
          </div>
        )}

        {/* gradient so the chips stay legible over any frame */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/45 to-transparent"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent px-2.5 pt-8 pb-2">
          <span className="text-[10.5px] font-medium tabular text-white/90">
            {formatTime(clip.start)} – {formatTime(clip.end)}
            <span className="ml-1 text-white/60">· {Math.round(clip.end - clip.start)}s</span>
          </span>
          {clip.layout === "split-screen" && (
            <span className="rounded bg-white/15 px-1 py-px text-[9.5px] font-medium text-white/90 backdrop-blur-sm">
              split
            </span>
          )}
        </div>

        <div className="absolute top-2 left-2">
          <ScoreGauge score={score} />
        </div>
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1.5">
          <StatusChip clip={clip} />
          {rank !== undefined && (
            <span
              className="rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-bold text-foreground/80 ring-1 ring-border backdrop-blur-md"
              title="Rank among the clips of this detection run (1 = most viral)"
            >
              #{rank}
            </span>
          )}
        </div>

        {isDone && !engaged && (
          <button
            type="button"
            onClick={startPlayback}
            aria-label={`Play ${title}`}
            title="Play clip"
            className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-90 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-foreground shadow-lg backdrop-blur-sm transition-transform group-hover/tile:scale-105">
              <Play className="ml-0.5 size-5" />
            </span>
          </button>
        )}
      </div>

      {/* ---------------- body ---------------- */}
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="line-clamp-2 text-[13px] leading-snug font-semibold tracking-tight" title={title}>
            {title}
          </h4>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {captionName}
          </span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {clip.captionEngine === "native" ? "fast captions" : "premium captions"}
          </span>
          {clip.hookDuration > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              hook
            </span>
          )}
          {clip.ctaDuration ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              cta
            </span>
          ) : null}
        </div>

        {clip.layoutNote && (
          <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
            {clip.layoutNote}
          </p>
        )}

        <div className="mt-auto flex items-center gap-1 pt-1">
          <Button size="sm" variant="soft" onClick={() => onEdit(clip)} className="flex-1">
            <PencilLine />
            Edit
          </Button>

          {isLive && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onCancel(clip)}
                    disabled={busy}
                    aria-label={`Cancel ${title}`}
                  />
                }
              >
                <XCircle />
                Cancel
              </TooltipTrigger>
              <TooltipContent>
                {isProcessing
                  ? "Stop this render - the worker halts within a couple of seconds"
                  : "Drop this clip from the render queue"}
              </TooltipContent>
            </Tooltip>
          )}

          {isDone && mediaUrl && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    nativeButton={false}
                    render={<a href={mediaUrl} download={`${title.replace(/[^\w\-]+/g, "_").slice(0, 60)}.mp4`} />}
                    aria-label="Download clip"
                  />
                }
              >
                <Download />
              </TooltipTrigger>
              <TooltipContent>Download MP4</TooltipContent>
            </Tooltip>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="More clip actions" />}
            >
              <EllipsisVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={isProcessing || Boolean(busy)}
                onClick={() => onRender(clip)}
              >
                <Sparkles />
                {isDone ? "Re-render with stored settings" : "Render now"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(clip)}>
                <PencilLine />
                Edit & re-render
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!isDone}
                onClick={() => {
                  if (mediaUrl) window.open(mediaUrl, "_blank", "noopener");
                }}
              >
                <Play />
                Open in new tab
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {isProcessing && (
                <DropdownMenuItem onClick={() => onCancel(clip)} variant="destructive">
                  <XCircle />
                  Cancel render
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onDelete(clip)} variant="destructive" disabled={isProcessing}>
                <Trash2 />
                Delete clip
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ClipAnalysisPanel
        analysis={clip.aiAnalysis}
        open={analysisOpen}
        onOpenChange={setAnalysisOpen}
      />
    </article>
  );
}
