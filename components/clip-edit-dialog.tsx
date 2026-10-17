"use client"

import * as React from "react"
import {
  Captions,
  Clock,
  Crop,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Info,
  Loader2,
  MoveHorizontal,
  Palette,
  Quote,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
  Type,
} from "lucide-react"
import type {
  CaptionPreset,
  ClipLayout,
  ClipRecord,
  ClipVisualOverlay,
  OverlayStylePreset,
  VisualMomentPlacement,
  VisualOverlayAnimation,
} from "@/lib/types"
import { DEFAULT_FILTER_PRESETS } from "@/lib/presets"
import { formatTime } from "@/lib/pipeline-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * The clip editor: fix anything about a single clip and re-render just that
 * clip. Nothing else on the grid is touched, and the tile behind keeps showing
 * the previous render until the new one lands.
 *
 * The form is initialised from the clip record every time the dialog opens (no
 * long-lived duplicated state), and "Save & re-render" sends the edits and the
 * render request as one call so the two can never disagree.
 */

interface Draft {
  start: string;
  end: string;
  hookText: string;
  hookDuration: string;
  ctaText: string;
  ctaDuration: string;
  filterPreset: string;
  captionPresetId: string;
  layout: ClipLayout;
  hookStylePresetId: string;
  ctaStylePresetId: string;
  autoVisuals: boolean;
  visualOverlays: ClipVisualOverlay[];
}

function draftFrom(clip: ClipRecord, captionPresets: CaptionPreset[]): Draft {
  return {
    start: clip.start.toFixed(1),
    end: clip.end.toFixed(1),
    hookText: clip.hookText ?? "",
    hookDuration: String(clip.hookDuration ?? 3),
    ctaText: clip.ctaText ?? "",
    ctaDuration: String(clip.ctaDuration ?? 2.5),
    filterPreset: clip.filterPreset || "vibrant",
    captionPresetId:
      clip.captionPresetId || captionPresets.find((preset) => preset.isDefault)?._id || captionPresets[0]?._id || "",
    layout: clip.layout === "split-screen" ? "split-screen" : "speaker-focus",
    hookStylePresetId: clip.hookStylePresetId || "",
    ctaStylePresetId: clip.ctaStylePresetId || "",
    autoVisuals: clip.autoVisuals !== false,
    visualOverlays: clip.visualOverlays ? [...clip.visualOverlays] : [],
  };
}

function Section({
  title,
  icon,
  description,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <header className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] leading-tight font-semibold tracking-tight">{title}</h3>
          {description && <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
        {hint && (
          <Tooltip>
            <TooltipTrigger render={<Info className="size-3 text-muted-foreground/70" />} />
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

 interface ClipEditDialogProps {
  clip: ClipRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  captionPresets: CaptionPreset[];
  overlayPresets: OverlayStylePreset[];
  sourceUrl?: string | null;
  videoDuration?: number;
  busy?: boolean;
  onSave: (clip: ClipRecord, edits: Record<string, unknown>, andRender: boolean) => Promise<unknown>;
}

function ClipEditForm({
  clip,
  captionPresets,
  overlayPresets,
  sourceUrl,
  videoDuration,
  busy,
  onSave,
  onClose,
}: ClipEditDialogProps & { clip: ClipRecord; onClose: () => void }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  // The parent mounts this component with a fresh `key` per clip, so the draft is
  // seeded once on mount rather than re-derived in an effect.
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(clip, captionPresets));
  const [error, setError] = React.useState<string | null>(null);
  const [visualBusy, setVisualBusy] = React.useState<string | null>(null);
  const [customQueries, setCustomQueries] = React.useState<Record<string, string>>({});

  const patch = (partial: Partial<Draft>) => setDraft((current) => ({ ...current, ...partial }));

  const parsedStart = Number(draft.start);
  const parsedEnd = Number(draft.end);
  const length =
    Number.isFinite(parsedStart) && Number.isFinite(parsedEnd) ? Math.max(0, parsedEnd - parsedStart) : 0;
  const windowInvalid =
    !Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedEnd - parsedStart < 1 || parsedStart < 0;

  const seekTo = (seconds: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, seconds);
    void element.play().catch(() => undefined);
  };

  const resolveVisualsNow = async (overlayId?: string, customQuery?: string) => {
    setVisualBusy(overlayId || "all");
    setError(null);
    try {
      const response = await fetch(`/api/clips/${clip._id}/visuals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(overlayId ? { overlayId } : {}),
          ...(customQuery?.trim() ? { customQuery: customQuery.trim() } : {}),
        }),
      });
      let data = (await response.json()) as {
        queued?: boolean;
        jobStatus?: string;
        visualOverlays?: ClipVisualOverlay[];
        error?: string;
      };
      if (!response.ok) {
        setError(data.error || "Could not resolve contextual visuals.");
        return;
      }
      if (data.queued) {
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const status = await fetch(`/api/clips/${clip._id}/visuals`, { cache: "no-store" });
          if (!status.ok) throw new Error("Could not read visual prefetch status");
          data = await status.json();
          if (data.jobStatus === "done") break;
          if (data.jobStatus === "failed") throw new Error(data.error || "Visual prefetch failed");
          if (attempt === 119) throw new Error("Visual prefetch is still queued. Reopen the clip after the worker finishes.");
        }
      }
      if (Array.isArray(data.visualOverlays)) {
        patch({ visualOverlays: data.visualOverlays });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve contextual visuals.");
    } finally {
      setVisualBusy(null);
    }
  };

  const updateVisualItem = (id: string, partial: Partial<ClipVisualOverlay>) => {
    patch({
      visualOverlays: draft.visualOverlays.map((item) =>
        item.id === id ? { ...item, ...partial } : item
      ),
    });
  };

  const removeVisualItem = (id: string) => {
    patch({
      visualOverlays: draft.visualOverlays.filter((item) => item.id !== id),
    });
  };

  const submit = async (andRender: boolean) => {
    setError(null);
    const edits = {
      start: Number(draft.start),
      end: Number(draft.end),
      hookText: draft.hookText.trim(),
      hookDuration: Number(draft.hookDuration) || 0,
      ctaText: draft.ctaText.trim(),
      ctaDuration: Number(draft.ctaDuration) || 0,
      filterPreset: draft.filterPreset,
      captionPresetId: draft.captionPresetId,
      layout: draft.layout,
      autoVisuals: draft.autoVisuals,
      visualOverlays: draft.visualOverlays,
      ...(draft.hookStylePresetId ? { hookStylePresetId: draft.hookStylePresetId } : {}),
      ...(draft.ctaStylePresetId ? { ctaStylePresetId: draft.ctaStylePresetId } : {}),
    };
    if (windowInvalid) {
      setError("The clip window must be at least 1 second long and start at 0 or later.");
      return;
    }
    const result = await onSave(clip, edits, andRender);
    if (result) onClose();
    else setError("The server refused these changes - see the notification for why.");
  };

  const hookStyles = overlayPresets.filter((preset) => preset.kind === "hook");
  const ctaStyles = overlayPresets.filter((preset) => preset.kind === "cta");

  return (
    <>
      <DialogBody className="p-0">
        <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          {/* preview */}
          <div className="space-y-2">
            <div className="relative aspect-9/16 w-full overflow-hidden rounded-xl bg-black ring-1 ring-border">
              {sourceUrl ? (
                <video
                  ref={videoRef}
                  src={`${sourceUrl}#t=${Math.max(0, parsedStart || 0).toFixed(2)}`}
                  controls
                  playsInline
                  preload="metadata"
                  className="size-full object-contain"
                />
              ) : (
                <div className="flex size-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
                  Preview unavailable
                </div>
              )}
              {clip.status === "done" && clip.outputPath && (
                <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                  source · {Math.round(clip.end - clip.start)}s clip
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => seekTo(parsedStart || 0)} type="button">
                <MoveHorizontal />
                Jump to start
              </Button>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => seekTo(parsedEnd || 0)} type="button">
                <MoveHorizontal />
                Jump to end
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {videoDuration ? `Source is ${formatTime(videoDuration)} long.` : "Drag the timeline to check the cut."}
            </p>
          </div>

          {/* form */}
          <div className="space-y-5">
            <Section title="Clip window" icon={<Clock />} description="Seconds inside the source video.">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Start (s)">
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    value={draft.start}
                    onChange={(event) => patch({ start: event.target.value })}
                  />
                </Field>
                <Field label="End (s)">
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    value={draft.end}
                    onChange={(event) => patch({ end: event.target.value })}
                  />
                </Field>
                <Field label="Length" hint="Derived from the window; the renderer trims nothing.">
                  <div className="flex h-7 items-center justify-center rounded-md border border-input bg-muted/50 px-2 text-xs tabular">
                    {length.toFixed(1)}s
                  </div>
                </Field>
              </div>
            </Section>

            <div className="h-px bg-border/70" />

            <Section title="On-screen text" icon={<Type />} description="Empty hook text removes the hook intro entirely.">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_92px]">
                <Field label="Hook text (shown over the replayed hook)">
                  <Input
                    value={draft.hookText}
                    placeholder="e.g. NOBODY TALKS ABOUT THIS"
                    onChange={(event) => patch({ hookText: event.target.value })}
                  />
                </Field>
                <Field label="Hook (s)">
                  <Input
                    type="number"
                    step="0.5"
                    min={0}
                    value={draft.hookDuration}
                    onChange={(event) => patch({ hookDuration: event.target.value })}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_92px]">
                <Field label="CTA text (end card)">
                  <Input
                    value={draft.ctaText}
                    placeholder="e.g. FOLLOW FOR PART 2"
                    onChange={(event) => patch({ ctaText: event.target.value })}
                  />
                </Field>
                <Field label="CTA (s)">
                  <Input
                    type="number"
                    step="0.5"
                    min={0}
                    value={draft.ctaDuration}
                    onChange={(event) => patch({ ctaDuration: event.target.value })}
                  />
                </Field>
              </div>
              {!draft.hookText.trim() && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <Quote className="size-3" />
                  No hook text - this clip renders without the hook intro.
                </p>
              )}
            </Section>

            <div className="h-px bg-border/70" />

            <Section title="Look" icon={<Palette />} description="Captions, framing and overlay styling.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Caption preset">
                  <Select
                    value={draft.captionPresetId}
                    onValueChange={(value) => patch({ captionPresetId: String(value ?? "") })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a caption preset" />
                    </SelectTrigger>
                    <SelectContent className="dark">
                      {captionPresets.map((preset) => (
                        <SelectItem key={preset._id} value={preset._id}>
                          {preset.name}
                          {preset.isDefault ? " · default" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Framing" hint="Speaker focus glides a single 9:16 window to whoever is talking. Split screen gives every detected person a pane.">
                  <Select
                    value={draft.layout}
                    onValueChange={(value) => patch({ layout: value === "split-screen" ? "split-screen" : "speaker-focus" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="dark">
                      <SelectItem value="speaker-focus">Speaker focus</SelectItem>
                      <SelectItem value="split-screen">Multi-person split</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Color filter">
                  <Select
                    value={draft.filterPreset}
                    onValueChange={(value) => patch({ filterPreset: String(value ?? "vibrant") })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="dark">
                      {DEFAULT_FILTER_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {hookStyles.length > 0 && (
                  <Field label="Hook card style">
                    <Select
                      value={draft.hookStylePresetId}
                      onValueChange={(value) => patch({ hookStylePresetId: String(value ?? "") })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Default style" />
                      </SelectTrigger>
                      <SelectContent className="dark">
                        {hookStyles.map((preset) => (
                          <SelectItem key={preset._id} value={preset._id}>
                            {preset.name}
                            {preset.isDefault ? " · default" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {ctaStyles.length > 0 && (
                  <Field label="CTA card style">
                    <Select
                      value={draft.ctaStylePresetId}
                      onValueChange={(value) => patch({ ctaStylePresetId: String(value ?? "") })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Default style" />
                      </SelectTrigger>
                      <SelectContent className="dark">
                        {ctaStyles.map((preset) => (
                          <SelectItem key={preset._id} value={preset._id}>
                            {preset.name}
                            {preset.isDefault ? " · default" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </div>

              {clip.aiAnalysis?.safety_analysis.risky_words.length ? (
                <p className="rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                  <Captions className="mr-1 inline size-3" />
                  The AI flagged:{" "}
                  {clip.aiAnalysis.safety_analysis.risky_words
                    .map((word) => word.word_or_phrase)
                    .join(", ")}{" "}
                  — profanity is always masked in captions at render time.
                </p>
              ) : null}
            </Section>

            <div className="h-px bg-border/70" />

            <Section
              title="Contextual visuals"
              icon={<ImageIcon />}
              description="Free-to-use images aligned to transcript beats and composited in safe 9:16 zones."
            >
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-[12px] font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.autoVisuals}
                    onChange={(e) => patch({ autoVisuals: e.target.checked })}
                    className="rounded border-border"
                  />
                  <span>Enable contextual visuals for this clip</span>
                </label>

                <div className="flex items-center gap-1.5">
                  {draft.visualOverlays.some((v) => v.status === "resolved") && (
                    <a
                      href={`/api/clips/${clip._id}/credits?format=txt`}
                      download
                      className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
                    >
                      <Download className="size-3" />
                      Credits
                    </a>
                  )}
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={visualBusy !== null}
                    onClick={() => void resolveVisualsNow()}
                  >
                    {visualBusy === "all" ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {draft.visualOverlays.length > 0
                      ? "Resolve / refresh images"
                      : "Plan & resolve images"}
                  </Button>
                </div>
              </div>

              {draft.visualOverlays.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No visual moments planned yet. Click &ldquo;Plan &amp; resolve images&rdquo; to preview or let the worker resolve them automatically on render.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {draft.visualOverlays.map((vis) => (
                    <div
                      key={vis.id}
                      className="rounded-xl border bg-muted/15 p-3 space-y-2 text-[11.5px]"
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => seekTo(vis.sourceStart)}
                              className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20"
                              title="Jump video preview to this moment"
                            >
                              {vis.sourceStart.toFixed(1)}s–{vis.sourceEnd.toFixed(1)}s
                            </button>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {vis.category}
                              {vis.entityName ? ` · ${vis.entityName}` : ""}
                            </span>
                            {vis.framing === "illustrative" && (
                              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                Illustrative stock
                              </span>
                            )}
                          </div>
                          <p className="font-medium text-foreground">
                            &ldquo;{vis.quote}&rdquo;
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {vis.visualIntent}
                          </p>
                        </div>

                        {vis.mediaUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={vis.mediaUrl}
                            alt={vis.attribution?.title || vis.visualIntent}
                            className="h-16 w-16 shrink-0 rounded-lg object-cover border"
                          />
                        )}

                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => removeVisualItem(vis.id)}
                          aria-label="Remove visual moment"
                        >
                          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        <Field label="Placement">
                          <Select
                            value={vis.placement}
                            onValueChange={(value) =>
                              updateVisualItem(vis.id, {
                                placement: (value ?? "main") as VisualMomentPlacement,
                              })
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="dark">
                              <SelectItem value="main">Main clip only</SelectItem>
                              <SelectItem value="hook">Hook replay only</SelectItem>
                              <SelectItem value="both">Both hook &amp; main</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>

                        <Field label="Animation">
                          <Select
                            value={vis.animation}
                            onValueChange={(value) =>
                              updateVisualItem(vis.id, {
                                animation: (value ??
                                  "subtle-zoom") as VisualOverlayAnimation,
                              })
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="dark">
                              <SelectItem value="subtle-zoom">Subtle zoom</SelectItem>

                              <SelectItem value="fade">Smooth fade</SelectItem>
                              <SelectItem value="pop">Pop in</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <Input
                          value={
                            customQueries[vis.id] ??
                            (vis.searchQueries[0] || "")
                          }
                          onChange={(e) =>
                            setCustomQueries((prev) => ({
                              ...prev,
                              [vis.id]: e.target.value,
                            }))
                          }
                          placeholder="Search query to replace image..."
                          className="h-7 text-[11px]"
                        />
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={visualBusy !== null}
                          onClick={() =>
                            void resolveVisualsNow(
                              vis.id,
                              customQueries[vis.id] ?? vis.searchQueries[0]
                            )
                          }
                        >
                          {visualBusy === vis.id ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                          Replace
                        </Button>
                      </div>

                      {vis.attribution && (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5 text-[10.5px] text-muted-foreground">
                          <span>
                            {vis.attribution.provider === "pexels" ? (
                              <a
                                href="https://www.pexels.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline underline-offset-2 hover:text-foreground font-medium"
                              >
                                Photos provided by Pexels
                              </a>
                            ) : (
                              <span className="uppercase font-medium">
                                {vis.attribution.provider}
                              </span>
                            )}{" "}
                            · {vis.attribution.license} ·{" "}
                            {vis.attribution.creatorUrl ? (
                              <a
                                href={vis.attribution.creatorUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline underline-offset-2 hover:text-foreground"
                              >
                                {vis.attribution.creator}
                              </a>
                            ) : (
                              vis.attribution.creator
                            )}
                          </span>
                          <a
                            href={vis.attribution.sourcePageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                          >
                            Source page
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">{error}</p>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <p className="mr-auto hidden text-[11px] text-muted-foreground sm:block">
          Only this clip is re-rendered; the rest of the grid stays as it is.
        </p>
        <Button variant="outline" onClick={onClose} disabled={Boolean(busy)}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => submit(false)} disabled={Boolean(busy) || !draft}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Save changes
        </Button>
        <Button onClick={() => submit(true)} disabled={Boolean(busy) || !draft}>
          {busy ? <Loader2 className="animate-spin" /> : <Rocket />}
          Save &amp; re-render
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The edit surface for one clip. Saving writes the edit; saving *and* rendering
 * re-renders only this clip - the rest of the grid keeps its current output.
 */
export function ClipEditDialog(props: ClipEditDialogProps) {
  const { clip, open, onOpenChange } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[92dvh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Crop className="size-3.5" />
            </span>
            Edit clip
            {clip && (
              <span className="font-normal text-muted-foreground">
                {formatTime(clip.start)}–{formatTime(clip.end)}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Change the window, the on-screen text or the style, then re-render only this clip.
          </DialogDescription>
        </DialogHeader>

        {clip && open ? (
          <ClipEditForm
            key={clip._id}
            {...props}
            clip={clip}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
