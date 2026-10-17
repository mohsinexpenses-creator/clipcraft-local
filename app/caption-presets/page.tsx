"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  CaptionPreset,
  OverlayStylePreset,
} from "@/lib/types";
import {
  CAPTION_THEME_CATALOG,
  getCaptionThemeDefinition,
  isCaptionThemeName,
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
  const [sampleCtaText] = useState(
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
    const newPreset: CaptionPreset = {
      _id: `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: "Custom preset",
      captionTheme: "kinetic-01",
      matchOverlayTheme: true,
      fontFamily: "Inter, sans-serif",
      fontSize: 50,
      fontWeight: "bold",
      textColor: "#FFFFFF",
      highlightColor: "#FFE600",
      strokeColor: "#000000",
      strokeWidth: 3,
      positionY: 28,
      animationStyle: "karaoke",
      uppercase: true,
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
          captionTheme: activePreset.captionTheme ?? "kinetic-01",
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

  /**
   * Built-in presets are seeded with `INSERT OR IGNORE`, so a row created by an older
   * build keeps its old style forever: editing `lib/presets.ts` never reaches an existing
   * database. This is the deliberate re-sync - built-in rows are rewritten from the shipped
   * values, while custom presets and the preset marked default are left as they are.
   */
  const handleResetBuiltIns = async () => {
    const ok = window.confirm(
      "Restore the built-in caption, hook and CTA styles from the shipped presets?\n\n" +
        "Anything you created yourself stays, and so does the preset marked as default.",
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
        "Built-in caption and overlay styles re-synced with the shipped presets.",
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
          className="animate-fade-up space-y-4 lg:col-span-7"
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
              <div className="rounded-xl border bg-card/70 p-3 shadow-[var(--shadow-card)]">
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

                <div className="subtle-scroll mt-2.5 grid max-h-[300px] grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
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
                                : "Kinetic 01"}
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

                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2"><Label>Preset name</Label><Input value={activePreset.name} onChange={(e) => setActivePreset({ ...activePreset, name: e.target.value })} /></div>
                  <div className="space-y-2"><Label>Caption theme</Label>
                    <Select value={activePreset.captionTheme ?? "kinetic-01"} onValueChange={(value) => { const theme = getCaptionThemeDefinition(isCaptionThemeName(value) ? value : "kinetic-01"); if (theme) setActivePreset({ ...activePreset, captionTheme: theme.id }); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CAPTION_THEME_CATALOG.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label>Sample hook text (preview)</Label><Input value={sampleHookText} onChange={(e) => setSampleHookText(e.target.value)} /></div>
                  <ColorField label="Primary color" value={activePreset.textColor} onChange={(textColor) => setActivePreset({ ...activePreset, textColor })} />
                  <ColorField label="Accent color" value={activePreset.highlightColor} onChange={(highlightColor) => setActivePreset({ ...activePreset, highlightColor })} />
                  <div className="space-y-2"><Label>Font size: {activePreset.fontSize}px</Label><Slider value={activePreset.fontSize} min={12} max={160} onValueChange={(fontSize) => setActivePreset({ ...activePreset, fontSize })} /></div>
                  <div className="space-y-2"><Label>Position: {activePreset.positionY}% from bottom</Label><Slider value={activePreset.positionY} min={0} max={100} onValueChange={(positionY) => setActivePreset({ ...activePreset, positionY })} /></div>
                  <div className="space-y-2"><Label>Words per caption: {activePreset.lineStyles?.[0]?.maxWords ?? 4}</Label><Slider value={activePreset.lineStyles?.[0]?.maxWords ?? 4} min={1} max={8} onValueChange={(maxWords) => setActivePreset({ ...activePreset, lineStyles: [{ maxWords }] })} /></div>
                  <div className="flex items-center justify-between"><Label>Match Hook + CTA to theme</Label><Switch checked={activePreset.matchOverlayTheme ?? true} onCheckedChange={(matchOverlayTheme) => setActivePreset({ ...activePreset, matchOverlayTheme })} /></div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">Theme components own typography and motion. Colors/font size apply where supported by the selected theme; position and caption grouping apply to all themes.</p>
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
          className="animate-fade-up min-w-fit lg:col-span-5"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex flex-col gap-3 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)]">
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
