'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { PromptTemplate } from '@/lib/types';
import { PromptEditor } from '@/components/prompt-editor';
import { DEFAULT_PROMPT_TEMPLATES } from '@/lib/presets';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Info } from 'lucide-react';

export default function PromptTemplatesPage() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadTemplates = useCallback(async (): Promise<PromptTemplate[]> => {
    try {
      const res = await fetch('/api/prompt-templates');
      if (res.ok) {
        const data = await res.json();
        return data.templates || DEFAULT_PROMPT_TEMPLATES;
      }
    } catch (err) {
      console.error('Error fetching prompt templates:', err);
    }
    return DEFAULT_PROMPT_TEMPLATES;
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const list = await loadTemplates();
      if (ignore) return;
      setTemplates(list);
      setIsLoading(false);
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
      throw new Error('Failed to update prompt template');
    }

    setTemplates(await loadTemplates());
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="animate-fade-up space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Prompt templates</h1>
        <p className="text-sm text-muted-foreground">
          Customize the AI prompts used for viral segment detection and hook text
          generation.
        </p>
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-80 rounded-lg" />
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
        ) : (
          <PromptEditor
            initialTemplates={templates.length > 0 ? templates : DEFAULT_PROMPT_TEMPLATES}
            onSave={handleSaveTemplate}
          />
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
            where the timestamped transcript is injected, and must ask the model to return a
            strict JSON array with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">start</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">end</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">score</code>,{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">reason</code> and{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hookText</code> fields.
          </p>
          <p>
            <strong className="font-medium text-foreground">Hook text prompt</strong> — must
            contain{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {'{{clipTranscript}}'}
            </code>{' '}
            where the clip&apos;s transcript text is injected.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
