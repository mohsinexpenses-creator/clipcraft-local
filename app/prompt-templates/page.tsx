'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { PromptTemplate } from '@/lib/types';
import { PromptEditor } from '@/components/prompt-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Info, Loader2, RotateCcw } from 'lucide-react';

async function getErrorFromResponse(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export default function PromptTemplatesPage() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadTemplates = useCallback(async (): Promise<PromptTemplate[]> => {
    const res = await fetch('/api/prompt-templates');
    if (!res.ok) {
      throw new Error(await getErrorFromResponse(res, 'Failed to load prompt templates.'));
    }

    const data = await res.json();
    return data.templates || [];
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const list = await loadTemplates();
        if (ignore) return;
        setTemplates(list);
        setErrorMessage(null);
      } catch (err) {
        if (!ignore) {
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load prompt templates.');
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [loadTemplates]);

  const handleSaveTemplate = async (template: PromptTemplate) => {
    const res = await fetch('/api/prompt-templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
    });

    if (!res.ok) {
      throw new Error(await getErrorFromResponse(res, 'Failed to update prompt template.'));
    }

    setTemplates(await loadTemplates());
    setErrorMessage(null);
  };

  const handleResetDefaults = async () => {
    if (
      !confirm(
        'Restore the built-in prompt templates? Your edits to the built-in templates will be overwritten. Custom templates you created are kept.'
      )
    ) {
      return;
    }

    setIsResetting(true);
    try {
      const res = await fetch('/api/prompt-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      });

      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to reset prompt templates.'));
      }

      setTemplates(await loadTemplates());
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to reset prompt templates.');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="animate-fade-up flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Prompt templates</h1>
          <p className="text-sm text-muted-foreground">
            Customize the AI prompts used for viral segment detection and hook text
            generation.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={isResetting}
          onClick={handleResetDefaults}
          title="Restore the built-in prompt templates shipped with the app"
        >
          {isResetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Reset to defaults
        </Button>
      </div>

      {errorMessage && (
        <Alert variant="destructive" className="animate-fade-up">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <div className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-80 rounded-lg" />
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
        ) : templates.length > 0 ? (
          <PromptEditor
            initialTemplates={templates}
            onSave={handleSaveTemplate}
          />
        ) : (
          <Card>
            <CardContent className="py-10 text-sm text-muted-foreground">
              No prompt templates were found in SQLite. Restart the app to seed the default templates.
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="size-4 text-muted-foreground" />
            Template variables
          </CardTitle>
          <CardDescription>
            Keep these placeholders in your prompts so the right data gets injected
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">Viral detection prompt</strong> —
            must contain{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{transcript}}'}
            </code>{' '}
            where the timestamped transcript is injected. The optional{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{clipCount}}'}
            </code>,{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{minClipDuration}}'}
            </code>{' '}and{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{maxClipDuration}}'}
            </code>{' '}
            placeholders are filled from the AI clip options on the dashboard. The model must
            return a strict JSON array with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">start</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">end</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">score</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">reason</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hookText</code> and the
            optional packaging fields (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">title</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">ctaText</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hashtags</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">scores</code>…).
          </p>
          <p>
            <strong className="font-medium text-foreground">Hook text prompt</strong> — must
            contain{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{clipTranscript}}'}
            </code>{' '}
            where the clip&apos;s transcript text is injected.
          </p>
          <p>
            <strong className="font-medium text-foreground">CTA prompt</strong> — also uses{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{clipTranscript}}'}
            </code>{' '}
            and should return only a short end-of-video CTA string.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
