"use client";

import React, { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowUpDown,
  Captions,
  CheckCircle2,
  Clock,
  Clapperboard,
  FileText,
  Film,
  Gauge,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "cn";
import type { ClipRecord, PipelineOptions } from "@/lib/types";
import { isPipelineOptionsEqual } from "@/lib/pipeline-defaults";
import { clipScore, formatClock, stageMeta } from "@/lib/pipeline-ui";
import type { VideoListItem } from "@/lib/pipeline-ui";
import { usePipeline } from "@/hooks/use-pipeline";
import { sortClipsForGrid } from "@/lib/pipeline-ui";
import { ClipTile } from "@/components/clip-tile";
import { ClipEditDialog } from "@/components/clip-edit-dialog";
import { PipelineStepper } from "@/components/pipeline-stepper";
import { AutomationPanel } from "@/components/pipeline-settings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The studio: one list of videos, one pipeline strip per video and the clip grid
 * that the automatic chain fills in. There is deliberately nothing to "start":
 * uploading a video queues transcription, which queues detection, which queues
 * the renders - this page only watches, explains and lets you fix one clip.
 */

type ClipFilter = "all" | "live" | "ready" | "failed";
type ClipSort = "run" | "score" | "status";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function formatTranscriptionEngine(video: { transcriptionProvider?: string; transcriptionModel?: string }) {
  if (!video.transcriptionProvider) return "engine pending";
  if (video.transcriptionProvider === "deepgram") {
    return `Deepgram · ${video.transcriptionModel || "nova-2"}`;
  }
  return `whisper.cpp · ${video.transcriptionModel || "local model"}`;
}

/** Sidebar row: name, one status line, and a hairline progress bar when active. */
function VideoRow({
  video,
  selected,
  onSelect,
  onDelete,
}: {
  video: VideoListItem;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const meta = stageMeta(video.pipelineStatus.stage);
  const active = meta.pulse;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group relative cursor-pointer rounded-xl border p-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        selected
          ? "border-primary/35 bg-accent/70 shadow-[var(--shadow-card)]"
          : "border-transparent hover:border-border hover:bg-muted/70"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug font-medium">
          {video.originalName}
        </p>
        <button
          type="button"
          aria-label="Delete video"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="size-3" />
        <span className="tabular">{formatTime(video.duration || 0)}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular">{video.counts.clips} clips</span>
        {video.counts.done > 0 && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular text-emerald-600 dark:text-emerald-400">{video.counts.done} ready</span>
          </>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
            meta.chip
          )}
        >
          <span className={cn("size-1 rounded-full", meta.bar, active && "animate-pulse")} />
          {meta.label}
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full transition-[width] duration-700", meta.bar, active && "progress-live")}
            style={{ width: `${Math.max(3, video.pipelineStatus.progress)}%` }}
          />
        </span>
      </div>
    </div>
  );
}

function StatChip({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "muted" | "success" | "warn";
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-1.5">
      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] leading-none tracking-wide text-muted-foreground uppercase">{label}</p>
        <p
          className={cn(
            "mt-0.5 text-[13px] leading-none font-semibold tabular",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "warn" && "text-amber-600 dark:text-amber-400"
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const videoId = searchParams.get("videoId");

  const pipeline = usePipeline(videoId);
  const {
    videos,
    detail,
    clips,
    status,
    captionPresets,
    overlayPresets,
    isLoading,
    isRefreshing,
    busy,
    listError,
  } = pipeline;

  const [filter, setFilter] = useState<ClipFilter>("all");
  const [sort, setSort] = useState<ClipSort>("run");
  const [query, setQuery] = useState("");
  const [editingClip, setEditingClip] = useState<ClipRecord | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [automationDraft, setAutomationDraft] = useState<PipelineOptions | null>(null);

  const selectedVideo = videoId ? videos.find((video) => video._id === videoId) ?? null : null;
  const video = detail?.video;

  // Defaults for the settings dialog come from the video, then from the
  // browser's "next upload" defaults.
  const effectivePipeline = automationDraft ?? detail?.status.pipeline ?? video?.pipeline ?? null;
  const settingsDirty =
    automationDraft !== null && !isPipelineOptionsEqual(automationDraft, detail?.status.pipeline ?? video?.pipeline);

  const stage = status?.stage ?? selectedVideo?.pipelineStatus.stage;
  const stageMeta = stage ? stageMetaOf(stage) : null;

  const filteredClips = useMemo(() => {
    const sorted = sortClipsForGrid(clips, sort);
    const byFilter = sorted.filter((clip) => {
      if (filter === "live") return clip.status === "processing" || clip.status === "pending";
      if (filter === "ready") return clip.status === "done";
      if (filter === "failed") return clip.status === "failed";
      return true;
    });
    const needle = query.trim().toLowerCase();
    if (!needle) return byFilter;
    return byFilter.filter((clip) =>
      [clip.aiAnalysis?.viral_packaging.video_title, clip.hookText, clip.ctaText, clip.aiAnalysis?.why_this_will_go_viral]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  }, [clips, filter, query, sort]);

  const counts = status?.counts ?? { clips: 0, done: 0, active: 0, queued: 0, failed: 0, progress: 0 };
  const bestScore = useMemo(() => {
    const scores = clips.map((clip) => clipScore(clip)).filter((score): score is number => score !== null);
    return scores.length ? Math.max(...scores) : null;
  }, [clips]);

  const filteredVideos = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // The search box filters the library only while no clip search is active.
    if (!needle) return videos;
    return videos.filter((entry) => entry.originalName.toLowerCase().includes(needle));
  }, [query, videos]);

  const openSettings = () => {
    setAutomationDraft(detail?.status.pipeline ?? video?.pipeline ?? null);
    setSettingsOpen(true);
  };

  const confirmDeleteVideo = () => {
    if (!videoId) return;
    if (window.confirm("Delete this video, its transcript and every clip? Rendered files are removed too.")) {
      void pipeline.deleteVideo(videoId);
    }
  };

  return (
    <div className="space-y-5">
      {/* ---------- page header ---------- */}
      <div className="flex animate-fade-up flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">Studio</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Upload a landscape video and the pipeline transcribes it, finds the viral moments and renders
            9:16 clips - no buttons in between.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-lg"
                  aria-label="Refresh"
                  onClick={() => void pipeline.refresh()}
                />
              }
            >
              <RefreshCw className={cn(isRefreshing && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <Button size="lg" nativeButton={false} render={<Link href="/upload" />}>
            <Upload />
            Upload video
          </Button>
        </div>
      </div>

      {listError && !videoId && (
        <Alert variant="destructive">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        {/* ---------- library ---------- */}
        <aside
          className="animate-fade-up space-y-3 lg:sticky lg:top-6"
          style={{ animationDelay: "40ms" }}
        >
          <div className="rounded-2xl border bg-card/70 p-3 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
                <Film className="size-3.5 text-muted-foreground" />
                Library
              </h2>
              <Badge variant="secondary" className="tabular">
                {videos.length}
              </Badge>
            </div>

            <div className="relative mt-2.5">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={videoId ? "Search clips…" : "Search videos…"}
                className="h-8 pl-7.5 text-xs"
                aria-label="Search"
              />
            </div>

            <div className="subtle-scroll mt-2.5 max-h-[min(58vh,560px)] space-y-1 overflow-y-auto pr-0.5">
              {isLoading ? (
                [0, 1, 2].map((index) => <Skeleton key={index} className="skeleton-sheen h-[86px] rounded-xl" />)
              ) : filteredVideos.length === 0 ? (
                <div className="rounded-xl border border-dashed px-4 py-8 text-center">
                  <p className="text-[12.5px] font-medium">
                    {videos.length ? "No match" : "No videos yet"}
                  </p>
                  <p className="mx-auto mt-1 max-w-[220px] text-[11px] text-muted-foreground">
                    {videos.length
                      ? "Try a different search."
                      : "Upload a long-form landscape video to start the pipeline."}
                  </p>
                  {!videos.length && (
                    <Button size="sm" variant="outline" className="mt-3" nativeButton={false} render={<Link href="/upload" />}>
                      <Upload />
                      Upload video
                    </Button>
                  )}
                </div>
              ) : (
                filteredVideos.map((entry) => (
                  <VideoRow
                    key={entry._id}
                    video={entry}
                    selected={entry._id === videoId}
                    onSelect={() => pipeline.selectVideo(entry._id)}
                    onDelete={() => {
                      if (window.confirm(`Delete "${entry.originalName}" and its clips?`)) {
                        void pipeline.deleteVideo(entry._id);
                      }
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </aside>

        {/* ---------- main column ---------- */}
        <div className="animate-fade-up min-w-0 space-y-4" style={{ animationDelay: "80ms" }}>
          {!videoId ? (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed bg-card/50 px-6 py-16 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Clapperboard className="size-7" />
              </span>
              <div className="max-w-md space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight">Pick a video, or start a new one</h2>
                <p className="text-[13px] text-muted-foreground">
                  Every video shows its live pipeline state here: transcript, viral detection, then the clip
                  grid with scores and AI analytics.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="lg" nativeButton={false} render={<Link href="/upload" />}>
                  <Upload />
                  Upload video
                </Button>
                {videos.length > 0 && (
                  <Button size="lg" variant="outline" onClick={() => pipeline.selectVideo(videos[0]._id)}>
                    Open latest
                  </Button>
                )}
              </div>
            </div>
          ) : !detail || !video ? (
            <div className="space-y-4">
              <Skeleton className="skeleton-sheen h-28 rounded-2xl" />
              <Skeleton className="skeleton-sheen h-64 rounded-2xl" />
            </div>
          ) : (
            <>
              {/* video header */}
              <section className="rounded-2xl border bg-card p-4 shadow-[var(--shadow-card)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-[15px] font-semibold tracking-tight" title={video.originalName}>
                      {video.originalName}
                    </h2>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span className="tabular">{formatClock(video.duration || 0)}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="tabular">
                        {video.width}×{video.height}
                      </span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>{formatTranscriptionEngine(video)}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>uploaded {new Date(video.createdAt).toLocaleDateString()}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="soft"
                      onClick={() =>
                        effectivePipeline && void pipeline.detect(video._id, effectivePipeline.viral, false)
                      }
                      disabled={busy === "detect" || !detail.transcriptReady}
                    >
                      {busy === "detect" ? <Loader2 className="animate-spin" /> : <Sparkles />}
                      Detect again
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void pipeline.renderAll(video._id, {})}
                      disabled={!counts.clips || busy === "renderAll"}
                      title={
                        counts.clips
                          ? "Queue every clip that is not rendered yet"
                          : "Run viral detection first"
                      }
                    >
                      {busy === "renderAll" ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                      Render pending
                      {counts.queued + counts.active > 0 && (
                        <span className="ml-1 tabular opacity-70">{counts.queued + counts.active}</span>
                      )}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Pipeline settings" onClick={openSettings} />}>
                        <Settings2 />
                      </TooltipTrigger>
                      <TooltipContent>Pipeline settings</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Transcribe again"
                            onClick={() => void pipeline.transcribe(video._id)}
                            disabled={busy === "transcribe"}
                          />
                        }
                      >
                        <Captions />
                      </TooltipTrigger>
                      <TooltipContent>Re-transcribe (re-detects and re-renders)</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Delete video"
                            className="hover:text-destructive"
                            onClick={confirmDeleteVideo}
                          />
                        }
                      >
                        <Trash2 />
                      </TooltipTrigger>
                      <TooltipContent>Delete video and clips</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {stageMeta && (
                  <div className="mt-3">
                    <PipelineStepper
                      status={status!}
                      busy={Boolean(busy)}
                      onResume={() => void pipeline.resume(video._id)}
                      onRetryStep={(step) => {
                        if (step.key === "transcript") void pipeline.transcribe(video._id);
                        else if (step.key === "analyze")
                          void pipeline.detect(video._id, effectivePipeline?.viral ?? { clipCount: 10, minClipDuration: 60, maxClipDuration: 90, includeHookText: true, includeCta: true }, true);
                        else void pipeline.renderAll(video._id, { clipIds: clips.filter((clip) => clip.status === "failed").map((clip) => clip._id) });
                      }}
                    />
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <StatChip icon={<Clapperboard />} label="Clips" value={String(counts.clips)} />
                  <StatChip
                    icon={<CheckCircle2 />}
                    label="Ready"
                    value={`${counts.done}/${counts.clips || 0}`}
                    tone={counts.done && counts.done === counts.clips ? "success" : undefined}
                  />
                  <StatChip
                    icon={<Loader2 className={counts.active ? "animate-spin" : undefined} />}
                    label="Rendering"
                    value={String(counts.active + counts.queued)}
                    tone={counts.active ? "warn" : undefined}
                  />
                  <StatChip
                    icon={<Gauge />}
                    label="Top score"
                    value={bestScore === null ? "—" : bestScore.toFixed(1)}
                  />
                </div>

                {detail.video.error && (
                  <Alert variant="destructive" className="mt-3">
                    <AlertCircle className="mt-0.5" />
                    <AlertDescription className="text-[12px]">{detail.video.error}</AlertDescription>
                  </Alert>
                )}
              </section>

              {/* clips */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
                      Clips
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular">
                        {filteredClips.length}
                        {filteredClips.length !== counts.clips ? ` / ${counts.clips}` : ""}
                      </span>
                    </h3>
                    <div className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5">
                      {(
                        [
                          ["all", "All"],
                          ["live", "In progress"],
                          ["ready", "Ready"],
                          ["failed", "Failed"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFilter(key)}
                          className={cn(
                            "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                            filter === key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {label}
                          {key !== "all" && (
                            <span className="ml-1 tabular opacity-60">
                              {key === "live"
                                ? counts.active + counts.queued
                                : key === "ready"
                                  ? counts.done
                                  : counts.failed}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSort(sort === "run" ? "score" : sort === "score" ? "status" : "run")}
                      title="Change clip order"
                    >
                      <ArrowUpDown />
                      {sort === "run" ? "Latest run" : sort === "score" ? "Top score" : "Status"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTranscriptOpen((open) => !open)}>
                      <FileText />
                      Transcript
                    </Button>
                  </div>
                </div>

                {transcriptOpen && (
                  <TranscriptPanel
                    videoId={video._id}
                    onLoad={pipeline.loadTranscript}
                    isLoading={pipeline.isTranscriptLoading}
                    transcript={pipeline.transcript}
                  />
                )}

                {counts.clips === 0 ? (
                  <div className="rounded-2xl border border-dashed bg-card/50 px-6 py-12 text-center">
                    {stageMeta && (stageMeta.pulse || stage === "queued") ? (
                      <>
                        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <Loader2 className="size-5 animate-spin" />
                        </span>
                        <p className="mt-3 text-[13px] font-medium">{stageMeta.hint}</p>
                        <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-muted-foreground">
                          Clips appear in this grid as soon as the AI finishes scoring the transcript - the
                          renders queue themselves right after.
                        </p>
                        <div className="mx-auto mt-5 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
                          {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="skeleton-sheen aspect-9/16 rounded-2xl" />
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <Sparkles className="size-5" />
                        </span>
                        <p className="mt-3 text-[13px] font-medium">No clips yet</p>
                        <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-muted-foreground">
                          {detail.transcriptReady
                            ? "The transcript is ready - detection was skipped or paused. Start it, or turn the automation back on in Pipeline settings."
                            : "Waiting for the transcript. Keep this page open - or come back later, the worker keeps going either way."}
                        </p>
                        {detail.transcriptReady && (
                          <Button
                            size="sm"
                            className="mt-4"
                            onClick={() =>
                              effectivePipeline && void pipeline.detect(video._id, effectivePipeline.viral, true)
                            }
                          >
                            <Sparkles />
                            Detect and render now
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                ) : filteredClips.length === 0 ? (
                  <div className="rounded-2xl border border-dashed bg-card/50 px-6 py-10 text-center text-[12.5px] text-muted-foreground">
                    No clip matches this filter.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredClips.map((clip, index) => (
                      <div
                        key={clip._id}
                        className="animate-fade-up"
                        style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
                      >
                        <ClipTile
                          clip={clip}
                          captionPresets={captionPresets}
                          busy={busy === `render:${clip._id}` || busy === `save:${clip._id}`}
                          onEdit={setEditingClip}
                          onRender={(target) => void pipeline.renderClip(target)}
                          onCancel={(target) => void pipeline.cancelClip(target)}
                          onDelete={(target) => void pipeline.deleteClip(target)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {/* ---------- clip editor ---------- */}
      <ClipEditDialog
        clip={editingClip}
        open={Boolean(editingClip)}
        onOpenChange={(open) => !open && setEditingClip(null)}
        captionPresets={captionPresets}
        overlayPresets={overlayPresets}
        sourceUrl={video?.fileName ? `/api/media/uploads/${encodeURIComponent(video.fileName)}` : null}
        videoDuration={video?.duration}
        busy={editingClip ? busy === `save:${editingClip._id}` : false}
        onSave={pipeline.saveClip}
      />

      {/* ---------- pipeline settings ---------- */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Pipeline settings</DialogTitle>
            <DialogDescription className="text-[12px]">
              Applies to this video from now on - including the next automatic step.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {effectivePipeline ? (
              <AutomationPanel
                value={effectivePipeline}
                onChange={setAutomationDraft}
                onSave={() => {
                  if (!videoId || !automationDraft) return;
                  void pipeline.saveAutomation(videoId, automationDraft).then(() => {
                    setSettingsOpen(false);
                    setAutomationDraft(null);
                  });
                }}
                dirty={settingsDirty}
                busy={busy === `automation:${videoId}`}
              />
            ) : (
              <p className="text-[12.5px] text-muted-foreground">Loading…</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Transcript is loaded on demand: it is the biggest thing this page could fetch. */
function TranscriptPanel({
  videoId,
  onLoad,
  isLoading,
  transcript,
}: {
  videoId: string;
  onLoad: (id: string) => Promise<void>;
  isLoading: boolean;
  transcript: { segments: { start: number; end: number; text: string }[] } | null;
}) {
  // Fetching is delegated to the hook, which caches per video, so opening this
  // panel again - or switching back to a video - costs nothing.
  React.useEffect(() => {
    void onLoad(videoId);
  }, [videoId, onLoad, transcript]);

  return (
    <div className="animate-fade-in space-y-2 rounded-2xl border bg-card/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {transcript ? `${transcript.segments.length} segments` : "Loading transcript…"}
        </p>
        {transcript && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              const full = transcript.segments
                .map((segment) => `[${formatTime(segment.start)} – ${formatTime(segment.end)}] ${segment.text}`)
                .join("\n");
              void navigator.clipboard?.writeText(full).catch(() => undefined);
            }}
          >
            Copy with timestamps
          </Button>
        )}
      </div>
      {isLoading && !transcript ? (
        <Skeleton className="skeleton-sheen h-40 rounded-lg" />
      ) : (
        <textarea
          readOnly
          aria-label="Full transcript with timestamps"
          className="subtle-scroll h-40 w-full resize-y rounded-lg border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed shadow-inner focus:ring-1 focus:ring-ring focus:outline-none"
          value={(transcript?.segments ?? [])
            .map((segment) => `[${formatTime(segment.start)} – ${formatTime(segment.end)}] ${segment.text}`)
            .join("\n")}
        />
      )}
    </div>
  );
}

function stageMetaOf(stage: NonNullable<VideoListItem["pipelineStatus"]["stage"]>) {
  return stageMeta(stage);
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[13px]">Loading studio…</span>
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
