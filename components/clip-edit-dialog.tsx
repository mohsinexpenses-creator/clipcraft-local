"use client"

import * as React from "react"
import {
  Captions,
  Clock,
  Crop,
  Info,
  Loader2,
  MoveHorizontal,
  Palette,
  Quote,
  Rocket,
  Save,
  Type,
} from "lucide-react"
import type {
  CaptionEngine,
  CaptionPreset,
  ClipLayout,
  ClipRecord,
  OverlayStylePreset,
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
  captionEngine: CaptionEngine;
  layout: ClipLayout;
  hookStylePresetId: string;
  ctaStylePresetId: string;
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
    captionEngine: clip.captionEngine === "native" ? "native" : "remotion",
    layout: clip.layout === "split-screen" ? "split-screen" : "speaker-focus",
    hookStylePresetId: clip.hookStylePresetId || "",
    ctaStylePresetId: clip.ctaStylePresetId || "",
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

export interface ClipEditDialogProps {
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
      captionEngine: draft.captionEngine,
      layout: draft.layout,
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

                <Field label="Caption engine" hint="Premium paints every frame (slowest, smoothest). Fast burns animated ASS captions in one native pass.">
                  <Select
                    value={draft.captionEngine}
                    onValueChange={(value) => patch({ captionEngine: value === "native" ? "native" : "remotion" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="dark">
                      <SelectItem value="remotion">Premium · smoothest</SelectItem>
                      <SelectItem value="native">Fast · ~10× quicker</SelectItem>
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
