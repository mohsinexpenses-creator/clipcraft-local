"use client"

import * as React from "react"
import { Clapperboard, Film, Sparkles, Type, Wand2 } from "lucide-react"
import { cn } from "cn"
import type { PipelineOptions } from "@/lib/types"
import { OPTION_LIMITS } from "@/lib/pipeline-defaults"
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

interface NumberFieldProps {
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
function NumberField({ id, value, onCommit, min, max, step = 1, disabled }: NumberFieldProps) {
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
}: AutomationPanelProps) {
  const patch = (partial: Partial<PipelineOptions>) =>
    onChange?.({ ...value, ...partial, viral: { ...value.viral, ...(partial.viral ?? {}) } });

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
