import React from "react";
import { AudioLines, Clapperboard, Gauge, Sparkles } from "lucide-react";
import { UploadWorkspace } from "@/components/upload-workspace";

export const metadata = { title: "Upload" };

const NOTES = [
  {
    icon: AudioLines,
    title: "Nothing else to press",
    text: "Transcription, clip detection and rendering queue themselves in that order. Close the tab if you like — the worker carries on.",
  },
  {
    icon: Gauge,
    title: "Scored as they land",
    text: "Every clip shows its viral score, the AI's rank, and the full analysis behind both.",
  },
  {
    icon: Clapperboard,
    title: "Fix one clip, not the batch",
    text: "Edit any clip — window, hook, CTA, captions, framing — and re-render just that one.",
  },
] as const;

/**
 * Upload is the single entry point of the product: choose a file, decide how
 * much automation you want, and everything else happens on the dashboard.
 */
export default function UploadPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="animate-fade-up space-y-1.5 text-center">
        <h1 className="flex items-center justify-center gap-2 text-[22px] leading-tight font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" />
          Upload a video
        </h1>
        <p className="mx-auto max-w-xl text-[13px] text-muted-foreground">
          Add a landscape video from this machine. The pipeline takes it from there: transcript, viral
          moments, then rendered 9:16 clips with animated captions.
        </p>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <UploadWorkspace />

        <ul className="animate-fade-up space-y-2 lg:pt-1" style={{ animationDelay: "120ms" }}>
          {NOTES.map((note) => {
            const Icon = note.icon;
            return (
              <li key={note.title} className="flex gap-2.5 rounded-xl border bg-card/60 p-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-tight font-medium">{note.title}</p>
                  <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{note.text}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
