# ClipCraft Local

A **personal, local-first** AI clip generator: give it one long landscape video
(podcast, interview, sermon, lecture) and it produces short, vertical **9:16 clips**
optimized for social feeds — each with an active-speaker crop, a duplicated intro covering
the full detected hook timestamp range, on-screen hook/CTA text, and word-synced captions.

Everything heavy runs **on your own machine** (Node.js only, no Python). Videos,
transcripts, presets, and job state live in a local SQLite file (`./data/clipcraft.db`)
using `better-sqlite3`; no database service or Docker is needed. The existing viral
segment and hook/CTA generation calls use Google AI Studio; speech-to-text and face
detection run locally with whisper.cpp and OpenCV YuNet.

---

## What it does, end to end

**Upload is the only step you press.** The moment a file lands, the app queues the
transcript, then viral detection, then a render of every clip with the default
configuration (steps 2, 3 and 6 below). Closing the page or restarting the worker only
pauses the chain: it recovers at the step where it stopped.

1. **Upload** — resumable, chunked, **no size limit** (a 3-hour podcast is a normal
   input). Files are stored as `uploads/001_my_recording.mp4`. The upload form also
   captures the automation you want (`autoDetect` / `autoRender` + AI clip options);
   it is saved on the video record (`videos.pipeline_json`) so later retries and
   re-runs use exactly the same settings.
2. **Transcribe** — whisper.cpp (local) produces a transcript with **word-level
   timestamps**, stored in SQLite. (Optional Deepgram override if you set a key.)
3. **Detect viral segments** — the Gemini LLM picks the most promising windows and
   writes `{start, end, hookText, ctaText, reason, score}`. If it returns fewer
   clips than requested, a **top-up pass** tops the list up to the exact count.
   Clips appear in the dashboard grid as soon as they exist, each showing its **score**,
   and the full AI analysis behind it (drop-down on the tile).
   - **Edit and re-render one clip** — *Edit* on any tile changes the window, hook/CTA
     text, caption and layout for that clip alone and re-renders only it. The rest of the
     grid is untouched (`POST /api/clips` = save + render in one call).
4. **Replay the hook** — the complete `hook_timestamp.start`→`hook_timestamp.end`
   interval returned during viral detection is duplicated at the **start** with a
   0.5 s dip-to-black, so the clip opens with the detected hook and then builds back to it.
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
   with a SQLite record (status, score, layout, engines, presets). The dashboard
   streams it back over a Range-enabled HTTP endpoint for preview/download.

## Settings (`/settings`)

Every default the studio asks you for lives in one sidebar page, in five sections:

| Section | What it holds |
|---|---|
| Pipeline defaults | auto-detect / auto-render and the viral-detection request (clip count, duration window, hook/CTA text) |
| Render clip defaults | caption engine, layout, filter preset, caption + hook/CTA style presets, hook/CTA durations |
| AI providers | Gemini key pool, Deepgram key + model, and which transcription engine to use |
| Worker | clip / viral-detection / Remotion concurrency |
| Profanity | what happens to the *audio* of a flagged word (mute / beep / leave it) |

The rule is one line long, in both processes:

**what you saved on this page, otherwise the built-in default.**

`.env.local` is *not* a fallback for these five sections — a value can never come from a
file you are not looking at, so the page and the app cannot disagree. (Everything
without a form field — binary paths, model files, CRF, upload limits, timeouts — still
lives in `.env.local` exactly as before.) A row saved here is marked `settings`;
"Reset to defaults" deletes the row and the shipped default applies again. Keys are
stored in the local SQLite file (same trust boundary as `.env.local` used to be) and the
API only ever returns them masked — pasting a masked value back means "keep it".

Pipeline and render defaults are **snapshotted onto the video at upload**, so a clip
already being rendered is never changed from under the worker, and editing a clip in the
studio always wins over the default.

The Verify column calls the real upstream APIs with `fetch` and labels each key by its
mask, so a rotated key is obvious, and unsaved keys can be tested first (paste → test →
save). Everything applies to the next job except the two loop sizes: **clip and detection
concurrency need `npm run worker` restarted**, because those are read when its polling
loops start (the page says so while such an override is saved).

The `hook/CTA` durations are the one field with a subtlety: the rendered clip is
`[replayed hook][full segment]`, and the replay length is **the hook interval the prompt
returned** (`hook_timestamp.start → end`), used at its exact length. "Hook intro fallback"
is what applies only when a clip's analysis has no usable interval, and `0` turns the
replay and the hook text off for a clip.

### Style presets

`/caption-presets` edits the caption, hook and CTA styles, and the built-ins are seeded
into SQLite once (`INSERT OR IGNORE`) so your edits survive an upgrade. That also means a
row created by an older build never picks up a changed default — **Reset to shipped
styles** re-syncs the built-in rows from `lib/presets.ts` while keeping every preset you
made yourself and the preset you marked default.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router), TypeScript, Tailwind v4, shadcn-style UI |
| Persistence | SQLite via `better-sqlite3` — typed video, clip, preset, template, and job tables |
| Queue | SQLite jobs table — separate polling loops for transcription and rendering |
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

# 2. configure (DATABASE_PATH is optional; this is the default)
copy .env.example .env.local   # set DATABASE_PATH / paths here; keys live in the app

# 3. whisper.cpp model (Windows build is committed; this fetches the ggml model)
npm run setup:whisper

# 4. worker + web (or just double-click start-clipcraft.bat)
npm run worker
npm run dev
```

Then open <http://localhost:3000>, paste a Google AI Studio key into
**`/settings` → AI providers** (Test it, then save — keys are configured in the app, not
in `.env.local`), and start at **`/startup-validation`**: it checks SQLite read/write
access, WAL mode, FFmpeg, the transcription engine, the LLM chain, and the Remotion
renderer, and tells you exactly what to fix.

## Project structure

```
app/                    Next.js pages + API routes
  page.tsx              the studio: library sidebar, live pipeline, clip grid
  upload/               upload page (resumable chunks, optional YouTube import)
  caption-presets/      caption style preset manager (live preview)
  prompt-templates/     edit the LLM prompt templates
  startup-validation/   pre-flight checks UI
  settings/             defaults for pipeline + render, AI keys, worker, profanity
  api/                  videos, clips, transcript, detect-viral, upload(+session),
                        media (Range file server), presets, templates, settings (+
                        settings/verify, which probes Google and Deepgram)
lib/                    shared server logic
  llm.ts                Gemini fallback chain (config array, plain fetch)
  ai.ts                 prompt templates, JSON parsing, exact-count top-up
  whisper.ts            whisper.cpp discovery + transcription
  ffmpeg.ts             FFmpeg/ffprobe resolution, stream probing + spawn wrapper
  queue.ts              SQLite job queue (transcription + clip render)
  pipeline.ts           the automatic chain: transcript -> detection -> render
  pipeline-status.ts    derives the live stage/progress from queue + clip rows
  pipeline-defaults.ts  clip options + their limits, shared by client and server
  app-settings.ts       the one resolver for stored settings: precedence, clamping,
                        key masking, verification payloads (no raw secrets out)
  settings-verify.ts    live HEAD/GET probes against Gemini + Deepgram
  clip-edits.ts         validates a single-clip edit before it is saved/rendered
  profanity.ts          word masking + render-time mute/beep windows
  overlay-bg.ts         solid/gradient card-background picker helpers
  presets.ts            default caption/overlay/text presets
  upload*.ts            upload policy, resumable sessions, browser client
  db.ts                 typed SQLite tables, schema migrations, and prepared CRUD
worker/                 the long-running SQLite queue consumer
  index.ts              both workers + graceful shutdown
  processor.ts          per-clip orchestration (hook, layout, engines, masking)
  asd/                  active-speaker detection (audio, YuNet, tracker, scoring)
  yunet-detector.ts     YuNet ONNX pre/post-processing (OpenCV-exact)
  layout.ts             speaker-focus vs split-grid plans (peak-concurrent cells)
  ffmpeg-pipeline.ts    crop/overlay graph and single final H.264 encode
  remotion-renderer.ts  "remotion" transparent overlay-frame renderer
  native-captions.ts    "native" ASS caption PNGs + hook/CTA overlay frames
remotion/               compositions: captions, hook overlay, CTA overlay
scripts/                setup-whisper.{mjs,ps1}, setup-yunet.mjs, verify-clip.ts
bin/whisper-win-x64/    committed Windows whisper.cpp build (whisper-cli + DLLs)
models/yunet/           committed YuNet face-detection model (232 KB)
tests/                  node:test unit tests (tsx --test)
docs/                   feature guides (layouts, overlays, viral prompt)
```

## Hard constraints (by design)

- **No Python anywhere.** Everything is Node.js/TypeScript.
- **No database services or Docker.** SQLite and the durable local jobs table replace MongoDB, Redis, and BullMQ.
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
- **[docs/sqlite-migration-inventory.md](./docs/sqlite-migration-inventory.md)** — legacy collections, indexes, queue payloads, and behavior recorded before migration
