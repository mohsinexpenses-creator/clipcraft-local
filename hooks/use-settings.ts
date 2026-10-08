"use client";

import * as React from "react";
import { AppSettings, AppSettingsSection, AppSettingsSnapshot } from "@/lib/types";
import { useToast } from "@/components/ui/toaster";

/** One provider probe, mirrored from `lib/settings-verify.ts` (kept structural so the client needs no server import). */
export interface VerifyResult {
  target: "gemini" | "deepgram";
  status: "ok" | "rejected" | "limited" | "unreachable" | "error";
  label: string;
  message: string;
  latencyMs?: number;
  httpStatus?: number;
  models?: string[];
  notes?: string[];
}

export interface SettingsOptions {
  captionPresets: Array<{ id: string; name: string; isDefault: boolean }>;
  overlayPresets: Array<{ id: string; kind: "hook" | "cta"; name: string; isDefault: boolean }>;
}

export interface SettingsPayload extends AppSettingsSnapshot {
  /** The lists the selects are built from, sent with the snapshot so the page is one request. */
  options: SettingsOptions;
}

export type SettingsBusy =
  | "load"
  | `save:${AppSettingsSection}`
  | `reset:${AppSettingsSection}`
  | "verify:gemini"
  | "verify:deepgram"
  | "verify:all"
  | null;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(String(data.error ?? data.message ?? `Request to ${url} failed.`));
  }
  return data as T;
}

/**
 * The Settings page's only data source.
 *
 * One snapshot for the whole page: every card edits a local draft of its own section
 * and PUTs that section, and the server's answer (the recomputed snapshot, with the
 * `app` / `env` / `default` provenance per field) replaces the page state. That is why
 * saving a section you did not touch is impossible, and why the page can honestly show
 * "from .env.local" next to a value it never stored.
 */
export function useSettings() {
  const { toast } = useToast();
  const [payload, setPayload] = React.useState<SettingsPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<SettingsBusy>(null);
  const [results, setResults] = React.useState<VerifyResult[]>([]);
  // Bumped on every payload replace. The key-management card uses it as a React `key`,
  // so its local draft state is rebuilt from the fresh snapshot instead of being
  // re-synced from an effect.
  const [revision, setRevision] = React.useState(0);

  const load = React.useCallback(async () => {
    setBusy("load");
    try {
      const data = await requestJson<SettingsPayload>("/api/settings");
      setPayload(data);
      setRevision((current) => current + 1);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load settings.");
    } finally {
      setBusy(null);
    }
  }, []);

  // Deferred one microtask so the effect body itself performs no state update.
  React.useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const save = React.useCallback(
    async (section: AppSettingsSection, value: object) => {
      setBusy(`save:${section}`);
      try {
        const data = await requestJson<SettingsPayload>("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ section, value }),
        });
        setPayload(data);
        setRevision((current) => current + 1);
        setError(null);
        toast({ title: "Settings saved", description: settingsToastNote(section), tone: "success" });
        return true;
      } catch (caught) {
        toast({
          title: "Could not save",
          description: caught instanceof Error ? caught.message : "The server refused these settings.",
          tone: "error",
        });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast]
  );

  const reset = React.useCallback(
    async (section: AppSettingsSection) => {
      setBusy(`reset:${section}`);
      try {
        const data = await requestJson<SettingsPayload>(`/api/settings?section=${section}`, {
          method: "DELETE",
        });
        setPayload(data);
        setRevision((current) => current + 1);
        setResults((current) => current.filter((result) => section !== "ai" || result.target !== "gemini"));
        toast({
          title: "Section cleared",
          description: "Values fall back to .env.local and the built-in defaults.",
          tone: "success",
        });
        return true;
      } catch (caught) {
        toast({
          title: "Could not reset",
          description: caught instanceof Error ? caught.message : "The server refused the reset.",
          tone: "error",
        });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast]
  );

  const verify = React.useCallback(
    async (input: {
      target: "gemini" | "deepgram" | "all";
      candidates?: Record<string, string | undefined>;
      withGeneration?: boolean;
      keyIndex?: number;
    }) => {
      setBusy(`verify:${input.target}`);
      try {
        const data = await requestJson<{ results: VerifyResult[] }>("/api/settings/verify", {
          method: "POST",
          body: JSON.stringify(input),
        });
        setResults((current) => {
          const kept = current.filter(
            (result) => !data.results.some((fresh) => fresh.target === result.target && fresh.label === result.label)
          );
          return [...kept, ...data.results];
        });
        return data.results;
      } catch (caught) {
        toast({
          title: "Verification failed",
          description: caught instanceof Error ? caught.message : "The probe could not run.",
          tone: "error",
        });
        return [];
      } finally {
        setBusy(null);
      }
    },
    [toast]
  );

  const effective: AppSettings | null = payload?.effective ?? null;

  return {
    payload,
    effective,
    sources: payload?.sources ?? {},
    stored: payload?.stored ?? {},
    configured: payload?.configured ?? [],
    restartRequired: payload?.restartRequired ?? [],
    env: payload?.env ?? {},
    limits: payload?.limits,
    options: payload?.options ?? { captionPresets: [], overlayPresets: [] },
    revision,
    isLoading: payload === null && busy === "load",
    busy,
    error,
    results,
    clearResults: () => setResults([]),
    reload: load,
    save,
    reset,
    verify,
  };
}

/** A saved section is only useful if the user knows what it changes - and when it needs a restart. */
function settingsToastNote(section: AppSettingsSection): string {
  switch (section) {
    case "pipeline":
      return "Used for the next upload, and for videos that have no settings of their own.";
    case "render":
      return "Applies to clips nobody has edited - including the automatic render.";
    case "ai":
      return "Used from the next AI call and the next transcription onwards.";
    case "worker":
      return "Clip and detection concurrency apply after the worker restarts.";
    case "profanity":
      return "Applies to the next render; captions and overlay text stay masked either way.";
    default:
      return "";
  }
}

