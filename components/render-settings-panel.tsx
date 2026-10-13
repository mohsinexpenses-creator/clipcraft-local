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
 * The "render clip settings" form: framing, color filter and the preset
 * choices every automatically rendered clip starts with. Captions are always
 * rendered by Remotion (animated overlays through headless Chrome).
 *
 * One implementation serves two homes: the Render defaults card on /settings
 * (app-wide defaults) and the per-video settings dialog on the dashboard, so
 * both always edit - and show - exactly what the database stores.
 */

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

      <div className="rounded-xl border bg-muted/20 p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[12px] font-semibold">Auto contextual visuals</p>
            <p className="text-[11px] text-muted-foreground">
              Automatically plans and composites up to {value.maxVisualMoments ?? 2} free-to-use images per clip from Pexels, Openverse, and Wikimedia Commons.
            </p>
          </div>
          <div className="w-36">
            <Segmented
              ariaLabel="Auto contextual visuals"
              value={(value.autoVisuals ?? true) ? "on" : "off"}
              onChange={(mode) => patch({ autoVisuals: mode === "on" })}
              options={[
                { value: "on", label: "Enabled" },
                { value: "off", label: "Off" },
              ]}
              disabled={disabled}
            />
          </div>
        </div>

        {(value.autoVisuals ?? true) && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label="Max visuals / clip"
                hint="Default 2 high-value visual beats per short clip (up to 3)."
              >
                <NumberField
                  id="default-max-visual-moments"
                  value={value.maxVisualMoments ?? 2}
                  min={limits?.maxVisualMoments?.min ?? 0}
                  max={limits?.maxVisualMoments?.max ?? 3}
                  step={1}
                  onCommit={(maxVisualMoments) => patch({ maxVisualMoments })}
                  disabled={disabled}
                />
              </Field>

              <Field
                label="Min confidence"
                hint="Moments below this threshold are skipped."
              >
                <NumberField
                  id="default-visual-confidence"
                  value={value.visualConfidenceThreshold ?? 0.65}
                  min={limits?.visualConfidence?.min ?? 0.4}
                  max={limits?.visualConfidence?.max ?? 0.95}
                  step={0.05}
                  onCommit={(visualConfidenceThreshold) =>
                    patch({ visualConfidenceThreshold })
                  }
                  disabled={disabled}
                />
              </Field>

              <Field
                label="Card animation"
                hint="Entrance style for contextual visual cards."
              >
                <Select
                  value={value.visualAnimation ?? "subtle-zoom"}
                  onValueChange={(next) =>
                    patch({
                      visualAnimation: (next ??
                        "subtle-zoom") as RenderDefaults["visualAnimation"],
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="dark">
                    <SelectItem value="subtle-zoom">Subtle zoom</SelectItem>
                    <SelectItem value="slide-up">Slide up</SelectItem>
                    <SelectItem value="fade">Smooth fade</SelectItem>
                    <SelectItem value="pop">Pop in</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1 text-[11.5px]">
              <span className="text-muted-foreground font-medium">Image sources:</span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.visualProviders?.pexels ?? true}
                  onChange={(e) =>
                    patch({
                      visualProviders: {
                        ...(value.visualProviders ?? {
                          pexels: true,
                          openverse: true,
                          wikimedia: true,
                        }),
                        pexels: e.target.checked,
                      },
                    })
                  }
                  disabled={disabled}
                  className="rounded border-border"
                />
                <span>Pexels (stock situations)</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.visualProviders?.openverse ?? true}
                  onChange={(e) =>
                    patch({
                      visualProviders: {
                        ...(value.visualProviders ?? {
                          pexels: true,
                          openverse: true,
                          wikimedia: true,
                        }),
                        openverse: e.target.checked,
                      },
                    })
                  }
                  disabled={disabled}
                  className="rounded border-border"
                />
                <span>Openverse (CC0 / PD / CC-BY)</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.visualProviders?.wikimedia ?? true}
                  onChange={(e) =>
                    patch({
                      visualProviders: {
                        ...(value.visualProviders ?? {
                          pexels: true,
                          openverse: true,
                          wikimedia: true,
                        }),
                        wikimedia: e.target.checked,
                      },
                    })
                  }
                  disabled={disabled}
                  className="rounded border-border"
                />
                <span>Wikimedia Commons (entities &amp; places)</span>
              </label>
            </div>
            <p className="text-[10.5px] text-muted-foreground">
              Photos provided by{" "}
              <a
                href="https://www.pexels.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Pexels
              </a>
              ,{" "}
              <a
                href="https://openverse.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Openverse
              </a>
              , and{" "}
              <a
                href="https://commons.wikimedia.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Wikimedia Commons
              </a>
              . Only assets permitting reuse and modification are selected (NC and ND licenses excluded).
            </p>
          </>
        )}
      </div>

      {/* Sound effects (SFX) */}
      <div className="rounded-xl border bg-muted/20 p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[12.5px] font-semibold">
              Sound effects (Hook, transitions, visual beats &amp; CTA)
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Mixes subtle studio SFX (whoosh, pop, click, typewriter ticks) on the output timeline without clipping speech.
            </p>
          </div>
          <div className="w-36 shrink-0">
            <Segmented<"on" | "off">
              ariaLabel="Sound effects"
              value={(value.sfxEnabled ?? true) ? "on" : "off"}
              onChange={(next) => patch({ sfxEnabled: next === "on" })}
              options={[
                { value: "on", label: "Enabled" },
                { value: "off", label: "Off" },
              ]}
              disabled={disabled}
            />
          </div>
        </div>

        {(value.sfxEnabled ?? true) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="SFX level (dB)"
              hint="Default -14 dB keeps SFX punchy while sitting cleanly underneath speech."
            >
              <NumberField
                id="default-sfx-volume"
                value={value.sfxVolume ?? -14}
                min={-36}
                max={0}
                step={1}
                onCommit={(sfxVolume) => patch({ sfxVolume })}
                disabled={disabled}
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}
