"use client";

import * as React from "react";
import Link from "next/link";
import type { RenderDefaults, SettingsLimits } from "@/lib/types";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NumberField } from "@/components/pipeline-settings";
import { cn } from "cn";

/**
 * The "render clip settings" form: caption engine, framing, color filter and the
 * preset choices every automatically rendered clip starts with.
 *
 * One implementation serves two homes: the Render defaults card on /settings
 * (app-wide defaults) and the per-video settings dialog on the dashboard, so
 * both always edit - and show - exactly what the database stores.
 */

export const ENGINE_LABELS: Record<string, string> = {
  remotion: "Premium · animated overlays",
  native: "Fast · ASS captions in one pass",
};

export interface RenderSettingsPanelProps {
  value: RenderDefaults;
  onChange: (next: RenderDefaults) => void;
  limits?: SettingsLimits;
  captionPresets: Array<{ id: string; name: string; isDefault: boolean }>;
  overlayPresets: Array<{
    id: string;
    kind: "hook" | "cta";
    name: string;
    isDefault: boolean;
  }>;
  disabled?: boolean;
  className?: string;
}

/** Segmented control (kept local: the settings page has its own copy). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T | undefined;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex rounded-lg border bg-muted/40 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            title={option.hint}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium whitespace-nowrap transition-all outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/40",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-60",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger>
              <span className="cursor-help text-[10px] text-muted-foreground">ⓘ</span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{hint}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </Label>
      {children}
    </div>
  );
}

export function RenderSettingsPanel({
  value,
  onChange,
  limits,
  captionPresets,
  overlayPresets,
  disabled,
  className,
}: RenderSettingsPanelProps) {
  const patch = (partial: Partial<RenderDefaults>) =>
    onChange({ ...value, ...partial });

  return (
    <div className={cn("space-y-3.5", className)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Caption engine"
          hint="Premium renders animated captions through headless Chrome (smoothest, slower). Fast burns ASS captions with FFmpeg in one pass (~10x faster)."
        >
          <Segmented
            ariaLabel="Caption engine"
            value={value.captionEngine}
            onChange={(captionEngine) =>
              patch({ captionEngine: captionEngine as RenderDefaults["captionEngine"] })
            }
            options={(limits?.engines ?? ["remotion", "native"]).map((engine) => ({
              value: engine,
              label: engine === "remotion" ? "Premium" : "Fast",
              hint: ENGINE_LABELS[engine],
            }))}
            disabled={disabled}
          />
        </Field>

        <Field
          label="Framing"
          hint="Speaker focus glides one 9:16 window to whoever talks; split screen gives each person a pane."
        >
          <Segmented
            ariaLabel="Layout"
            value={value.layout}
            onChange={(layout) => patch({ layout: layout as RenderDefaults["layout"] })}
            options={[
              { value: "speaker-focus", label: "Speaker focus" },
              { value: "split-screen", label: "Split screen" },
            ]}
            disabled={disabled}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Color filter">
          <Select
            value={value.filterPreset}
            onValueChange={(next) => patch({ filterPreset: String(next ?? "vibrant") })}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {(limits?.filterPresets ?? []).map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Caption preset"
          hint={
            value.captionPresetId
              ? "The caption style every new clip starts with."
              : undefined
          }
        >
          <Select
            value={value.captionPresetId ?? "__default"}
            onValueChange={(next) =>
              patch({ captionPresetId: next === "__default" ? null : String(next ?? "") })
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              <SelectItem value="__default">Database default</SelectItem>
              {captionPresets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                  {preset.isDefault ? " · table default" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!value.captionPresetId && (
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              Uses the preset marked default on{" "}
              <Link
                href="/caption-presets"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Style presets
              </Link>
              .
            </p>
          )}
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Hook style">
          <Select
            value={value.hookStylePresetId ?? "__default"}
            onValueChange={(next) =>
              patch({ hookStylePresetId: next === "__default" ? null : String(next ?? "") })
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              <SelectItem value="__default">Database default</SelectItem>
              {overlayPresets
                .filter((preset) => preset.kind === "hook")
                .map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="CTA style">
          <Select
            value={value.ctaStylePresetId ?? "__default"}
            onValueChange={(next) =>
              patch({ ctaStylePresetId: next === "__default" ? null : String(next ?? "") })
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              <SelectItem value="__default">Database default</SelectItem>
              {overlayPresets
                .filter((preset) => preset.kind === "cta")
                .map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Hook intro fallback (s)"
          hint="Only used when a clip has no usable hook interval from the AI - that interval normally decides the length. 0 turns the hook intro and hook text off."
        >
          <NumberField
            id="default-hook-duration"
            value={value.hookDuration}
            min={limits?.overlayDuration.min ?? 0}
            max={limits?.overlayDuration.max ?? 30}
            step={0.5}
            onCommit={(hookDuration) => patch({ hookDuration })}
            disabled={disabled}
          />
        </Field>

        <Field label="CTA card (s)" hint="Shown over the last seconds of the clip.">
          <NumberField
            id="default-cta-duration"
            value={value.ctaDuration}
            min={limits?.overlayDuration.min ?? 0}
            max={limits?.overlayDuration.max ?? 30}
            step={0.5}
            onCommit={(ctaDuration) => patch({ ctaDuration })}
            disabled={disabled}
          />
        </Field>
      </div>
    </div>
  );
}
