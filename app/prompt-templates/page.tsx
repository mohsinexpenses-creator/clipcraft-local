'use client';

import React, { useState, useEffect } from 'react';
import { PromptTemplate } from '@/lib/types';
import { PromptEditor } from '@/components/prompt-editor';
import { DEFAULT_PROMPT_TEMPLATES } from '@/lib/presets';
import { Sparkles, Terminal } from 'lucide-react';

export default function PromptTemplatesPage() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTemplates = async () => {
    try {
      const res = await fetch('/api/prompt-templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates || DEFAULT_PROMPT_TEMPLATES);
      }
    } catch (err) {
      console.error('Error fetching prompt templates:', err);
      setTemplates(DEFAULT_PROMPT_TEMPLATES);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const handleSaveTemplate = async (template: PromptTemplate) => {
    const res = await fetch('/api/prompt-templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
    });

    if (!res.ok) {
      throw new Error('Failed to update prompt template');
    }

    await fetchTemplates();
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="border-b border-slate-800/80 pb-6 space-y-2">
        <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight flex items-center gap-3">
          <Sparkles className="h-8 w-8 text-amber-400" />
          LLM Prompt Templates Manager
        </h1>
        <p className="text-sm text-slate-400">
          View and customize the Gemini AI prompt templates used for (1) viral segment candidate detection and (2) short-form intro hook text overlay generation.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12 text-slate-500">
          Loading prompt templates...
        </div>
      ) : (
        <PromptEditor
          initialTemplates={templates.length > 0 ? templates : DEFAULT_PROMPT_TEMPLATES}
          onSave={handleSaveTemplate}
        />
      )}

      {/* Guidance Info Card */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6 space-y-3">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Terminal className="h-4 w-4 text-amber-400" />
          Template Variable Guidance
        </h3>
        <ul className="text-xs text-slate-400 space-y-2 leading-relaxed list-disc list-inside">
          <li>
            <strong className="text-slate-200">Viral Detection Prompt:</strong> Must contain <code className="text-amber-400 bg-slate-950 px-1.5 py-0.5 rounded">&#123;&#123;transcript&#125;&#125;</code> where the video transcript with timestamps will be injected. Must instruct Gemini to return a strict JSON array of objects with <code className="text-slate-300">start</code>, <code className="text-slate-300">end</code>, <code className="text-slate-300">score</code>, <code className="text-slate-300">reason</code>, and <code className="text-slate-300">hookText</code> fields.
          </li>
          <li>
            <strong className="text-slate-200">Hook Text Prompt:</strong> Must contain <code className="text-amber-400 bg-slate-950 px-1.5 py-0.5 rounded">&#123;&#123;clipTranscript&#125;&#125;</code> where the target clip's transcript text will be injected.
          </li>
        </ul>
      </div>
    </div>
  );
}
