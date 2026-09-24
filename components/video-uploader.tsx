'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Tv, Loader2, CheckCircle2, AlertCircle, FileVideo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from 'cn';

export const VideoUploader = () => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setErrorMessage(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setSelectedFile(file);
      setErrorMessage(null);
    }
  };

  const handleUploadFile = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setStatusMessage('Uploading video file…');
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }

      const data = await res.json();
      const transcriptionLabel = data.video?.transcriptionProvider === 'deepgram'
        ? `Deepgram (${data.video?.transcriptionModel || 'nova-2'})`
        : `whisper.cpp (${data.video?.transcriptionModel || 'local model'})`;
      setStatusMessage(`Upload complete. Transcription is starting with ${transcriptionLabel}. Redirecting to dashboard…`);

      setTimeout(() => {
        router.push(`/?videoId=${data.video._id}`);
      }, 800);
    } catch (err) {
      console.error('Upload error:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to upload video');
      setIsProcessing(false);
    }
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
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragActive(true);
            }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
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
                  {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB · Click to change
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">Click or drag a video file here</p>
                <p className="mt-1 text-xs text-muted-foreground">MP4, MOV, MKV</p>
              </div>
            )}
          </div>

          {selectedFile && !isProcessing && (
            <Button size="lg" className="w-full" onClick={handleUploadFile}>
              <Upload />
              Upload & process video
            </Button>
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
