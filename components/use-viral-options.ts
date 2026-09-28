'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_VIRAL_OPTIONS, ViralDetectionOptions } from '@/lib/types';

const STORAGE_KEY = 'clipcraft.viral-options';
const CHANGE_EVENT = 'clipcraft:viral-options-change';

/**
 * Parsed snapshot cache so `getSnapshot` can return a stable reference between
 * reads (useSyncExternalStore re-renders whenever the snapshot identity
 * changes).
 */
let cachedRaw: string | null | undefined = undefined;
let cachedOptions: ViralDetectionOptions = DEFAULT_VIRAL_OPTIONS;

function readSnapshot(): ViralDetectionOptions {
  if (typeof window === 'undefined') return DEFAULT_VIRAL_OPTIONS;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_VIRAL_OPTIONS;
  }

  if (raw !== cachedRaw) {
    cachedRaw = raw;
    if (!raw) {
      cachedOptions = DEFAULT_VIRAL_OPTIONS;
    } else {
      try {
        cachedOptions = {
          ...DEFAULT_VIRAL_OPTIONS,
          ...(JSON.parse(raw) as Partial<ViralDetectionOptions>),
        };
      } catch {
        cachedOptions = DEFAULT_VIRAL_OPTIONS;
      }
    }
  }
  return cachedOptions;
}

function invalidateSnapshot() {
  // Force the next read to re-parse what is actually in localStorage.
  cachedRaw = undefined;
}

function subscribe(onStoreChange: () => void): () => void {
  // 'storage' covers other tabs; the custom event covers writes from this tab
  // (same-tab localStorage writes do not fire 'storage').
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

/**
 * The AI clip options (count / clip length range / hook text switch), persisted
 * in localStorage and restored across visits. Backed by useSyncExternalStore so
 * it is safe under both static and dynamic rendering (no effect, no hydration
 * mismatch).
 */
export function useViralOptions(): [
  ViralDetectionOptions,
  (next: ViralDetectionOptions) => void,
] {
  const options = useSyncExternalStore(
    subscribe,
    readSnapshot,
    () => DEFAULT_VIRAL_OPTIONS
  );

  const setOptions = useCallback((next: ViralDetectionOptions) => {
    invalidateSnapshot();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full/unavailable - the options still apply to this run.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [options, setOptions];
}
