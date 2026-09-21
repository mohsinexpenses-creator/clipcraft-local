import React from 'react';
import { VideoUploader } from '@/components/video-uploader';
import { Upload, Film, Sparkles, Cpu } from 'lucide-react';

export default function UploadPage() {
  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">
          Upload Long-Form Video
        </h1>
        <p className="text-sm text-slate-400 max-w-xl mx-auto">
          Upload your landscape video file to run local whisper.cpp transcription, Claude AI viral segment analysis, smart face cropping, and Remotion animated captions.
        </p>
      </div>

      <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl backdrop-blur-sm">
        <VideoUploader />
      </div>

      {/* Processing Pipeline Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
            <Cpu className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-slate-200">1. Local Transcription</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Extracts audio with FFmpeg and runs local whisper.cpp for word-level timestamp alignment.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-slate-200">2. Claude AI Analysis</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Analyzes full transcript to detect viral short-form candidates and punchy hook overlay text.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400">
            <Film className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-slate-200">3. 9:16 Remotion Render</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Smart face crop, horizontal mirror, color filter presets, duplicated hook intro, and styled captions.
          </p>
        </div>
      </div>
    </div>
  );
}
