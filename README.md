# ClipCraft Local

A **personal, local-first** AI clip generator: give it one long landscape video
(podcast, interview, sermon, lecture) and it produces short, vertical **9:16 clips**
optimized for social feeds — each with an active-speaker crop, a duplicated 3-second
"suspense hook" intro, on-screen hook/CTA text, and word-synced animated captions.

Everything heavy runs **on your own machine** (Node.js only, no Python). The only
network calls are to your local MongoDB/Redis (Docker) and the free **Google AI
Studio** LLM (viral-segment detection + hook/CTA text). Speech-to-text and face
detection are fully local (whisper.cpp + OpenCV YuNet).

---

## What it does, end to end

1. **Upload** — resumable, chunked, **no size limit** (a 3-hour podcast is a normal
   input). Files are stored as `uploads/001_my_recording.mp4`.
2. **Transcribe** — whisper.cpp (local) produces a transcript with **word-level
   timestamps**, stored in MongoDB. (Optional Deepgram override if you set a key.)
3. **Detect viral segments** — the Gemini LLM picks the most promising windows and
   writes `{start, end, hookText, ctaText, reason, score}`. If it returns fewer
   clips than requested, a **top-up pass** tops the list up to the exact count.
4. **Find the hook** — the LLM picks the single most gripping moment inside each
   clip; it is duplicated to the **start** (fixed 3 s) with a 0.5 s dip-to-black,
   so the clip opens with the best beat and then builds back to it.
5. **Frame the speaker** — active-speaker detection (YuNet faces + audio/motion
   fusion, `worker/asd/`) drives the 9:16 crop:
   - **Speaker focus** — one window that glides to follow whoever is talking.
   - **Split screen** — an adaptive 2/3/4-cell grid with one pane per person. Each pane
     is a **locked** camera: placed on the person once, perfectly still while their
     head stays in frame, and it only glides to re-centre them if they actually leave
     it. Two people = two stacked halves with a **stable** assignment (left person
     always the top pane, right person the bottom) — it never swaps mid-clip. Captions,
     hook text and the CTA card are placed so they never cover a face.
   There is **no fallback detector**: if no face can be found, the render fails
   with a clear explanation instead of guessing.
6. **Render** — the selected caption engine prepares transparent overlay frames,
   then one FFmpeg filter graph performs the mirror/crop/colour work, hook intro,
   caption + card compositing, and the single final H.264 encode. The `remotion`
   engine (default, “Premium”) paints animated overlays in headless Chrome; `native`
   (“Fast”) rasterizes ASS captions and uses Remotion only for the hook/CTA cards.
   Both produce the same 1080×1920 output path without a lossy intermediate video.
   On-screen hook/CTA text comes from user-editable **style presets** (font,
   colours, position, animation, solid or **gradient** card background).
7. **Mask profanity** — captions and overlay text are always masked on screen
   (`fuck` → `f**k`, while `class`/`pass`/`glass` stay untouched); the **audio** of
   a profane word is muted, beeped, or left alone (`PROFANITY_AUDIO_MODE`) — all at
   render time, so re-rendering after a settings change never re-transcribes.
8. **Store** — output lands in `generated-clips/001_my_recording/<clip title>.mp4`
   with a MongoDB record (status, score, layout, engines, presets). The dashboard
   streams it back over a Range-enabled HTTP endpoint for preview/download.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router), TypeScript, Tailwind v4, shadcn-style UI |
| Persistence | MongoDB (Docker) — videos, transcripts, clips, presets, prompt templates |
| Queue | BullMQ + Redis (Docker) — separate workers for transcription and rendering |
| Worker | long-running `tsx worker/index.ts` process (not serverless) |
| Video | `ffmpeg-static` + `child_process` (no fluent-ffmpeg), mirrored before face tracking |
| Speech-to-text | whisper.cpp (local binary + ggml model; optional Deepgram override) |
| Face detection | OpenCV **YuNet** ONNX on `onnxruntime-node` (no face-api, no vision APIs) |
| LLM | Google AI Studio only — a 5-slot Gemini fallback chain in `lib/llm.ts` (plain `fetch`, no SDKs) |
| Caption overlays | Remotion transparent frames (default) or native ASS rasterization (fast) |

## Quickstart

Full instructions (env vars, troubleshooting, Windows specifics) live in
**[SETUP.md](./SETUP.md)**. The short version:

```powershell
# 1. dependencies
npm install

# 2. configure
copy .env.example .env.local   # then set MONGODB_URI, REDIS_URL, GEMINI_API_KEY

# 3. databases (Docker)
npm run db:up

# 4. whisper.cpp model (Windows build is committed; this fetches the ggml model)
npm run setup:whisper

# 5. worker + web (or just double-click start-clipcraft.bat)
npm run worker
npm run dev
```

Then open <http://localhost:3000> and start at **`/startup-validation`** — it
checks MongoDB, Redis, FFmpeg, the transcription engine, the LLM chain, and the
Remotion renderer, and tells you exactly what to fix.

## Project structure

```
app/                    Next.js pages + API routes
  upload/               upload page (resumable chunks, optional YouTube import)
  caption-presets/      caption style preset manager (live preview)
  prompt-templates/     edit the LLM prompt templates
  startup-validation/   pre-flight checks UI
  api/                  videos, clips, transcript, detect-viral, upload(+session),
                        media (Range file server), presets, templates
lib/                    shared server logic
  llm.ts                Gemini fallback chain (config array, plain fetch)
  ai.ts                 prompt templates, JSON parsing, exact-count top-up
  whisper.ts            whisper.cpp discovery + transcription
  ffmpeg.ts             ffmpeg-static resolution + spawn wrapper
  queue.ts              BullMQ queues (transcription + clip render)
  profanity.ts          word masking + render-time mute/beep windows
  overlay-bg.ts         solid/gradient card-background picker helpers
  presets.ts            default caption/overlay/text presets
  upload*.ts            upload policy, resumable sessions, browser client
  db.ts                 MongoDB (database name: clipcraft)
worker/                 the long-running BullMQ consumer
  index.ts              both workers + graceful shutdown
  processor.ts          per-clip orchestration (hook, layout, engines, masking)
  asd/                  active-speaker detection (audio, YuNet, tracker, scoring)
  yunet-detector.ts     YuNet ONNX pre/post-processing (OpenCV-exact)
  layout.ts             speaker-focus vs split-grid plans (peak-concurrent cells)
  ffmpeg-pipeline.ts    crop/overlay graph and single final H.264 encode
  remotion-renderer.ts  "remotion" transparent overlay-frame renderer
  native-captions.ts    "native" ASS caption PNGs + hook/CTA overlay frames
remotion/               compositions: captions, hook overlay, CTA overlay
scripts/                setup-whisper.{mjs,ps1}, setup-yunet.mjs
bin/whisper-win-x64/    committed Windows whisper.cpp build (whisper-cli + DLLs)
models/yunet/           committed YuNet face-detection model (232 KB)
tests/                  node:test unit tests (tsx --test)
docs/                   feature guides (layouts, overlays, viral prompt)
```

## Hard constraints (by design)

- **No Python anywhere.** Everything is Node.js/TypeScript.
- **Local + free.** Single user, runs on one PC, no multi-tenant auth, no billing,
  no cloud media services. The only paid-capable dependency is the Gemini key,
  which is free-tier.
- **No `fluent-ffmpeg`.** `ffmpeg-static` + `child_process.spawn` directly.
- **9:16 output, always** (1080×1920).
- **Not for Vercel** — heavy processing needs a long-running local worker.

## Documentation

- **[SETUP.md](./SETUP.md)** — install, env vars, running, troubleshooting
- **[docs/LAYOUTS.md](./docs/LAYOUTS.md)** — speaker focus vs split screen + how
  active-speaker tracking works
- **[docs/OVERLAYS.md](./docs/OVERLAYS.md)** — hook/CTA text, style presets, the
  background picker
- **[docs/VIRAL_PROMPT_GUIDE.md](./docs/VIRAL_PROMPT_GUIDE.md)** — the viral-detection
  prompt, its variables, and how to customize it
