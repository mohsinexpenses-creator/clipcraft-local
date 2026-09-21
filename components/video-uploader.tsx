'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Film, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

export const VideoUploader = () => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setErrorMessage(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('video/')) {
        setSelectedFile(file);
        setErrorMessage(null);
      } else {
        setErrorMessage('Please upload a valid video file (.mp4, .mov, .mkv, .webm)');
      }
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setUploadProgress(10);
    setStatusMessage('Uploading video file to local storage...');
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      setUploadProgress(40);
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }

      setUploadProgress(80);
      setStatusMessage('Video saved! Starting audio extraction & transcription pipeline...');

      const data = await res.json();
      const videoId = data.video._id;

      setUploadProgress(100);
      setStatusMessage('Upload complete! Redirecting to video dashboard...');

      setTimeout(() => {
        router.push(`/?videoId=${videoId}`);
      }, 1200);
    } catch (err: any) {
      console.error('Upload error:', err);
      setErrorMessage(err.message || 'Error uploading video file');
      setIsUploading(false);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-all ${
          selectedFile
            ? 'border-amber-500/50 bg-amber-500/5'
            : 'border-slate-700 bg-slate-900/50 hover:border-slate-500 hover:bg-slate-900'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800 text-amber-400 shadow-inner">
          {selectedFile ? <Film className="h-8 w-8" /> : <Upload className="h-8 w-8" />}
        </div>

        {selectedFile ? (
          <div>
            <p className="text-lg font-semibold text-slate-100">{selectedFile.name}</p>
            <p className="text-sm text-slate-400 mt-1">
              {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB • Click to change file
            </p>
          </div>
        ) : (
          <div>
            <p className="text-lg font-medium text-slate-200">
              Drag & drop your landscape video here, or <span className="text-amber-400 underline">browse</span>
            </p>
            <p className="text-sm text-slate-500 mt-2">
              Supports MP4, MOV, MKV, WebM up to long-form landscape video
            </p>
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-4 text-sm text-rose-400">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {statusMessage && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 p-4 text-sm text-amber-300">
          {isUploading ? <Loader2 className="h-5 w-5 animate-spin text-amber-400" /> : <CheckCircle className="h-5 w-5 text-emerald-400" />}
          <span>{statusMessage}</span>
        </div>
      )}

      {isUploading && (
        <div className="mt-4 w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
          <div
            className="bg-gradient-to-r from-amber-500 to-rose-500 h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      {selectedFile && !isUploading && (
        <div className="mt-6 flex justify-end">
          <button
            onClick={handleUpload}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 text-white font-semibold shadow-lg shadow-rose-500/20 hover:opacity-95 transition cursor-pointer"
          >
            <Upload className="h-5 w-5" />
            Upload & Transcribe Video
          </button>
        </div>
      )}
    </div>
  );
};
