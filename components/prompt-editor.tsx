'use client';

import React, { useState } from 'react';
import { PromptTemplate } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Loader2, Save, Sparkles } from 'lucide-react';

interface PromptEditorProps {
  initialTemplates: PromptTemplate[];
  onSave: (template: PromptTemplate) => Promise<void>;
}

export const PromptEditor: React.FC<PromptEditorProps> = ({ initialTemplates, onSave }) => {
  const [selectedTypeId, setSelectedTypeId] = useState<string>(
    initialTemplates[0]?._id || 'prompt-viral-detection'
  );

  const activeTemplate =
    initialTemplates.find((t) => t._id === selectedTypeId || t.type === selectedTypeId) ||
    initialTemplates[0];

  const [systemPrompt, setSystemPrompt] = useState(activeTemplate?.systemPrompt || '');
  const [userTemplate, setUserTemplate] = useState(activeTemplate?.template || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSelectType = (id: string) => {
    setSelectedTypeId(id);
    const tmpl = initialTemplates.find((t) => t._id === id || t.type === id);
    if (tmpl) {
      setSystemPrompt(tmpl.systemPrompt);
      setUserTemplate(tmpl.template);
      setSaveSuccess(false);
    }
  };

  const handleSave = async () => {
    if (!activeTemplate) return;
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      await onSave({
        ...activeTemplate,
        systemPrompt,
        template: userTemplate,
        updatedAt: new Date().toISOString(),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (!activeTemplate) return null;

  const variableHints =
    activeTemplate.type === 'viral_detection'
      ? ['{{transcript}}', '{{clipCount}}', '{{minClipDuration}}', '{{maxClipDuration}}']
      : ['{{clipTranscript}}'];

  return (
    <div className="space-y-4">
      {/* Template selector */}
      <div className="flex flex-wrap gap-2">
        {initialTemplates.map((t) => {
          const isActive = t._id === selectedTypeId || t.type === selectedTypeId;
          return (
            <button
              key={t._id}
              onClick={() => handleSelectType(t._id)}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                isActive
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Sparkles className="size-3.5" />
              {t.name}
            </button>
          );
        })}
      </div>

      <Card className="gap-5 animate-fade-in" key={activeTemplate._id}>
        <CardHeader>
          <CardTitle className="text-base">{activeTemplate.name}</CardTitle>
          <CardDescription>{activeTemplate.description}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="system-prompt">System prompt</Label>
            <Textarea
              id="system-prompt"
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Defines the AI's role and expertise…"
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="user-template">Prompt template</Label>
              <div className="flex flex-wrap gap-1.5">
                {variableHints.map((hint) => (
                  <Badge key={hint} variant="secondary" className="font-mono">
                    {hint}
                  </Badge>
                ))}
              </div>
            </div>
            <Textarea
              id="user-template"
              rows={10}
              value={userTemplate}
              onChange={(e) => setUserTemplate(e.target.value)}
              className="font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              The variables above are replaced with the transcript and the AI clip options when the
              AI runs. Changes apply to the next AI analysis run.
            </p>
          </div>
        </CardContent>

        <CardFooter className="justify-between border-t pt-5">
          {saveSuccess ? (
            <span className="flex animate-fade-in items-center gap-1.5 text-xs font-medium text-primary">
              <CheckCircle2 />
              Template saved
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Changes apply to the next AI analysis run
            </span>
          )}

          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            Save template
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};
