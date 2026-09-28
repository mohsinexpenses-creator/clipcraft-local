'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CaptionPreset, OverlayStylePreset } from '@/lib/types';
import { CaptionPreview } from '@/components/caption-preview';
import { OverlayStyleEditor } from '@/components/overlay-style-editor';
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from '@/lib/presets';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MonitorPlay,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { cn } from 'cn';

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
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'}
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
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [activePreset, setActivePreset] = useState<CaptionPreset>(DEFAULT_CAPTION_PRESETS[0]);
  const [sampleHookText, setSampleHookText] = useState('THE 1 SECRET YOU WERE NEVER TOLD');
  const [sampleCtaText, setSampleCtaText] = useState('FOLLOW FOR MORE BREAKDOWNS');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hookStyle, setHookStyle] = useState<OverlayStylePreset>(
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'hook')!
  );
  const [ctaStyle, setCtaStyle] = useState<OverlayStylePreset>(
    DEFAULT_OVERLAY_STYLE_PRESETS.find((p) => p.kind === 'cta')!
  );

  const initializedRef = useRef(false);

  const loadPresets = useCallback(async (): Promise<CaptionPreset[]> => {
    const res = await fetch('/api/caption-presets');
    if (!res.ok) {
      throw new Error(await getErrorFromResponse(res, 'Failed to load caption presets.'));
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
          setActivePresetId(list[0]._id);
          setActivePreset(list[0]);
        }
      } catch (err) {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load caption presets.');
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
    }
  };

  const handleCreateNewPreset = () => {
    const newPreset: CaptionPreset = {
      _id: `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: 'Custom preset',
      fontFamily: 'Inter, sans-serif',
      fontSize: 50,
      fontWeight: 'bold',
      textColor: '#FFFFFF',
      highlightColor: '#FFE600',
      strokeColor: '#000000',
      strokeWidth: 3,
      positionY: 28,
      animationStyle: 'karaoke',
      uppercase: true,
      isDefault: false,
    };

    setPresets([newPreset, ...presets]);
    setActivePresetId(newPreset._id);
    setActivePreset(newPreset);
    setSaveSuccess(false);
  };

  const handleSavePreset = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/caption-presets', {
        method: activePreset._id.startsWith('preset-') ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activePreset),
      });

      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to save caption preset.'));
      }

      setSaveSuccess(true);
      const list = await refreshPresets();
      const savedPreset = list.find((preset) => preset._id === activePreset._id) || activePreset;
      setActivePreset(savedPreset);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Error saving preset:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save caption preset.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePreset = async (id: string) => {
    if (!confirm('Are you sure you want to delete this preset?')) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/caption-presets?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to delete caption preset.'));
      }
      const list = await refreshPresets();
      if (list.length > 0) {
        setActivePresetId(list[0]._id);
        setActivePreset(list[0]);
      }
    } catch (err) {
      console.error('Error deleting preset:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to delete caption preset.');
    }
  };

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex animate-fade-up flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Style presets</h1>
          <p className="text-sm text-muted-foreground">
            Design caption, hook overlay, and CTA overlay styles with live preview —
            typography, colors, card look, and animation.
          </p>
        </div>
        <Button size="lg" onClick={handleCreateNewPreset}>
          <Plus />
          New preset
        </Button>
      </div>

      {errorMessage && (
        <Alert variant="destructive" className="animate-fade-up">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Editor */}
        <div className="animate-fade-up space-y-4 lg:col-span-7" style={{ animationDelay: '60ms' }}>
          <Tabs defaultValue="captions">
            <TabsList>
              <TabsTrigger value="captions">Captions</TabsTrigger>
              <TabsTrigger value="hook">Hook overlay</TabsTrigger>
              <TabsTrigger value="cta">CTA overlay</TabsTrigger>
            </TabsList>

            <TabsContent value="captions" className="space-y-4">
          {/* Preset selector */}
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => {
              const isActive = p._id === activePresetId;
              return (
                <button
                  key={p._id}
                  onClick={() => handleSelectPreset(p._id)}
                  className={cn(
                    'cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    isActive
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {p.name}
                </button>
              );
            })}
          </div>

          <Card className="gap-5">
            <CardHeader>
              <CardTitle className="text-base">Customize style</CardTitle>
              <CardDescription>
                Changes apply to the live preview immediately
              </CardDescription>
              {!activePreset.isDefault && (
                <CardAction>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeletePreset(activePreset._id)}
                    title="Delete preset"
                    className="hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </CardAction>
              )}
            </CardHeader>

            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="preset-name">Preset name</Label>
                  <Input
                    id="preset-name"
                    value={activePreset.name}
                    onChange={(e) => setActivePreset({ ...activePreset, name: e.target.value })}
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="sample-hook">Sample hook text (preview)</Label>
                  <Input
                    id="sample-hook"
                    value={sampleHookText}
                    onChange={(e) => setSampleHookText(e.target.value)}
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="sample-cta">Sample CTA text (preview)</Label>
                  <Input
                    id="sample-cta"
                    value={sampleCtaText}
                    onChange={(e) => setSampleCtaText(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label id="animation-label">Animation style</Label>
                  <Select
                    value={activePreset.animationStyle}
                    onValueChange={(v) =>
                      setActivePreset({
                        ...activePreset,
                        animationStyle: (v as CaptionPreset['animationStyle']) || 'karaoke',
                      })
                    }
                  >
                    <SelectTrigger aria-labelledby="animation-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="karaoke">Karaoke fill</SelectItem>
                      <SelectItem value="word-pop">Word pop</SelectItem>
                      <SelectItem value="fade-in">Fade in</SelectItem>
                      <SelectItem value="static">Static</SelectItem>
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
                        fontWeight: (v as CaptionPreset['fontWeight']) || 'bold',
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
                    onValueChange={(v) => setActivePreset({ ...activePreset, fontSize: v })}
                    aria-label="Font size"
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
                    onValueChange={(v) => setActivePreset({ ...activePreset, positionY: v })}
                    aria-label="Vertical position"
                  />
                </div>

                <ColorField
                  label="Text color"
                  value={activePreset.textColor}
                  onChange={(v) => setActivePreset({ ...activePreset, textColor: v })}
                />

                <ColorField
                  label="Active word highlight"
                  value={activePreset.highlightColor}
                  onChange={(v) => setActivePreset({ ...activePreset, highlightColor: v })}
                />

                <ColorField
                  label="Stroke color"
                  value={activePreset.strokeColor}
                  onChange={(v) => setActivePreset({ ...activePreset, strokeColor: v })}
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
                    onValueChange={(v) => setActivePreset({ ...activePreset, strokeWidth: v })}
                    aria-label="Stroke width"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
                  <div className="space-y-0.5">
                    <Label htmlFor="uppercase-toggle">Uppercase captions</Label>
                    <p className="text-xs text-muted-foreground">
                      Render all caption text in capital letters
                    </p>
                  </div>
                  <Switch
                    id="uppercase-toggle"
                    checked={activePreset.uppercase ?? true}
                    onCheckedChange={(checked) =>
                      setActivePreset({ ...activePreset, uppercase: checked })
                    }
                  />
                </div>
              </div>
            </CardContent>

            <CardFooter className="justify-between border-t pt-5">
              {saveSuccess ? (
                <span className="flex animate-fade-in items-center gap-1.5 text-xs font-medium text-primary">
                  <CheckCircle2 />
                  Preset saved
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Save to use this style on your clips
                </span>
              )}
              <Button onClick={handleSavePreset} disabled={isSaving}>
                {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
                Save preset
              </Button>
            </CardFooter>
          </Card>
            </TabsContent>

            <TabsContent value="hook">
              <OverlayStyleEditor kind="hook" value={hookStyle} onChange={setHookStyle} />
            </TabsContent>

            <TabsContent value="cta">
              <OverlayStyleEditor kind="cta" value={ctaStyle} onChange={setCtaStyle} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Live preview */}
        <div className="animate-fade-up lg:col-span-5" style={{ animationDelay: '120ms' }}>
          <div className="sticky top-20 space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <MonitorPlay className="size-4 text-muted-foreground" />
              Live preview
            </h2>

            <CaptionPreview
              preset={activePreset}
              hookText={sampleHookText}
              ctaText={sampleCtaText}
              hookStyle={hookStyle}
              ctaStyle={ctaStyle}
            />

            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              Interactive Remotion Player showing the 9:16 layout, hook overlay, and
              word-synced captions. Switch tabs to style the hook and CTA overlays.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
