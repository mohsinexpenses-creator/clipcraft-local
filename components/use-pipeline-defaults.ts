'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_PIPELINE_OPTIONS, PipelineOptions } from '@/lib/types';
import { sanitizePipelineOptions } from '@/lib/pipeline-defaults';

/**
 * The automation defaults for the NEXT upload, persisted in localStorage and
 * shared between the upload page and the dashboard's settings panel.
 *
 * Stored in one place because the upload form and the dashboard must show the
 * same thing: what the pipeline will do when a video arrives. Per-video changes
 * go to the API (PATCH /api/videos/[id]) and never touch these defaults.
 */

const STORAGE_KEY = 'clipcraft.pipeline-defaults';
const LEGACY_VIRAL_KEY = 'clipcraft.viral-options';
const CHANGE_EVENT = 'clipcraft:pipeline-defaults-change';

let cachedRaw: string | null | undefined = undefined;
let cachedOptions: PipelineOptions = DEFAULT_PIPELINE_OPTIONS;

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

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

export function usePipelineDefaults(): [
  PipelineOptions,
  (next: Partial<PipelineOptions>) => void,
  () => void,
] {
  const options = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT_PIPELINE_OPTIONS);

  const setOptions = useCallback((patch: Partial<PipelineOptions>) => {
    const next = sanitizePipelineOptions({ ...readSnapshot(), ...patch });
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      // Keep the legacy key in sync so an older tab (or an old build) still
      // reads sensible AI options.
      window.localStorage.setItem(LEGACY_VIRAL_KEY, JSON.stringify(next.viral));
    } catch {
      // Storage full/unavailable - the values still apply to this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const reset = useCallback(() => {
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
