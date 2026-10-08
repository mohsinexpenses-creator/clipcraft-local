"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { CaptionPreset, ClipRecord, OverlayStylePreset, PipelineOptions, TranscriptData, ViralDetectionOptions } from "@/lib/types"
import type { PipelineStatus } from "@/lib/pipeline-status"
import type { VideoListItem } from "@/lib/pipeline-ui"
import { useToast } from "@/components/ui/toaster"

/**
 * The dashboard's only data source.
 *
 * The pipeline runs unattended, so this hook exists so no component has to
 * remember to refresh anything: it polls while work is in flight (2s), slows
 * down to 12s when idle, pauses while the tab is hidden, and refreshes right
 * after every action. The clip grid, the stepper and the sidebar rows all read
 * from here, so they can never disagree mid-run.
 */

export interface PipelineDetail {
  video: {
    _id: string
    originalName: string
    fileName: string
    fileBase?: string
    duration: number
    width: number
    height: number
    fileSize: number
    status: "uploaded" | "transcribing" | "transcribed" | "failed"
    transcriptionProvider?: "deepgram" | "whisper.cpp"
    transcriptionModel?: string
    pipeline?: PipelineOptions
    error?: string
    createdAt: string
    updatedAt: string
  }
  transcriptReady: boolean
  clips: ClipRecord[]
  status: PipelineStatus
}

/** Poll fast while anything is moving, lazily when the video is finished. */
const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 12000;

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return (typeof data?.error === "string" && data.error) || fallback;
  } catch {
    return fallback;
  }
}

async function requestJson<T>(url: string, init?: RequestInit & { fallbackError?: string }): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(await readError(response, init?.fallbackError ?? `Request to ${url} failed.`));
  }
  return (await response.json()) as T;
}

export function usePipeline(selectedVideoId: string | null) {
  const router = useRouter();
  const { toast } = useToast();

  const [videos, setVideos] = React.useState<VideoListItem[]>([]);
  // Both caches are keyed by video id. Switching videos therefore cannot flash the
  // previous video's data, and no effect has to "reset" state on a dependency change.
  const [detailEntry, setDetailEntry] = React.useState<{
    videoId: string;
    data: PipelineDetail;
  } | null>(null);
  const [transcriptEntry, setTranscriptEntry] = React.useState<{
    videoId: string;
    data: TranscriptData;
  } | null>(null);
  const [captionPresets, setCaptionPresets] = React.useState<CaptionPreset[]>([]);
  const [overlayPresets, setOverlayPresets] = React.useState<OverlayStylePreset[]>([]);
  const [isTranscriptLoading, setTranscriptLoading] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const detail =
    selectedVideoId && detailEntry?.videoId === selectedVideoId ? detailEntry.data : null;
  const transcript =
    selectedVideoId && transcriptEntry?.videoId === selectedVideoId ? transcriptEntry.data : null;

  const videosRequest = React.useRef(0);

  const loadVideos = React.useCallback(async () => {
    const requestId = ++videosRequest.current;
    try {
      const data = await requestJson<{ videos: VideoListItem[] }>("/api/videos", {
        fallbackError: "Failed to load videos.",
      });
      if (requestId !== videosRequest.current) return data.videos ?? [];
      setVideos(data.videos ?? []);
      setListError(null);
      return data.videos ?? [];
    } catch (error) {
      if (requestId === videosRequest.current) {
        setListError(error instanceof Error ? error.message : "Failed to load videos.");
      }
      return [];
    } finally {
      if (requestId === videosRequest.current) setIsLoading(false);
    }
  }, []);

  const loadDetail = React.useCallback(
    async (videoId: string | null, options: { silent?: boolean } = {}) => {
      if (!videoId) return null;
      if (!options.silent) setBusy("refresh");
      try {
        const data = await requestJson<PipelineDetail>(`/api/videos/${videoId}/pipeline`, {
          fallbackError: "Failed to load pipeline status.",
        });
        setDetailEntry({ videoId, data });
        setListError(null);
        return data;
      } catch (error) {
        if (!options.silent) {
          setListError(error instanceof Error ? error.message : "Failed to load pipeline status.");
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const loadPresets = React.useCallback(async () => {
    try {
      const [captions, overlays] = await Promise.all([
        requestJson<{ presets: CaptionPreset[] }>("/api/caption-presets"),
        requestJson<{ presets: OverlayStylePreset[] }>("/api/overlay-presets"),
      ]);
      setCaptionPresets(captions.presets ?? []);
      setOverlayPresets(overlays.presets ?? []);
    } catch {
      // The editor falls back to the stored preset ids when presets cannot load.
    }
  }, []);

  // First paint: library + presets. The fetches are started in a microtask so the
  // effect body itself never updates state - React renders once instead of twice -
  // while still landing before the browser paints.
  React.useEffect(() => {
    queueMicrotask(() => {
      void loadVideos();
      void loadPresets();
    });
  }, [loadVideos, loadPresets]);

  // Selected video changed: fetch its detail immediately.
  React.useEffect(() => {
    if (!selectedVideoId) return;
    queueMicrotask(() => {
      void loadDetail(selectedVideoId);
    });
  }, [selectedVideoId, loadDetail]);

  // Polling: fast while a step runs, slow otherwise, never while hidden.
  React.useEffect(() => {
    if (!selectedVideoId) return;
    const active =
      detail?.status.stage === "transcribing" ||
      detail?.status.stage === "analyzing" ||
      detail?.status.stage === "rendering";
    const interval = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadDetail(selectedVideoId, { silent: true });
      void loadVideos();
    };
    const id = setInterval(tick, interval);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedVideoId, detail?.status.stage, loadDetail, loadVideos]);

  /** Run `action`, then refresh everything once and report the outcome. */
  const run = React.useCallback(
    async <T,>(
      key: string,
      action: () => Promise<T>,
      feedback?: { success?: string; onDone?: (result: T) => void }
    ): Promise<T | null> => {
      setBusy(key);
      try {
        const result = await action();
        feedback?.onDone?.(result);
        if (feedback?.success) toast({ title: feedback.success, tone: "success" });
        // Pull immediately: the user should see the new state, not wait for a poll.
        await Promise.all([loadVideos(), loadDetail(selectedVideoId, { silent: true })]);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "That did not work.";
        toast({ title: "Action failed", description: message, tone: "error" });
        await Promise.all([loadVideos(), loadDetail(selectedVideoId, { silent: true })]);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [loadDetail, loadVideos, selectedVideoId, toast]
  );

  const selectVideo = React.useCallback(
    (videoId: string) => {
      router.push(`/?videoId=${videoId}`, { scroll: false });
    },
    [router]
  );

  const refresh = React.useCallback(async () => {
    await Promise.all([loadVideos(), loadDetail(selectedVideoId)]);
  }, [loadDetail, loadVideos, selectedVideoId]);

  const transcribe = React.useCallback(
    (videoId: string) =>
      run("transcribe", () => requestJson(`/api/videos/${videoId}/transcript`, { method: "POST" }), {
        success: "Transcription queued — detection and rendering follow automatically.",
      }),
    [run]
  );

  const detect = React.useCallback(
    (videoId: string, options: ViralDetectionOptions, autoRender: boolean) =>
      run(
        "detect",
        () =>
          requestJson(`/api/videos/${videoId}/detect-viral`, {
            method: "POST",
            body: JSON.stringify({ options, autoRender }),
          }),
        { success: "Viral detection started — clips appear as they are found." }
      ),
    [run]
  );

  const resume = React.useCallback(
    (videoId: string) =>
      run(`resume:${videoId}`, () => requestJson(`/api/videos/${videoId}/pipeline`, { method: "POST" }), {
        success: "Pipeline nudged — the next step is queued.",
      }),
    [run]
  );

  const renderAll = React.useCallback(
    (videoId: string, body: Record<string, unknown> = {}) =>
      run("renderAll", () => requestJson(`/api/videos/${videoId}/render`, { method: "POST", body: JSON.stringify(body) }), {
        success: "Renders queued.",
      }),
    [run]
  );

  const renderClip = React.useCallback(
    (clip: ClipRecord) =>
      run(
        `render:${clip._id}`,
        () =>
          requestJson<{ clip: ClipRecord }>("/api/clips", {
            method: "POST",
            body: JSON.stringify({ clipId: clip._id, videoId: clip.videoId }),
          }),
        { success: "Render queued for this clip." }
      ),
    [run]
  );

  const saveClip = React.useCallback(
    (clip: ClipRecord, edits: Record<string, unknown>, andRender: boolean) =>
      run(
        `save:${clip._id}`,
        async () => {
          if (!andRender) {
            return await requestJson(`/api/clips/${clip._id}`, {
              method: "PATCH",
              body: JSON.stringify(edits),
            });
          }
          // Save + render in one request: /api/clips applies the same fields and
          // queues the job, so there is no window where the edit is saved but the
          // render still uses the old settings.
          return await requestJson("/api/clips", {
            method: "POST",
            body: JSON.stringify({ clipId: clip._id, videoId: clip.videoId, ...edits }),
          });
        },
        { success: andRender ? "Clip updated — re-rendering." : "Clip updated." }
      ),
    [run]
  );

  const cancelClip = React.useCallback(
    (clip: ClipRecord) =>
      run(`cancel:${clip._id}`, () => requestJson(`/api/clips/${clip._id}/cancel`, { method: "POST" }), {
        success: "Cancellation requested — the worker stops within a couple of seconds.",
      }),
    [run]
  );

  const deleteClip = React.useCallback(
    (clip: ClipRecord) =>
      run(`delete:${clip._id}`, () => requestJson(`/api/clips/${clip._id}`, { method: "DELETE" }), {
        success: "Clip deleted.",
      }),
    [run]
  );

  const deleteVideo = React.useCallback(
    (videoId: string) =>
      run(
        `delete-video:${videoId}`,
        () => requestJson(`/api/videos/${videoId}`, { method: "DELETE" }),
        {
          success: "Video deleted.",
          onDone: () => {
            setTranscriptEntry(null);
            setDetailEntry(null);
            router.push("/", { scroll: false });
          },
        }
      ),
    [run, router]
  );

  /** Persist automation changes (auto-detect / auto-render / AI clip options). */
  const saveAutomation = React.useCallback(
    (videoId: string, pipeline: Partial<PipelineOptions>) =>
      run(`automation:${videoId}`, () =>
        requestJson(`/api/videos/${videoId}`, {
          method: "PATCH",
          body: JSON.stringify({ pipeline }),
        })
      ),
    [run]
  );

  /**
   * Transcript text is only needed when someone asks to see it, so it is fetched
   * lazily and cached per video. `force` refetches after a re-transcription.
   */
  const loadTranscript = React.useCallback(
    async (videoId: string, options: { force?: boolean } = {}) => {
      if (!options.force && transcriptEntry?.videoId === videoId) return;
      setTranscriptLoading(true);
      try {
        const data = await requestJson<{ transcript: TranscriptData | null }>(
          `/api/videos/${videoId}/transcript`
        );
        if (data.transcript) setTranscriptEntry({ videoId, data: data.transcript });
      } catch (error) {
        toast({
          title: "Transcript unavailable",
          description: error instanceof Error ? error.message : "Failed to load the transcript.",
          tone: "error",
        });
      } finally {
        setTranscriptLoading(false);
      }
    },
    [toast, transcriptEntry]
  );

  return {
    videos,
    detail,
    clips: detail?.clips ?? [],
    status: detail?.status ?? null,
    captionPresets,
    overlayPresets,
    transcript,
    isTranscriptLoading,
    isLoading,
    isRefreshing: busy === "refresh",
    busy,
    listError,
    selectVideo,
    refresh,
    transcribe,
    detect,
    resume,
    renderAll,
    renderClip,
    saveClip,
    cancelClip,
    deleteClip,
    deleteVideo,
    saveAutomation,
    loadTranscript,
  };
}

export type PipelineController = ReturnType<typeof usePipeline>;
