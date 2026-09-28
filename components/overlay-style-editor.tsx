'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { OverlayStylePreset } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CheckCircle2, Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react';

interface OverlayStyleEditorProps {
  kind: 'hook' | 'cta';
  value: OverlayStylePreset;
  onChange: (preset: OverlayStylePreset) => void;
}

/**
 * Editor for hook / CTA overlay STYLE presets: font, colors, card, position and
 * animation of the overlay text. (The TEXT itself is still edited per clip;
 * presets only control how it looks.)
 */
export const OverlayStyleEditor: React.FC<OverlayStyleEditorProps> = ({ kind, value, onChange }) => {
  const [presets, setPresets] = useState<OverlayStylePreset[]>([]);
  const [activeId, setActiveId] = useState<string>(value._id);
  const [draft, setDraft] = useState<OverlayStylePreset>(value);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPresets = useCallback(async (): Promise<OverlayStylePreset[]> => {
    const res = await fetch(`/api/overlay-presets?kind=${kind}`);
    if (!res.ok) throw new Error('Failed to load overlay style presets.');
    const data = await res.json();
    return data.presets || [];
  }, [kind]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const list = await loadPresets();
        if (ignore) return;
        setPresets(list);
        const initial = list.find((p) => p._id === activeId) ?? list[0];
        if (initial) {
          setActiveId(initial._id);
          setDraft(initial);
          onChange(initial);
        }
      } catch (err) {
        if (!ignore) setError(err instanceof Error ? err.message : 'Failed to load presets.');
      }
    })();
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const patch = (partial: Partial<OverlayStylePreset>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    onChange(next);
  };

  const handleSelect = (id: string) => {
    const preset = presets.find((p) => p._id === id);
    if (!preset) return;
    setActiveId(id);
    setDraft(preset);
    setSaveSuccess(false);
    onChange(preset);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/overlay-presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save overlay style preset.');
      }
      setPresets(await loadPresets());
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save overlay style preset.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleNew = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/overlay-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          _id: '',
          name: kind === 'hook' ? 'New Hook Style' : 'New CTA Style',
          isDefault: false,
        }),
      });
      if (!res.ok) throw new Error('Failed to create overlay style preset.');
      const data = await res.json();
      setPresets(await loadPresets());
      if (data.preset) {
        setActiveId(data.preset._id);
        setDraft(data.preset);
        onChange(data.preset);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create overlay style preset.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (draft.isDefault) {
      setError('Default style presets cannot be deleted.');
      return;
    }
    if (!confirm(`Delete the style preset "${draft.name}"?`)) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/overlay-presets?id=${encodeURIComponent(draft._id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete overlay style preset.');
      }
      const list = await loadPresets();
      setPresets(list);
      const next = list[0];
      if (next) {
        setActiveId(next._id);
        setDraft(next);
        onChange(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete overlay style preset.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const isActive = preset._id === activeId;
          return (
            <button
              key={preset._id}
              onClick={() => handleSelect(preset._id)}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                isActive
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Sparkles className="size-3.5" />
              {preset.name}
              {preset.isDefault && <Badge variant="secondary" className="ml-1 text-[10px]">default</Badge>}
            </button>
          );
        })}
        <Button variant="outline" size="sm" onClick={handleNew} disabled={isSaving}>
          <Plus />
          New style
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Card className="gap-5">
        <CardHeader>
          <CardTitle className="text-base">{draft.name}</CardTitle>
          <CardDescription>
            {kind === 'hook'
              ? 'How the hook intro overlay looks during the first seconds of the clip.'
              : 'How the end-of-clip call-to-action card looks.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`style-name-${kind}`}>Style name</Label>
              <Input
                id={`style-name-${kind}`}
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`style-font-${kind}`}>Font family</Label>
              <Input
                id={`style-font-${kind}`}
                value={draft.fontFamily}
                onChange={(e) => patch({ fontFamily: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label id={`style-weight-label-${kind}`}>Font weight</Label>
              <Select
                value={draft.fontWeight}
                onValueChange={(v) =>
                  patch({ fontWeight: (v as OverlayStylePreset['fontWeight']) || 'black' })
                }
              >
                <SelectTrigger aria-labelledby={`style-weight-label-${kind}`}>
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
                <Label htmlFor={`style-size-${kind}`}>Font size</Label>
                <span className="text-xs text-muted-foreground">{draft.fontSize}px</span>
              </div>
              <Slider
                id={`style-size-${kind}`}
                min={20}
                max={64}
                step={1}
                value={draft.fontSize}
                onValueChange={(v) => patch({ fontSize: v })}
                aria-label="Font size"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`style-position-${kind}`}>Position (from top)</Label>
                <span className="text-xs text-muted-foreground">{draft.positionY}%</span>
              </div>
              <Slider
                id={`style-position-${kind}`}
                min={4}
                max={80}
                step={1}
                value={draft.positionY}
                onValueChange={(v) => patch({ positionY: v })}
                aria-label="Position from top"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`style-text-color-${kind}`}>Text color</Label>
              <Input
                id={`style-text-color-${kind}`}
                type="color"
                value={draft.textColor.startsWith('#') ? draft.textColor : '#FFFFFF'}
                onChange={(e) => patch({ textColor: e.target.value })}
                className="h-9 p-1"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`style-border-color-${kind}`}>Border color</Label>
              <Input
                id={`style-border-color-${kind}`}
                type="color"
                value={draft.borderColor.startsWith('#') ? draft.borderColor : '#FFE600'}
                onChange={(e) => patch({ borderColor: e.target.value })}
                className="h-9 p-1"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`style-bg-${kind}`}>Card background (CSS color or gradient)</Label>
              <Input
                id={`style-bg-${kind}`}
                value={draft.backgroundColor}
                onChange={(e) => patch({ backgroundColor: e.target.value })}
                placeholder="rgba(15, 23, 42, 0.92)"
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`style-border-width-${kind}`}>Border width (px)</Label>
              <Input
                id={`style-border-width-${kind}`}
                type="number"
                min={0}
                max={8}
                value={draft.borderWidth}
                onChange={(e) => patch({ borderWidth: Math.max(0, Math.min(8, Number(e.target.value) || 0)) })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`style-radius-${kind}`}>Corner radius (px)</Label>
              <Input
                id={`style-radius-${kind}`}
                type="number"
                min={0}
                max={999}
                value={draft.borderRadius}
                onChange={(e) => patch({ borderRadius: Math.max(0, Math.min(999, Number(e.target.value) || 0)) })}
              />
            </div>

            <div className="space-y-2">
              <Label id={`style-anim-label-${kind}`}>Animation</Label>
              <Select
                value={draft.animationStyle}
                onValueChange={(v) =>
                  patch({ animationStyle: (v as OverlayStylePreset['animationStyle']) || 'pop' })
                }
              >
                <SelectTrigger aria-labelledby={`style-anim-label-${kind}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pop">Pop</SelectItem>
                  <SelectItem value="fade">Fade</SelectItem>
                  <SelectItem value="slide-up">Slide up</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor={`style-uppercase-${kind}`}>Uppercase text</Label>
                <p className="text-xs text-muted-foreground">Render the overlay in capital letters</p>
              </div>
              <Switch
                id={`style-uppercase-${kind}`}
                checked={draft.textTransform !== 'none'}
                onCheckedChange={(checked) =>
                  patch({ textTransform: checked ? 'uppercase' : 'none' })
                }
              />
            </div>

            {kind === 'hook' && (
              <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
                <div className="space-y-0.5">
                  <Label htmlFor={`style-badge-${kind}`}>Show badge chip</Label>
                  <p className="text-xs text-muted-foreground">
                    Small chip above the hook text (e.g. &quot;Hook Intro&quot;)
                  </p>
                </div>
                <Switch
                  id={`style-badge-${kind}`}
                  checked={draft.showBadge ?? true}
                  onCheckedChange={(checked) => patch({ showBadge: checked })}
                />
              </div>
            )}

            {kind === 'hook' && (draft.showBadge ?? true) && (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`style-badge-text-${kind}`}>Badge text</Label>
                <Input
                  id={`style-badge-text-${kind}`}
                  value={draft.badgeText || 'Hook Intro'}
                  onChange={(e) => patch({ badgeText: e.target.value })}
                />
              </div>
            )}
          </div>
        </CardContent>

        <CardFooter className="justify-between border-t pt-5">
          {saveSuccess ? (
            <span className="flex animate-fade-in items-center gap-1.5 text-xs font-medium text-primary">
              <CheckCircle2 />
              Style saved
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDelete}
              title="Delete style preset"
              className="hover:text-destructive"
              disabled={isSaving || draft.isDefault}
            >
              <Trash2 />
            </Button>
          )}

          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            Save style
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};
