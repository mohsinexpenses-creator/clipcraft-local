'use client';

import React, { useState } from 'react';
import { ClipRecord, CaptionPreset } from '@/lib/types';
import { DEFAULT_FILTER_PRESETS } from '@/lib/presets';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
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
  Clock,
  Download,
  Flame,
  Loader2,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';

interface ClipCardProps {
  clip: ClipRecord;
  captionPresets: CaptionPreset[];
  onRefresh: () => void;
}

function ClipStatusBadge({ status }: { status: ClipRecord['status'] }) {
  switch (status) {
    case 'done':
      return (
        <Badge variant="success">
          <CheckCircle2 />
          Done
        </Badge>
      );
    case 'processing':
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          Processing
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive">
          <AlertCircle />
          Failed
        </Badge>
      );
    default:
      return <Badge variant="outline">Pending</Badge>;
  }
}

export const ClipCard: React.FC<ClipCardProps> = ({ clip, captionPresets, onRefresh }) => {
  const [filterPreset, setFilterPreset] = useState(clip.filterPreset || 'vibrant');
  const [captionPresetId, setCaptionPresetId] = useState(
    clip.captionPresetId || 'preset-bold-yellow'
  );
  const [hookText, setHookText] = useState(clip.hookText || '');
  const [hookDuration] = useState(clip.hookDuration ?? 3);
  const [isTriggering, setIsTriggering] = useState(false);

  const handleRender = async () => {
    setIsTriggering(true);
    try {
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipId: clip._id,
          videoId: clip.videoId,
          start: clip.start,
          end: clip.end,
          hookDuration,
          hookText,
          filterPreset,
          captionPresetId,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to start rendering job');
      }

      onRefresh();
    } catch (err) {
      console.error('Error starting render:', err);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this clip?')) return;
    try {
      await fetch(`/api/clips/${clip._id}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) {
      console.error('Error deleting clip:', err);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const mediaUrl = clip.outputPath ? `/api/media${clip.outputPath}` : null;
  const isProcessing = clip.status === 'processing';

  return (
    <div className="animate-fade-up rounded-xl border bg-card p-5 text-card-foreground shadow-xs transition-colors hover:border-ring/60">
      <div className="flex flex-col gap-6 md:flex-row">
        {/* 9:16 preview */}
        <div className="relative aspect-[9/16] w-full shrink-0 overflow-hidden rounded-lg border bg-muted md:w-56">
          {clip.status === 'done' && mediaUrl ? (
            <video
              src={mediaUrl}
              controls
              playsInline
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
              {isProcessing ? (
                <>
                  <Loader2 className="size-7 animate-spin text-primary" />
                  <div className="w-28 space-y-1.5">
                    <Progress value={clip.progress || 0} />
                    <p className="text-xs font-medium text-muted-foreground">
                      Rendering {clip.progress || 0}%
                    </p>
                  </div>
                </>
              ) : clip.status === 'failed' ? (
                <>
                  <AlertCircle className="size-7 text-destructive" />
                  <p className="text-xs font-medium text-destructive">Render failed</p>
                </>
              ) : (
                <>
                  <div className="flex size-11 items-center justify-center rounded-full border bg-background">
                    <Play className="ml-0.5 size-5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">Ready to render</p>
                </>
              )}
            </div>
          )}

          {/* Viral score */}
          <Badge
            variant="outline"
            className="absolute top-2.5 left-2.5 gap-1 bg-background/90 backdrop-blur-sm"
          >
            <Flame className="text-primary" />
            {clip.viralScore?.toFixed(1) || '8.5'}
          </Badge>
        </div>

        {/* Details + controls */}
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3" />
                {formatTime(clip.start)} – {formatTime(clip.end)} ·{' '}
                {Math.round(clip.end - clip.start)}s segment
              </p>
              <h3 className="truncate text-base font-semibold tracking-tight">
                {clip.hookText || 'Short clip segment'}
              </h3>
            </div>
            <ClipStatusBadge status={clip.status} />
          </div>

          {clip.viralReason && (
            <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground/80">Why it works: </span>
              {clip.viralReason}
            </p>
          )}

          {clip.error && (
            <p className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
              {clip.error}
            </p>
          )}

          {/* Settings */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`hook-${clip._id}`}>Intro hook text</Label>
              <Input
                id={`hook-${clip._id}`}
                value={hookText}
                onChange={(e) => setHookText(e.target.value)}
                placeholder="e.g. WATCH THIS FIRST"
                disabled={isProcessing}
              />
            </div>

            <div className="space-y-2">
              <Label id={`filter-label-${clip._id}`}>Color filter</Label>
              <Select
                value={filterPreset}
                onValueChange={(v) => setFilterPreset(String(v ?? 'vibrant'))}
                disabled={isProcessing}
              >
                <SelectTrigger aria-labelledby={`filter-label-${clip._id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_FILTER_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label id={`caption-label-${clip._id}`}>Caption preset</Label>
              <Select
                value={captionPresetId}
                onValueChange={(v) => setCaptionPresetId(String(v ?? 'preset-bold-yellow'))}
                disabled={isProcessing}
              >
                <SelectTrigger aria-labelledby={`caption-label-${clip._id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {captionPresets.map((cp) => (
                    <SelectItem key={cp._id} value={cp._id}>
                      {cp.name} · {cp.animationStyle}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDelete}
              title="Delete clip"
              className="hover:text-destructive"
              disabled={isProcessing}
            >
              <Trash2 />
            </Button>

            <div className="flex items-center gap-2">
              {clip.status === 'done' && mediaUrl && (
                <Button
                  variant="outline"
                  render={<a href={mediaUrl} download={`clip_${clip._id}.mp4`} />}
                >
                  <Download />
                  Download
                </Button>
              )}

              <Button
                onClick={handleRender}
                disabled={isTriggering || isProcessing}
              >
                {isTriggering || isProcessing ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                {isProcessing
                  ? 'Processing…'
                  : clip.status === 'done'
                    ? 'Re-render clip'
                    : 'Render clip'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
