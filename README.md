# ClipCraft Local

A **personal, local-first** AI clip generator: give it one long landscape video
(podcast, interview, sermon, lecture) and it produces short, vertical **9:16 clips**
optimized for social feeds — each with an active-speaker crop, a duplicated intro covering
the full detected hook timestamp range, on-screen hook/CTA text, and word-synced captions.

Everything heavy runs **on your own machine** (Node.js only, no Python). Videos,
transcripts, presets, and job state live in a local SQLite file (`./data/clipcraft.db`)
using `better-sqlite3`; no database service or Docker is needed. The existing viral
segment and hook/CTA generation calls use Google AI Studio; Deepgram handles
transcription and face detection remains local through the existing YuNet flow.

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
2. **Transcribe** — Deepgram produces the transcript with **word-level
   timestamps**, stored in SQLite.
3. **Detect viral segments** — the Gemini LLM picks the most promising windows and
   writes `{start, end, hookText, ctaText, reason, score}`. If it returns fewer
   clips than requested, a **top-up pass** tops the list up to the exact count.
   Clips appear in the dashboard grid as soon as they exist, each showing its **score**,
   and the full AI analysis behind it (drop-down on the tile).
   - **Edit and re-render one clip** — _Edit_ on any tile changes the window, hook/CTA
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
6. **Plan B-roll (optional)** — after detection, each clip gets a B-roll plan: named
  people/places/events use their **Wikipedia article image** full screen, while
  keyword photos from **Pexels / Pixabay / Unsplash** appear as landscape cards beside
  the captions. A
   60 s clip targets 10–15 images, never inside the hook replay, never overlapping
   each other. **No image is ever AI-generated**; every one records its provider,
   source URL, author and licence. The plan is stored on the clip and shown on its
   tile with per-image **swap** / **remove** and a per-clip **re-run**. It is on by
   default and can be switched off per video. See [docs/BROLL.md](./docs/BROLL.md).
7. **Render** — Remotion paints the animated caption + hook + CTA overlay frames
   in headless Chrome, then one FFmpeg filter graph performs the mirror/crop/colour
   work, hook intro, B-roll images (painted BEFORE the captions, so text is always
   on top), caption + card compositing, and the single final H.264 encode. A soft
   whoosh/pop marks each B-roll image in and out, mixed under the voice.
   The result is a 1080×1920 output with no lossy intermediate video.
   On-screen hook/CTA text comes from user-editable **style presets** (font,
   colours, position, animation, solid or **gradient** card background).
8. **Mask profanity** — captions and overlay text are always masked on screen
   (`fuck` → `f**k`, while `class`/`pass`/`glass` stay untouched); the **audio** of
   a profane word is muted, beeped, or left alone (`PROFANITY_AUDIO_MODE`) — all at
   render time, so re-rendering after a settings change never re-transcribes.
9. **Store** — output lands in `generated-clips/001_my_recording/<clip title>.mp4`
   with a SQLite record (status, score, layout, engines, presets). The dashboard
   streams it back over a Range-enabled HTTP endpoint for preview/download.

## Settings (`/settings`)

Every default the studio asks you for lives in one sidebar page, in six sections:

| Section              | What it holds                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline defaults    | auto-detect / auto-render and the viral-detection request (clip count, duration window, hook/CTA text)                                                                                                  |
| Render clip defaults | layout, filter preset, caption + hook/CTA style presets, hook/CTA durations                                                                                                             |
| AI providers         | Gemini key pool, Deepgram key + model, and which transcription engine to use. Every key field is Test + Save on its own - Test asks the provider, Save stores it (keys are only ever shown back masked) |
| Worker               | clip / viral-detection concurrency and a per-render Chrome logical-thread budget                                                                                                                        |
| Profanity            | what happens to the _audio_ of a flagged word (mute / beep / leave it)                                                                                                                                  |
| Paths & binaries     | upload, generated-clips and transient frame/work folders plus an optional FFmpeg executable                                                                                                            |

The rule is one line long, in both processes:

**what you saved on this page, otherwise the built-in default.**

`.env.local` is _not_ a fallback for these six sections — a value can never come from a
file you are not looking at, so the page and the app cannot disagree. (Everything
without a form field — model files, CRF, upload limits and timeouts — still lives in
`.env.local` exactly as before.) A row saved here is marked `settings`;
"Reset to defaults" deletes the row and the shipped default applies again. Keys are
stored in the local SQLite file (same trust boundary as `.env.local` used to be) and the
API only ever returns them masked — pasting a masked value back means "keep it".

Pipeline and render defaults are **snapshotted onto the video at upload**, so a clip
already being rendered is never changed from under the worker, and editing a clip in the
studio always wins over the default.

The Verify column calls the real upstream APIs with `fetch` and labels each key by its
mask, so a rotated key is obvious, and unsaved keys can be tested first (paste → test →
save). The **Chrome thread budget** is a 10–100% slider in 5% steps (default 50%).
Before each job the worker converts it to a bounded whole Chrome-tab count using the host's
available logical threads, so it applies without a restart and remains portable between
machines. Existing absolute tab-count records migrate safely on startup. Everything else
applies to the next job except the two loop sizes: **clip and detection concurrency need
`npm run worker` restarted**, because those are read when its polling loops start (the
page says so while such an override is saved).

Path changes are validated with a real write probe and are read again for the next upload,
render, frame extraction and media request — no web or worker restart is needed. The small
folder picker intentionally works only when ClipCraft is opened directly on `localhost`;
it lists directories only, permits creating one child folder, and is not exposed through a
LAN or Internet deployment.

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

The caption theme selector and style gallery include all 13 locally bundled Remotion themes
(Pop, Karaoke, Kinetic 01/02, Hustle, Grape, Beast, Poppin, Aarit, Soft AI, Gaming Stream,
Simple One Word, and Podcast). The original eight styles are preserved; Bold Punch remains
the Kinetic 01 style, and the other twelve themes appear as individually named gallery
cards. New theme cards are seeded into existing databases on the next app start, without a
reset. Hook and CTA cards can match the chosen theme's font, accent, card and motion, while
retaining their existing text and timing. A default you previously chose is preserved
when built-ins are reset.

Caption theme source is vendored under `remotion/caption-themes/vendor` with its MIT
license. Caption fonts are bundled locally in `public/fonts` (including the theme fonts);
third-party Google font OFL licenses are in `public/fonts/licenses`.
Old built-in caption presets are removed from existing databases on the next start; presets you created yourself are kept.

## Tech stack

| Layer            | Choice                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Frontend + API   | Next.js 16 (App Router), TypeScript, Tailwind v4, shadcn-style UI                               |
| Persistence      | SQLite via `better-sqlite3` — typed video, clip, preset, template, and job tables               |
| Queue            | SQLite jobs table — separate polling loops for transcription and rendering                      |
| Worker           | long-running `tsx worker/index.ts` process (not serverless)                                     |
| Video            | `ffmpeg-static` + `child_process` (no fluent-ffmpeg), mirrored before face tracking             |
| Speech-to-text   | Deepgram (cloud transcription)                                                                    |
| Face detection   | OpenCV **YuNet** ONNX on `onnxruntime-node` (no face-api or external AI APIs)                    |
| LLM              | Google AI Studio only — a 5-slot Gemini fallback chain in `lib/llm.ts` (plain `fetch`, no SDKs) |
| Caption overlays | Remotion transparent frames painted in headless Chrome       |

## Quickstart

Full instructions (env vars, troubleshooting, Windows specifics) live in
**[SETUP.md](./SETUP.md)**. The short version:

```powershell
# 1. dependencies
npm install

# 2. configure (DATABASE_PATH is optional; this is the default)
copy .env.example .env.local   # set DATABASE_PATH / paths here; keys live in the app

# 3. worker + web (or just double-click start-clipcraft.bat)
npm run worker
npm run dev
```

Then open <http://localhost:3000>, paste a Google AI Studio key into
**`/settings` → AI providers** (Test it, then save — keys are configured in the app, not
in `.env.local`), and start at **`/startup-validation`**: it checks SQLite read/write
access, WAL mode, FFmpeg, the transcription engine, the LLM chain, and the Remotion
renderer, and tells you exactly what to fix.

## Optional latency safeguards

The conservative default keeps the original LLM fallback behavior. For a latency
benchmark, set the following documented environment flags in `.env.local` and restart
the worker:

- `LLM_TASK_ROUTING_ENABLED=1` routes short hook/overlay/safety work to the Lite model
  family with 15–20 second limits and `thinkingBudget: 0`; viral detection keeps a
  90-second quality route and B-roll planning remains a separate 45-second LLM call.
- `LLM_CIRCUIT_BREAKER_ENABLED=1` opens a process-local model circuit after repeated
  timeout, network, 429, or 5xx failures. `LLM_CIRCUIT_FAILURE_THRESHOLD` (default 2)
  and `LLM_CIRCUIT_COOLDOWN_SECONDS` (default 90) tune it. The worker logs every
  route- and circuit-based model skip.

Both are off by default and can be disabled independently without changing stored
clips, captions, B-roll plans, or final encoding settings. Render-time safety reuses
normalized `risky_words` and `words_to_change` from viral analysis; the optional context
review only runs when that data is absent. Set `FORCE_LLM_SAFETY_REVIEW=1` for an explicit
audit pass. B-roll now paints one transparent sequence per scheduled image window rather
than blank full-timeline frames. `BROLL_ACTIVE_RANGE_RENDERING=0` is a rollback switch
for the legacy one-sequence renderer; it is enabled by default.

Speaker-focus B-roll rendering now starts beside active-speaker detection by default,
using the same fixed card anchor, timing, images, caption colour, and final compositing
order as the sequential path. Split-screen clips deliberately remain sequential because
their face-safe card placement needs the final ASD face bands. If either concurrent branch
fails or the job is cancelled, the sibling is aborted and awaited before cleanup; set
`RENDER_PARALLEL_BROLL_ASD=0` on CPU- or RAM-constrained workers to restore the sequential
path. That shared branch caps Chrome tabs at two by default so ASD keeps CPU/RAM;
`RENDER_PARALLEL_BROLL_CONCURRENCY=1..32` changes that cap while still honoring a smaller
Chrome-tab setting.

B-roll card decoding/cropping/JPEG preparation now uses two bounded Jimp workers by
default (`BROLL_IMAGE_PREP_CONCURRENCY=2`); set it to `1` for the prior serial path.
Active-speaker detection likewise begins with an adaptive <=4 fps, 240-frame, 960px JPEG
balanced pass and interpolates only adjacent measured face positions onto the established
8 fps analysis cadence. Bounded two-frame YuNet decode/inference runs concurrently, while
tracking and speaker fusion stay ordered and sequential. On sustained small-face wide shots,
the redundant full-frame YuNet pass is skipped while overlapping tiles remain; set
`ASD_DETECTION_CONCURRENCY=1` or `ASD_SKIP_FULL_FRAME_ON_WIDE_SHOTS=0` for their prior
paths. If face evidence is missing, fleeting, or too small, it retries the <=8 fps,
480-frame quality path and remembers that quality preference for the immutable source.
`ASD_INITIAL_PROFILE=legacy-fast` restores the prior 640px first pass and
`ASD_ADAPTIVE_SAMPLING=0` starts quality-only. Exact ASD outputs are disk-cached by source
path/size/mtime, clip range and profile/version under the Settings temporary-work
folder (default `.tmp/asd-cache`, bounded by `ASD_CACHE_MAX_MB`, default 512); set
`ASD_CACHE_ENABLED=0` or `ASD_CACHE_DIR` to disable or relocate it.

For an image-input queue experiment, `FFMPEG_OVERLAY_THREAD_QUEUE_SIZE` defaults to the
baseline-safe `2`; benchmark `16` or `32` on the actual render host before retaining either
value. It is read per job and `2` is the rollback.
`CAPTION_ACTIVE_RANGE_RENDERING=1` is an experimental sparse-caption benchmark: it keeps
the full composition clock and re-bases only proven caption/hook/CTA windows in FFmpeg.
It automatically stays on the legacy full transparent sequence for dense speech or a
fragmented timeline, and `0` restores that path explicitly. Caption chunks and themed
style variants are also memoized per Remotion render; neither change alters caption design,
timing, output resolution, or final encoding.

`FFMPEG_OVERLAY_CONCAT=1` (the default) then combines only verified, frame-aligned,
non-overlapping 1080×1920 PNG ranges within the same semantic layer into one transparent
FFconcat stream. This reduces image inputs and overlay stages while retaining B-roll below
captions, the existing hook/CTA paint order, and the sole final H.264 encode. An invalid,
incomplete, overlapping, or custom-timed sequence automatically keeps the prior direct
input path. Set `FFMPEG_OVERLAY_CONCAT=0` to roll back every overlay range to direct
per-sequence compositing when comparing a renderer or FFmpeg build.

For repeatable timing and visual comparisons, use the immutable static speaker-focus
fixture and the `[JOB-TIMING]` substage contract in
[docs/RENDER_BENCHMARK.md](./docs/RENDER_BENCHMARK.md). It never changes regular render
settings automatically; real-render/reference-frame/audio gates remain explicitly deferred
until a representative source fixture and FFmpeg tooling are available.

## Project structure

```
app/                    Next.js pages + API routes
  page.tsx              the studio: library sidebar, live pipeline, clip grid
  upload/               upload page (resumable chunks, file upload only)
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
  deepgram.ts           Deepgram transcription client
  ffmpeg.ts             FFmpeg/ffprobe resolution, stream probing + spawn wrapper
  queue.ts              SQLite job queue (transcription + clip render)
  pipeline.ts           the automatic chain: transcript -> detection -> render
  pipeline-status.ts    derives the live stage/progress from queue + clip rows
  pipeline-defaults.ts  clip options + their limits, shared by client and server
  app-settings.ts       the one resolver for stored settings: precedence, clamping,
                        key masking, verification payloads (no raw secrets out)
  settings-verify.ts    live probes: Google model list/test + Deepgram /v1/auth/token
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
  remotion-renderer.ts  transparent overlay-frame renderer (Remotion)
remotion/               compositions: captions, hook overlay, CTA overlay
scripts/                setup-yunet.mjs, verify-clip.ts
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
- **No generated imagery.** Named people, places and events use their Wikipedia
  article image; keyword cards use stock providers. Every image records attribution,
  and a missing article image is skipped rather than filled with a stock lookalike.
- **9:16 output, always** (1080×1920).
- **Not for Vercel** — heavy processing needs a long-running local worker.

## Documentation

- **[SETUP.md](./SETUP.md)** — install, env vars, running, troubleshooting
- **[docs/BROLL.md](./docs/BROLL.md)** — auto B-roll: Wikipedia and stock providers,
  the scheduler, rendering order, sound effects and caching
- **[docs/LAYOUTS.md](./docs/LAYOUTS.md)** — speaker focus vs split screen + how
  active-speaker tracking works
- **[docs/OVERLAYS.md](./docs/OVERLAYS.md)** — hook/CTA text, style presets, the
  background picker
- **[docs/VIRAL_PROMPT_GUIDE.md](./docs/VIRAL_PROMPT_GUIDE.md)** — the viral-detection
  prompt, its variables, and how to customize it
- **[docs/RENDER_BENCHMARK.md](./docs/RENDER_BENCHMARK.md)** — static comparison fixture,
  job timing keys, and deferred real-render gates
- **[docs/sqlite-migration-inventory.md](./docs/sqlite-migration-inventory.md)** — legacy collections, indexes, queue payloads, and behavior recorded before migration
