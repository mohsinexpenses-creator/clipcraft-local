'use client';

import React, { useState } from 'react';
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

interface NumberFieldProps {
  id: string;
  value: number;
  onCommit: (next: number) => void;
  min: number;
  max: number;
  step?: number;
}

/**
 * Number input that tolerates free editing: while focused, the field holds a
 * local draft string, so clearing it or typing an intermediate value (e.g.
 * deleting "60" to type "180") never fights the min/max clamping. The value
 * is committed - and only then clamped into [min, max] - on blur or Enter.
 * (The old controlled-clamp-on-every-keystroke pattern snapshotted empty
 * input back to the minimum, which made the field impossible to edit.)
 *
 * External updates flow in via a `key` remount: when not editing, the inner
 * component re-mounts with a fresh draft = String(value). No useEffect needed.
 */
const NumberField: React.FC<NumberFieldProps> = (props) => {
  const [editing, setEditing] = useState(false);
  return (
    <NumberFieldInner
      key={editing ? 'editing' : `value-${props.value}`}
      {...props}
      editing={editing}
      setEditing={setEditing}
    />
  );
};

interface NumberFieldInnerProps extends NumberFieldProps {
  editing: boolean;
  setEditing: (next: boolean) => void;
}

const NumberFieldInner: React.FC<NumberFieldInnerProps> = ({
  id,
  value,
  onCommit,
  min,
  max,
  step = 1,
  setEditing,
}) => {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    const n = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(n)) {
      // Revert to the last committed value instead of forcing a random one.
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
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
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
};

/**
 * The "ask before generating" panel for viral detection: how many clips to
 * generate, the MINIMUM clip length (the maximum is fixed internally), and
 * the hook-text / CTA switches. The values are injected into the viral prompt
 * ({{clipCount}}, {{minClipDuration}}, {{maxClipDuration}}) and enforced after
 * parsing.
 */
export const ViralDetectOptions: React.FC<ViralDetectOptionsProps> = ({ value, onChange }) => {
  const patch = (partial: Partial<ViralDetectionOptions>) => onChange({ ...value, ...partial });

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="viral-clip-count">Number of clips</Label>
            <NumberField
              id="viral-clip-count"
              value={value.clipCount}
              onCommit={(clipCount) => patch({ clipCount })}
              min={1}
              max={25}
            />
            <p className="text-xs text-muted-foreground">
              Top viral moments to generate (1–25, default 10)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="viral-min-length">Min clip length (seconds)</Label>
            <NumberField
              id="viral-min-length"
              value={value.minClipDuration}
              onCommit={(minClipDuration) => patch({ minClipDuration })}
              min={5}
              max={600}
            />
            <p className="text-xs text-muted-foreground">
              Clips shorter than this are never created (default 60s). The maximum is fixed at
              600s (10 min).
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
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

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="viral-cta-toggle">CTA text</Label>
              <p className="text-xs text-muted-foreground">
                Generate the on-screen end CTA card for every clip. Turn off to render clips
                without a CTA.
              </p>
            </div>
            <Switch
              id="viral-cta-toggle"
              checked={value.includeCta}
              onCheckedChange={(checked) => patch({ includeCta: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
