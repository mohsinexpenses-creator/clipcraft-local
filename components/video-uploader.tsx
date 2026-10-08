'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Upload,
  Tv,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileVideo,
  X,
  Sparkles,
  Captions,
  Clapperboard,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from 'cn';
import type { PipelineOptions } from '@/lib/types';
import {
  deleteUploadSession,
  formatDuration,
  formatFileSize,
  formatSpeed,
  UploadAbortedError,
  UploadFileProgress,
  UploadPhase,
  uploadVideoFile,
} from '@/lib/upload-client';

/**
 * The upload step of the pipeline - and the only interaction a new video needs.
 *
 * Once the last byte lands, the server queues transcription, transcription
 * queues viral detection, and detection queues the renders (see
 * lib/pipeline.ts). The uploader's job is therefore to stream the file
 * resumably, remember the automation the user chose, and get out of the way by
 * navigating straight to the dashboard that watches it happen.
 */

/** The three steps the video walks through on its own after this page. */
const PIPELINE_STEPS = [
  {
    icon: Captions,
    title: 'Transcribe',
    text: 'Local whisper.cpp or Deepgram, with word-level timestamps.',
  },
  {
    icon: Sparkles,
    title: 'Detect clips',
    text: 'AI ranks the best moments, writes the hook and the CTA.',
  },
  {
    icon: Clapperboard,
    title: 'Render 9:16',
    text: 'Speaker crop, hook replay, animated captions - default styles.',
  },
] as const;

export interface VideoUploaderProps {
  /** Automation to store on this video; defaults to the saved upload defaults. */
  pipeline: PipelineOptions;
}

export const VideoUploader: React.FC<VideoUploaderProps> = ({ pipeline }) => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [phase, setPhase] = useState<UploadPhase | 'idle'>('idle');
  const [progress, setProgress] = useState<UploadFileProgress | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectFile = (file: File) => {
    setSelectedFile(file);
    setErrorMessage(null);
    setStatusMessage(null);
    setProgress(null);
    setSessionId(null);
    setPhase('idle');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      selectFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      selectFile(file);
    }
  };

  /**
   * Uploads through the resumable chunked endpoint, so a multi-hour recording is never
   * buffered in memory and can be resumed if the connection drops. The chosen
   * automation travels with the finalize request and is stored on the video record.
   */
  const handleUploadFile = async (resumeSessionId?: string | null) => {
    if (!selectedFile) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setIsProcessing(true);
    setPhase('uploading');
    setProgress(null);
    setErrorMessage(null);
    setStatusMessage(
      resumeSessionId ? 'Resuming upload from the last confirmed byte…' : 'Uploading video file…'
    );

    try {
      const data = await uploadVideoFile(selectedFile, {
        sessionId: resumeSessionId ?? undefined,
        signal: controller.signal,
        onSessionCreated: setSessionId,
        onProgress: setProgress,
        onPhase: setPhase,
        pipeline,
      });

      setSessionId(null);
      setPhase('idle');
      setIsProcessing(false);
      // Go straight to the dashboard: it polls the pipeline, so the user lands on
      // a live progress bar instead of a "thank you" screen.
      router.push(`/?videoId=${data.video._id}`);
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        setStatusMessage('Upload cancelled.');
        setErrorMessage(null);
        setProgress(null);
        setSessionId(null);
        setPhase('idle');
        setIsProcessing(false);
        return;
      }

      console.error('Upload error:', err);
      setStatusMessage(null);
      setPhase('idle');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to upload video');
      setIsProcessing(false);
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancelUpload = () => {
    const id = sessionId;
    abortRef.current?.abort();
    // The partial file can be several GB - drop it unless the user resumes instead.
    if (id) void deleteUploadSession(id);
  };

  const handleProcessYoutube = async () => {
    if (!youtubeUrl.trim()) return;

    setIsProcessing(true);
    setStatusMessage('Fetching video from YouTube…');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: youtubeUrl.trim(), pipeline }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'YouTube download failed');
      }

      const data = await res.json();
      setIsProcessing(false);
      router.push(`/?videoId=${data.video._id}`);
    } catch (err) {
      console.error('YouTube error:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to fetch YouTube video');
      setIsProcessing(false);
    }
  };

  const uploadedBytes = progress?.uploadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? selectedFile?.size ?? 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
  const canResume =
    !isProcessing && Boolean(sessionId) && uploadedBytes > 0 && Boolean(errorMessage);
  const nextStep =
    pipeline.autoDetect && pipeline.autoRender
      ? 'transcript → viral detection → render'
      : pipeline.autoDetect
        ? 'transcript → viral detection'
        : 'transcript only';

  return (
    <div className="mx-auto w-full">
      <Tabs defaultValue="file" onValueChange={() => setErrorMessage(null)}>
        <TabsList className="w-full">
          <TabsTrigger value="file" className="flex-1">
            <FileVideo />
            Video file
          </TabsTrigger>
          <TabsTrigger value="youtube" className="flex-1">
            <Tv />
            YouTube link
          </TabsTrigger>
        </TabsList>

        {/* File upload */}
        <TabsContent value="file" className="mt-4 space-y-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!isProcessing) fileInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !isProcessing) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!isProcessing) setIsDragActive(true);
            }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center outline-none transition-[border-color,background-color,box-shadow] duration-200',
              'focus-visible:ring-2 focus-visible:ring-ring/40',
              isProcessing && 'cursor-default opacity-90',
              isDragActive
                ? 'border-primary bg-accent shadow-[var(--shadow-lift)]'
                : selectedFile
                  ? 'border-primary/50 bg-accent/40'
                  : 'border-input bg-muted/25 hover:border-ring hover:bg-muted/45'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              className="hidden"
            />

            <span
              className={cn(
                'flex size-12 items-center justify-center rounded-2xl transition-colors',
                selectedFile ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {isProcessing ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
            </span>

            {selectedFile ? (
              <div>
                <p className="max-w-[46ch] truncate text-sm font-medium">{selectedFile.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatFileSize(selectedFile.size)} · Click to change
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">Drop a video here, or click to choose one</p>
                <p className="mt-1 text-xs text-muted-foreground">MP4, MOV, MKV, WEBM · no size limit</p>
              </div>
            )}

            {!isProcessing && (
              <p className="text-[11px] text-muted-foreground">
                After the upload this video runs <span className="font-medium text-foreground/70">{nextStep}</span> on
                its own.
              </p>
            )}
          </div>

          {isProcessing && (
            <div className="space-y-2">
              <Progress value={percent} />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="tabular">
                  {formatFileSize(uploadedBytes)} / {formatFileSize(totalBytes)} · {percent}%
                </span>
                <span>
                  {phase === 'finalizing'
                    ? 'Finishing upload (probing the video)…'
                    : `${formatSpeed(progress?.bytesPerSecond ?? 0)} · ${
                        progress?.etaSeconds === null || progress?.etaSeconds === undefined
                          ? 'estimating…'
                          : `${formatDuration(progress.etaSeconds)} left`
                      }`}
                </span>
              </div>
            </div>
          )}

          {selectedFile && isProcessing && (
            <Button variant="outline" size="lg" className="w-full" onClick={handleCancelUpload}>
              <X />
              Cancel upload
            </Button>
          )}

          {selectedFile && !isProcessing && !canResume && (
            <Button size="lg" className="w-full" onClick={() => handleUploadFile()}>
              <Upload />
              Upload &amp; start the pipeline
            </Button>
          )}

          {canResume && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="lg" className="flex-1" onClick={() => handleUploadFile(sessionId)}>
                <Upload />
                Resume upload from {formatFileSize(uploadedBytes)}
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  if (sessionId) void deleteUploadSession(sessionId);
                  setSessionId(null);
                  setProgress(null);
                  setErrorMessage(null);
                }}
              >
                <X />
                Discard
              </Button>
            </div>
          )}

          {selectedFile && !isProcessing && (
            <p className="text-[11px] text-muted-foreground">
              Long recordings upload in chunks ({formatFileSize(selectedFile.size)} won&apos;t be buffered in
              memory) and resume automatically if the connection drops.
            </p>
          )}
        </TabsContent>

        {/* YouTube */}
        <TabsContent value="youtube" className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="youtube-url">YouTube video URL</Label>
            <Input
              id="youtube-url"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={youtubeUrl}
              onChange={(e) => {
                setYoutubeUrl(e.target.value);
                setErrorMessage(null);
              }}
              disabled={isProcessing}
            />
            <p className="text-[11px] text-muted-foreground">
              Disabled by default: set <code className="rounded bg-muted px-1">ENABLE_YT_IMPORT=1</code> in
              .env.local. Direct uploads are faster and never break with YouTube.
            </p>
          </div>

          {youtubeUrl.trim() && !isProcessing && (
            <Button size="lg" className="w-full" onClick={handleProcessYoutube}>
              <Tv />
              Fetch YouTube video
            </Button>
          )}
        </TabsContent>
      </Tabs>

      {/* Feedback */}
      {errorMessage && (
        <Alert variant="destructive" className="mt-4 animate-fade-in">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {statusMessage && (
        <Alert className="mt-4 animate-fade-in">
          {isProcessing ? (
            <Loader2 className="mt-0.5 animate-spin text-primary" />
          ) : (
            <CheckCircle2 className="mt-0.5 text-primary" />
          )}
          <AlertDescription>{statusMessage}</AlertDescription>
        </Alert>
      )}

      {/* What happens next */}
      <ol className="mt-5 grid gap-2 sm:grid-cols-3">
        {PIPELINE_STEPS.map((step, index) => {
          const Icon = step.icon;
          const skipped =
            (step.title === 'Detect clips' && !pipeline.autoDetect) ||
            (step.title === 'Render 9:16' && !pipeline.autoRender);
          return (
            <li
              key={step.title}
              className={cn(
                'relative flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                skipped ? 'bg-muted/25 text-muted-foreground' : 'bg-card'
              )}
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary tabular">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[12.5px] leading-tight font-medium">
                  <Icon className="size-3.5" />
                  {step.title}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {skipped ? 'Manual — you start it from the dashboard.' : step.text}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
