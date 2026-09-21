'use client';

import React, { useState } from 'react';
import { ClipRecord, CaptionPreset } from '@/lib/types';
import { DEFAULT_FILTER_PRESETS } from '@/lib/presets';
import {
  Play,
  Download,
  Trash2,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  SlidersHorizontal,
  Clock,
  Type,
} from 'lucide-react';

interface ClipCardProps {
  clip: ClipRecord;
  captionPresets: CaptionPreset[];
  onRefresh: () => void;
}

export const ClipCard: React.FC<ClipCardProps> = ({ clip, captionPresets, onRefresh }) => {
  const [filterPreset, setFilterPreset] = useState(clip.filterPreset || 'vibrant');
  const [captionPresetId, setCaptionPresetId] = useState(clip.captionPresetId || 'preset-bold-yellow');
  const [hookText, setHookText] = useState(clip.hookText || '');
  const [hookDuration, setHookDuration] = useState(clip.hookDuration ?? 3);
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

  const mediaUrl = clip.outputPath
    ? `/api/media${clip.outputPath}`
    : null;

  return (
    <div className="flex flex-col md:flex-row gap-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl backdrop-blur-sm transition-all hover:border-slate-700">
      {/* Portrait Video Player / Preview Area (9:16 Aspect) */}
      <div className="relative w-full md:w-56 shrink-0 aspect-[9/16] rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center">
        {clip.status === 'done' && mediaUrl ? (
          <video
            src={mediaUrl}
            controls
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-4 text-center">
            {clip.status === 'processing' ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
                <span className="text-xs font-semibold text-amber-300">Rendering Clip ({clip.progress || 0}%)</span>
                <div className="w-28 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-amber-400 h-full rounded-full transition-all duration-300" style={{ width: `${clip.progress || 0}%` }} />
                </div>
              </div>
            ) : clip.status === 'failed' ? (
              <div className="flex flex-col items-center gap-2 text-rose-400">
                <AlertCircle className="h-8 w-8" />
                <span className="text-xs">Render Failed</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-slate-500">
                <div className="h-12 w-12 rounded-full border border-slate-700 flex items-center justify-center bg-slate-900">
                  <Play className="h-6 w-6 text-slate-400 ml-0.5" />
                </div>
                <span className="text-xs">9:16 Portrait Preview</span>
              </div>
            )}
          </div>
        )}

        {/* Viral Score Badge */}
        <div className="absolute top-3 left-3 flex items-center gap-1 rounded-full bg-slate-950/80 backdrop-blur-md px-2.5 py-1 text-xs font-bold text-amber-400 border border-amber-500/30">
          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
          <span>{clip.viralScore?.toFixed(1) || '8.5'}/10</span>
        </div>
      </div>

      {/* Clip Options & Controls */}
      <div className="flex-1 flex flex-col justify-between space-y-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 mb-1">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  {formatTime(clip.start)} - {formatTime(clip.end)} ({Math.round(clip.end - clip.start)}s duration)
                </span>
              </div>
              <h3 className="text-lg font-bold text-slate-100">
                {clip.hookText || 'Short Clip Segment'}
              </h3>
            </div>

            {/* Status Indicator */}
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
              clip.status === 'done'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : clip.status === 'processing'
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse'
                : clip.status === 'failed'
                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                : 'bg-slate-800 text-slate-300 border-slate-700'
            }`}>
              {clip.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
              {clip.status === 'processing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {clip.status === 'failed' && <AlertCircle className="h-3.5 w-3.5" />}
              <span className="capitalize">{clip.status}</span>
            </span>
          </div>

          {clip.viralReason && (
            <p className="mt-2 text-xs text-slate-400 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80">
              <span className="font-semibold text-slate-300">Viral Reason:</span> {clip.viralReason}
            </p>
          )}
        </div>

        {/* Clip Settings Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          {/* On-Screen Hook Overlay Text */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5 text-amber-400" />
              Intro Hook Overlay Text (Max ~8 Words)
            </label>
            <input
              type="text"
              value={hookText}
              onChange={(e) => setHookText(e.target.value)}
              placeholder="e.g. WATCH THIS FIRST"
              className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* Color Filter Preset */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5 text-indigo-400" />
              Color Filter Preset
            </label>
            <select
              value={filterPreset}
              onChange={(e) => setFilterPreset(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            >
              {DEFAULT_FILTER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Caption Preset */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5 text-rose-400" />
              Animated Caption Preset
            </label>
            <select
              value={captionPresetId}
              onChange={(e) => setCaptionPresetId(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            >
              {captionPresets.map((cp) => (
                <option key={cp._id} value={cp._id}>
                  {cp.name} ({cp.animationStyle})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
          <button
            onClick={handleDelete}
            className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
            title="Delete clip"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2">
            {clip.status === 'done' && mediaUrl && (
              <a
                href={mediaUrl}
                download={`clip_${clip._id}.mp4`}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs font-medium hover:bg-slate-700 transition"
              >
                <Download className="h-3.5 w-3.5" />
                Download MP4
              </a>
            )}

            <button
              onClick={handleRender}
              disabled={isTriggering || clip.status === 'processing'}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-rose-500 text-white text-xs font-semibold shadow-md shadow-rose-500/20 hover:opacity-95 transition disabled:opacity-50 cursor-pointer"
            >
              {isTriggering || clip.status === 'processing' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  {clip.status === 'done' ? 'Re-render Clip' : 'Render 9:16 Clip'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
