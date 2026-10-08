"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Braces,
  Check,
  Clipboard,
  Cloud,
  Cpu,
  Gauge,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "cn";
import type { AppSettingsSection, PipelineOptions, RenderDefaults } from "@/lib/types";
import { useSettings, type VerifyResult } from "@/hooks/use-settings";
import { AutomationPanel, NumberField } from "@/components/pipeline-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One place for everything that used to need `.env.local`: how far the upload
 * automation goes, how a clip is rendered by default, which provider keys are used,
 * how hard the worker pushes, and what happens to profane audio.
 *
 * Two rules shape the whole page:
 *
 * 1. Each card owns one settings section and saves only that section, so a half-edited
 *    card can never overwrite another one.
 * 2. Every field says where its value comes from - Settings, `.env.local`, or the
 *    built-in default - and "Clear section" puts it back to that chain. Nothing here
 *    edits the env file, so a hand-written `.env.local` stays authoritative until an
 *    override is actually saved.
 */

const SECTIONS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "render", label: "Render defaults" },
  { id: "ai", label: "AI providers" },
  { id: "worker", label: "Worker & limits" },
  { id: "profanity", label: "Safety" },
] as const;

export function SettingsWorkspace() {
  const settings = useSettings();
  const { payload, effective, error, busy, reload } = settings;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="animate-fade-up flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="flex items-center gap-2 text-[22px] leading-tight font-semibold tracking-tight">
            <Sparkles className="size-5 text-primary" />
            Settings
          </h1>
          <p className="max-w-2xl text-[13px] text-muted-foreground">
            Defaults for the automatic pipeline, how clips are rendered, provider keys and worker
            limits. Stored in the same SQLite file as everything else - and{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[12px]">.env.local</code> still wins
            for anything you never save here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={busy === "load"}>
          {busy === "load" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Reload
        </Button>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0">
            {error}{" "}
            <span className="text-muted-foreground">
              The rest of the app keeps working with the values it already has.
            </span>
          </p>
        </div>
      )}

      {!payload && !error ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {SECTIONS.map((section) => (
            <div key={section.id} className="h-[260px] animate-pulse rounded-2xl border bg-card/40" />
          ))}
        </div>
      ) : null}

      {payload && effective ? (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <PipelineCard settings={settings} effective={effective} />
          <RenderCard settings={settings} effective={effective} />
          <ProvidersCard
            key={`ai-${settings.revision}`}
            settings={settings}
            effective={effective}
            className="lg:col-span-2"
          />
          <WorkerCard settings={settings} effective={effective} />
          <SafetyCard settings={settings} effective={effective} />
        </div>
      ) : null}
    </div>
  );
}

type SettingsController = ReturnType<typeof useSettings>;

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

interface CardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  section: AppSettingsSection;
  settings: SettingsController;
  dirty: boolean;
  onSave: () => void | Promise<void>;
  children: React.ReactNode;
  className?: string;
  /** Extra hint under the save row, e.g. "needs a worker restart". */
  footnote?: React.ReactNode;
}

function SettingsCard({
  title,
  description,
  icon,
  section,
  settings,
  dirty,
  onSave,
  children,
  className,
  footnote,
}: CardProps) {
  const configured = settings.configured.includes(section);
  const busy = settings.busy === `save:${section}` || settings.busy === `reset:${section}`;

  return (
    <section
      className={cn("animate-fade-up flex flex-col rounded-2xl border bg-card p-4 shadow-[var(--shadow-card)]", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] leading-tight font-semibold tracking-tight">
              {title}
              {configured ? <SourceChip source="app" /> : null}
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 flex-1 space-y-3.5">{children}</div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" onClick={onSave} disabled={busy || !dirty}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          {dirty ? "Save changes" : "Saved"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void settings.reset(section)}
          disabled={busy || !configured}
        >
          Clear section
        </Button>
        <p className="ml-auto min-w-0 text-[11px] leading-snug text-muted-foreground">{footnote}</p>
      </div>
    </section>
  );
}

function SourceChip({ source, className }: { source?: string; className?: string }) {
  if (!source || source === "default") return null;
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide whitespace-nowrap uppercase",
        source === "app"
          ? "bg-primary/10 text-primary"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        className
      )}
      title={
        source === "app"
          ? "Saved on this page"
          : "Coming from .env.local - saving here overrides it"
      }
    >
      {source === "app" ? "settings" : ".env"}
    </span>
  );
}

function Row({
  label,
  hint,
  source,
  children,
  className,
}: {
  label: string;
  hint?: string;
  source?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="min-w-0">
        <Label className="flex items-center gap-1.5 text-[12.5px] font-medium">
          {label}
          <SourceChip source={source} />
        </Label>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <div className="w-[190px] shrink-0">{children}</div>
    </div>
  );
}

/** Segmented control for short enums - faster than a dropdown and it shows the options. */
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
    <div role="group" aria-label={ariaLabel} className="flex rounded-lg border bg-muted/40 p-0.5">
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
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-60"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function EnvBadge({ hint }: { hint?: { present: boolean; masked: string; inEnvFile: boolean } }) {
  if (!hint) return null;
  if (!hint.present && !hint.inEnvFile) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex cursor-help items-center gap-1 text-[10.5px] text-muted-foreground" />}
      >
        <Cloud className="size-3" />
        {hint.present ? "in env" : "in .env.local"}
      </TooltipTrigger>
      <TooltipContent className="dark">
        {hint.present
          ? `This process can read it${hint.masked ? ` (${hint.masked})` : ""}.` : "Set in .env.local but not loaded by this process."}
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Pipeline defaults                                                          */
/* -------------------------------------------------------------------------- */

function PipelineCard({
  settings,
  effective,
}: {
  settings: SettingsController;
  effective: NonNullable<SettingsController["effective"]>;
}) {
  const [draft, setDraft] = React.useState<PipelineOptions | null>(null);
  const value = draft ?? effective.pipeline;
  const saved = effective.pipeline;

  const save = async () => {
    if (!draft) return;
    // Only changed fields are sent; the server merges them into the stored row.
    const changed = diffFields(saved, draft);
    const ok = await settings.save("pipeline", changed);
    if (ok) setDraft(null);
  };

  return (
    <SettingsCard
      section="pipeline"
      title="Pipeline defaults"
      description="What an upload does on its own. Stored on each video at upload time, so changing this never rewrites a running pipeline."
      icon={<Wand2 className="size-4" />}
      settings={settings}
      dirty={draft !== null}
      onSave={() => void save()}
      footnote="New uploads only · per-video overrides win in the dashboard"
    >
      <AutomationPanel
        value={value}
        onChange={(next) => setDraft(next)}
        busy={settings.busy === "save:pipeline"}
      />
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Render clip defaults                                                       */
/* -------------------------------------------------------------------------- */

const ENGINE_LABELS: Record<string, string> = {
  remotion: "Premium · animated overlays",
  native: "Fast · ASS captions in one pass",
};

function RenderCard({
  settings,
  effective,
}: {
  settings: SettingsController;
  effective: NonNullable<SettingsController["effective"]>;
}) {
  const [draft, setDraft] = React.useState<RenderDefaults | null>(null);
  const value = draft ?? effective.render;
  const saved = effective.render;
  const sources = settings.sources.render ?? {};
  const limits = settings.limits;

  const patch = (partial: Partial<RenderDefaults>) => setDraft((current) => ({ ...(current ?? saved), ...partial }));

  const save = async () => {
    if (!draft) return;
    const ok = await settings.save("render", draft);
    if (ok) setDraft(null);
  };

  return (
    <SettingsCard
      section="render"
      title="Render clip defaults"
      description="The configuration every automatically rendered clip starts with. Editing a clip in the grid overrides it for that clip only."
      icon={<Braces className="size-4" />}
      settings={settings}
      dirty={draft !== null}
      onSave={() => void save()}
      footnote="Applies from the next detection or re-render onwards"
    >
      <Row label="Caption engine" hint="Premium is slower and smoothest; Fast rasterizes captions with FFmpeg." source={sources.captionEngine}>
        <Segmented
          ariaLabel="Caption engine"
          value={value.captionEngine}
          onChange={(captionEngine) => patch({ captionEngine: captionEngine as RenderDefaults["captionEngine"] })}
          options={(limits?.engines ?? ["remotion", "native"]).map((engine) => ({
            value: engine,
            label: engine === "remotion" ? "Premium" : "Fast",
            hint: ENGINE_LABELS[engine],
          }))}
          disabled={settings.busy === "save:render"}
        />
      </Row>

      <Row label="Framing" hint="Speaker focus glides one 9:16 window; split screen gives each person a pane." source={sources.layout}>
        <Segmented
          ariaLabel="Layout"
          value={value.layout}
          onChange={(layout) => patch({ layout: layout as RenderDefaults["layout"] })}
          options={[
            { value: "speaker-focus", label: "Speaker focus" },
            { value: "split-screen", label: "Split screen" },
          ]}
          disabled={settings.busy === "save:render"}
        />
      </Row>

      <Row label="Color filter" source={sources.filterPreset}>
        <Select value={value.filterPreset} onValueChange={(next) => patch({ filterPreset: String(next ?? "vibrant") })}>
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
      </Row>

      <Row
        label="Caption preset"
        hint={value.captionPresetId ? undefined : "Uses the preset marked default in the caption preset table."}
        source={sources.captionPresetId}
      >
        <Select
          value={value.captionPresetId ?? "__default"}
          onValueChange={(next) => patch({ captionPresetId: next === "__default" ? null : String(next ?? "") })}
        >
          <SelectTrigger className="h-8 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="dark">
            <SelectItem value="__default">Database default</SelectItem>
            {settings.options.captionPresets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
                {preset.isDefault ? " · table default" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Hook style" source={sources.hookStylePresetId} className="sm:block">
          <Select
            value={value.hookStylePresetId ?? "__default"}
            onValueChange={(next) => patch({ hookStylePresetId: next === "__default" ? null : String(next ?? "") })}
          >
            <SelectTrigger className="mt-2 h-8 w-full text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              <SelectItem value="__default">Database default</SelectItem>
              {settings.options.overlayPresets
                .filter((preset) => preset.kind === "hook")
                .map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="CTA style" source={sources.ctaStylePresetId} className="sm:block">
          <Select
            value={value.ctaStylePresetId ?? "__default"}
            onValueChange={(next) => patch({ ctaStylePresetId: next === "__default" ? null : String(next ?? "") })}
          >
            <SelectTrigger className="mt-2 h-8 w-full text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              <SelectItem value="__default">Database default</SelectItem>
              {settings.options.overlayPresets
                .filter((preset) => preset.kind === "cta")
                .map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Row>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Hook intro (s)" hint="0 removes the replayed hook entirely." source={sources.hookDuration} className="sm:block">
          <div className="mt-2">
            <NumberField
              id="default-hook-duration"
              value={value.hookDuration}
              min={limits?.overlayDuration.min ?? 0}
              max={limits?.overlayDuration.max ?? 30}
              step={0.5}
              onCommit={(hookDuration) => patch({ hookDuration })}
              disabled={settings.busy === "save:render"}
            />
          </div>
        </Row>
        <Row label="CTA card (s)" hint="Shown over the last seconds of the clip." source={sources.ctaDuration} className="sm:block">
          <div className="mt-2">
            <NumberField
              id="default-cta-duration"
              value={value.ctaDuration}
              min={limits?.overlayDuration.min ?? 0}
              max={limits?.overlayDuration.max ?? 30}
              step={0.5}
              onCommit={(ctaDuration) => patch({ ctaDuration })}
              disabled={settings.busy === "save:render"}
            />
          </div>
        </Row>
      </div>
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* AI providers: Gemini pool + Deepgram                                       */
/* -------------------------------------------------------------------------- */

function ProvidersCard({
  settings,
  effective,
  className,
}: {
  settings: SettingsController;
  effective: NonNullable<SettingsController["effective"]>;
  className?: string;
}) {
  // Keys the user has staged but not saved yet. `null` = "unchanged from the server",
  // which is why nothing has to be re-synced when the snapshot refreshes: the whole
  // card is re-mounted with a new `key` after every save or reset (see `revision`).
  const storedKeys = (settings.stored.ai as { geminiApiKeys?: string[] } | undefined)?.geminiApiKeys ?? [];
  const [staged, setStaged] = React.useState<string[] | null>(null);
  const pool = staged ?? storedKeys;
  const [candidate, setCandidate] = React.useState("");
  const [deepgramKey, setDeepgramKey] = React.useState("");
  const storedDeepgramMasked = String(
    (settings.stored.ai as { deepgramApiKey?: string } | undefined)?.deepgramApiKey ?? ""
  );

  const dirty = staged !== null || candidate.trim().length > 0 || deepgramKey.trim().length > 0;

  const addCandidate = () => {
    const key = candidate.trim();
    if (!key) return;
    setStaged([...pool, key]);
    setCandidate("");
  };

  const savePool = async () => {
    // Masked entries mean "keep that stored key" (the server resolves them); the new
    // ones are the typed values. Order is preserved, so reordering works too.
    const keys = [...pool, candidate.trim()].filter(Boolean);
    const ok = await settings.save("ai", { geminiApiKeys: keys });
    if (ok) {
      setCandidate("");
      setStaged(null);
    }
  };

  const verifyKey = (key: string, index: number) =>
    settings.verify({
      target: "gemini",
      ...(key ? { candidates: { geminiApiKey: key } } : { keyIndex: index }),
    });

  return (
    <section className={cn("animate-fade-up rounded-2xl border bg-card p-4 shadow-[var(--shadow-card)]", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] leading-tight font-semibold tracking-tight">
              AI providers
              {settings.configured.includes("ai") ? <SourceChip source="app" /> : null}
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
              Viral detection runs on Google AI Studio. Keys are tried in order and rotate on a 429,
              so a second free key is real redundancy. Deepgram is optional: set a key only to
              transcribe in the cloud instead of with local whisper.cpp.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void settings.verify({ target: "all" })}
          disabled={settings.busy !== null}
        >
          {settings.busy === "verify:all" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Test everything
        </Button>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        {/* Gemini pool */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              Gemini keys
              <EnvBadge hint={settings.env.GEMINI_API_KEY} />
            </h3>
            <span className="text-[11px] text-muted-foreground">
              {effective.ai.geminiApiKeys.length
                ? `${effective.ai.geminiApiKeys.length} in effect`
                : "none configured — viral detection will fail"}
            </span>
          </div>

          {effective.ai.geminiApiKeys.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[11.5px] leading-snug text-muted-foreground">
              No key yet. Paste one below, <span className="text-foreground">Test</span> it, then save.
              Create keys free at aistudio.google.com/apikey.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {effective.ai.geminiApiKeys.map((masked, index) => {
                const result = settings.results.find((entry) => entry.target === "gemini" && entry.label.includes(masked));
                return (
                  <li
                    key={`${masked}-${index}`}
                    className="flex items-center gap-2 rounded-lg border bg-muted/25 px-2.5 py-1.5"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-[10px] font-semibold ring-1 ring-border">
                      {index + 1}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{masked}</code>
                    {result ? <ResultDot result={result} /> : null}
                    <Tooltip>
                      <TooltipTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Test this key" />}>
                        <BadgeCheck className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent className="dark">Ask Google AI Studio whether this key works</TooltipContent>
                    </Tooltip>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Test key ${index + 1}`}
                      onClick={() => void verifyKey("", index)}
                      disabled={settings.busy !== null}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-1.5">
            <Input
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCandidate();
                }
              }}
              placeholder="Paste a new GEMINI_API_KEY"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12px]"
              aria-label="New Gemini API key"
            />
            <Button size="sm" variant="outline" onClick={addCandidate} disabled={!candidate.trim()}>
              <Plus />
              Add
            </Button>
          </div>

          {dirty ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-primary/5 px-2.5 py-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                {pool.length} key{pool.length === 1 ? "" : "s"} staged
                {candidate.trim() ? " (plus the pasted one)" : ""}
                {pool.length === 0 ? " - saving clears the stored pool" : ""}.
              </span>
              <Button size="xs" variant="soft" onClick={() => void savePool()} disabled={settings.busy === "save:ai"}>
                {settings.busy === "save:ai" ? <Loader2 className="animate-spin" /> : <Save />}
                Save pool
              </Button>
              <Button size="xs" variant="ghost" onClick={() => { setStaged(null); setCandidate(""); }}>
                Undo
              </Button>
            </div>
          ) : null}

          <GeminiPoolEditor pool={pool} storedKeys={storedKeys} setStaged={setStaged} />

          <details className="group rounded-lg border bg-muted/20 px-2.5 py-2">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              Where do the keys come from right now?
            </summary>
            <div className="mt-2 space-y-1.5 text-[11px] leading-snug text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <SourceChip source={settings.sources.ai?.geminiApiKeys} />
                {settings.sources.ai?.geminiApiKeys === "app"
                  ? "the pool saved on this page"
                  : settings.sources.ai?.geminiApiKeys === "env"
                    ? "GEMINI_API_KEY in .env.local"
                    : "nothing yet - viral detection cannot run until you add a key"}
              </p>
              <p>Saved keys live in the SQLite file next to your videos; they never leave this machine except to the provider.</p>
            </div>
          </details>
        </div>

        {/* Deepgram */}
        <div className="space-y-2.5">
          <h3 className="flex items-center gap-1.5 text-[12.5px] font-semibold">
            Deepgram (optional)
            <EnvBadge hint={settings.env.DEEPGRAM_API_KEY} />
          </h3>

          <div className="space-y-1.5">
            <Label htmlFor="deepgram-key" className="text-[11.5px] text-muted-foreground">
              API key
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="deepgram-key"
                value={deepgramKey}
                onChange={(event) => setDeepgramKey(event.target.value)}
                placeholder={storedDeepgramMasked ? storedDeepgramMasked : "Paste to store a key here"}
                spellCheck={false}
                autoComplete="off"
                type="password"
                className="font-mono text-[12px]"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!deepgramKey.trim() || settings.busy !== null}
                onClick={() => void settings.verify({ target: "deepgram", candidates: { deepgramApiKey: deepgramKey.trim(), deepgramModel: effective.ai.deepgramModel } })}
              >
                {settings.busy === "verify:deepgram" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Test
              </Button>
            </div>
          </div>

          <Row label="Model" hint="Anything Deepgram understands, e.g. nova-3 or nova-2:general." source={settings.sources.ai?.deepgramModel}>
            <Input
              value={effective.ai.deepgramModel}
              onChange={() => undefined}
              readOnly
              className="h-7 font-mono text-[12px]"
              aria-label="Deepgram model (read-only until saved)"
            />
          </Row>

          <ModelEditor save={(model) => settings.save("ai", { deepgramModel: model })} current={effective.ai.deepgramModel} busy={settings.busy === "save:ai"} />

          <Row
            label="Transcription engine"
            hint="Auto prefers Deepgram when a key exists. Forcing an engine makes a missing setup an error instead of a silent fallback."
            source={settings.sources.ai?.transcriptionProvider}
          >
            <EngineChoice save={(transcriptionProvider) => settings.save("ai", { transcriptionProvider })} value={effective.ai.transcriptionProvider} busy={settings.busy === "save:ai"} />
          </Row>

          <ProviderSummary settings={settings} />
        </div>
      </div>

      <VerifyResults results={settings.results} onClear={settings.clearResults} busy={settings.busy} />
    </section>
  );
}

/**
 * Staged view of the key pool: remove, reorder and label what is new. Nothing is sent
 * until "Save pool", and a stored key is only ever represented by its mask.
 */
function GeminiPoolEditor({
  pool,
  storedKeys,
  setStaged,
}: {
  pool: string[];
  storedKeys: string[];
  setStaged: (next: (current: string[] | null) => string[] | null) => void;
}) {
  if (pool.length === 0) return null;

  const isStored = (entry: string) => storedKeys.includes(entry);
  const move = (index: number, delta: number) =>
    setStaged((current) => {
      const list = current ?? storedKeys;
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  return (
    <div className="space-y-1.5 rounded-lg border border-dashed bg-muted/20 p-2">
      <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
        Unsaved pool · {pool.length} key{pool.length === 1 ? "" : "s"}
      </p>
      <ul className="space-y-1">
        {pool.map((entry, index) => (
          <li key={`${entry.slice(-6)}-${index}`} className="flex items-center gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate font-mono">
              {isStored(entry) ? entry : shorten(entry)}
            </span>
            {!isStored(entry) ? <Badge variant="outline">new</Badge> : null}
            <Button size="icon-xs" variant="ghost" aria-label="Move up" onClick={() => move(index, -1)}>
              <ArrowUp className="size-3" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Move down" onClick={() => move(index, 1)}>
              <ArrowDown className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove from pool"
              onClick={() => setStaged((current) => (current ?? storedKeys).filter((_, position) => position !== index))}
            >
              <Trash2 className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelEditor({ save, current, busy }: { save: (model: string) => Promise<boolean>; current: string; busy: boolean }) {
  const [value, setValue] = React.useState(current);
  if (value === current) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-primary/5 px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        Model will change to <code className="font-mono text-foreground">{value}</code>
      </span>
      <Button size="xs" variant="soft" disabled={busy} onClick={() => void save(value)}>
        Save
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setValue(current)}>
        Undo
      </Button>
    </div>
  );
}

function EngineChoice({
  value,
  save,
  busy,
}: {
  value: string;
  save: (next: "auto" | "deepgram" | "whisper") => Promise<boolean>;
  busy: boolean;
}) {
  return (
    <Segmented
      ariaLabel="Transcription engine"
      value={value as "auto" | "deepgram" | "whisper"}
      disabled={busy}
      onChange={(next) => void save(next)}
      options={[
        { value: "auto", label: "Auto", hint: "Deepgram when a key exists, otherwise whisper.cpp" },
        { value: "whisper", label: "Local", hint: "Always whisper.cpp" },
        { value: "deepgram", label: "Cloud", hint: "Always Deepgram - errors if no key" },
      ]}
    />
  );
}

function ProviderSummary({ settings }: { settings: SettingsController }) {
  const whisperOnly = settings.effective?.ai.transcriptionProvider === "whisper";
  const hasKey = Boolean(settings.effective?.ai.deepgramApiKey);
  if (whisperOnly || !hasKey) {
    return (
      <p className="flex items-start gap-1.5 rounded-lg bg-muted/30 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
        <Cpu className="mt-0.5 size-3.5 shrink-0" />
        Transcription runs locally with whisper.cpp - no audio leaves this machine.
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-sky-500/10 px-2.5 py-2 text-[11px] leading-snug text-sky-700 dark:text-sky-300">
      <Cloud className="mt-0.5 size-3.5 shrink-0" />
      Audio is uploaded to Deepgram for transcription. Word timestamps come back and every later step
      stays local.
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Worker & limits                                                            */
/* -------------------------------------------------------------------------- */

function WorkerCard({
  settings,
  effective,
}: {
  settings: SettingsController;
  effective: NonNullable<SettingsController["effective"]>;
}) {
  const [draft, setDraft] = React.useState<Partial<{ clipConcurrency: number; viralConcurrency: number; remotionConcurrency: number | null }>>({});
  const value = { ...effective.worker, ...draft };
  const limits = settings.limits?.concurrency;
  const autoRemotion = effective.worker.remotionConcurrency === null;

  const save = async () => {
    if (Object.keys(draft).length === 0) return;
    const ok = await settings.save("worker", draft);
    if (ok) setDraft({});
  };

  return (
    <SettingsCard
      section="worker"
      title="Worker & limits"
      description="How hard the render process pushes. Each clip render runs FFmpeg plus a headless Chrome, so one slot per CPU-heavy core is the honest ceiling."
      icon={<Gauge className="size-4" />}
      settings={settings}
      dirty={Object.keys(draft).length > 0}
      onSave={() => void save()}
      footnote={
        settings.restartRequired.length ? (
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />
            Saved here - the loops are sized at start, so restart{" "}
            <code className="rounded bg-muted px-1">npm run worker</code> to apply it
          </span>
        ) : (
          <span>
            Chrome tabs apply on the next render; the two loop sizes apply when{" "}
            <code className="rounded bg-muted px-1">npm run worker</code> starts.
          </span>
        )
      }
    >
      <Row
        label="Clip renders at once"
        hint={
          settings.sources.worker?.clipConcurrency === "env"
            ? "Currently from WORKER_CONCURRENCY in .env.local."
            : "1 is the right value on a normal PC."
        }
        source={settings.sources.worker?.clipConcurrency}
      >
        <NumberField
          id="clip-concurrency"
          value={value.clipConcurrency}
          min={limits?.clip.min ?? 1}
          max={limits?.clip.max ?? 8}
          onCommit={(clipConcurrency) => setDraft((current) => ({ ...current, clipConcurrency }))}
          disabled={settings.busy === "save:worker"}
        />
      </Row>

      <Row
        label="Viral detections at once"
        hint="Detection is an LLM call, not a render - useful when several videos are uploaded together."
        source={settings.sources.worker?.viralConcurrency}
      >
        <NumberField
          id="viral-concurrency"
          value={value.viralConcurrency}
          min={limits?.viral.min ?? 1}
          max={limits?.viral.max ?? 8}
          onCommit={(viralConcurrency) => setDraft((current) => ({ ...current, viralConcurrency }))}
          disabled={settings.busy === "save:worker"}
        />
      </Row>

      <Row
        label="Chrome tabs per render"
        hint={autoRemotion ? "Unset: the renderer picks half your CPU cores." : "Overridden from Settings; applies on the next render."}
        source={settings.sources.worker?.remotionConcurrency}
      >
        <div className="flex items-center gap-2">
          <Switch
            id="remotion-auto"
            checked={!autoRemotion}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, remotionConcurrency: checked ? (effective.worker.remotionConcurrency ?? 2) : null }))
            }
            disabled={settings.busy === "save:worker"}
          />
          <Label htmlFor="remotion-auto" className="text-[11.5px] font-normal text-muted-foreground">
            Manual
          </Label>
          <div className="w-[70px]">
            <NumberField
              id="remotion-concurrency"
              value={effective.worker.remotionConcurrency ?? 0}
              min={limits?.remotion.min ?? 1}
              max={limits?.remotion.max ?? 8}
              disabled={autoRemotion || settings.busy === "save:worker"}
              onCommit={(remotionConcurrency) => setDraft((current) => ({ ...current, remotionConcurrency }))}
            />
          </div>
        </div>
      </Row>

      <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
        <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Env fallbacks</p>
        <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
          {["WORKER_CONCURRENCY", "VIRAL_CONCURRENCY", "REMOTION_CONCURRENCY"].map((name) => (
            <li key={name} className="flex items-center justify-between gap-2">
              <code className="font-mono">{name}</code>
              <span className="flex items-center gap-1.5">
                {settings.env[name]?.present ? settings.env[name]?.masked || "set" : "not set"}
                <EnvBadge hint={settings.env[name]} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Safety                                                                     */
/* -------------------------------------------------------------------------- */

function SafetyCard({
  settings,
  effective,
}: {
  settings: SettingsController;
  effective: NonNullable<SettingsController["effective"]>;
}) {
  const [draft, setDraft] = React.useState<{ audioMode: "mute" | "beep" | "off" } | null>(null);
  const value = draft ?? effective.profanity;

  const save = async () => {
    if (!draft) return;
    const ok = await settings.save("profanity", draft);
    if (ok) setDraft(null);
  };

  return (
    <SettingsCard
      section="profanity"
      title="Profanity & masking"
      description="On-screen text is always masked (fuck → f**k, while class/pass/glass stay untouched). This only decides what happens to the spoken word."
      icon={<ShieldCheck className="size-4" />}
      settings={settings}
      dirty={draft !== null}
      onSave={() => void save()}
      footnote="Applies to the next render - no re-transcription needed"
    >
      <div className="grid gap-2">
        {AUDIO_MODES.map((mode) => {
          const active = value.audioMode === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              onClick={() => setDraft({ audioMode: mode.value })}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-all outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/40",
                active ? "border-primary/40 bg-primary/5" : "hover:border-primary/20 hover:bg-muted/40"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-input"
                )}
              >
                {active ? <Check className="size-2.5" /> : null}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                  {mode.label}
                  {settings.sources.profanity?.audioMode === "env" && mode.value === effective.profanity.audioMode && !draft ? (
                    <SourceChip source="env" />
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{mode.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Masking uses the word timestamps from the transcript, so changing this only needs a re-render -
        the stored text keeps the original words.
      </p>
    </SettingsCard>
  );
}

const AUDIO_MODES = [
  { value: "mute" as const, label: "Mute the word", description: "The offending word is silent. Default, and what most platforms expect." },
  { value: "beep" as const, label: "Beep over the word", description: "A 1 kHz tone replaces it - unmistakably censored, which some audiences like." },
  { value: "off" as const, label: "Leave the audio alone", description: "Only the text is masked. Use where you control the platform policy." },
];

/* -------------------------------------------------------------------------- */
/* Verification results                                                       */
/* -------------------------------------------------------------------------- */

function ResultDot({ result }: { result: VerifyResult }) {
  const tone =
    result.status === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : result.status === "limited"
        ? "text-amber-600 dark:text-amber-400"
        : "text-destructive";
  const Icon = result.status === "ok" ? Check : result.status === "limited" ? AlertTriangle : X;
  return <Icon className={cn("size-3.5 shrink-0", tone)} />;
}

function VerifyResults({
  results,
  onClear,
  busy,
}: {
  results: VerifyResult[];
  onClear: () => void;
  busy: string | null;
}) {
  if (results.length === 0) return null;
  const pending = busy?.startsWith("verify");

  return (
    <div className="mt-4 animate-fade-in space-y-2 rounded-xl border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {pending ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
          Provider checks
        </p>
        <Button size="xs" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
      <ul className="space-y-1.5">
        {results.map((result) => (
          <li key={`${result.target}-${result.label}`} className="flex items-start gap-2 rounded-lg bg-background/60 px-2.5 py-2 ring-1 ring-border/60">
            <ResultDot result={result} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                <code className="min-w-0 truncate font-mono text-[11px]">{result.label}</code>
                {result.httpStatus ? <span className="text-muted-foreground">HTTP {result.httpStatus}</span> : null}
                {typeof result.latencyMs === "number" ? (
                  <span className="text-muted-foreground">{result.latencyMs} ms</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{result.message}</p>
              {result.notes?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {result.notes.map((note) => (
                    <li key={note} className="text-[11px] leading-snug text-muted-foreground">
                      · {note}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Clipboard className="size-3" />
        A check contacts the provider directly with the real key - it never sends your videos.
      </p>
    </div>
  );
}

/** `AIzaSyC…9f3` - a typed key is never shown in full on this page. */
function shorten(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Shallow diff so a card only sends the fields the user actually touched. */
function diffFields<T extends object>(base: T, next: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) changed[key] = next[key];
  }
  return changed;
}
