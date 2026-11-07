'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Captions,
  CheckCircle2,
  Clapperboard,
  FileVideo,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
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

const PIPELINE_STEPS = [
  { icon: Captions, title: 'Transcribe', text: 'Deepgram transcription with word-level timestamps.' },
  { icon: Sparkles, title: 'Detect clips', text: 'AI ranks the best moments, writes the hook and the CTA.' },
  { icon: Clapperboard, title: 'Render 9:16', text: 'Speaker crop, hook replay, animated captions - default styles.' },
] as const;

export interface VideoUploaderProps {
  /** Automation stored independently on every finalized video. */
  pipeline: PipelineOptions;
}

type UploadState = 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'cancelled' | 'removed';

interface UploadItem {
  id: string;
  file: File;
  state: UploadState;
  progress?: UploadFileProgress;
  sessionId?: string;
  error?: string;
  videoId?: string;
}

function makeItem(file: File): UploadItem {
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
    file,
    state: 'queued',
  };
}

/**
 * A sequential multi-file resumable uploader. Each file owns its own session and
 * terminal state; a bad recording never stops later files from reaching their
 * pipeline. Navigation happens only after every queued file completed cleanly.
 */
export const VideoUploader: React.FC<VideoUploaderProps> = ({ pipeline }) => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeItemIdRef = useRef<string | null>(null);
  const itemsRef = useRef<UploadItem[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // State is used for rendering; refs below remain the race-safe imperative
  // handles used by the asynchronous upload loop and cancel button.
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const replaceItems = (next: UploadItem[] | ((previous: UploadItem[]) => UploadItem[])) => {
    setItems((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next;
      itemsRef.current = resolved;
      return resolved;
    });
  };

  const patchItem = (id: string, patch: Partial<UploadItem>) => {
    replaceItems((previous) => previous.map((item) =>
      item.id === id && item.state !== 'removed' ? { ...item, ...patch } : item,
    ));
  };

  const addFiles = (incoming: FileList | File[]) => {
    const files = Array.from(incoming).filter((file) => file.size > 0);
    if (!files.length) return;
    replaceItems((previous) => [...previous, ...files.map(makeItem)]);
    setStatusMessage(null);
  };

  const runQueue = async (retryIds?: Set<string>) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setStatusMessage('Preparing uploads…');
    let hadError = false;
    let lastVideoId: string | undefined;

    // Convert selected failures back to queue entries before claiming the first.
    if (retryIds) {
      replaceItems((previous) => previous.map((item) =>
        retryIds.has(item.id) && item.state === 'error'
          ? { ...item, state: 'queued', error: undefined }
          : item,
      ));
    }

    try {
      for (;;) {
        const next = itemsRef.current.find((item) =>
          item.state === 'queued' && (!retryIds || retryIds.has(item.id)),
        );
        if (!next) break;

        const controller = new AbortController();
        activeControllerRef.current = controller;
        activeItemIdRef.current = next.id;
        setActiveItemId(next.id);
        patchItem(next.id, { state: 'uploading', progress: undefined, error: undefined });
        setStatusMessage(`Uploading ${next.file.name}…`);

        try {
          const result = await uploadVideoFile(next.file, {
            sessionId: next.sessionId,
            signal: controller.signal,
            pipeline,
            onSessionCreated: (sessionId) => patchItem(next.id, { sessionId }),
            onProgress: (progress) => patchItem(next.id, { progress }),
            onPhase: (phase: UploadPhase) => patchItem(next.id, {
              state: phase === 'finalizing' ? 'finalizing' : 'uploading',
            }),
          });
          lastVideoId = result.video._id;
          patchItem(next.id, {
            state: 'done',
            progress: {
              uploadedBytes: next.file.size,
              totalBytes: next.file.size,
              bytesPerSecond: next.progress?.bytesPerSecond ?? 0,
              etaSeconds: 0,
            },
            sessionId: undefined,
            videoId: result.video._id,
          });
        } catch (error) {
          const latest = itemsRef.current.find((item) => item.id === next.id);
          if (latest?.state === 'removed') continue;
          if (error instanceof UploadAbortedError) {
            patchItem(next.id, { state: 'cancelled', progress: undefined, sessionId: undefined });
          } else {
            hadError = true;
            patchItem(next.id, {
              state: 'error',
              error: error instanceof Error ? error.message : 'Failed to upload video.',
            });
          }
        } finally {
          activeControllerRef.current = null;
          activeItemIdRef.current = null;
          setActiveItemId(null);
        }
      }
    } finally {
      setIsProcessing(false);
    }

    const remaining = itemsRef.current.filter((item) =>
      item.state !== 'removed' && item.state !== 'done' && item.state !== 'cancelled',
    );
    const completed = itemsRef.current.filter((item) => item.state === 'done');
    if (!hadError && remaining.length === 0 && completed.length > 0) {
      const videoId = lastVideoId ?? completed.at(-1)?.videoId;
      setStatusMessage(`All ${completed.length} upload${completed.length === 1 ? '' : 's'} completed. Opening the dashboard…`);
      router.push(videoId ? `/?videoId=${videoId}` : '/');
      return;
    }
    if (hadError) {
      setStatusMessage('Finished the remaining files. Retry only the files that failed below.');
    } else if (!completed.length) {
      setStatusMessage('No upload is queued.');
    }
  };

  const cancelOrRemove = (item: UploadItem) => {
    const isActive = activeItemIdRef.current === item.id;
    if (isActive) activeControllerRef.current?.abort();
    if (item.sessionId) void deleteUploadSession(item.sessionId);
    patchItem(item.id, { state: 'removed', error: undefined, progress: undefined });
    setStatusMessage(`${item.file.name} removed from the upload queue.`);
  };

  const retryItem = (item: UploadItem) => {
    void runQueue(new Set([item.id]));
  };

  const queuedCount = items.filter((item) => item.state === 'queued').length;
  const visibleItems = items.filter((item) => item.state !== 'removed');
  const nextStep = pipeline.autoDetect && pipeline.autoRender
    ? 'transcript → viral detection → render'
    : pipeline.autoDetect ? 'transcript → viral detection' : 'transcript only';

  return (
    <div className="mx-auto w-full space-y-4">
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragActive(true);
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragActive(false);
          if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center outline-none transition-[border-color,background-color,box-shadow] duration-200',
          'focus-visible:ring-2 focus-visible:ring-ring/40',
          isDragActive ? 'border-primary bg-accent shadow-[var(--shadow-lift)]' : 'border-input bg-muted/25 hover:border-ring hover:bg-muted/45',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            // Allow choosing the same file again after it was removed.
            event.target.value = '';
          }}
          className="hidden"
        />
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Upload className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium">Drop one or more videos here, or click to choose files</p>
          <p className="mt-1 text-xs text-muted-foreground">MP4, MOV, MKV, WEBM · no size limit · uploads run one at a time</p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Every completed video starts <span className="font-medium text-foreground/70">{nextStep}</span> independently.
        </p>
      </div>

      {visibleItems.length > 0 && (
        <div className="space-y-2 rounded-2xl border bg-card p-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <p className="text-sm font-medium">Upload queue · {visibleItems.length} file{visibleItems.length === 1 ? '' : 's'}</p>
            {!isProcessing && queuedCount > 0 && (
              <Button size="sm" onClick={() => void runQueue()}>
                <Upload />
                Upload {queuedCount} queued
              </Button>
            )}
            {isProcessing && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Sequential upload in progress</span>
            )}
          </div>

          {visibleItems.map((item) => {
            const progress = item.progress;
            const uploaded = progress?.uploadedBytes ?? 0;
            const total = progress?.totalBytes ?? item.file.size;
            const percent = total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;
            const active = item.state === 'uploading' || item.state === 'finalizing';
            const terminalLabel = item.state === 'done'
              ? 'Uploaded and queued'
              : item.state === 'cancelled'
                ? 'Cancelled'
                : item.state === 'error'
                  ? 'Needs retry'
                  : item.state === 'queued'
                    ? 'Waiting'
                    : 'Finalizing';
            return (
              <div key={item.id} className="rounded-xl border bg-background px-3 py-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                    item.state === 'done' ? 'bg-emerald-500/10 text-emerald-600' : item.state === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                  )}>
                    {active ? <Loader2 className="size-4 animate-spin" /> : item.state === 'done' ? <CheckCircle2 className="size-4" /> : item.state === 'error' ? <AlertCircle className="size-4" /> : <FileVideo className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="max-w-[42ch] truncate text-sm font-medium">{item.file.name}</p>
                      <span className="text-[11px] text-muted-foreground">{formatFileSize(item.file.size)} · {terminalLabel}</span>
                    </div>
                    {active && (
                      <div className="mt-2 space-y-1.5">
                        <Progress value={percent} />
                        <div className="flex justify-between text-[11px] text-muted-foreground tabular">
                          <span>{formatFileSize(uploaded)} / {formatFileSize(total)} · {percent}%</span>
                          <span>{item.state === 'finalizing' ? 'Probing and queuing…' : `${formatSpeed(progress?.bytesPerSecond ?? 0)} · ${progress?.etaSeconds == null ? 'estimating…' : `${formatDuration(progress.etaSeconds)} left`}`}</span>
                        </div>
                      </div>
                    )}
                    {item.error && <p className="mt-2 text-xs text-destructive">{item.error}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.state === 'error' && !isProcessing && (
                      <Button variant="outline" size="icon" aria-label={`Retry ${item.file.name}`} title="Retry this file" onClick={() => retryItem(item)}><RotateCcw className="size-3.5" /></Button>
                    )}
                    {item.state !== 'done' && (
                      <Button variant="ghost" size="icon" aria-label={`Remove ${item.file.name}`} title="Remove from queue" onClick={() => cancelOrRemove(item)}><Trash2 className="size-3.5" /></Button>
                    )}
                    {active && activeItemId === item.id && (
                      <Button variant="ghost" size="icon" aria-label={`Cancel ${item.file.name}`} title="Cancel upload" onClick={() => activeControllerRef.current?.abort()}><X className="size-3.5" /></Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {statusMessage && (
        <Alert className="animate-fade-in">
          {isProcessing ? <Loader2 className="mt-0.5 animate-spin text-primary" /> : <CheckCircle2 className="mt-0.5 text-primary" />}
          <AlertDescription>{statusMessage}</AlertDescription>
        </Alert>
      )}

      <ol className="grid gap-2 sm:grid-cols-3">
        {PIPELINE_STEPS.map((step, index) => {
          const Icon = step.icon;
          const skipped = (step.title === 'Detect clips' && !pipeline.autoDetect) || (step.title === 'Render 9:16' && !pipeline.autoRender);
          return (
            <li key={step.title} className={cn('relative flex items-start gap-2.5 rounded-xl border px-3 py-2.5', skipped ? 'bg-muted/25 text-muted-foreground' : 'bg-card')}>
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary tabular">{index + 1}</span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[12.5px] leading-tight font-medium"><Icon className="size-3.5" />{step.title}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{skipped ? 'Manual — you start it from the dashboard.' : step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
