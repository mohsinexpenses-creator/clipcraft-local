'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { VideoRecord, ClipRecord, CaptionPreset } from '@/lib/types';
import { ClipCard } from '@/components/clip-card';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Clapperboard,
  Film,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { cn } from 'cn';

function VideoStatusBadge({ status }: { status: VideoRecord['status'] }) {
  switch (status) {
    case 'transcribed':
      return (
        <Badge variant="success">
          <CheckCircle2 />
          Transcribed
        </Badge>
      );
    case 'transcribing':
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          Transcribing
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
      return <Badge variant="outline">Uploaded</Badge>;
  }
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

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

  const loadVideos = useCallback(async (): Promise<VideoRecord[]> => {
    try {
      const res = await fetch('/api/videos');
      if (res.ok) {
        const data = await res.json();
        return data.videos || [];
      }
    } catch (err) {
      console.error('Error fetching videos:', err);
    }
    return [];
  }, []);

  const loadClipsAndPresets = useCallback(
    async (): Promise<{ clips: ClipRecord[]; presets: CaptionPreset[] }> => {
      const result: { clips: ClipRecord[]; presets: CaptionPreset[] } = {
        clips: [],
        presets: [],
      };
      try {
        const [clipsRes, presetsRes] = await Promise.all([
          fetch(selectedVideoId ? `/api/clips?videoId=${selectedVideoId}` : '/api/clips'),
          fetch('/api/caption-presets'),
        ]);

        if (clipsRes.ok) {
          const data = await clipsRes.json();
          result.clips = data.clips || [];
        }

        if (presetsRes.ok) {
          const data = await presetsRes.json();
          result.presets = data.presets || [];
        }
      } catch (err) {
        console.error('Error fetching clips or presets:', err);
      }
      return result;
    },
    [selectedVideoId]
  );

  const refreshClipsAndPresets = useCallback(async () => {
    const data = await loadClipsAndPresets();
    setClips(data.clips);
    setCaptionPresets(data.presets);
  }, [loadClipsAndPresets]);

  // Initial video load
  useEffect(() => {
    let ignore = false;
    (async () => {
      const list = await loadVideos();
      if (ignore) return;
      setVideos(list);
      if (!selectedVideoId && list.length > 0) {
        setSelectedVideoId(list[0]._id);
      }
      setIsLoadingVideos(false);
    })();
    return () => {
      ignore = true;
    };
  }, [loadVideos, selectedVideoId]);

  // Load clips + presets whenever the selected video changes
  useEffect(() => {
    let ignore = false;
    (async () => {
      const data = await loadClipsAndPresets();
      if (ignore) return;
      setClips(data.clips);
      setCaptionPresets(data.presets);
    })();
    return () => {
      ignore = true;
    };
  }, [loadClipsAndPresets]);

  // Poll while render jobs are active
  useEffect(() => {
    const hasActiveJobs = clips.some((c) => c.status === 'pending' || c.status === 'processing');
    if (!hasActiveJobs) return;

    const interval = setInterval(async () => {
      const data = await loadClipsAndPresets();
      setClips(data.clips);
      setCaptionPresets(data.presets);
    }, 3000);

    return () => clearInterval(interval);
  }, [clips, loadClipsAndPresets]);

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

      await refreshClipsAndPresets();
    } catch (err) {
      console.error('Detect viral error:', err);
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to analyze viral segments with Gemini AI'
      );
    } finally {
      setIsDetectingViral(false);
    }
  };

  const handleReTranscribe = async () => {
    if (!selectedVideoId) return;
    setIsTranscribing(true);
    try {
      await fetch(`/api/videos/${selectedVideoId}/transcript`, { method: 'POST' });
      setVideos(await loadVideos());
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
      setVideos(await loadVideos());
      await refreshClipsAndPresets();
    } catch (err) {
      console.error('Delete video error:', err);
    }
  };

  const handleRefreshVideos = async () => {
    setVideos(await loadVideos());
  };

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex animate-fade-up flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Manage source videos, detect viral moments with AI, and render 9:16 portrait clips.
          </p>
        </div>
        <Button size="lg" render={<Link href="/upload" />}>
          <Upload />
          Upload video
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Source videos */}
        <div className="animate-fade-up lg:col-span-4" style={{ animationDelay: '60ms' }}>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                Source videos
                <Badge variant="secondary">{videos.length}</Badge>
              </CardTitle>
              <CardDescription>Videos uploaded for clipping</CardDescription>
              <CardAction>
                <Button variant="ghost" size="icon" onClick={handleRefreshVideos} title="Refresh videos">
                  <RefreshCw />
                </Button>
              </CardAction>
            </CardHeader>

            <CardContent>
              {isLoadingVideos ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-[74px] w-full rounded-lg" />
                  ))}
                </div>
              ) : videos.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
                  <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                    <Film className="size-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">No videos yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Upload a long-form landscape video to get started.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" render={<Link href="/upload" />}>
                    <Upload />
                    Upload video
                  </Button>
                </div>
              ) : (
                <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
                  {videos.map((vid) => {
                    const isSelected = vid._id === selectedVideoId;
                    return (
                      <div
                        key={vid._id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setSelectedVideoId(vid._id);
                          router.push(`/?videoId=${vid._id}`);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedVideoId(vid._id);
                            router.push(`/?videoId=${vid._id}`);
                          }
                        }}
                        className={cn(
                          'group cursor-pointer rounded-lg border p-3 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                          isSelected
                            ? 'border-primary/40 bg-accent'
                            : 'border-border hover:bg-muted'
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-sm font-medium">{vid.originalName}</p>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                            title="Delete video"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteVideo(vid._id);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="size-3" />
                            {formatTime(vid.duration || 0)}
                          </span>
                          <VideoStatusBadge status={vid.status} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Selected video + clips */}
        <div className="animate-fade-up space-y-6 lg:col-span-8" style={{ animationDelay: '120ms' }}>
          {selectedVideo ? (
            <>
              <Card className="gap-4">
                <CardHeader>
                  <CardTitle className="text-lg">{selectedVideo.originalName}</CardTitle>
                  <CardDescription>
                    {formatTime(selectedVideo.duration || 0)} • {selectedVideo.width}×
                    {selectedVideo.height} • Uploaded{' '}
                    {new Date(selectedVideo.createdAt).toLocaleDateString()}
                  </CardDescription>
                  <CardAction>
                    <div className="flex items-center gap-2">
                      {selectedVideo.status !== 'transcribed' && (
                        <Button
                          variant="outline"
                          onClick={handleReTranscribe}
                          disabled={isTranscribing}
                        >
                          {isTranscribing ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                          Transcribe
                        </Button>
                      )}
                      <Button
                        onClick={handleDetectViralClips}
                        disabled={isDetectingViral || selectedVideo.status !== 'transcribed'}
                      >
                        {isDetectingViral ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Sparkles />
                        )}
                        {isDetectingViral ? 'Analyzing…' : 'Detect viral clips'}
                      </Button>
                    </div>
                  </CardAction>
                </CardHeader>

                {errorMessage && (
                  <CardContent className="pt-0">
                    <Alert variant="destructive">
                      <AlertCircle className="mt-0.5" />
                      <AlertDescription>{errorMessage}</AlertDescription>
                    </Alert>
                  </CardContent>
                )}

                {selectedVideo.transcript && (
                  <CardContent className="pt-0">
                    <div className="rounded-lg bg-muted/60 p-4">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        Transcript overview · {selectedVideo.transcript.segments?.length || 0}{' '}
                        segments
                      </p>
                      <p className="line-clamp-2 text-sm leading-relaxed text-foreground/80">
                        “{selectedVideo.transcript.text || 'No transcript text extracted yet.'}”
                      </p>
                    </div>
                  </CardContent>
                )}
              </Card>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Clapperboard className="size-4 text-muted-foreground" />
                    Generated clips
                    <Badge variant="secondary">{clips.length}</Badge>
                  </h2>
                  <Button variant="ghost" size="sm" onClick={refreshClipsAndPresets}>
                    <RefreshCw />
                    Refresh
                  </Button>
                </div>

                <Separator />

                {clips.length === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                        <Scissors className="size-5 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">No clips created yet</p>
                        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                          Run “Detect viral clips” above to automatically identify
                          high-engagement segments from the transcript.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {clips.map((clip) => (
                      <ClipCard
                        key={clip._id}
                        clip={clip}
                        captionPresets={captionPresets}
                        onRefresh={refreshClipsAndPresets}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                  <Film className="size-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Select a video to view clips</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    Choose an uploaded video from the list, or upload a new landscape
                    video to get started.
                  </p>
                </div>
              </CardContent>
            </Card>
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
        <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          Loading dashboard…
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
