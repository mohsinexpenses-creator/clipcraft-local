'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_PIPELINE_OPTIONS, PipelineOptions } from '@/lib/types';
import { sanitizePipelineOptions } from '@/lib/pipeline-defaults';

/**
 * The automation defaults for the NEXT upload, shared by the upload page and the
 * dashboard's settings panel.
 *
 * Two layers, deliberately:
 *
 *  - **Settings -> Pipeline** (server, SQLite) is the managed source. If a value is
 *    saved there it is applied to the browser store once, on load, so the upload form
 *    shows what the pipeline will really do - including on a different browser.
 *  - **localStorage** is the browser-side cache and the place an edit on the upload
 *    form goes. It keeps the form instant (no request before first paint) and lets a
 *    one-off change persist for the next upload without touching the managed defaults.
 *
 * Per-video changes go to the API (`PATCH /api/videos/[id]`) and never touch either.
 */

const STORAGE_KEY = 'clipcraft.pipeline-defaults';
const LEGACY_VIRAL_KEY = 'clipcraft.viral-options';
const CHANGE_EVENT = 'clipcraft:pipeline-defaults-change';

let cachedRaw: string | null | undefined = undefined;
let cachedOptions: PipelineOptions = DEFAULT_PIPELINE_OPTIONS;
/** Once the user edits the form, seeding from the server stops - edits win. */
let editedLocally = false;
let seedStarted = false;

function readSnapshot(): PipelineOptions {
  if (typeof window === 'undefined') return DEFAULT_PIPELINE_OPTIONS;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    // One-time upgrade: the panel used to store only the AI clip options.
    if (!raw) {
      const legacy = window.localStorage.getItem(LEGACY_VIRAL_KEY);
      if (legacy) raw = JSON.stringify({ viral: JSON.parse(legacy) });
    }
  } catch {
    return DEFAULT_PIPELINE_OPTIONS;
  }

  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedOptions = sanitizePipelineOptions(raw ? JSON.parse(raw) : {});
  }
  return cachedOptions;
}

function persist(next: PipelineOptions): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // Keep the legacy key in sync so an older tab (or an old build) still
    // reads sensible AI options.
    window.localStorage.setItem(LEGACY_VIRAL_KEY, JSON.stringify(next.viral));
  } catch {
    // Storage full/unavailable - the values still apply to this session.
  }
  cachedRaw = undefined; // Force the snapshot to be re-read on the next render.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

/**
 * Applies the managed defaults once per page load. Module-level and best-effort on
 * purpose: a settings request that fails must never block or change the upload form.
 */
async function seedFromServerDefaults(): Promise<void> {
  if (seedStarted || typeof window === 'undefined') return;
  seedStarted = true;

  try {
    const response = await fetch('/api/settings');
    if (!response.ok) return;
    const payload = (await response.json()) as { stored?: { pipeline?: unknown } };
    const stored = payload?.stored?.pipeline;
    if (!stored || editedLocally) return;

    const next = sanitizePipelineOptions(stored);
    if (JSON.stringify(next) !== JSON.stringify(readSnapshot())) persist(next);
  } catch {
    // Offline, dev-server restart, or settings unavailable: keep the local values.
  }
}

export function usePipelineDefaults(): [
  PipelineOptions,
  (next: Partial<PipelineOptions>) => void,
  () => void,
] {
  const options = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT_PIPELINE_OPTIONS);

  useEffect(() => {
    void seedFromServerDefaults();
  }, []);

  const setOptions = useCallback((patch: Partial<PipelineOptions>) => {
    editedLocally = true;
    persist(sanitizePipelineOptions({ ...readSnapshot(), ...patch }));
  }, []);

  const reset = useCallback(() => {
    editedLocally = true;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_VIRAL_KEY);
    } catch {
      // ignore
    }
    cachedRaw = undefined;
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [options, setOptions, reset];
}
