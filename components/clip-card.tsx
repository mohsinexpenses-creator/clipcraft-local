'use client';

import React, { useEffect, useState } from 'react';
import { ClipRecord, CaptionPreset, ClipLayout, OverlayStylePreset } from '@/lib/types';
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
import { Alert, AlertDescription } from '@/components/ui/alert';

interface ClipCardProps {
  clip: ClipRecord;
  captionPresets: CaptionPreset[];
  onRefresh: () => Promise<void>;
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

async function getErrorFromResponse(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export const ClipCard: React.FC<ClipCardProps> = ({ clip, captionPresets, onRefresh }) => {
  const [filterPreset, setFilterPreset] = useState(clip.filterPreset || 'vibrant');
  const [captionPresetId, setCaptionPresetId] = useState(
    clip.captionPresetId || 'preset-bold-yellow'
  );
  const [hookText, setHookText] = useState(clip.hookText || '');
  const [ctaText, setCtaText] = useState(clip.ctaText || '');
  const [hookDuration] = useState(clip.hookDuration ?? 3);
  const [ctaDuration] = useState(clip.ctaDuration ?? 2.5);
  const [layout, setLayout] = useState<ClipLayout>(clip.layout || 'speaker-focus');
  const [hookStylePresetId, setHookStylePresetId] = useState(
    clip.hookStylePresetId || 'hook-bold-yellow'
  );
  const [ctaStylePresetId, setCtaStylePresetId] = useState(
    clip.ctaStylePresetId || 'cta-gradient-green'
  );
  const [overlayPresets, setOverlayPresets] = useState<OverlayStylePreset[]>([]);
  const [isTriggering, setIsTriggering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/overlay-presets');
        if (!res.ok) return;
        const data = await res.json();
        if (!ignore && Array.isArray(data.presets)) setOverlayPresets(data.presets);
      } catch {
        // Style pickers stay on their defaults when the API is unavailable.
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const handleRender = async () => {
    setIsTriggering(true);
    setActionError(null);
    try {
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipId: clip._id,
          videoId: clip.videoId,
          start: clip.start,
          end: clip.end,
          hookDuration: hookText.trim() ? (hookDuration > 0 ? hookDuration : 3) : 0,
          hookText,
          ctaText,
          ctaDuration,
          filterPreset,
          captionPresetId,
          layout,
          hookStylePresetId,
          ctaStylePresetId,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to start rendering job.'));
      }

      await onRefresh();
    } catch (err) {
      console.error('Error starting render:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to start rendering job.');
    } finally {
      setIsTriggering(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this clip?')) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/clips/${clip._id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to delete clip.'));
      }
      await onRefresh();
    } catch (err) {
      console.error('Error deleting clip:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to delete clip.');
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
            {typeof clip.viralScore === 'number' ? clip.viralScore.toFixed(1) : '—'}
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
                {clip.title || clip.hookText || 'Short clip segment'}
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

          {(clip.retentionStrength ||
            clip.psychologicalTrigger ||
            clip.safetyRisk ||
            clip.scores) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {clip.retentionStrength && (
                <Badge variant="secondary">🎯 Retention: {clip.retentionStrength}</Badge>
              )}
              {clip.psychologicalTrigger && (
                <Badge variant="secondary">🧠 {clip.psychologicalTrigger}</Badge>
              )}
              {clip.safetyRisk && (
                <Badge
                  variant={clip.safetyRisk === 'High' ? 'destructive' : 'outline'}
                  className={clip.safetyRisk === 'Medium' ? 'border-amber-500/50 text-amber-600 dark:text-amber-400' : undefined}
                >
                  {clip.safetyRisk === 'Low' ? '✅' : '⚠️'} Safety: {clip.safetyRisk}
                </Badge>
              )}
              {clip.scores && (
                <span className="text-[11px] text-muted-foreground">
                  Viral {clip.scores.viral}/10 · Retention {clip.scores.retention}/10 ·
                  Controversy {clip.scores.controversy}/10 · Shareability {clip.scores.shareability}/10
                </span>
              )}
            </div>
          )}

          {clip.hashtags && clip.hashtags.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">{clip.hashtags.join(' ')}</p>
          )}

          {clip.safetyNotes && clip.safetyNotes !== 'No risky wording detected.' && (
            <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              <span className="font-medium">Safety notes: </span>
              {clip.safetyNotes}
            </p>
          )}

          {clip.ctaText && (
            <p className="mt-3 rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground/80">End CTA: </span>
              {clip.ctaText}
            </p>
          )}

          {clip.error && (
            <p className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
              {clip.error}
            </p>
          )}

          {actionError && (
            <Alert variant="destructive" className="mt-3">
              <AlertCircle className="mt-0.5" />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          {/* Settings */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`hook-${clip._id}`}>Intro hook text</Label>
              <Input
                id={`hook-${clip._id}`}
                value={hookText}
                onChange={(e) => setHookText(e.target.value)}
                placeholder={
                  hookText.trim()
                    ? 'e.g. WATCH THIS FIRST'
                    : 'Hook overlay off — type text to enable it'
                }
                disabled={isProcessing}
              />
              {!hookText.trim() && (
                <p className="text-xs text-muted-foreground">
                  This clip renders without a hook intro/overlay until hook text is added.
                </p>
              )}
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`cta-${clip._id}`}>End CTA text</Label>
              <Input
                id={`cta-${clip._id}`}
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                placeholder="e.g. FOLLOW FOR MORE"
                disabled={isProcessing}
              />
            </div>

            <div className="space-y-2">
              <Label id={`layout-label-${clip._id}`}>Clip layout</Label>
              <Select
                value={layout}
                onValueChange={(v) => setLayout(v === 'split-screen' ? 'split-screen' : 'speaker-focus')}
                disabled={isProcessing}
              >
                <SelectTrigger aria-labelledby={`layout-label-${clip._id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="speaker-focus">Speaker focus · follows the talker</SelectItem>
                  <SelectItem value="split-screen">Split screen · two speakers</SelectItem>
                </SelectContent>
              </Select>
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

            <div className="space-y-2">
              <Label id={`hook-style-label-${clip._id}`}>Hook style</Label>
              <Select
                value={hookStylePresetId}
                onValueChange={(v) => setHookStylePresetId(String(v ?? 'hook-bold-yellow'))}
                disabled={isProcessing}
              >
                <SelectTrigger aria-labelledby={`hook-style-label-${clip._id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(overlayPresets.filter((p) => p.kind === 'hook').length
                    ? overlayPresets.filter((p) => p.kind === 'hook')
                    : [{ _id: 'hook-bold-yellow', name: 'Bold Yellow Punch' }] as OverlayStylePreset[]
                  ).map((p) => (
                    <SelectItem key={p._id} value={p._id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label id={`cta-style-label-${clip._id}`}>CTA style</Label>
              <Select
                value={ctaStylePresetId}
                onValueChange={(v) => setCtaStylePresetId(String(v ?? 'cta-gradient-green'))}
                disabled={isProcessing}
              >
                <SelectTrigger aria-labelledby={`cta-style-label-${clip._id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(overlayPresets.filter((p) => p.kind === 'cta').length
                    ? overlayPresets.filter((p) => p.kind === 'cta')
                    : [{ _id: 'cta-gradient-green', name: 'Green Gradient Card' }] as OverlayStylePreset[]
                  ).map((p) => (
                    <SelectItem key={p._id} value={p._id}>
                      {p.name}
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
                  nativeButton={false}
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
