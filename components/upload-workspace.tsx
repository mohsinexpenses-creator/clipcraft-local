'use client';

import React from 'react';
import Link from 'next/link';
import { VideoUploader } from '@/components/video-uploader';
import { AutomationPanel } from '@/components/pipeline-settings';
import { usePipelineDefaults } from '@/components/use-pipeline-defaults';

/**
 * The upload workspace: the file picker and the automation the uploaded video
 * should run with. Split out of the page so the page itself stays a server
 * component (it exports metadata) while only this panel is interactive.
 */
export function UploadWorkspace() {
  const [defaults, setDefaults] = usePipelineDefaults();

  return (
    <div className="space-y-5">
      <section className="animate-fade-up rounded-2xl border bg-card p-4 shadow-[var(--shadow-card)]" style={{ animationDelay: '40ms' }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">New source video</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              MP4, MOV, MKV and WEBM · resumable · no size limit
            </p>
          </div>
        </div>
        <VideoUploader pipeline={defaults} />
      </section>

      <section className="animate-fade-up rounded-2xl border bg-card p-4 shadow-[var(--shadow-card)]" style={{ animationDelay: '80ms' }}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Automation</h2>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            saved for next uploads
          </span>
        </div>
        <AutomationPanel value={defaults} onChange={setDefaults} />
        <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
          Sent with the upload and stored on that video, so the chain keeps these settings after a reload -
          and you can change them later per video from the dashboard.{" "}
          <Link href="/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
            Manage defaults in Settings
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
