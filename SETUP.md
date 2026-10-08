# ClipCraft Local — Setup & Troubleshooting (Windows-first)

Practical guide to installing and running ClipCraft. The product overview lives in
[README.md](./README.md); feature guides in [`docs/`](./docs).

Everything runs on your own PC: Next.js + a separate worker backed by a local SQLite
file. **No Python, Docker, MongoDB, or Redis service is needed.** The existing
viral-analysis and hook/CTA prompts call Google AI Studio; Deepgram is an *optional*
paid transcription override, off by default.

One-click on Windows: **`start-clipcraft.bat`** starts the worker and web app, then
opens the browser. The steps below are what it does, manually.

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js 20+ (LTS) | Next.js 16, the worker, and `better-sqlite3` | `node -v` |
| **Microsoft Visual C++ Redistributable (x64)** | `whisper-cli.exe` is a native build and needs `vcruntime140.dll` / `msvcp140.dll` | Install once: <https://aka.ms/vs/17/release/vc_redist.x64.exe> |
| Google AI Studio API key (`GEMINI_API_KEY`) | Viral-segment detection + hook/CTA text | Free: <https://aistudio.google.com/app/apikey> |

FFmpeg is normally provided by `ffmpeg-static` during `npm install`. VFR detection
and `verify:clip` also use **ffprobe**; `ffmpeg-static` does not bundle it, so install
a full local FFmpeg distribution (which includes ffprobe) or set `FFPROBE_PATH` to
an existing local executable. If ffprobe is absent, the worker falls back to FFmpeg's
text probe but marks VFR/stream-start diagnostics as unavailable.

---

## 2. Install

```powershell
cd clipcraft-local
npm install
```

`npm install` fetches:

- `better-sqlite3` → the native SQLite binding used for local records and the durable jobs table
- `ffmpeg-static` → the FFmpeg binary used for trimming, cropping, compositing,
  and the one final H.264 encode
- a full local FFmpeg install / `FFPROBE_PATH` → stream rates, start times and
  durations for VFR detection and `npm run verify:clip`
- `@remotion/bundler` + `@remotion/renderer` → the headless browser Remotion needs
  to paint transparent caption / hook / CTA frames (first render downloads Chromium automatically)
- `onnxruntime-node` → the ONNX runtime that runs the committed YuNet face model
  (fully local, no vision API)

---

## 3. Configure `.env.local`

```powershell
copy .env.example .env.local
```

Then edit `.env.local`. Set the Google AI key; SQLite creates its database and parent
directory automatically. Set `DATABASE_PATH` only if you want a non-default location.

```ini
DATABASE_PATH=./data/clipcraft.db
GEMINI_API_KEY=your-key
```

Both `npm run dev` and `npm run worker` load `.env.local` (via `@next/env`'s
`loadEnvConfig` in `lib/errors.ts`) — **start the worker from the repository root**.

### All variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_PATH` | `./data/clipcraft.db` | Path to the SQLite database, relative to the repository root unless absolute. Parent folders are created automatically. Web and worker processes must use the same path; restart both after changing it. The file is ignored by Git. |
| `GEMINI_API_KEY` | — | Google AI Studio. The chain is Gemini-only (5 slots, newest-first: `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite`); every slot reads this one key but draws from a separate free daily pool, so it is real 503-redundancy. Model order lives in `LLM_PROVIDER_CHAIN` in `lib/llm.ts` — append an entry there (and set the key) to add a provider back. The other free providers were removed after live testing: Groq 413 (free per-minute INPUT cap) + 429s, Cerebras 402 (paid), Mistral 429 (~1 RPM), NVIDIA NIM 404/410 (retired models) + timeouts. |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` | off (`nova-2`) | **Optional, paid.** If set, Deepgram wins over local whisper.cpp. Leave empty to stay 100 % local/free. |
| `WHISPER_CLI_PATH` | auto-detect | Overrides binary discovery (searches `.whisper/…`, `bin/whisper-win-x64/whisper-cli.exe`, `bin/whisper-cli`). |
| `WHISPER_MODEL_PATH` | auto-detect | Overrides model discovery (`models/ggml-*.bin`). |
| `WHISPER_LANGUAGE` | `auto` | e.g. `ur`, `hi`, `en`. `auto` detects the spoken language (needed for Urdu/Hindi/Punjabi). |
| `WHISPER_THREADS` | half your cores (2–8) | CPU threads for whisper. |
| `FFMPEG_PATH` | `ffmpeg-static` | Point at your own FFmpeg binary if the npm download failed. Must be FFmpeg ≥ 5.1 (`-fps_mode` is used). |
| `FFPROBE_PATH` | sibling / PATH | Full path to a local ffprobe if it is not beside FFmpeg or on PATH. Needed for VFR detection and clip verification. |
| `VIDEO_CRF` | `17` | Final libx264 quality; accepted range is 16–18 (lower means larger, higher-quality files). |
| `VIDEO_PRESET` | `slow` | libx264 speed/efficiency preset. Use `medium` to trade compression efficiency for faster renders. |
| `CAPTION_OFFSET_MS` | `0` | Caption-only timing adjustment. Positive delays captions; negative advances them. Audio/profanity timing is unchanged. |
| `SAVE_PRECAPTION_DEBUG` | `0` | Set `1` to keep `<clipId>_precaption.mp4` (video/audio before caption/card overlays) beside the final output. It adds a diagnostic encode only when enabled. |
| `SPLIT_FACE_TARGET_FRAC` | `0.38` | Split-grid face-box centre as a fraction of pane height; clamped to `0.25–0.55`. Applies consistently to 2/3/4-cell layouts. |
| `SPLIT_ZOOM` | `1.5` | Maximum split crop magnification; clamped to `1–2`. Set `1.0` to avoid enlargement. Low-resolution inputs may still need enlargement to fill output. |
| `PORT` | `3000` | Next.js port. |
| `ALLOWED_DEV_ORIGINS` | `*.e2b.app` (built in) | Extra hostnames allowed for dev assets (tunnels, LAN). Comma-separated, no scheme/port. |
| `WORKER_CONCURRENCY` | `1` | Clips rendered in parallel. Keep at 1 on a normal PC: each job runs FFmpeg plus transparent overlay-frame generation. |
| `REMOTION_CONCURRENCY` | auto | Chrome tabs Remotion uses while painting transparent overlays. |
| `REMOTION_LOG_LEVEL` | `info` | `verbose` when debugging a render. |
| `REMOTION_TIMEOUT_MINUTES` | `60` | Per-render ceiling. |


| `ENABLE_YT_IMPORT` | off | Set `1` to re-enable the (fragile) YouTube download path on the upload page. |
| `PROFANITY_AUDIO_MODE` | `mute` | Render-time audio handling of profane words from the transcript: `mute` (silence the word), `beep` (1 kHz tone), `off` (leave audio alone). Captions/overlay text are masked **regardless**; the stored transcript keeps the original words, so changing this only needs a re-render. |
| `UPLOAD_DIR` | `uploads` | Where source videos + in-progress upload sessions are stored. |
| `MAX_UPLOAD_MB` | `0` (unlimited) | Optional guard rail for a single upload. Long podcasts need no limit — leave at 0. |
| `UPLOAD_CHUNK_MB` | `8` | Chunk size the resumable uploader sends. |
| `MAX_MULTIPART_MB` | `256` | Size cap for the single-request `POST /api/upload` (it buffers the body in RAM). The UI never uses that endpoint. |
| `UPLOAD_SESSION_TTL_HOURS` | `24` | Unfinished upload sessions are deleted after this long. |

---

### Defaults live in two places

`.env.local` is the **fallback**, and the app has a **Settings** page (`/settings`, in the
sidebar) that saves overrides for the same values into `app_settings` rows in the SQLite
file: pipeline defaults, render clip defaults, the Gemini key pool, Deepgram key + model
+ engine choice, worker concurrency, and the profanity audio mode. Precedence is always
*stored value → `.env.local` → built-in default*, and every row on that page tells you
which of the three won.

That split is deliberate:

- a fresh clone (or a script like `npm run verify:clip`) keeps working from `.env.local`
  alone, with nothing to click first;
- the pool in `GEMINI_API_KEY` may hold several keys separated by commas, semicolons, or
  newlines — `lib/llm.ts` tries each one before moving to the next model;
- keys saved in the app are returned **masked** (`AIza…9f3`). Pasting a masked entry back
  and saving keeps the stored key, so you can reorder the pool without retyping it.
  Secrets live in the same git-ignored SQLite file as `.env.local`, so the trust boundary
  does not change;
- **clip and detection concurrency need `npm run worker` restarted** — the polling loops
  are sized when the process starts, and the page says so while an override is saved.
  Everything else, including Chrome tabs per render, transcription, render defaults and
  the profanity mode, applies to the next job. Use **Test** on the AI card to check a key
  against Google or Deepgram before saving — unsaved keys are testable too.

## 4. SQLite database and job queue

No separate database or queue process is required. The web server and worker open the
same file at `DATABASE_PATH` (default `./data/clipcraft.db`). The app creates the
parent directory and database on first use, enables WAL mode with
`busy_timeout=5000`, and applies versioned schema migrations. Back up the database
file while both processes are stopped; in WAL mode, SQLite may also use adjacent
`-wal` and `-shm` files while running.

The SQLite `jobs` table replaces BullMQ/Redis. The worker polls independent
transcription and render queues; keep `npm run worker` running while processing. It
preserves two total attempts (one retry after 2 seconds by default; the exponential
backoff doubles if a job is configured for more attempts) and requeues interrupted
claims on startup. Run exactly one worker process per database: `WORKER_CONCURRENCY`
controls parallel render slots inside that process, while transcription uses one slot.
A terminal job row is retained until that record is queued again or deleted; deleting
a clip/video also removes its job rows.

**Existing MongoDB data is not imported.** This migration intentionally starts with a
fresh SQLite database; old MongoDB records do not appear automatically. Existing media
files in `uploads/` remain on disk, but their metadata is not carried over. Back them
up and re-upload them if they are still needed.

---

## 5. Download a whisper.cpp model

The repo ships a **Windows x64** whisper.cpp build at `bin/whisper-win-x64/`
(`whisper-cli.exe` + its DLLs). The ggml *models* are 75 MB–1.5 GB and are
deliberately **not** committed — download one:

```powershell
npm run setup:whisper        # Node script (Windows/macOS/Linux)
npm run setup:whisper:ps     # pure PowerShell equivalent

# options
npm run setup:whisper -- --model small --force
```

The script:

1. fetches a whisper.cpp release binary into `.whisper/` (skipped on Windows when
   the committed `bin/whisper-win-x64/whisper-cli.exe` exists; on macOS/Linux it
   prints build-from-source instructions),
2. downloads a ggml model into `models/` (default **`small`** — much better for
   Urdu/Hindi; `tiny` faster/rougher, `medium`/`large-v3` best/slowest), and
3. writes `WHISPER_CLI_PATH` / `WHISPER_MODEL_PATH` into `.env.local`.

For non-English audio use `small` or better, and set `WHISPER_LANGUAGE=ur` (or
leave `auto`).

> If your network blocks GitHub/Hugging Face, download `ggml-small.bin` manually
> from <https://huggingface.co/ggerganov/whisper.cpp/tree/main> into `models/` and
> set `WHISPER_MODEL_PATH=models/ggml-small.bin`.

---

## 6. YuNet face model (active-speaker tracking)

Clips frame the active speaker with OpenCV's **YuNet** detector
(`face_detection_yunet_2023mar.onnx`) running on `onnxruntime-node` — fully local.
The 232 KB model is **committed** at `models/yunet/`, so there is nothing to do.

`npm run setup:yunet` is idempotent: it re-downloads and SHA-256-verifies the model
(if the committed copy is ever missing/corrupt) from OpenCV Zoo / jsDelivr /
Hugging Face mirrors, and refuses a file that doesn't match the official
232 589-byte checksum.

**There is no fallback detector** (no skin-tone heuristic, no static-crop
"pretend tracking"). If the model is missing or the ONNX runtime fails, speaker
layout renders **stop with a clear error** telling you to run
`npm run setup:yunet` — see [docs/LAYOUTS.md](./docs/LAYOUTS.md) for the full
tracking design (audio↔motion fusion, hysteresis, the locked split-screen panes).

---

## 7. Run the app (two processes)

```powershell
# 1. worker (transcription + rendering) — leave this running
npm run worker

# 2. web app
npm run dev
```

(or double-click **`start-clipcraft.bat`** to start both and open the browser)

Open <http://localhost:3000>, then **visit `/startup-validation` first**. That page
checks SQLite open/write/read access, WAL mode and `busy_timeout`, FFmpeg, the
transcription engine (using the *same* discovery logic as the real run), the AI
provider chain, and the Remotion renderer, and tells you exactly what to fix.

### What happens after you upload

1. The browser uploads through `POST /api/upload/session` +
   `PUT /api/upload/session/{id}` in chunks (8 MB default). **No size limit** — a
   three-hour podcast is normal — and each chunk streams straight to disk, so a
   multi-GB file never sits in the server's RAM. Losing the connection (VPN hiccup,
   dev-server reload, laptop sleep) is fine: press **Resume upload** and it
   continues from the last confirmed byte. The single-request `POST /api/upload`
   remains for scripts/Postman, but it buffers the body in memory, so it is capped
   at `MAX_MULTIPART_MB` (256 MB).
2. Finishing the upload moves the file into `uploads/` (named
   `001_my_recording.mp4` — 3-digit sequence + original name), probes it with
   FFmpeg and enqueues a **transcription job** — the request returns immediately.
   The automation you ticked on the upload form (`autoDetect`, `autoRender`, plus
   the AI clip options) is stored with the video record in `videos.pipeline_json`,
   so the rest of the chain keeps running with those settings after a reload, a
   retry, or a worker restart. It is editable per video from the dashboard's
   **Pipeline** panel.
3. The worker transcribes with whisper.cpp (or Deepgram, if you opted in) and
   stores word-level timestamps in SQLite.
4. **Detect viral segments** asks the Gemini chain (5-slot fallback) for
   `{start, end, hookText, ctaText, reason, score}` — with an automatic **top-up
   pass** if it returns fewer than the requested count. It is queued by the worker as
   soon as step 3 finishes, so you never have to press it (unless you switched
   *auto-detect* off). Clip count, minimum clip length (max is fixed internally at
   90 s), and the hook/CTA switches come from the video's stored settings; the form
   remembers your last choice in `localStorage` as the default for the next upload.
5. **Render** (per clip, queued for every detected clip when *auto-render* is on —
   the default, using the stock configuration; turn it off to review the scores in the
   grid first): the complete hook interval returned by viral detection
   (`hook_timestamp.start`→`hook_timestamp.end`) is duplicated to the **start**, with
   a 0.5 s dip-to-black → active-speaker layout planning (`worker/asd/` +
   `worker/layout.ts`) → transparent caption / hook / CTA frames are prepared by
   the selected **caption engine** (`remotion` default, or native ASS for captions)
   → one FFmpeg graph does the source trim, mirror, crop, colour, hook intro, overlay
   compositing, audio handling and the single final H.264 encode (1080×1920).
6. Output: `generated-clips/001_my_recording/<clip title>.mp4`, tracked in
   SQLite. The dashboard plays it through `/api/media/...` (Range-enabled, so
   seeking works). Each clip in the grid shows its viral score and the AI analysis;
   **Edit** on a clip saves new settings and re-renders that one clip only.

---

## 8. Troubleshooting

**`YuNet face detection is unavailable` / `No faces were detected in this clip window`**
Speaker layouts have no fallback detector by design: run `npm run setup:yunet`
(model), and if a face genuinely can't be found, pick a window where the speaker
is visible, reasonably large and well lit — then re-render.

**Remotion overlay-frame rendering fails**
The worker uses Remotion only to paint transparent PNG overlays; the source video
never enters Chrome. On the first run Remotion downloads its browser shell. Check
the `[Remotion Renderer]` log for bundle/browser errors, then retry with a lower
`REMOTION_CONCURRENCY` if memory is constrained. Increase
`REMOTION_TIMEOUT_MINUTES` only for legitimately long overlay sequences.

**Rendered clip has no video / black frames**
The source crop and overlays are composed in the final FFmpeg pass. Check the
`[FFmpeg]` log for the filter/encode error and verify `FFMPEG_PATH` points to a
build with libx264; the transparent overlay render cannot replace or decode the
source video.

**Rendered clip is silent**
The final FFmpeg pass maps the source audio (or creates a silent `anullsrc` track
when the source has none) and encodes it as AAC. `PROFANITY_AUDIO_MODE=mute`
intentionally silences transcript windows; check the `[FFmpeg]` mapping/filter log
if other audio is missing.

**Captions out of sync / audio drifts / clip plays at the wrong speed**
Run `npm run verify:clip -- <file>` to inspect avg/r frame rates, VFR classification,
stream start times/durations and bitrates. The worker uses the average rate, explicitly
normalizes VFR branches before hook concatenation, and aligns audio timestamps against
the video stream start. Use `CAPTION_OFFSET_MS` only for a remaining caption-vs-speech
latency (`+` delays captions, `-` advances them); it never changes audio. Set
`SAVE_PRECAPTION_DEBUG=1` to compare the pre-overlay output with the final render.

**Crop is on the wrong side of the speaker**
Sample frames are extracted with `hflip` applied, because the render chain is
`hflip,crop=…` — crop coordinates must live in *mirrored* space. If you change the
pipeline, keep sampling and cropping in the same space.

**Re-rendering a clip does nothing**
The SQLite queue uses a stable job ID per clip and resets a terminal/queued row when
re-enqueuing. A render already marked `running` returns HTTP 409; wait for it to finish
before submitting that clip again. Different clips from the same source video may
render concurrently.

**`whisper-cli.exe` fails with "VCRUNTIME140.dll was not found"**
Install the VC++ redistributable (§1).

**Whisper complains about an unknown option (`-ojf`, `-sow`, `-wt`)**
Those are newer whisper.cpp flags. The committed build supports them; if you point
`WHISPER_CLI_PATH` at an older build, use one that accepts `-ojf` (or re-run
`npm run setup:whisper --force`).

**Upload fails with a size error**
The UI's resumable path has **no limit**. Size errors mean an optional guard rail
is set: `MAX_UPLOAD_MB` (unlimited unless you set it) or `MAX_MULTIPART_MB` for the
single-request endpoint (scripts only).

**Upload stops at a certain percentage / the connection drops mid-upload**
Nothing is lost: the in-flight chunk is re-sent from the last confirmed byte, and
the uploader retries automatically. If the page reloaded or the dev server
restarted, press **Resume upload** — it continues from the server's byte count.
Chunks live in `uploads/.upload-sessions/<id>/`; unfinished sessions are deleted
after `UPLOAD_SESSION_TTL_HOURS` (24 h default).

**The dev server gets slow or OOMs during a large upload**
It should not: bytes stream to disk with backpressure, so memory stays flat. The
one buffered path left is the single-shot `POST /api/upload` — which is exactly why
it is capped and why the UI always uses the chunked endpoint.

**Video stuck in `transcribing` / clip stuck in `processing`**
The worker may not be running (`npm run worker`). Transcription and rendering are
stored in the SQLite jobs table, not tied to the HTTP request; after a worker crash,
starting it again recovers jobs that were left running. Check the worker log and
`DATABASE_PATH` if the status does not change.

**SQLite cannot open the database / reports a lock timeout**
Confirm `DATABASE_PATH` points to a writable local disk and that both the web app and
worker use the same value. Stop/restart both processes after changing it. SQLite is
configured for WAL and waits up to five seconds for a competing writer; do not place
the file on a network share or sync folder.

**`ffmpeg-static` binary missing after install**
Its postinstall download was blocked. Set `FFMPEG_PATH` to your own `ffmpeg.exe`
(any FFmpeg 5+ build works), or run `npm rebuild ffmpeg-static`.

**Port 3000 already in use**
`set PORT=3001` (PowerShell: `$env:PORT=3001`) before `npm run dev`.

---

## 8b. Known harmless warnings

**`next build` prints "Static analysis determined that this filesystem access
causes the whole project to be traced"**
Expected. `lib/ffmpeg.ts`, `lib/whisper.ts` and `app/api/media/[...path]/route.ts`
resolve paths at runtime (`uploads/`, `generated-clips/`, `models/`, `bin/`) —
exactly what a local app has to do. The build still finishes successfully; the
warning matters only for a Vercel deployment, which this project is explicitly not.

**First render downloads a headless browser**
Remotion fetches its headless Chrome shell on the first `renderFrames` call (and
`npm run studio` needs it too) — a one-time download of a few hundred MB. If your
network blocks it, allow the Chrome-for-Testing CDN, or run
`npx remotion browser ensure`.

---

## 9. Useful commands

```powershell
npm run worker           # SQLite-backed worker (transcription + rendering)
npm run dev              # Next.js dev server
npm run studio           # Remotion Studio — inspect CaptionComposition frame by frame
npm run setup:whisper    # whisper.cpp binary (non-Windows) + ggml model
npm run setup:yunet      # (re)download + verify the YuNet face model
npm run typecheck        # tsc --noEmit
npm test                 # node:test unit tests (tsx --test tests/*.test.ts)
npm run verify:clip -- generated-clips/<video>/<clip>.mp4  # ffprobe output diagnostics
npm run lint             # eslint
npm run build            # production build
```

---

## 10. Where things live

```
app/api/videos/            upload, list, probe; [id]/transcript + [id]/detect-viral
app/api/clips/             list, create/render, [id] (status/file), [id]/cancel
app/api/upload/            single-shot multipart (capped) + optional YouTube import
app/api/upload/session/    resumable chunked upload (no limit) + finalize/abort
app/api/media/[...path]/   Range-enabled HTTP file server for uploads/ + generated-clips/
app/api/{caption,overlay,text}-presets/ + prompt-templates/ + startup-validation/
app/caption-presets/       caption style preset manager (live preview)
app/prompt-templates/      edit the LLM prompt templates
app/startup-validation/    pre-flight checks UI
lib/upload.ts              shared upload policy: names, sizes, video record, enqueue
lib/upload-session.ts      resumable sessions on disk (append, finalize, TTL sweep)
lib/upload-client.ts       browser chunking, progress, retry + resume
lib/ffmpeg.ts              FFmpeg/ffprobe resolution + structured stream probe + spawn wrapper
lib/whisper.ts             cross-platform whisper.cpp discovery & transcription
lib/deepgram.ts            optional cloud STT override (REST, no SDK)
lib/queue.ts               prepared SQLite jobs: atomic claims, retries, and recovery
lib/llm.ts                 Gemini fallback chain (config array + plain fetch, no SDKs)
lib/ai.ts                  prompt templates + JSON parsing + exact-count top-up
lib/profanity.ts           word masking + render-time mute/beep windows
lib/overlay-bg.ts          solid/gradient card-background picker helpers
lib/presets.ts             default caption/overlay/text presets
lib/startup-validation.ts  the checks behind /startup-validation
lib/db.ts                  SQLite schema migrations, prepared helpers, and typed CRUD
worker/index.ts            SQLite queue loops, recovery, graceful shutdown
worker/processor.ts        per-clip orchestration (hook, layout, engines, masking)
worker/asd/                active-speaker detection: audio.ts, yunet, tracker.ts,
                           speaker.ts (fusion + timeline)
worker/yunet-detector.ts   YuNet ONNX detector (OpenCV-exact pre/post-processing)
worker/frame-sampler.ts    mirrored frame sampling + pan smoothing/decimation
worker/layout.ts           speaker-focus vs split-grid plans (peak-concurrent cells)
worker/camera-lock.ts      locked split-pane camera (hold still, re-centre only when the head leaves)
worker/overlay-layout.ts   layout-aware caption / hook / CTA placement (off the faces in a split)
worker/ffmpeg-pipeline.ts  One final FFmpeg graph: hflip → crop → colour → hook → overlays → H.264
worker/remotion-renderer.ts  "remotion" engine: transparent full-timeline overlay PNG sequence
worker/native-captions.ts  "native" engine: ASS caption PNGs + Remotion hook/CTA sequences
worker/captions-ass.ts     ASS caption generation (karaoke fill, word pop, CTA lift)
remotion/                  CaptionComposition + AnimatedWord + Hook/CTA overlays
scripts/setup-whisper.*    binary + ggml model downloader (.mjs and .ps1)
scripts/setup-yunet.mjs    YuNet model downloader with SHA-256 verification
scripts/verify-clip.ts     ffprobe report for resolution, rates, stream timing and bitrates
models/yunet/              committed YuNet face-detection model (232 KB)
bin/whisper-win-x64/       committed Windows x64 whisper.cpp build (whisper-cli + DLLs)
```
