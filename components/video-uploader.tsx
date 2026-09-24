'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Tv, Loader2, CheckCircle2, AlertCircle, FileVideo, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { cn } from 'cn';

export const VideoUploader = () => {
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
   * buffered in memory, never hits the old 512 MB check, and can be resumed if the
   * connection drops.
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
      });

      setSessionId(null);
      setPhase('idle');
      const transcriptionLabel =
        data.video?.transcriptionProvider === 'deepgram'
          ? `Deepgram (${data.video?.transcriptionModel || 'nova-2'})`
          : `whisper.cpp (${data.video?.transcriptionModel || 'local model'})`;
      setStatusMessage(
        `Upload complete (${formatFileSize(selectedFile.size)}). Transcription is starting with ${transcriptionLabel}. Redirecting to dashboard…`
      );

      setTimeout(() => {
        router.push(`/?videoId=${data.video._id}`);
      }, 800);
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
        body: JSON.stringify({ youtubeUrl: youtubeUrl.trim() }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'YouTube download failed');
      }

      const data = await res.json();
      const transcriptionLabel = data.video?.transcriptionProvider === 'deepgram'
        ? `Deepgram (${data.video?.transcriptionModel || 'nova-2'})`
        : `whisper.cpp (${data.video?.transcriptionModel || 'local model'})`;
      setStatusMessage(`YouTube video fetched. Transcription is starting with ${transcriptionLabel}. Redirecting to dashboard…`);

      setTimeout(() => {
        router.push(`/?videoId=${data.video._id}`);
      }, 800);
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

  return (
    <div className="mx-auto w-full max-w-xl">
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
              'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              isProcessing && 'cursor-default opacity-80',
              isDragActive
                ? 'border-primary bg-accent'
                : selectedFile
                  ? 'border-primary/50 bg-accent/50'
                  : 'border-input bg-muted/30 hover:border-ring hover:bg-muted/50'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="flex size-11 items-center justify-center rounded-full bg-muted">
              <Upload className="size-5 text-muted-foreground" />
            </div>

            {selectedFile ? (
              <div>
                <p className="text-sm font-medium">{selectedFile.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatFileSize(selectedFile.size)} · Click to change
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">Click or drag a video file here</p>
                <p className="mt-1 text-xs text-muted-foreground">MP4, MOV, MKV · no size limit</p>
              </div>
            )}
          </div>

          {isProcessing && (
            <div className="space-y-2">
              <Progress value={percent} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
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
              Upload &amp; process video
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
            <p className="text-xs text-muted-foreground">
              Long recordings upload in chunks ({formatFileSize(selectedFile.size)} won&apos;t be
              buffered in memory) and resume automatically if the connection drops.
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
    </div>
  );
};
