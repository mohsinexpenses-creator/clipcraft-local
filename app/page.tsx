'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { VideoRecord, ClipRecord, CaptionPreset } from '@/lib/types';
import { ClipCard } from '@/components/clip-card';
import {
  Film,
  Sparkles,
  Upload,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Layers,
  Zap,
} from 'lucide-react';

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialVideoId = searchParams.get('videoId');

  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(initialVideoId);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [captionPresets, setCaptionPresets] = useState<CaptionPreset[]>([]);
  const [isLoadingVideos, setIsLoadingVideos] = useState(true);
  const [isDetectingViral, setIsDetectingViral] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchVideos = useCallback(async () => {
    try {
      const res = await fetch('/api/videos');
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos || []);
        if (!selectedVideoId && data.videos && data.videos.length > 0) {
          setSelectedVideoId(data.videos[0]._id);
        }
      }
    } catch (err) {
      console.error('Error fetching videos:', err);
    } finally {
      setIsLoadingVideos(false);
    }
  }, [selectedVideoId]);

  const fetchClipsAndPresets = useCallback(async () => {
    try {
      const [clipsRes, presetsRes] = await Promise.all([
        fetch(selectedVideoId ? `/api/clips?videoId=${selectedVideoId}` : '/api/clips'),
        fetch('/api/caption-presets'),
      ]);

      if (clipsRes.ok) {
        const data = await clipsRes.json();
        setClips(data.clips || []);
      }

      if (presetsRes.ok) {
        const data = await presetsRes.json();
        setCaptionPresets(data.presets || []);
      }
    } catch (err) {
      console.error('Error fetching clips or presets:', err);
    }
  }, [selectedVideoId]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  useEffect(() => {
    fetchClipsAndPresets();
  }, [fetchClipsAndPresets]);

  useEffect(() => {
    const hasActiveJobs = clips.some((c) => c.status === 'pending' || c.status === 'processing');
    if (!hasActiveJobs) return;

    const interval = setInterval(() => {
      fetchClipsAndPresets();
    }, 3000);

    return () => clearInterval(interval);
  }, [clips, fetchClipsAndPresets]);

  const selectedVideo = videos.find((v) => v._id === selectedVideoId);

  const handleDetectViralClips = async () => {
    if (!selectedVideoId) return;
    setIsDetectingViral(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/videos/${selectedVideoId}/detect-viral`, {
        method: 'POST',
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to detect viral segments');
      }

      await fetchClipsAndPresets();
    } catch (err: any) {
      console.error('Detect viral error:', err);
      setErrorMessage(err.message || 'Failed to analyze viral segments with Gemini AI');
    } finally {
      setIsDetectingViral(false);
    }
  };

  const handleReTranscribe = async () => {
    if (!selectedVideoId) return;
    setIsTranscribing(true);
    try {
      await fetch(`/api/videos/${selectedVideoId}/transcript`, { method: 'POST' });
      await fetchVideos();
    } catch (err) {
      console.error('Re-transcribe error:', err);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleDeleteVideo = async (videoId: string) => {
    if (!confirm('Are you sure you want to delete this video and all its clips?')) return;
    try {
      await fetch(`/api/videos/${videoId}`, { method: 'DELETE' });
      if (selectedVideoId === videoId) setSelectedVideoId(null);
      await fetchVideos();
      await fetchClipsAndPresets();
    } catch (err) {
      console.error('Delete video error:', err);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800/80 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">
            Video Clip Dashboard
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage source videos, run Gemini AI viral segment analysis, and render 9:16 portrait clips.
          </p>
        </div>

        <Link
          href="/upload"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-semibold text-sm shadow-lg shadow-rose-500/20 hover:opacity-95 transition"
        >
          <Upload className="h-4 w-4" />
          Upload New Video
        </Link>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Source Videos List Sidebar */}
        <div className="lg:col-span-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
              <Film className="h-4 w-4 text-amber-400" />
              Source Videos ({videos.length})
            </h2>
            <button
              onClick={fetchVideos}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
              title="Refresh videos"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {isLoadingVideos ? (
            <div className="flex items-center justify-center p-8 rounded-2xl border border-slate-800 bg-slate-900/40 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading videos...
            </div>
          ) : videos.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-8 text-center">
              <Film className="h-8 w-8 text-slate-600 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-300">No videos uploaded yet</p>
              <p className="text-xs text-slate-500 mt-1 mb-4">Upload a long-form landscape video to get started.</p>
              <Link
                href="/upload"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400 hover:underline"
              >
                Upload Video →
              </Link>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
              {videos.map((vid) => {
                const isSelected = vid._id === selectedVideoId;
                return (
                  <div
                    key={vid._id}
                    onClick={() => {
                      setSelectedVideoId(vid._id);
                      router.push(`/?videoId=${vid._id}`);
                    }}
                    className={`group relative flex flex-col justify-between rounded-xl border p-3.5 cursor-pointer transition ${
                      isSelected
                        ? 'border-amber-500/80 bg-amber-500/10 shadow-lg shadow-amber-500/5'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-bold text-slate-200 truncate group-hover:text-amber-300">
                        {vid.originalName}
                      </p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteVideo(vid._id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition"
                        title="Delete video"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-slate-500" />
                        {formatTime(vid.duration || 0)}
                      </span>

                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${
                        vid.status === 'transcribed'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : vid.status === 'transcribing'
                          ? 'bg-amber-500/10 text-amber-400'
                          : 'bg-slate-800 text-slate-400'
                      }`}>
                        {vid.status === 'transcribed' && <CheckCircle2 className="h-2.5 w-2.5" />}
                        {vid.status === 'transcribing' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                        <span className="capitalize">{vid.status}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Video & Clip Generation Content */}
        <div className="lg:col-span-8 space-y-6">
          {selectedVideo ? (
            <>
              {/* Video Header Card */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold text-slate-100">{selectedVideo.originalName}</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Duration: {formatTime(selectedVideo.duration)} • Resolution: {selectedVideo.width}x{selectedVideo.height} • Uploaded {new Date(selectedVideo.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {selectedVideo.status !== 'transcribed' && (
                      <button
                        onClick={handleReTranscribe}
                        disabled={isTranscribing}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition cursor-pointer"
                      >
                        {isTranscribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Transcribe Audio
                      </button>
                    )}

                    <button
                      onClick={handleDetectViralClips}
                      disabled={isDetectingViral || selectedVideo.status !== 'transcribed'}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-bold text-xs shadow-lg shadow-rose-500/20 hover:opacity-95 transition disabled:opacity-50 cursor-pointer"
                    >
                      {isDetectingViral ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Gemini AI Analyzing...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" />
                          Detect Viral Clips (Gemini AI)
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {errorMessage && (
                  <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-400">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Video Transcript Highlight Preview */}
                {selectedVideo.transcript && (
                  <div className="rounded-xl bg-slate-950/60 p-3.5 border border-slate-800/80">
                    <p className="text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-400" />
                      Transcript Overview ({selectedVideo.transcript.segments?.length || 0} segments)
                    </p>
                    <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed italic">
                      "{selectedVideo.transcript.text || 'No transcript text extracted yet.'}"
                    </p>
                  </div>
                )}
              </div>

              {/* Generated Clips Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <Layers className="h-5 w-5 text-amber-400" />
                    Generated Short Clips ({clips.length})
                  </h3>

                  <button
                    onClick={fetchClipsAndPresets}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh Clips
                  </button>
                </div>

                {clips.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-10 text-center space-y-3">
                    <Sparkles className="h-10 w-10 text-amber-400/60 mx-auto" />
                    <p className="text-base font-bold text-slate-200">No short clips created yet</p>
                    <p className="text-xs text-slate-400 max-w-md mx-auto">
                      Click <span className="text-amber-400 font-semibold">"Detect Viral Clips (Gemini AI)"</span> above to automatically identify high-engagement segments.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {clips.map((clip) => (
                      <ClipCard
                        key={clip._id}
                        clip={clip}
                        captionPresets={captionPresets}
                        onRefresh={fetchClipsAndPresets}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center p-16 rounded-2xl border border-slate-800 bg-slate-900/30 text-center">
              <Film className="h-12 w-12 text-slate-600 mb-4" />
              <h3 className="text-lg font-bold text-slate-200">Select a video to view clips</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Choose an uploaded video from the left sidebar or upload a new landscape video.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center p-12 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading ClipCraft Dashboard...
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
