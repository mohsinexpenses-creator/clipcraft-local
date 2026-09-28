'use client';

import React from 'react';
import { ViralDetectionOptions } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SlidersHorizontal } from 'lucide-react';

interface ViralDetectOptionsProps {
  value: ViralDetectionOptions;
  onChange: (next: ViralDetectionOptions) => void;
}

/**
 * The "ask before generating" panel for viral detection: how many clips to
 * generate, the clip length range, and whether hook text is needed at all.
 * The values are injected into the viral prompt ({{clipCount}},
 * {{minClipDuration}}, {{maxClipDuration}}) and enforced after parsing.
 */
export const ViralDetectOptions: React.FC<ViralDetectOptionsProps> = ({ value, onChange }) => {
  const patch = (partial: Partial<ViralDetectionOptions>) => onChange({ ...value, ...partial });

  const parseClamped = (raw: string, fallback: number, min: number, max: number) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="size-4 text-muted-foreground" />
          AI clip options
        </CardTitle>
        <CardDescription>
          Configure the run before detection — these values are injected straight into the viral
          prompt and enforced on every generated clip.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="viral-clip-count">Number of clips</Label>
            <Input
              id="viral-clip-count"
              type="number"
              min={1}
              max={25}
              step={1}
              value={value.clipCount}
              onChange={(e) =>
                patch({ clipCount: parseClamped(e.target.value, 10, 1, 25) })
              }
            />
            <p className="text-xs text-muted-foreground">
              Top viral moments to generate (1–25, default 10)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="viral-min-length">Min clip length (seconds)</Label>
            <Input
              id="viral-min-length"
              type="number"
              min={5}
              max={600}
              step={1}
              value={value.minClipDuration}
              onChange={(e) =>
                patch({
                  minClipDuration: parseClamped(e.target.value, 60, 5, 600),
                  maxClipDuration: Math.max(
                    value.maxClipDuration,
                    parseClamped(e.target.value, 60, 5, 600)
                  ),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Clips shorter than this are never created (default 60s)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="viral-max-length">Max clip length (seconds)</Label>
            <Input
              id="viral-max-length"
              type="number"
              min={5}
              max={1200}
              step={1}
              value={value.maxClipDuration}
              onChange={(e) =>
                patch({
                  maxClipDuration: Math.max(
                    value.minClipDuration,
                    parseClamped(e.target.value, 90, 5, 1200)
                  ),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Longer clips are trimmed to this (default 90s)
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-3">
            <div className="space-y-0.5">
              <Label htmlFor="viral-hook-toggle">Hook text</Label>
              <p className="text-xs text-muted-foreground">
                Generate the on-screen hook text (and the 3s hook intro) for every clip. Turn off to
                skip hook text entirely.
              </p>
            </div>
            <Switch
              id="viral-hook-toggle"
              checked={value.includeHookText}
              onCheckedChange={(checked) => patch({ includeHookText: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
