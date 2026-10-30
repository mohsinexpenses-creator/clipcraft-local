"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  CaptionLineStyle,
  CaptionPreset,
  CaptionThemeName,
  OverlayStylePreset,
} from "@/lib/types";
import {
  CAPTION_THEME_CATALOG,
  getCaptionThemeDefinition,
} from "@/lib/caption-theme-styles";
import { CaptionPreview } from "@/components/caption-preview";
import { OverlayStyleEditor } from "@/components/overlay-style-editor";
import {
  DEFAULT_CAPTION_PRESETS,
  DEFAULT_OVERLAY_STYLE_PRESETS,
} from "@/lib/presets";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  CheckCircle2,
  Layers,
  Loader2,
  MonitorPlay,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "cn";

const ANIMATION_LABELS: Record<string, string> = {
  karaoke: "Karaoke",
  "word-pop": "Word pop",
  "fade-in": "Fade in",
  static: "Static",
};

const FONT_OPTIONS = [
  "Inter, system-ui, sans-serif",
  "Poppins, Arial, sans-serif",
  "Montserrat, system-ui, sans-serif",
  "Outfit, Arial, sans-serif",
  "Rajdhani, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Arial Black', Impact, sans-serif",
  "Impact, 'Arial Black', sans-serif",
  "'Segoe UI', sans-serif",
] as const;

const ANIMATION_OPTIONS = [
  { value: "karaoke", label: "Karaoke" },
  { value: "word-pop", label: "Word pop" },
  { value: "fade-in", label: "Fade in" },
  { value: "static", label: "Static" },
] as const;

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
          aria-label={`${label} picker`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs uppercase"
        />
      </div>
    </div>
  );
}

async function getErrorFromResponse(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export default function CaptionPresetsPage() {
  const [presets, setPresets] = useState<CaptionPreset[]>([]);
  // Filters the style gallery - with the growing catalogue a flat chip row no
  // longer scales, so the list is searchable and scrolls inside a fixed panel.
  const [presetQuery, setPresetQuery] = useState("");
  const [activePresetId, setActivePresetId] = useState<string>("");
  const [activePreset, setActivePreset] = useState<CaptionPreset>(
    DEFAULT_CAPTION_PRESETS[0],
  );
  const [sampleHookText, setSampleHookText] = useState(
    "THE 1 SECRET YOU WERE NEVER TOLD",
  );
  const [sampleCtaText, setSampleCtaText] = useState(
    "FOLLOW FOR MORE BREAKDOWNS",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isSettingDefault, setIsSettingDefault] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [defaultSuccess, setDefaultSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  // Bumped after a reset so the hook/CTA editors reload from the database instead of
  // continuing to show the values they had loaded on mount.
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [hookStyle, setHookStyle] = useState<OverlayStylePreset>(
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === "hook")!,
  );
  const [ctaStyle, setCtaStyle] = useState<OverlayStylePreset>(
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === "cta")!,
  );

  const initializedRef = useRef(false);

  const filteredPresets = useMemo(() => {
    const needle = presetQuery.trim().toLowerCase();
    if (!needle) return presets;
    return presets.filter((preset) => {
      const themeLabel = getCaptionThemeDefinition(
        preset.captionTheme,
      )?.label.toLowerCase();
      return (
        preset.name.toLowerCase().includes(needle) ||
        Boolean(themeLabel?.includes(needle))
      );
    });
  }, [presets, presetQuery]);

  const loadPresets = useCallback(async (): Promise<CaptionPreset[]> => {
    const res = await fetch("/api/caption-presets");
    if (!res.ok) {
      throw new Error(
        await getErrorFromResponse(res, "Failed to load caption presets."),
      );
    }

    const data = await res.json();
    return data.presets || [];
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const list = await loadPresets();
        if (ignore) return;
        setPresets(list);
        setErrorMessage(null);
        if (!initializedRef.current && list.length > 0) {
          initializedRef.current = true;
          const initial = list.find((preset) => preset.isDefault) ?? list[0];
          setActivePresetId(initial._id);
          setActivePreset(initial);
        }
      } catch (err) {
        if (!ignore) {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : "Failed to load caption presets.",
          );
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [loadPresets]);

  const refreshPresets = useCallback(async () => {
    const list = await loadPresets();
    setPresets(list);
    setErrorMessage(null);
    return list;
  }, [loadPresets]);

  const handleSelectPreset = (id: string) => {
    setActivePresetId(id);
    const found = presets.find((p) => p._id === id);
    if (found) {
      setActivePreset({ ...found });
      setSaveSuccess(false);
      setDefaultSuccess(false);
    }
  };

  const handleCreateNewPreset = () => {
    const theme =
      getCaptionThemeDefinition("kinetic-01") ?? CAPTION_THEME_CATALOG[0];
    const newPreset: CaptionPreset = {
      _id: `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: "Custom preset",
      fontFamily: theme?.captionFontFamily ?? "Inter, sans-serif",
      fontSize: 50,
      captionScale: 70,
      fontWeight: "bold",
      textColor: theme?.captionPrimaryColor ?? "#FFFFFF",
      highlightColor: theme?.captionAccentColor ?? "#FFE600",
      strokeColor: "#000000",
      strokeWidth: 3,
      positionY: 28,
      animationStyle: "karaoke",
      uppercase: true,
      captionTheme: theme?.id,
      matchOverlayTheme: true,
      isDefault: false,
    };

    setActivePresetId(newPreset._id);
    setActivePreset(newPreset);
    setSaveSuccess(false);
    setDefaultSuccess(false);
  };

  const handleSavePreset = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/caption-presets", {
        method: presets.some((preset) => preset._id === activePreset._id)
          ? "PUT"
          : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...activePreset,
          // Explicit null lets PUT clear a previously saved theme (undefined is omitted by JSON).
          captionTheme: activePreset.captionTheme ?? null,
        }),
      });

      if (!res.ok) {
        throw new Error(
          await getErrorFromResponse(res, "Failed to save caption preset."),
        );
      }

      setSaveSuccess(true);
      const list = await refreshPresets();
      const savedPreset =
        list.find((preset) => preset._id === activePreset._id) || activePreset;
      setActivePreset(savedPreset);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error("Error saving preset:", err);
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to save caption preset.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleSetDefault = async () => {
    setIsSettingDefault(true);
    setDefaultSuccess(false);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/caption-presets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: activePreset._id }),
      });
      if (!res.ok) {
        throw new Error(
          await getErrorFromResponse(
            res,
            "Failed to set the default caption preset.",
          ),
        );
      }
      const list = await refreshPresets();
      const selected = list.find((preset) => preset._id === activePreset._id);
      if (selected) setActivePreset(selected);
      setDefaultSuccess(true);
      setTimeout(() => setDefaultSuccess(false), 3000);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to set the default caption preset.",
      );
    } finally {
      setIsSettingDefault(false);
    }
  };

  const handleDeletePreset = async (id: string) => {
    if (activePreset.isDefault) {
      setErrorMessage(
        "Set a different caption preset as the default before deleting this one.",
      );
      return;
    }
    if (!confirm("Are you sure you want to delete this preset?")) return;
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/caption-presets?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(
          await getErrorFromResponse(res, "Failed to delete caption preset."),
        );
      }
      const list = await refreshPresets();
      if (list.length > 0) {
        const next = list.find((preset) => preset.isDefault) ?? list[0];
        setActivePresetId(next._id);
        setActivePreset(next);
      }
    } catch (err) {
      console.error("Error deleting preset:", err);
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to delete caption preset.",
      );
    }
  };

  const patchLineStyle = (index: number, patch: Partial<CaptionLineStyle>) => {
    const lineStyles = activePreset.lineStyles ?? [];
    setActivePreset({
      ...activePreset,
      lineStyles: lineStyles.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line,
      ),
    });
  };

  const addLineStyle = () => {
    const lineStyles = activePreset.lineStyles ?? [];
    if (lineStyles.length >= 6) return;
    setActivePreset({
      ...activePreset,
      lineStyles: [
        ...lineStyles,
        {
          maxWords: 2,
          fontFamily: activePreset.fontFamily,
          fontSize: activePreset.fontSize,
          fontWeight: activePreset.fontWeight,
          textColor: activePreset.textColor,
          highlightColor: activePreset.highlightColor,
          strokeColor: activePreset.strokeColor,
          strokeWidth: activePreset.strokeWidth,
          uppercase: activePreset.uppercase ?? true,
          animationStyle: activePreset.animationStyle,
          lineHeight: 1.12,
        },
      ],
    });
  };

  const removeLineStyle = (index: number) => {
    const lineStyles = activePreset.lineStyles ?? [];
    if (lineStyles.length <= 1) return;
    setActivePreset({
      ...activePreset,
      lineStyles: lineStyles.filter((_, lineIndex) => lineIndex !== index),
    });
  };

  /**
   * Built-in presets are seeded with `INSERT OR IGNORE`, so a row created by an older
   * build keeps its old style forever: editing `lib/presets.ts` never reaches an existing
   * database. This is the deliberate re-sync - built-in rows are rewritten from the shipped
   * values, while custom presets and the preset marked default are left as they are.
   */
  const handleResetBuiltIns = async () => {
    const ok = window.confirm(
      "Reset all caption presets to the shipped code defaults?\n\n" +
        "Every saved caption preset, including custom ones, will be deleted. The shipped default caption will be restored. Hook and CTA presets will also be re-synced.",
    );
    if (!ok) return;

    setIsResetting(true);
    setErrorMessage(null);
    setNotice(null);
    try {
      const responses = await Promise.all([
        fetch("/api/caption-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        }),
        fetch("/api/overlay-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        }),
      ]);
      for (const response of responses) {
        if (!response.ok) {
          throw new Error(
            await getErrorFromResponse(
              response,
              "Failed to restore the built-in presets.",
            ),
          );
        }
      }

      const list = await refreshPresets();
      const restored = list.find((preset) => preset._id === activePreset._id);
      if (restored) setActivePreset(restored);
      setOverlayRevision((value) => value + 1);
      setNotice(
        "All caption presets were replaced with shipped defaults. Hook and CTA styles were re-synced.",
      );
      setTimeout(() => setNotice(null), 8000);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to restore the built-in presets.",
      );
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex animate-fade-up flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Style presets
          </h1>
          <p className="text-sm text-muted-foreground">
            Design caption, hook overlay, and CTA overlay styles with live
            preview — typography, colors, card look, and animation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleResetBuiltIns()}
            disabled={isResetting || isSaving}
            title="Rewrite the built-in preset rows in the database from the shipped preset values"
          >
            {isResetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Reset to shipped styles
          </Button>
          <Button size="lg" onClick={handleCreateNewPreset}>
            <Plus />
            New preset
          </Button>
        </div>
      </div>

      {errorMessage && (
        <Alert variant="destructive" className="animate-fade-up">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert className="animate-fade-up border-primary/40 bg-primary/5">
          <CheckCircle2 className="mt-0.5 text-primary" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {/* <div className="grid grid-cols-1 gap-6 lg:grid-cols-12"> */}
      <div className="flex gap-6 ">
        {/* Editor */}
        <div
          className="animate-fade-up space-y-4 lg:col-span-7 w-full"
          style={{ animationDelay: "60ms" }}
        >
          <Tabs defaultValue="captions">
            <TabsList>
              <TabsTrigger value="captions">Captions</TabsTrigger>
              <TabsTrigger value="hook">Hook overlay</TabsTrigger>
              <TabsTrigger value="cta">CTA overlay</TabsTrigger>
            </TabsList>

            <TabsContent value="captions" className="space-y-4">
              {/* Style gallery: searchable, scrolls inside a fixed-height panel so a
              growing catalogue never pushes the editor (or the preview) away. */}
              <div className="rounded-xl border bg-card/70 p-3 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
                    <Layers className="size-3.5 text-muted-foreground" />
                    Caption styles
                    <Badge variant="secondary" className="tabular">
                      {presets.length}
                    </Badge>
                  </h2>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={presetQuery}
                      onChange={(event) => setPresetQuery(event.target.value)}
                      placeholder="Search styles…"
                      className="h-8 w-48 pl-7.5 text-xs"
                      aria-label="Search caption styles"
                    />
                  </div>
                </div>

                <div className="subtle-scroll mt-2.5 grid max-h-75 grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
                  {filteredPresets.length === 0 ? (
                    <p className="col-span-full rounded-lg border border-dashed px-4 py-6 text-center text-[12px] text-muted-foreground">
                      No style matches “{presetQuery}”.
                    </p>
                  ) : (
                    filteredPresets.map((p) => {
                      const isActive = p._id === activePresetId;
                      const rich = Boolean(p.lineStyles?.length);
                      const theme = getCaptionThemeDefinition(p.captionTheme);
                      return (
                        <button
                          key={p._id}
                          type="button"
                          onClick={() => handleSelectPreset(p._id)}
                          className={cn(
                            "group flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            isActive
                              ? "border-primary/50 bg-primary/10"
                              : "border-border bg-background/50 hover:border-primary/25 hover:bg-muted",
                          )}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className={cn(
                                "truncate text-[12.5px] font-semibold",
                                isActive
                                  ? "text-foreground"
                                  : "text-foreground/85",
                              )}
                            >
                              {p.name}
                            </span>
                            {p.isDefault ? (
                              <Badge
                                variant="secondary"
                                className="shrink-0 text-[9.5px]"
                              >
                                Default
                              </Badge>
                            ) : null}
                          </span>
                          <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                            <span>
                              {theme
                                ? `Theme · ${theme.label}`
                                : (ANIMATION_LABELS[p.animationStyle] ??
                                  p.animationStyle)}
                            </span>
                            <span className="text-muted-foreground/40">·</span>
                            <span>
                              {rich
                                ? `${p.lineStyles!.length} line styles`
                                : "single style"}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <Card className="gap-5">
                <CardHeader>
                  <CardTitle className="text-base">Customize style</CardTitle>
                  <CardDescription>
                    Changes apply to the live preview immediately
                  </CardDescription>
                  <CardAction className="flex items-center gap-2">
                    {activePreset.isDefault ? (
                      <Badge variant="secondary">Default preset</Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSetDefault}
                        disabled={
                          isSettingDefault ||
                          isSaving ||
                          !presets.some(
                            (preset) => preset._id === activePreset._id,
                          )
                        }
                      >
                        {isSettingDefault ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        Set as default
                      </Button>
                    )}
                    {!activePreset.isDefault && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeletePreset(activePreset._id)}
                        title="Delete preset"
                        className="hover:text-destructive"
                        disabled={isSaving || isSettingDefault}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </CardAction>
                </CardHeader>

                <CardContent>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="preset-name">Preset name</Label>
                      <Input
                        id="preset-name"
                        value={activePreset.name}
                        onChange={(e) =>
                          setActivePreset({
                            ...activePreset,
                            name: e.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="sample-hook">
                        Sample hook text (preview)
                      </Label>
                      <Input
                        id="sample-hook"
                        value={sampleHookText}
                        onChange={(e) => setSampleHookText(e.target.value)}
                      />
                    </div>

                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="sample-cta">
                        Sample CTA text (preview)
                      </Label>
                      <Input
                        id="sample-cta"
                        value={sampleCtaText}
                        onChange={(e) => setSampleCtaText(e.target.value)}
                      />
                    </div>

                    <div className="space-y-4 rounded-lg border p-4 sm:col-span-2">
                      <div className="space-y-2">
                        <Label id="caption-theme-label">Caption theme</Label>
                        <Select
                          value={
                            activePreset.captionTheme ??
                            CAPTION_THEME_CATALOG[0]?.id ??
                            "kinetic-01"
                          }
                          onValueChange={(value) => {
                            const theme = getCaptionThemeDefinition(
                              value as CaptionThemeName,
                            );
                            if (!theme) return;
                            setActivePreset({
                              ...activePreset,
                              captionTheme: theme.id,
                              matchOverlayTheme: true,
                              textColor: theme.captionPrimaryColor,
                              highlightColor: theme.captionAccentColor,
                            });
                          }}
                        >
                          <SelectTrigger aria-labelledby="caption-theme-label">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CAPTION_THEME_CATALOG.map((theme) => (
                              <SelectItem key={theme.id} value={theme.id}>
                                {theme.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {
                            getCaptionThemeDefinition(activePreset.captionTheme)
                              ?.description
                          }{" "}
                          Theme font:{" "}
                          {
                            getCaptionThemeDefinition(
                              activePreset.captionTheme,
                            )?.captionFontFamily.split(",")[0]
                          }
                          . Size, placement and caption colors remain
                          adjustable.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          The {CAPTION_THEME_CATALOG.length} theme animations are rendered by Remotion in
                          headless Chrome.
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 p-3">
                        <div className="space-y-0.5">
                          <Label htmlFor="match-overlay-theme">
                            Match Hook + CTA to theme
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            Applies the theme font, palette, card shape and
                            motion; saved overlay sizes, badge text and
                            placement remain.
                          </p>
                        </div>
                        <Switch
                          id="match-overlay-theme"
                          checked={activePreset.matchOverlayTheme !== false}
                          onCheckedChange={(matchOverlayTheme) =>
                            setActivePreset({
                              ...activePreset,
                              matchOverlayTheme,
                            })
                          }
                        />
                      </div>

                      {activePreset.lineStyles?.length ? (
                        <div className="space-y-4 border-t pt-4">
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label id="line-alignment-label">
                                Line alignment
                              </Label>
                              <Select
                                value={activePreset.lineAlignment ?? "center"}
                                onValueChange={(value) =>
                                  setActivePreset({
                                    ...activePreset,
                                    lineAlignment:
                                      value === "left" || value === "right"
                                        ? value
                                        : "center",
                                  })
                                }
                              >
                                <SelectTrigger aria-labelledby="line-alignment-label">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="left">Left</SelectItem>
                                  <SelectItem value="center">Center</SelectItem>
                                  <SelectItem value="right">Right</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="line-gap-input">
                                Line gap (px)
                              </Label>
                              <Input
                                id="line-gap-input"
                                type="number"
                                min={0}
                                max={80}
                                value={activePreset.lineGap ?? 5}
                                onChange={(event) =>
                                  setActivePreset({
                                    ...activePreset,
                                    lineGap: Math.max(
                                      0,
                                      Math.min(
                                        80,
                                        Number(event.target.value) || 0,
                                      ),
                                    ),
                                  })
                                }
                              />
                            </div>
                          </div>

                          {activePreset.lineStyles.map((line, index) => (
                            <div
                              key={`rich-line-${index}`}
                              className="space-y-4 rounded-md bg-muted/40 p-4"
                            >
                              <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold">
                                  Visual line {index + 1}
                                </h3>
                                {activePreset.lineStyles!.length > 1 && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeLineStyle(index)}
                                  >
                                    Remove line
                                  </Button>
                                )}
                              </div>
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                  <Label id={`line-font-label-${index}`}>
                                    Font family
                                  </Label>
                                  <Select
                                    value={
                                      line.fontFamily ?? activePreset.fontFamily
                                    }
                                    onValueChange={(value) =>
                                      patchLineStyle(index, {
                                        fontFamily: value ?? activePreset.fontFamily,
                                      })
                                    }
                                  >
                                    <SelectTrigger aria-labelledby={`line-font-label-${index}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {FONT_OPTIONS.map((font) => (
                                        <SelectItem key={`${font}-${index}`} value={font}>
                                          {font.split(",")[0].replace(/['"]/g, "")}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`line-max-words-${index}`}>
                                    Maximum words on this line
                                  </Label>
                                  <Input
                                    id={`line-max-words-${index}`}
                                    type="number"
                                    min={1}
                                    max={8}
                                    value={line.maxWords ?? 4}
                                    onChange={(event) =>
                                      patchLineStyle(index, {
                                        maxWords: Math.max(
                                          1,
                                          Math.min(
                                            8,
                                            Math.round(
                                              Number(event.target.value) || 1,
                                            ),
                                          ),
                                        ),
                                      })
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label id={`line-weight-label-${index}`}>
                                    Line font weight
                                  </Label>
                                  <Select
                                    value={
                                      line.fontWeight ?? activePreset.fontWeight
                                    }
                                    onValueChange={(value) =>
                                      patchLineStyle(index, {
                                        fontWeight:
                                          (value as CaptionPreset["fontWeight"]) ||
                                          activePreset.fontWeight,
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      aria-labelledby={`line-weight-label-${index}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="normal">
                                        Normal
                                      </SelectItem>
                                      <SelectItem value="bold">Bold</SelectItem>
                                      <SelectItem value="extra-bold">
                                        Extra bold
                                      </SelectItem>
                                      <SelectItem value="black">
                                        Black
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label id={`line-animation-label-${index}`}>
                                    Line animation
                                  </Label>
                                  <Select
                                    value={
                                      line.animationStyle ??
                                      activePreset.animationStyle
                                    }
                                    onValueChange={(value) =>
                                      patchLineStyle(index, {
                                        animationStyle:
                                          (value as CaptionPreset["animationStyle"]) ||
                                          activePreset.animationStyle,
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      aria-labelledby={`line-animation-label-${index}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="karaoke">
                                        Karaoke
                                      </SelectItem>
                                      <SelectItem value="word-pop">
                                        Word pop
                                      </SelectItem>
                                      <SelectItem value="fade-in">
                                        Fade in
                                      </SelectItem>
                                      <SelectItem value="static">
                                        Static
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-3 sm:col-span-2">
                                  <div className="flex items-center justify-between">
                                    <Label htmlFor={`line-font-size-${index}`}>
                                      Line font size
                                    </Label>
                                    <span className="text-xs text-muted-foreground">
                                      {line.fontSize ?? activePreset.fontSize}px
                                    </span>
                                  </div>
                                  <Slider
                                    id={`line-font-size-${index}`}
                                    min={12}
                                    max={120}
                                    value={
                                      line.fontSize ?? activePreset.fontSize
                                    }
                                    onValueChange={(fontSize) =>
                                      patchLineStyle(index, { fontSize })
                                    }
                                    aria-label={`Line ${index + 1} font size`}
                                  />
                                </div>
                                <ColorField
                                  label="Line text color"
                                  value={
                                    line.textColor ?? activePreset.textColor
                                  }
                                  onChange={(textColor) =>
                                    patchLineStyle(index, { textColor })
                                  }
                                />
                                <ColorField
                                  label="Line active-word highlight"
                                  value={
                                    line.highlightColor ??
                                    activePreset.highlightColor
                                  }
                                  onChange={(highlightColor) =>
                                    patchLineStyle(index, { highlightColor })
                                  }
                                />
                                <ColorField
                                  label="Line stroke color"
                                  value={
                                    line.strokeColor ?? activePreset.strokeColor
                                  }
                                  onChange={(strokeColor) =>
                                    patchLineStyle(index, { strokeColor })
                                  }
                                />
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <Label>Line stroke width</Label>
                                    <span className="text-xs text-muted-foreground">
                                      {line.strokeWidth ??
                                        activePreset.strokeWidth}
                                      px
                                    </span>
                                  </div>
                                  <Slider
                                    min={0}
                                    max={20}
                                    value={
                                      line.strokeWidth ??
                                      activePreset.strokeWidth
                                    }
                                    onValueChange={(strokeWidth) =>
                                      patchLineStyle(index, { strokeWidth })
                                    }
                                    aria-label={`Line ${index + 1} stroke width`}
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`line-spacing-${index}`}>
                                    Letter spacing (px)
                                  </Label>
                                  <Input
                                    id={`line-spacing-${index}`}
                                    type="number"
                                    min={-5}
                                    max={30}
                                    step={0.1}
                                    value={line.letterSpacing ?? 0}
                                    onChange={(event) =>
                                      patchLineStyle(index, {
                                        letterSpacing: Math.max(
                                          -5,
                                          Math.min(
                                            30,
                                            Number(event.target.value) || 0,
                                          ),
                                        ),
                                      })
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`line-height-${index}`}>
                                    Line height multiplier
                                  </Label>
                                  <Input
                                    id={`line-height-${index}`}
                                    type="number"
                                    min={0.75}
                                    max={2.5}
                                    step={0.05}
                                    value={line.lineHeight ?? 1.12}
                                    onChange={(event) =>
                                      patchLineStyle(index, {
                                        lineHeight: Math.max(
                                          0.75,
                                          Math.min(
                                            2.5,
                                            Number(event.target.value) || 1.12,
                                          ),
                                        ),
                                      })
                                    }
                                  />
                                </div>
                                <div className="flex items-center justify-between rounded-md border p-3">
                                  <Label htmlFor={`line-uppercase-${index}`}>
                                    Uppercase
                                  </Label>
                                  <Switch
                                    id={`line-uppercase-${index}`}
                                    checked={
                                      line.uppercase ??
                                      activePreset.uppercase ??
                                      true
                                    }
                                    onCheckedChange={(uppercase) =>
                                      patchLineStyle(index, { uppercase })
                                    }
                                  />
                                </div>
                                <div className="flex items-center justify-between rounded-md border p-3">
                                  <Label htmlFor={`line-italic-${index}`}>
                                    Italic
                                  </Label>
                                  <Switch
                                    id={`line-italic-${index}`}
                                    checked={line.italic ?? false}
                                    onCheckedChange={(italic) =>
                                      patchLineStyle(index, { italic })
                                    }
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addLineStyle}
                            disabled={activePreset.lineStyles.length >= 6}
                          >
                            <Plus />
                            Add line style
                          </Button>
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label id="font-family-label">Font family</Label>
                      <Select
                        value={activePreset.fontFamily || "Inter, system-ui, sans-serif"}
                        onValueChange={(value) =>
                          setActivePreset({
                            ...activePreset,
                            fontFamily: value ?? activePreset.fontFamily,
                          })
                        }
                      >
                        <SelectTrigger aria-labelledby="font-family-label">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FONT_OPTIONS.map((font) => (
                            <SelectItem key={font} value={font}>
                              {font.split(",")[0].replace(/['"]/g, "")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label id="weight-label">Font weight</Label>
                      <Select
                        value={activePreset.fontWeight}
                        onValueChange={(v) =>
                          setActivePreset({
                            ...activePreset,
                            fontWeight:
                              (v as CaptionPreset["fontWeight"]) || "bold",
                          })
                        }
                      >
                        <SelectTrigger aria-labelledby="weight-label">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="normal">Normal</SelectItem>
                          <SelectItem value="bold">Bold</SelectItem>
                          <SelectItem value="extra-bold">Extra bold</SelectItem>
                          <SelectItem value="black">Black</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label id="animation-label">Animation</Label>
                      <Select
                        value={activePreset.animationStyle}
                        onValueChange={(value) =>
                          setActivePreset({
                            ...activePreset,
                            animationStyle:
                              (value as CaptionPreset["animationStyle"]) ||
                              "karaoke",
                          })
                        }
                      >
                        <SelectTrigger aria-labelledby="animation-label">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ANIMATION_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Font size</Label>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {activePreset.fontSize}px
                        </span>
                      </div>
                      <Slider
                        min={24}
                        max={72}
                        value={activePreset.fontSize}
                        onValueChange={(v) =>
                          setActivePreset({ ...activePreset, fontSize: v })
                        }
                        aria-label="Font size"
                      />
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Caption scale</Label>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {activePreset.captionScale ?? 70}%
                        </span>
                      </div>
                      <Slider
                        min={40}
                        max={100}
                        step={5}
                        value={activePreset.captionScale ?? 70}
                        onValueChange={(v) =>
                          setActivePreset({
                            ...activePreset,
                            captionScale: v,
                          })
                        }
                        aria-label="Caption scale"
                      />
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Vertical position</Label>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {activePreset.positionY}% from bottom
                        </span>
                      </div>
                      <Slider
                        min={10}
                        max={50}
                        value={activePreset.positionY}
                        onValueChange={(v) =>
                          setActivePreset({ ...activePreset, positionY: v })
                        }
                        aria-label="Vertical position"
                      />
                    </div>

                    <ColorField
                      label="Text color"
                      value={activePreset.textColor}
                      onChange={(v) =>
                        setActivePreset({ ...activePreset, textColor: v })
                      }
                    />

                    <ColorField
                      label="Active word highlight"
                      value={activePreset.highlightColor}
                      onChange={(v) =>
                        setActivePreset({ ...activePreset, highlightColor: v })
                      }
                    />

                    <ColorField
                      label="Stroke color"
                      value={activePreset.strokeColor}
                      onChange={(v) =>
                        setActivePreset({ ...activePreset, strokeColor: v })
                      }
                    />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Stroke width</Label>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {activePreset.strokeWidth}px
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={8}
                        value={activePreset.strokeWidth}
                        onValueChange={(v) =>
                          setActivePreset({ ...activePreset, strokeWidth: v })
                        }
                        aria-label="Stroke width"
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
                      <div className="space-y-0.5">
                        <Label htmlFor="uppercase-toggle">
                          Uppercase captions
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Render all caption text in capital letters
                        </p>
                      </div>
                      <Switch
                        id="uppercase-toggle"
                        checked={activePreset.uppercase ?? true}
                        onCheckedChange={(checked) =>
                          setActivePreset({
                            ...activePreset,
                            uppercase: checked,
                          })
                        }
                      />
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="justify-between border-t pt-5">
                  {defaultSuccess ? (
                    <span className="flex animate-fade-in items-center gap-1.5 text-xs font-medium text-primary">
                      <CheckCircle2 />
                      Default updated
                    </span>
                  ) : saveSuccess ? (
                    <span className="flex animate-fade-in items-center gap-1.5 text-xs font-medium text-primary">
                      <CheckCircle2 />
                      Preset saved
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Save to use this style on your clips
                    </span>
                  )}
                  <Button
                    onClick={handleSavePreset}
                    disabled={isSaving || isSettingDefault}
                  >
                    {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
                    Save preset
                  </Button>
                </CardFooter>
              </Card>
            </TabsContent>

            <TabsContent value="hook">
              <OverlayStyleEditor
                key={`hook-${overlayRevision}`}
                kind="hook"
                value={hookStyle}
                onChange={setHookStyle}
              />
            </TabsContent>

            <TabsContent value="cta">
              <OverlayStyleEditor
                key={`cta-${overlayRevision}`}
                kind="cta"
                value={ctaStyle}
                onChange={setCtaStyle}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* Live preview - pinned to the viewport on large screens: the panel is
            sticky and its player is sized from the viewport HEIGHT, so scrolling
            through a long style list never moves (or outgrows) the preview. */}
        <div
          className="animate-fade-up w-full min-w-0 lg:w-[420px] lg:shrink-0 lg:col-span-5"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex flex-col gap-3 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start">
            <div className="rounded-xl border bg-card/70 p-3 shadow-card">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
                <MonitorPlay className="size-3.5 text-muted-foreground" />
                Live preview
                <span className="ml-auto text-[10.5px] font-normal text-muted-foreground">
                  9:16 · 1080×1920
                </span>
              </h2>

              <CaptionPreview
                preset={activePreset}
                hookText={sampleHookText}
                ctaText={sampleCtaText}
                hookStyle={hookStyle}
                ctaStyle={ctaStyle}
                className="mt-3 h-[min(56dvh,540px)]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
