'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Tv, Loader2, CheckCircle, AlertCircle, FileVideo } from 'lucide-react';

export const VideoUploader = () => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<'file' | 'youtube'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setErrorMessage(null);
    }
  };

  const handleUploadFile = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setStatusMessage('Uploading video file...');
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }

      const data = await res.json();
      setStatusMessage('Upload complete! Redirecting to dashboard...');

      setTimeout(() => {
        router.push(`/?videoId=${data.video._id}`);
      }, 1000);
    } catch (err: any) {
      console.error('Upload error:', err);
      setErrorMessage(err.message || 'Failed to upload video');
      setIsProcessing(false);
    }
  };

  const handleProcessYoutube = async () => {
    if (!youtubeUrl.trim()) return;

    setIsProcessing(true);
    setStatusMessage('Fetching video from YouTube...');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: youtubeUrl.trim() }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'YouTube download failed');
      }

      const data = await res.json();
      setStatusMessage('YouTube video fetched! Redirecting to dashboard...');

      setTimeout(() => {
        router.push(`/?videoId=${data.video._id}`);
      }, 1000);
    } catch (err: any) {
      console.error('YouTube error:', err);
      setErrorMessage(err.message || 'Failed to fetch YouTube video');
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto space-y-6">
      {/* Tab Selector */}
      <div className="flex rounded-xl bg-slate-900 p-1 border border-slate-800">
        <button
          onClick={() => { setActiveTab('file'); setErrorMessage(null); }}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition ${
            activeTab === 'file'
              ? 'bg-slate-800 text-amber-400 shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileVideo className="h-4 w-4" />
          Upload Video File
        </button>

        <button
          onClick={() => { setActiveTab('youtube'); setErrorMessage(null); }}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition ${
            activeTab === 'youtube'
              ? 'bg-slate-800 text-red-400 shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Tv className="h-4 w-4" />
          Paste YouTube Link
        </button>
      </div>

      {/* Tab 1: File Dropzone */}
      {activeTab === 'file' && (
        <div className="space-y-4">
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
              selectedFile
                ? 'border-amber-500/60 bg-amber-500/5'
                : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-amber-400">
              <Upload className="h-6 w-6" />
            </div>

            {selectedFile ? (
              <div>
                <p className="text-sm font-semibold text-slate-100">{selectedFile.name}</p>
                <p className="text-xs text-slate-400 mt-1">
                  {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB • Click to change
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-slate-200">
                  Click or drag video file here (.mp4, .mov, .mkv)
                </p>
              </div>
            )}
          </div>

          {selectedFile && !isProcessing && (
            <button
              onClick={handleUploadFile}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-bold text-sm shadow-md hover:opacity-95 transition cursor-pointer"
            >
              Upload & Process Video
            </button>
          )}
        </div>
      )}

      {/* Tab 2: YouTube URL Input */}
      {activeTab === 'youtube' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 space-y-3">
            <label className="block text-xs font-semibold text-slate-300">
              Paste YouTube Video URL
            </label>
            <input
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(e) => { setYoutubeUrl(e.target.value); setErrorMessage(null); }}
              className="w-full rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-100 focus:border-red-500 focus:outline-none"
            />
          </div>

          {youtubeUrl.trim() && !isProcessing && (
            <button
              onClick={handleProcessYoutube}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-red-500 to-amber-500 text-white font-bold text-sm shadow-md hover:opacity-95 transition cursor-pointer flex items-center justify-center gap-2"
            >
              <Tv className="h-4 w-4" />
              Fetch YouTube Video
            </button>
          )}
        </div>
      )}

      {/* Messages */}
      {errorMessage && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3.5 text-xs text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {statusMessage && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 p-3.5 text-xs text-amber-300">
          {isProcessing ? <Loader2 className="h-4 w-4 animate-spin text-amber-400" /> : <CheckCircle className="h-4 w-4 text-emerald-400" />}
          <span>{statusMessage}</span>
        </div>
      )}
    </div>
  );
};
