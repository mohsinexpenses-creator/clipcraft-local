import React from 'react';
import { VideoUploader } from '@/components/video-uploader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AudioLines, Clapperboard, Sparkles } from 'lucide-react';

const steps = [
  {
    icon: AudioLines,
    title: '1. Transcription',
    description:
      'Audio is extracted with FFmpeg and transcribed locally with word-level timestamps.',
  },
  {
    icon: Sparkles,
    title: '2. AI analysis',
    description:
      'Gemini AI scans the transcript to find viral segments and writes punchy hook text.',
  },
  {
    icon: Clapperboard,
    title: '3. 9:16 rendering',
    description:
      'Smart face crop, color filters, duplicated hook intro, and animated captions.',
  },
];

export default function UploadPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="animate-fade-up space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Upload a video</h1>
        <p className="mx-auto max-w-xl text-sm text-muted-foreground">
          Add a landscape video from your machine or paste a YouTube link. The pipeline
          handles transcription, viral detection, and rendering automatically.
        </p>
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New source video</CardTitle>
            <CardDescription>
              MP4, MOV, and MKV files are supported
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VideoUploader />
          </CardContent>
        </Card>
      </div>

      <div
        className="grid animate-fade-up grid-cols-1 gap-4 pt-2 md:grid-cols-3"
        style={{ animationDelay: '120ms' }}
      >
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <Card key={step.title} className="gap-3 py-5">
              <CardContent className="space-y-2">
                <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium">{step.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
