"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  EllipsisVertical,
  Eye,
  Film,
  Loader2,
  PencilLine,
  Play,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react"
import { cn } from "cn"
import type {
  CameraDebugData,
  CameraDebugTrack,
  CameraDebugTrackPoint,
  CaptionPreset,
  ClipRecord,
} from "@/lib/types"
import { clipScore, formatTime, mediaUrlForOutputPath, scoreTone } from "@/lib/pipeline-ui"
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
import { BrollPlanPanel } from "@/components/broll-plan"

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

function smoothstep(value: number): number {
  const u = Math.max(0, Math.min(1, value));
  return u * u * (3 - 2 * u);
}

function cameraPositionAt(
  camera: CameraDebugData["camera"],
  t: number,
): { x: number; y: number } {
  let base = { x: camera.x0, y: camera.y0 };
  for (const cut of [...camera.cuts].sort((a, b) => a.t - b.t)) {
    if (cut.t <= t + 1e-6) base = { x: cut.x, y: cut.y };
  }
  for (const move of [...camera.moves].sort((a, b) => a.t - b.t)) {
    if (t <= move.t) break;
    if (t < move.t + move.duration) {
      const u = smoothstep((t - move.t) / move.duration);
      base = { x: base.x + (move.x - base.x) * u, y: base.y + (move.y - base.y) * u };
      break;
    }
    base = { x: move.x, y: move.y };
  }
  return base;
}

function nearestFace(track: CameraDebugTrack, t: number): CameraDebugTrackPoint | null {
  let nearest: CameraDebugTrackPoint | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of track.points) {
    const next = Math.abs(point.t - t);
    if (next < distance) {
      distance = next;
      nearest = point;
    }
  }
  return nearest && distance <= 0.5 ? nearest : null;
}

function activeSpeakerAt(debug: CameraDebugData, sourceTime: number): number | null {
  const segment = debug.speakerSegments.find(
    (item) => item.trackId !== null && sourceTime >= item.t0 - 1e-6 && sourceTime < item.t1 + 1e-6,
  );
  return segment?.trackId ?? null;
}

function CameraFaceBoxes({ debug, outputTime }: { debug: CameraDebugData; outputTime: number }) {
  const sourceTime =
    debug.hookDuration > 0 && outputTime < debug.hookDuration
      ? debug.hookStart + outputTime
      : outputTime - debug.hookDuration;
  const activeTrackId = activeSpeakerAt(debug, sourceTime);

  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden>
      {debug.tracks.map((track) => {
        const face = nearestFace(track, sourceTime);
        if (!face) return null;

        let left = 0;
        let top = 0;
        let width = 0;
        let height = 0;

        if (debug.splitCells && debug.splitCells.length > 0) {
          const cell = debug.splitCells.find((candidate) => candidate.trackId === track.id);
          if (!cell) return null;
          const win = cameraPositionAt(cell.camera, sourceTime);
          const faceHeight = face.h ?? face.w / 0.8;
          left = (cell.cellX + (face.cx - win.x) * cell.cellW / cell.cropW - face.w / 2) / 1080 * 100;
          top = (cell.cellY + (face.cy - win.y) * cell.cellH / cell.cropH - faceHeight / 2) / 1920 * 100;
          width = face.w * cell.cellW / cell.cropW / 1080 * 100;
          height = faceHeight * cell.cellH / cell.cropH / 1920 * 100;
        } else {
          const win = cameraPositionAt(debug.camera, sourceTime);
          const faceHeight = face.h ?? face.w / 0.8;
          left = (face.cx - win.x - face.w / 2) / debug.cropW * 100;
          top = (face.cy - win.y - faceHeight / 2) / debug.cropH * 100;
          width = face.w / debug.cropW * 100;
          height = faceHeight / debug.cropH * 100;
        }

        const active = track.id === activeTrackId;
        return (
          <div
            key={track.id}
            className={
              active
                ? "absolute border-2 border-emerald-400 shadow-[0_0_0_1px_rgba(16,185,129,0.35)]"
                : "absolute border-2 border-red-500 shadow-[0_0_0_1px_rgba(239,68,68,0.35)]"
            }
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
            }}
          >
            <span
              className={
                active
                  ? "absolute -top-5 left-0 rounded-sm bg-emerald-500 px-1 py-0.5 text-[9px] font-bold text-white"
                  : "absolute -top-5 left-0 rounded-sm bg-red-500 px-1 py-0.5 text-[9px] font-bold text-white"
              }
            >
              #{track.id}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface ClipTileProps {
  clip: ClipRecord;
  captionPresets: CaptionPreset[];
  busy?: boolean;
  /** A B-roll job or plan edit is in flight for this clip. */
  brollBusy?: boolean;
  onEdit: (clip: ClipRecord) => void;
  onRender: (clip: ClipRecord) => void;
  onCancel: (clip: ClipRecord) => void;
  onDelete: (clip: ClipRecord) => void;
  onRerunBroll: (clip: ClipRecord) => void;
  onRemoveAllBroll: (clip: ClipRecord) => void;
  onBrollEdit: (clip: ClipRecord, action: "swap" | "remove", itemId: string) => void;
}

export function ClipTile({
  clip,
  captionPresets,
  busy,
  brollBusy,
  onEdit,
  onRender,
  onCancel,
  onDelete,
  onRerunBroll,
  onRemoveAllBroll,
  onBrollEdit,
}: ClipTileProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [engaged, setEngaged] = React.useState(false);
  const [analysisOpen, setAnalysisOpen] = React.useState(false);
  const [debugFaces, setDebugFaces] = React.useState(false);
  const [debugTime, setDebugTime] = React.useState(0);

  const mediaUrl = mediaUrlForOutputPath(clip.outputPath);
  const isDone = clip.status === "done" && Boolean(mediaUrl);
  const isProcessing = clip.status === "processing";
  const isQueued = clip.status === "pending";
  const isFailed = clip.status === "failed";
  const isLive = isProcessing || isQueued;
  const score = clipScore(clip);
  const title = clip.aiAnalysis?.viral_packaging.video_title || clip.hookText || "Untitled clip";
  const downloadName = clip.outputPath?.split("/").pop() || `${title.replace(/[^\w\-]+/g, "_").slice(0, 60)}.mp4`;
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

  React.useEffect(() => {
    if (!debugFaces) return;
    let frame = 0;
    const update = () => {
      if (videoRef.current) setDebugTime(videoRef.current.currentTime);
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [debugFaces]);

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
        {debugFaces && clip.cameraDebug && (
          <CameraFaceBoxes debug={clip.cameraDebug} outputTime={debugTime} />
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
          {isDone && clip.cameraDebug && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setDebugFaces((current) => !current);
              }}
              aria-pressed={debugFaces}
              aria-label={debugFaces ? "Hide face debug boxes" : "Show face debug boxes"}
              title={debugFaces ? "Hide face debug boxes" : "Show active-speaker face boxes"}
              className={cn(
                "flex size-8 items-center justify-center rounded-full ring-1 backdrop-blur-md transition-colors",
                debugFaces
                  ? "bg-emerald-500 text-white ring-emerald-300/60"
                  : "bg-background/85 text-foreground/80 ring-border hover:bg-accent",
              )}
            >
              <Eye className="size-4" />
            </button>
          )}
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
                    render={<a href={mediaUrl} download={downloadName} />}
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

      <BrollPlanPanel
        plan={clip.broll ?? null}
        status={clip.brollStatus ?? (clip.broll ? "done" : "none")}
        error={clip.brollError}
        busy={brollBusy}
        onRerun={() => onRerunBroll(clip)}
                onRemoveAll={() => onRemoveAllBroll(clip)}
        onSwap={(itemId) => onBrollEdit(clip, "swap", itemId)}
        onRemove={(itemId) => onBrollEdit(clip, "remove", itemId)}
      />

      <ClipAnalysisPanel
        analysis={clip.aiAnalysis}
        open={analysisOpen}
        onOpenChange={setAnalysisOpen}
      />
    </article>
  );
}
