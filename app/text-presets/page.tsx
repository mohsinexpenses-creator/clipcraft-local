'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { TextPreset } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Pencil, Plus, Save, Trash2, X } from 'lucide-react';

async function getErrorFromResponse(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

interface PresetListProps {
  kind: TextPreset['kind'];
  presets: TextPreset[];
  onChange: () => Promise<void>;
  onError: (message: string | null) => void;
  placeholder: string;
}

function PresetList({ kind, presets, onChange, onError, placeholder }: PresetListProps) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch('/api/text-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text }),
      });
      if (!res.ok) throw new Error(await getErrorFromResponse(res, 'Failed to add preset.'));
      setDraft('');
      await onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add preset.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch('/api/text-presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _id: id, text }),
      });
      if (!res.ok) throw new Error(await getErrorFromResponse(res, 'Failed to save preset.'));
      setEditingId(null);
      await onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save preset.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this text preset?')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/text-presets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _id: id }),
      });
      if (!res.ok) throw new Error(await getErrorFromResponse(res, 'Failed to delete preset.'));
      await onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete preset.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          maxLength={60}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd();
          }}
        />
        <Button onClick={() => void handleAdd()} disabled={busy || !draft.trim()} className="shrink-0">
          <Plus />
          Add
        </Button>
      </div>

      <ul className="space-y-2">
        {presets.length === 0 && (
          <li className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            No {kind} presets yet - add one above.
          </li>
        )}
        {presets.map((preset) => (
          <li
            key={preset._id}
            className="flex items-center gap-2 rounded-lg border bg-background/60 px-3 py-2"
          >
            {editingId === preset._id ? (
              <>
                <Input
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  maxLength={60}
                  className="h-8 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveEdit(preset._id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={busy}
                  onClick={() => void handleSaveEdit(preset._id)}
                  title="Save"
                >
                  <Save className="size-4 text-emerald-600 dark:text-emerald-400" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={busy}
                  onClick={() => setEditingId(null)}
                  title="Cancel"
                >
                  <X className="size-4" />
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 truncate text-sm font-medium">{preset.text}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => {
                    setEditingId(preset._id);
                    setEditText(preset.text);
                  }}
                  title="Edit"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 hover:text-destructive"
                  disabled={busy}
                  onClick={() => void handleDelete(preset._id)}
                  title="Delete"
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TextPresetsPage() {
  const [presets, setPresets] = useState<TextPreset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadPresets = useCallback(async () => {
    const res = await fetch('/api/text-presets');
    if (!res.ok) {
      throw new Error(await getErrorFromResponse(res, 'Failed to load text presets.'));
    }
    const data = await res.json();
    setPresets(data.presets || []);
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/text-presets');
        if (!res.ok) {
          throw new Error(await getErrorFromResponse(res, 'Failed to load text presets.'));
        }
        const data = await res.json();
        if (ignore) return;
        setPresets(data.presets || []);
      } catch (err) {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load text presets.');
        }
      } finally {
        if (!ignore) setIsLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const hookPresets = presets.filter((p) => p.kind === 'hook');
  const ctaPresets = presets.filter((p) => p.kind === 'cta');

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Text Presets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Reusable overlay texts for the intro hook and the end CTA. Pick one on any clip card, or
          add/edit your own here - presets are saved to your local MongoDB.
        </p>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Intro hook presets</CardTitle>
              <CardDescription>
                Shown over the duplicated hook intro at the start of the clip.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PresetList
                kind="hook"
                presets={hookPresets}
                onChange={loadPresets}
                onError={setErrorMessage}
                placeholder="e.g. WATCH THIS FIRST"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">End CTA presets</CardTitle>
              <CardDescription>
                Shown over the last 2-3 seconds to push follows / comments.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PresetList
                kind="cta"
                presets={ctaPresets}
                onChange={loadPresets}
                onError={setErrorMessage}
                placeholder="e.g. FOLLOW FOR MORE"
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
