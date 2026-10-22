"use client"

import * as React from "react"
import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Film,
  ImagePlay,
  Images,
  Sparkles,
  Type,
  Wand2,
} from "lucide-react"
import { cn } from "cn"
import type { BrollProviderId, PipelineOptions } from "@/lib/types"
import { OPTION_LIMITS, STOCK_BROLL_PROVIDERS } from "@/lib/pipeline-defaults"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The one place the automatic pipeline is configured: which steps run by
 * themselves and what the AI is asked for.
 *
 * The upload page renders it with `onChange` writing to localStorage (defaults
 * for the next upload); the dashboard renders it with `onSave` pushing to
 * `PATCH /api/videos/[id]`, so the settings belong to that video from then on.
 * Same panel, same clamping, no duplicated form.
 */

export interface NumberFieldProps {
  id: string;
  value: number;
  onCommit: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}

/**
 * Number input that tolerates free editing: while focused it keeps a local draft
 * string, so clearing the field or typing an intermediate value never fights the
 * min/max clamp. The value is committed - and only then clamped - on blur/Enter.
 */
export function NumberField({ id, value, onCommit, min, max, step = 1, disabled }: NumberFieldProps) {
  const [editing, setEditing] = React.useState(false);
  // Re-mounting with a fresh draft when the outside value changes is what lets the
  // field hold "12" or "" mid-edit without the clamp fighting every keystroke.
  return (
    <NumberFieldInner
      key={editing ? "editing" : `value-${value}`}
      id={id}
      value={value}
      onCommit={onCommit}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      setEditing={setEditing}
    />
  );
}

function NumberFieldInner({
  id,
  value,
  onCommit,
  min,
  max,
  step,
  disabled,
  setEditing,
}: NumberFieldProps & { setEditing: (next: boolean) => void }) {
  const [draft, setDraft] = React.useState(String(value));

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
      className="h-8 text-xs tabular"
    />
  );
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        checked ? "border-primary/25 bg-primary/[0.04]" : "bg-muted/30"
      )}
    >
      <div className="flex min-w-0 gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5",
            checked ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer text-[12.5px] leading-tight font-medium">
            {title}
          </Label>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

export interface AutomationPanelProps {
  value: PipelineOptions;
  onChange?: (next: PipelineOptions) => void;
  /** Show a Save button that commits the draft (dashboard); omit for live mode (upload). */
  onSave?: (next: PipelineOptions) => void;
  dirty?: boolean;
  busy?: boolean;
  className?: string;
  /** Compact = only the AI clip options (used inside the upload card). */
  showAutomation?: boolean;
  showAiOptions?: boolean;
  /** Per-video B-roll automation (entity images + landscape cards). */
  showBroll?: boolean;
}

export function AutomationPanel({
  value,
  onChange,
  onSave,
  dirty,
  busy,
  className,
  showAutomation = true,
  showAiOptions = true,
  showBroll = true,
}: AutomationPanelProps) {
  const patch = (partial: Partial<PipelineOptions>) =>
    onChange?.({ ...value, ...partial, viral: { ...value.viral, ...(partial.viral ?? {}) } });
  const patchBroll = (partial: Partial<PipelineOptions["broll"]>) =>
    patch({ broll: { ...value.broll, ...partial } });
  const moveProvider = (index: number, delta: number) => {
    const order = [...value.broll.providerOrder];
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    patchBroll({ providerOrder: order });
  };

  return (
    <div className={cn("space-y-3", className)}>
      {showAutomation && (
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow
            id="auto-detect"
            icon={<Sparkles />}
            title="Detect clips automatically"
            description="Right after the transcript finishes, the AI picks the best moments."
            checked={value.autoDetect}
            onCheckedChange={(autoDetect) => patch({ autoDetect })}
            disabled={busy}
          />
          <ToggleRow
            id="auto-render"
            icon={<Clapperboard />}
            title="Render automatically"
            description="Every detected clip is rendered with the default caption, hook and CTA styles."
            checked={value.autoRender}
            onCheckedChange={(autoRender) => patch({ autoRender })}
            disabled={busy}
          />
        </div>
      )}

      {showAiOptions && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2">
            <Label htmlFor="auto-clip-count" className="flex items-center gap-1.5 text-[12px] font-medium">
              <Film className="size-3.5 text-muted-foreground" />
              Clips
              <Tooltip>
                <TooltipTrigger render={<span className="cursor-help text-[10px] text-muted-foreground">⌾</span>} />
                <TooltipContent>Top viral moments to generate, ranked. 1–{OPTION_LIMITS.clipCount.max}.</TooltipContent>
              </Tooltip>
            </Label>
            <div className="w-16">
              <NumberField
                id="auto-clip-count"
                value={value.viral.clipCount}
                onCommit={(clipCount) => patch({ viral: { ...value.viral, clipCount } })}
                min={OPTION_LIMITS.clipCount.min}
                max={OPTION_LIMITS.clipCount.max}
                disabled={busy}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2">
            <Label htmlFor="auto-min-length" className="flex items-center gap-1.5 text-[12px] font-medium">
              <Type className="size-3.5 text-muted-foreground" />
              Min length (s)
              <Tooltip>
                <TooltipTrigger render={<span className="cursor-help text-[10px] text-muted-foreground">⌾</span>} />
                <TooltipContent>
                  Shorter segments are dropped. The maximum stays fixed at {`90s`}.
                </TooltipContent>
              </Tooltip>
            </Label>
            <div className="w-16">
              <NumberField
                id="auto-min-length"
                value={value.viral.minClipDuration}
                onCommit={(minClipDuration) => patch({ viral: { ...value.viral, minClipDuration } })}
                min={OPTION_LIMITS.minClipDuration.min}
                max={OPTION_LIMITS.minClipDuration.max}
                disabled={busy}
              />
            </div>
          </div>

          <ToggleRow
            id="auto-hook"
            icon={<Wand2 />}
            title="Hook text"
            description="Generate the on-screen hook and replay the detected hook moment."
            checked={value.viral.includeHookText}
            onCheckedChange={(includeHookText) => patch({ viral: { ...value.viral, includeHookText } })}
            disabled={busy}
          />
          <ToggleRow
            id="auto-cta"
            icon={<Clapperboard />}
            title="CTA card"
            description="Generate the closing call-to-action card for every clip."
            checked={value.viral.includeCta}
            onCheckedChange={(includeCta) => patch({ viral: { ...value.viral, includeCta } })}
            disabled={busy}
          />
        </div>
      )}

      {showBroll && (
        <div className="space-y-2 rounded-xl border border-dashed bg-muted/20 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-1.5 text-[12px] font-semibold">
              <ImagePlay className="size-3.5 text-muted-foreground" />
              B-roll
            </h4>
            <span className="text-[10.5px] text-muted-foreground">
              Wikimedia Commons + stock photos · never AI-generated
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleRow
              id="auto-broll"
              icon={<ImagePlay />}
              title="Add B-roll automatically"
              description="Plan images after detection, before the render. Off = plain clips, exactly as before."
              checked={value.broll.autoBroll}
              onCheckedChange={(autoBroll) => patchBroll({ autoBroll })}
              disabled={busy || !showAutomation}
            />
            <ToggleRow
              id="broll-fullscreen"
              icon={<Images />}
              title="Full-screen entity images"
              description="A named person, place or event takes the frame — only when Gemini Vision confirms the photo."
              checked={value.broll.enableFullscreen}
              onCheckedChange={(enableFullscreen) => patchBroll({ enableFullscreen })}
              disabled={busy || !value.broll.autoBroll}
            />
            <ToggleRow
              id="broll-landscape"
              icon={<Film />}
              title="Landscape cards"
              description="Stock photos framed beside the captions for the words that have no named entity."
              checked={value.broll.enableLandscape}
              onCheckedChange={(enableLandscape) => patchBroll({ enableLandscape })}
              disabled={busy || !value.broll.autoBroll}
            />
            <ToggleRow
              id="broll-sfx"
              icon={<Sparkles />}
              title="Image sound effects"
              description="A soft whoosh as an image arrives and a pop as it leaves, mixed under the voice."
              checked={value.broll.sfx}
              onCheckedChange={(sfx) => patchBroll({ sfx })}
              disabled={busy || !value.broll.autoBroll}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-background/60 px-3 py-2">
              <Label htmlFor="broll-min-images" className="flex items-center gap-1.5 text-[12px] font-medium">
                Min images / 60 s
                <Tooltip>
                  <TooltipTrigger render={<span className="cursor-help text-[10px] text-muted-foreground">⌾</span>} />
                  <TooltipContent>
                    Scaled to the clip length: a 60 s clip targets 10–15 images. Images are never padded
                    with irrelevant photos to hit the minimum.
                  </TooltipContent>
                </Tooltip>
              </Label>
              <div className="w-16">
                <NumberField
                  id="broll-min-images"
                  value={value.broll.minImages}
                  onCommit={(minImages) => patchBroll({ minImages })}
                  min={OPTION_LIMITS.brollImages.min}
                  max={value.broll.maxImages}
                  disabled={busy || !value.broll.autoBroll}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-background/60 px-3 py-2">
              <Label htmlFor="broll-max-images" className="flex items-center gap-1.5 text-[12px] font-medium">
                Max images / 60 s
                <Tooltip>
                  <TooltipTrigger render={<span className="cursor-help text-[10px] text-muted-foreground">⌾</span>} />
                  <TooltipContent>Never more than one image per 4 s, so each stays readable.</TooltipContent>
                </Tooltip>
              </Label>
              <div className="w-16">
                <NumberField
                  id="broll-max-images"
                  value={value.broll.maxImages}
                  onCommit={(maxImages) => patchBroll({ maxImages })}
                  min={value.broll.minImages}
                  max={OPTION_LIMITS.brollImages.max}
                  disabled={busy || !value.broll.autoBroll}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              Stock order — first provider with a key and quota wins.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {value.broll.providerOrder.map((provider, index) => (
                <li
                  key={provider}
                  className="flex items-center gap-0.5 rounded-lg border bg-background px-1.5 py-0.5 text-[11px]"
                >
                  <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                  <span className="font-medium capitalize">{provider}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${provider} up`}
                    disabled={busy || index === 0}
                    onClick={() => moveProvider(index, -1)}
                  >
                    <ChevronUp className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${provider} down`}
                    disabled={busy || index === value.broll.providerOrder.length - 1}
                    onClick={() => moveProvider(index, 1)}
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
            {STOCK_BROLL_PROVIDERS.some((provider: BrollProviderId) => !value.broll.providerOrder.includes(provider)) ? (
              <p className="text-[10.5px] text-muted-foreground">
                A provider removed from the order is never called.
              </p>
            ) : null}
          </div>
        </div>
      )}

      {onSave && (
        <div className="flex items-center justify-end gap-2 pt-0.5">
          <p className="mr-auto text-[11px] text-muted-foreground">
            {dirty ? "Not saved yet." : "Saved for this video."}
          </p>
          <Button size="sm" onClick={() => onSave(value)} disabled={!dirty || busy}>
            {busy ? <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}
