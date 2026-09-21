'use client';

import React, { useState, useEffect } from 'react';
import { CaptionPreset } from '@/lib/types';
import { CaptionPreview } from '@/components/caption-preview';
import { DEFAULT_CAPTION_PRESETS } from '@/lib/presets';
import { Sliders, Plus, Save, Trash2, CheckCircle2, Loader2, Sparkles, Type } from 'lucide-react';

export default function CaptionPresetsPage() {
  const [presets, setPresets] = useState<CaptionPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [activePreset, setActivePreset] = useState<CaptionPreset>(DEFAULT_CAPTION_PRESETS[0]);
  const [sampleHookText, setSampleHookText] = useState('THE 1 SECRET YOU WERE NEVER TOLD');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchPresets = async () => {
    try {
      const res = await fetch('/api/caption-presets');
      if (res.ok) {
        const data = await res.json();
        const list = data.presets || DEFAULT_CAPTION_PRESETS;
        setPresets(list);
        if (!activePresetId && list.length > 0) {
          setActivePresetId(list[0]._id);
          setActivePreset(list[0]);
        }
      }
    } catch (err) {
      console.error('Error loading presets:', err);
    }
  };

  useEffect(() => {
    fetchPresets();
  }, []);

  const handleSelectPreset = (id: string) => {
    setActivePresetId(id);
    const found = presets.find((p) => p._id === id);
    if (found) {
      setActivePreset({ ...found });
      setSaveSuccess(false);
    }
  };

  const handleCreateNewPreset = () => {
    const newPreset: CaptionPreset = {
      _id: `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: 'Custom New Preset',
      fontFamily: 'Inter, sans-serif',
      fontSize: 50,
      fontWeight: 'bold',
      textColor: '#FFFFFF',
      highlightColor: '#FFE600',
      strokeColor: '#000000',
      strokeWidth: 3,
      positionY: 28,
      animationStyle: 'karaoke',
      uppercase: true,
      isDefault: false,
    };

    setPresets([newPreset, ...presets]);
    setActivePresetId(newPreset._id);
    setActivePreset(newPreset);
    setSaveSuccess(false);
  };

  const handleSavePreset = async () => {
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      const res = await fetch('/api/caption-presets', {
        method: activePreset._id.startsWith('preset-') ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activePreset),
      });

      if (res.ok) {
        setSaveSuccess(true);
        await fetchPresets();
        setTimeout(() => setSaveSuccess(false), 3000);
      }
    } catch (err) {
      console.error('Error saving preset:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePreset = async (id: string) => {
    if (!confirm('Are you sure you want to delete this preset?')) return;
    try {
      await fetch(`/api/caption-presets?id=${id}`, { method: 'DELETE' });
      await fetchPresets();
    } catch (err) {
      console.error('Error deleting preset:', err);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800/80 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight flex items-center gap-3">
            <Sliders className="h-8 w-8 text-amber-400" />
            Caption Presets & Live Preview
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Customize caption typography, active word highlight colors, stroke outlines, and animation styles with a live Remotion Player preview.
          </p>
        </div>

        <button
          onClick={handleCreateNewPreset}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-semibold text-sm shadow-lg shadow-rose-500/20 hover:opacity-95 transition cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Create New Preset
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Preset Controls Editor */}
        <div className="lg:col-span-7 space-y-6">
          {/* Preset Selector Tabs */}
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => {
              const isActive = p._id === activePresetId;
              return (
                <button
                  key={p._id}
                  onClick={() => handleSelectPreset(p._id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer border ${
                    isActive
                      ? 'border-amber-500 bg-amber-500/10 text-amber-400 shadow-md shadow-amber-500/5'
                      : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Type className="h-3.5 w-3.5" />
                  <span>{p.name}</span>
                </button>
              );
            })}
          </div>

          {/* Preset Settings Form */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-5 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-400" />
                Customize Preset Style
              </h2>

              {!activePreset.isDefault && (
                <button
                  onClick={() => handleDeletePreset(activePreset._id)}
                  className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                  title="Delete preset"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Preset Name */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-300 mb-1">Preset Name</label>
                <input
                  type="text"
                  value={activePreset.name}
                  onChange={(e) => setActivePreset({ ...activePreset, name: e.target.value })}
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              {/* Sample Hook Text */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-300 mb-1">Sample Hook Intro Text (Live Preview)</label>
                <input
                  type="text"
                  value={sampleHookText}
                  onChange={(e) => setSampleHookText(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              {/* Animation Style */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Animation Style</label>
                <select
                  value={activePreset.animationStyle}
                  onChange={(e) => setActivePreset({ ...activePreset, animationStyle: e.target.value as any })}
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="karaoke">Karaoke Word Fill</option>
                  <option value="word-pop">Word Pop Scale</option>
                  <option value="fade-in">Clean Fade In</option>
                  <option value="static">Static Block</option>
                </select>
              </div>

              {/* Font Weight */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Font Weight</label>
                <select
                  value={activePreset.fontWeight}
                  onChange={(e) => setActivePreset({ ...activePreset, fontWeight: e.target.value as any })}
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                  <option value="extra-bold">Extra Bold</option>
                  <option value="black">Black Heavy</option>
                </select>
              </div>

              {/* Font Size Slider */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1">
                  <span>Font Size</span>
                  <span className="text-amber-400">{activePreset.fontSize}px</span>
                </div>
                <input
                  type="range"
                  min="24"
                  max="72"
                  value={activePreset.fontSize}
                  onChange={(e) => setActivePreset({ ...activePreset, fontSize: Number(e.target.value) })}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Position Y Slider */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1">
                  <span>Vertical Position Y</span>
                  <span className="text-amber-400">{activePreset.positionY}% from bottom</span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="50"
                  value={activePreset.positionY}
                  onChange={(e) => setActivePreset({ ...activePreset, positionY: Number(e.target.value) })}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Main Text Color */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Base Text Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={activePreset.textColor}
                    onChange={(e) => setActivePreset({ ...activePreset, textColor: e.target.value })}
                    className="h-9 w-12 rounded bg-transparent cursor-pointer"
                  />
                  <input
                    type="text"
                    value={activePreset.textColor}
                    onChange={(e) => setActivePreset({ ...activePreset, textColor: e.target.value })}
                    className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              {/* Highlight Active Word Color */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Active Word Highlight Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={activePreset.highlightColor}
                    onChange={(e) => setActivePreset({ ...activePreset, highlightColor: e.target.value })}
                    className="h-9 w-12 rounded bg-transparent cursor-pointer"
                  />
                  <input
                    type="text"
                    value={activePreset.highlightColor}
                    onChange={(e) => setActivePreset({ ...activePreset, highlightColor: e.target.value })}
                    className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              {/* Stroke Outline Color */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Text Outline Stroke Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={activePreset.strokeColor}
                    onChange={(e) => setActivePreset({ ...activePreset, strokeColor: e.target.value })}
                    className="h-9 w-12 rounded bg-transparent cursor-pointer"
                  />
                  <input
                    type="text"
                    value={activePreset.strokeColor}
                    onChange={(e) => setActivePreset({ ...activePreset, strokeColor: e.target.value })}
                    className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>

              {/* Stroke Width Slider */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1">
                  <span>Outline Stroke Width</span>
                  <span className="text-amber-400">{activePreset.strokeWidth}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  value={activePreset.strokeWidth}
                  onChange={(e) => setActivePreset({ ...activePreset, strokeWidth: Number(e.target.value) })}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Uppercase Toggle */}
              <div className="sm:col-span-2 flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="uppercase-toggle"
                  checked={activePreset.uppercase ?? true}
                  onChange={(e) => setActivePreset({ ...activePreset, uppercase: e.target.checked })}
                  className="h-4 w-4 rounded accent-amber-500 cursor-pointer"
                />
                <label htmlFor="uppercase-toggle" className="text-xs font-semibold text-slate-200 cursor-pointer">
                  Convert caption text to ALL CAPS
                </label>
              </div>
            </div>

            {/* Save Action */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-800">
              {saveSuccess ? (
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Preset saved to MongoDB!
                </div>
              ) : (
                <span className="text-xs text-slate-500">
                  Save preset changes to make available across all clips.
                </span>
              )}

              <button
                onClick={handleSavePreset}
                disabled={isSaving}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-semibold text-xs shadow-lg shadow-rose-500/20 hover:opacity-95 transition cursor-pointer disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Preset
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Remotion Live In-App Preview Player */}
        <div className="lg:col-span-5 flex flex-col items-center">
          <div className="sticky top-24 w-full space-y-3 flex flex-col items-center">
            <h2 className="text-base font-bold text-slate-200 flex items-center gap-2 self-start">
              <Sparkles className="h-4 w-4 text-amber-400" />
              Live Remotion Player Preview
            </h2>

            <CaptionPreview
              preset={activePreset}
              hookText={sampleHookText}
            />

            <p className="text-xs text-slate-500 text-center max-w-xs">
              Interactive Remotion Player previewing the 9:16 portrait video layout, intro hook badge, and word-synced animated captions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
