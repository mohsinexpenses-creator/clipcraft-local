'use client';

import React, { useState } from 'react';
import { PromptTemplate } from '@/lib/types';
import { Sparkles, Save, CheckCircle2, Loader2, HelpCircle } from 'lucide-react';

interface PromptEditorProps {
  initialTemplates: PromptTemplate[];
  onSave: (template: PromptTemplate) => Promise<void>;
}

export const PromptEditor: React.FC<PromptEditorProps> = ({
  initialTemplates,
  onSave,
}) => {
  const [selectedTypeId, setSelectedTypeId] = useState<string>(
    initialTemplates[0]?._id || 'prompt-viral-detection'
  );

  const activeTemplate =
    initialTemplates.find((t) => t._id === selectedTypeId || t.type === selectedTypeId) ||
    initialTemplates[0];

  const [systemPrompt, setSystemPrompt] = useState(activeTemplate?.systemPrompt || '');
  const [userTemplate, setUserTemplate] = useState(activeTemplate?.template || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSavingSuccess] = useState(false);

  const handleSelectType = (id: string) => {
    setSelectedTypeId(id);
    const tmpl = initialTemplates.find((t) => t._id === id || t.type === id);
    if (tmpl) {
      setSystemPrompt(tmpl.systemPrompt);
      setUserTemplate(tmpl.template);
      setSaveSavingSuccess(false);
    }
  };

  const handleSave = async () => {
    if (!activeTemplate) return;
    setIsSaving(true);
    setSaveSavingSuccess(false);

    try {
      await onSave({
        ...activeTemplate,
        systemPrompt,
        template: userTemplate,
        updatedAt: new Date().toISOString(),
      });
      setSaveSavingSuccess(true);
      setTimeout(() => setSaveSavingSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Template Type Selector Tabs */}
      <div className="flex border-b border-slate-800">
        {initialTemplates.map((t) => {
          const isActive = t._id === selectedTypeId || t.type === selectedTypeId;
          return (
            <button
              key={t._id}
              onClick={() => handleSelectType(t._id)}
              className={`flex items-center gap-2 px-5 py-3 border-b-2 text-sm font-semibold transition cursor-pointer ${
                isActive
                  ? 'border-amber-500 text-amber-400 bg-slate-900/60'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="h-4 w-4" />
              {t.name}
            </button>
          );
        })}
      </div>

      {activeTemplate && (
        <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
          <div>
            <h2 className="text-xl font-bold text-slate-100">{activeTemplate.name}</h2>
            <p className="text-xs text-slate-400 mt-1">{activeTemplate.description}</p>
          </div>

          {/* System Prompt Input */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              System Prompt (Claude Role Definition)
            </label>
            <textarea
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* User Prompt Template Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                User Prompt Template (Supports variables)
              </label>
              <div className="flex items-center gap-1 text-[11px] text-amber-400">
                <HelpCircle className="h-3.5 w-3.5" />
                <span>
                  {activeTemplate.type === 'viral_detection'
                    ? 'Use {{transcript}} variable'
                    : 'Use {{clipTranscript}} variable'}
                </span>
              </div>
            </div>
            <textarea
              rows={10}
              value={userTemplate}
              onChange={(e) => setUserTemplate(e.target.value)}
              className="w-full rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs font-mono text-slate-100 focus:border-amber-500 focus:outline-none leading-relaxed"
            />
          </div>

          {/* Save Action Bar */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            {saveSuccess ? (
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Prompt template saved successfully to MongoDB!
              </div>
            ) : (
              <span className="text-xs text-slate-500">
                Changes will take effect on the next AI analysis run.
              </span>
            )}

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white text-xs font-semibold shadow-lg shadow-rose-500/20 hover:opacity-95 transition cursor-pointer disabled:opacity-50"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Save Prompt Template
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
