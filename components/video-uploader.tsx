'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileVideo,
  X,
  RotateCcw,
  Sparkles,
  Captions,
  Clapperboard,
  ArrowRight,
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
  uploadVideoFile,
} from '@/lib/upload-client';

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

export type FileItemStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'failed';

export interface UploadQueueItem {
  id: string;
  file: File;
  status: FileItemStatus;
  progress: UploadFileProgress | null;
  sessionId: string | null;
  videoId?: string;
  error?: string;
  pipelineSnapshot?: PipelineOptions;
}

export interface VideoUploaderProps {
  /** Automation to store on each uploaded video; defaults to the saved upload defaults. */
  pipeline: PipelineOptions;
}

function clonePipeline(pipeline: PipelineOptions): PipelineOptions {
  return {
    ...pipeline,
    viral: { ...pipeline.viral },
  };
}

export const VideoUploader: React.FC<VideoUploaderProps> = ({ pipeline }) => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<UploadQueueItem[]>([]);

  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const syncItems = (updater: (prev: UploadQueueItem[]) => UploadQueueItem[]) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  };

  const addFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((f) => f && f.size >= 0);
    if (incoming.length === 0) return;

    syncItems((prev) => {
      const existingKeys = new Set(
        prev.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`)
      );
      const additions: UploadQueueItem[] = [];
      for (const file of incoming) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        additions.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${additions.length}`,
          file,
          status: 'queued',
          progress: null,
          sessionId: null,
        });
      }
      return [...prev, ...additions];
    });
    setErrorMessage(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const removeItem = (id: string) => {
    const target = itemsRef.current.find((item) => item.id === id);
    if (!target || target.status === 'uploading' || target.status === 'finalizing') return;
    if (target.sessionId) {
      void deleteUploadSession(target.sessionId);
    }
    syncItems((prev) => prev.filter((item) => item.id !== id));
  };

  const uploadSingleItem = async (itemId: string): Promise<{ ok: boolean; videoId?: string; aborted?: boolean }> => {
    const current = itemsRef.current.find((entry) => entry.id === itemId);
    if (!current) return { ok: false };

    const snapshot = current.pipelineSnapshot ?? clonePipeline(pipeline);
    const controller = new AbortController();
    abortRef.current = controller;

    syncItems((prev) =>
      prev.map((entry) =>
        entry.id === itemId
          ? {
              ...entry,
              status: 'uploading',
              error: undefined,
              pipelineSnapshot: snapshot,
            }
          : entry
      )
    );

    try {
      const data = await uploadVideoFile(current.file, {
        sessionId: current.sessionId ?? undefined,
        signal: controller.signal,
        onSessionCreated: (sid) => {
          syncItems((prev) =>
            prev.map((entry) => (entry.id === itemId ? { ...entry, sessionId: sid } : entry))
          );
        },
        onProgress: (prog) => {
          syncItems((prev) =>
            prev.map((entry) => (entry.id === itemId ? { ...entry, progress: prog } : entry))
          );
        },
        onPhase: (phase) => {
          syncItems((prev) =>
            prev.map((entry) =>
              entry.id === itemId
                ? { ...entry, status: phase === 'finalizing' ? 'finalizing' : 'uploading' }
                : entry
            )
          );
        },
        pipeline: snapshot,
      });

      syncItems((prev) =>
        prev.map((entry) =>
          entry.id === itemId
            ? {
                ...entry,
                status: 'done',
                sessionId: null,
                videoId: data.video._id,
                error: undefined,
              }
            : entry
        )
      );
      return { ok: true, videoId: data.video._id };
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        syncItems((prev) =>
          prev.map((entry) =>
            entry.id === itemId
              ? {
                  ...entry,
                  status: 'queued',
                  progress: null,
                  sessionId: null,
                  error: undefined,
                }
              : entry
          )
        );
        return { ok: false, aborted: true };
      }

      const msg = err instanceof Error ? err.message : 'Failed to upload video';
      syncItems((prev) =>
        prev.map((entry) =>
          entry.id === itemId
            ? {
                ...entry,
                status: 'failed',
                error: msg,
              }
            : entry
        )
      );
      return { ok: false };
    } finally {
      abortRef.current = null;
    }
  };

  const runUploadQueue = async (onlyItemId?: string) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setErrorMessage(null);

    const targets = onlyItemId
      ? itemsRef.current.filter((item) => item.id === onlyItemId)
      : itemsRef.current.filter((item) => item.status === 'queued' || item.status === 'failed');

    let completedCount = 0;
    let failedCount = 0;
    let firstVideoId: string | undefined = itemsRef.current.find((i) => i.videoId)?.videoId;

    for (let idx = 0; idx < targets.length; idx += 1) {
      const target = targets[idx]!;
      // Ensure item was not removed while waiting in queue
      if (!itemsRef.current.some((entry) => entry.id === target.id)) continue;

      setStatusMessage(
        `Uploading ${idx + 1} of ${targets.length}: ${target.file.name}…`
      );

      const outcome = await uploadSingleItem(target.id);
      if (outcome.aborted) {
        setStatusMessage('Upload cancelled.');
        setIsProcessing(false);
        return;
      }
      if (outcome.ok) {
        completedCount += 1;
        if (!firstVideoId && outcome.videoId) {
          firstVideoId = outcome.videoId;
        }
      } else {
        failedCount += 1;
      }
    }

    setIsProcessing(false);

    const allDone =
      itemsRef.current.length > 0 &&
      itemsRef.current.every((i) => i.status === 'done');
    const resolvedFirstVideoId =
      itemsRef.current.find((i) => i.videoId)?.videoId ?? firstVideoId;

    if ((allDone || (completedCount > 0 && failedCount === 0)) && resolvedFirstVideoId) {
      setStatusMessage(
        `Uploaded ${itemsRef.current.length} video${itemsRef.current.length === 1 ? '' : 's'}. Opening dashboard…`
      );
      router.push(`/?videoId=${resolvedFirstVideoId}`);
    } else if (failedCount > 0) {
      setStatusMessage(
        completedCount > 0
          ? `${completedCount} uploaded, ${failedCount} failed. Retry failed files or continue to the dashboard.`
          : null
      );
      setErrorMessage(
        `${failedCount} file${failedCount === 1 ? '' : 's'} failed to upload. You can retry each failed file without re-uploading completed ones.`
      );
    }
  };

  const handleCancelActiveUpload = () => {
    const active = itemsRef.current.find(
      (item) => item.status === 'uploading' || item.status === 'finalizing'
    );
    abortRef.current?.abort();
    if (active?.sessionId) {
      void deleteUploadSession(active.sessionId);
    }
    syncItems((prev) =>
      prev.map((entry) =>
        entry.status === 'uploading' || entry.status === 'finalizing'
          ? {
              ...entry,
              status: 'queued',
              progress: null,
              sessionId: null,
              error: undefined,
            }
          : entry
      )
    );
    setIsProcessing(false);
    setStatusMessage('Upload cancelled.');
  };

  const pendingOrFailedCount = items.filter(
    (item) => item.status === 'queued' || item.status === 'failed'
  ).length;
  const doneItems = items.filter((item) => item.status === 'done');
  const firstSucceededVideoId = doneItems[0]?.videoId;

  const nextStep =
    pipeline.autoDetect && pipeline.autoRender
      ? 'transcript → viral detection → render'
      : pipeline.autoDetect
        ? 'transcript → viral detection'
        : 'transcript only';

  return (
    <div className="mx-auto w-full space-y-4">
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
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center outline-none transition-[border-color,background-color,box-shadow] duration-200',
          'focus-visible:ring-2 focus-visible:ring-ring/40',
          isProcessing && 'cursor-default opacity-90',
          isDragActive
            ? 'border-primary bg-accent shadow-[var(--shadow-lift)]'
            : items.length > 0
              ? 'border-primary/50 bg-accent/40'
              : 'border-input bg-muted/25 hover:border-ring hover:bg-muted/45'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*"
          onChange={handleFileChange}
          className="hidden"
        />

        <span
          className={cn(
            'flex size-12 items-center justify-center rounded-2xl transition-colors',
            items.length > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          )}
        >
          {isProcessing ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
        </span>

        <div>
          <p className="text-sm font-medium">
            {items.length > 0
              ? `${items.length} video${items.length === 1 ? '' : 's'} selected · Drop or click to add more`
              : 'Drop one or more videos here, or click to choose files'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            MP4, MOV, MKV, WEBM · multi-file batch upload · no size limit
          </p>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Videos upload sequentially in chunks and run{' '}
          <span className="font-medium text-foreground/70">{nextStep}</span> in FIFO order.
        </p>
      </div>

      {/* Per-file queue rows */}
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item, idx) => {
            const uploadedBytes = item.progress?.uploadedBytes ?? 0;
            const totalBytes = item.progress?.totalBytes ?? item.file.size ?? 0;
            const percent =
              item.status === 'done'
                ? 100
                : totalBytes > 0
                  ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
                  : 0;
            const isItemActive = item.status === 'uploading' || item.status === 'finalizing';

            return (
              <li
                key={item.id}
                className="rounded-xl border bg-card px-3.5 py-2.5 shadow-2xs space-y-2"
              >
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold tabular">
                      {idx + 1}
                    </span>
                    <FileVideo className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{item.file.name}</p>
                      <p className="text-[11px] text-muted-foreground tabular">
                        {formatFileSize(item.file.size)}
                        {item.status === 'queued' && ' · Queued'}
                        {item.status === 'uploading' &&
                          ` · Uploading ${percent}% (${formatSpeed(item.progress?.bytesPerSecond ?? 0)}${
                            item.progress?.etaSeconds !== null &&
                            item.progress?.etaSeconds !== undefined
                              ? `, ${formatDuration(item.progress.etaSeconds)} left`
                              : ''
                          })`}
                        {item.status === 'finalizing' && ' · Finalizing & probing…'}
                        {item.status === 'done' && ' · Uploaded'}
                        {item.status === 'failed' && ` · Failed${item.error ? `: ${item.error}` : ''}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {item.status === 'done' && (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    )}
                    {item.status === 'failed' && !isProcessing && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => void runUploadQueue(item.id)}
                      >
                        <RotateCcw className="size-3.5" />
                        Retry
                      </Button>
                    )}
                    {!isItemActive && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => removeItem(item.id)}
                        disabled={isProcessing && item.status === 'done'}
                        aria-label={`Remove ${item.file.name}`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {(isItemActive || item.status === 'done' || (item.status === 'failed' && uploadedBytes > 0)) && (
                  <Progress value={percent} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Action buttons */}
      {isProcessing ? (
        <Button variant="outline" size="lg" className="w-full" onClick={handleCancelActiveUpload}>
          <X />
          Cancel active upload
        </Button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          {pendingOrFailedCount > 0 && (
            <Button
              size="lg"
              className="flex-1"
              onClick={() => void runUploadQueue()}
            >
              <Upload />
              Upload {pendingOrFailedCount} video{pendingOrFailedCount === 1 ? '' : 's'} &amp; start pipeline
            </Button>
          )}
          {firstSucceededVideoId && (
            <Button
              variant={pendingOrFailedCount > 0 ? 'outline' : 'default'}
              size="lg"
              className="flex-1"
              onClick={() => router.push(`/?videoId=${firstSucceededVideoId}`)}
            >
              Open dashboard ({doneItems.length} uploaded)
              <ArrowRight />
            </Button>
          )}
        </div>
      )}

      {/* Feedback */}
      {errorMessage && (
        <Alert variant="destructive" className="animate-fade-in">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {statusMessage && (
        <Alert className="animate-fade-in">
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
