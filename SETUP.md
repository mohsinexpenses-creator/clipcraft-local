# ClipCraft Local — Setup & Troubleshooting (Windows-first)

Practical guide to installing and running ClipCraft. The product overview lives in
[README.md](./README.md); feature guides in [`docs/`](./docs).

Everything runs on your own PC: Next.js + a separate BullMQ worker + MongoDB/Redis in
Docker. **No Python, no cloud media services** — the only external calls are to your
local Docker services and the free Google AI Studio LLM. (Deepgram is an *optional*
paid transcription override, off by default.)

One-click on Windows: **`start-clipcraft.bat`** starts Docker Desktop, the DB
containers, the worker and the web app, then opens the browser. The steps below are
what it does, manually.

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js 20+ (LTS) | Next.js 16 + the worker | `node -v` |
| Docker Desktop | MongoDB + Redis containers | `docker compose version` |
| **Microsoft Visual C++ Redistributable (x64)** | `whisper-cli.exe` is a native build and needs `vcruntime140.dll` / `msvcp140.dll` | Install once: <https://aka.ms/vs/17/release/vc_redist.x64.exe> |
| Google AI Studio API key (`GEMINI_API_KEY`) | Viral-segment detection + hook/CTA text | Free: <https://aistudio.google.com/app/apikey> |

FFmpeg is **not** a manual install — `ffmpeg-static` downloads a binary during
`npm install` and `lib/ffmpeg.ts` resolves it automatically.

---

## 2. Install

```powershell
cd clipcraft-local
npm install
```

`npm install` fetches:

- `ffmpeg-static` → the FFmpeg binary used for cutting/mirroring/cropping/concat
- `@remotion/bundler` + `@remotion/renderer` → the headless browser Remotion needs
  to render captions (first render downloads Chromium automatically)
- `onnxruntime-node` → the ONNX runtime that runs the committed YuNet face model
  (fully local, no vision API)

---

## 3. Configure `.env.local`

```powershell
copy .env.example .env.local
```

Then edit `.env.local`. Minimum for a first run:

```ini
MONGODB_URI=mongodb://127.0.0.1:27017
REDIS_URL=redis://127.0.0.1:6379
GEMINI_API_KEY=your-key
```

Both `npm run dev` and `npm run worker` load `.env.local` (via `@next/env`'s
`loadEnvConfig` in `lib/errors.ts`) — **start the worker from the repository root**.

### All variables

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | — | Use `127.0.0.1`, **not** `localhost`, if Docker/WSL2 resolves it to `::1`. Database name is fixed to `clipcraft` (`lib/db.ts`). |
| `REDIS_URL` | — | Same note as above. BullMQ needs Redis ≥ 6.2. |
| `GEMINI_API_KEY` | — | Google AI Studio. The chain is Gemini-only (5 slots, newest-first: `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite`); every slot reads this one key but draws from a separate free daily pool, so it is real 503-redundancy. Model order lives in `LLM_PROVIDER_CHAIN` in `lib/llm.ts` — append an entry there (and set the key) to add a provider back. The other free providers were removed after live testing: Groq 413 (free per-minute INPUT cap) + 429s, Cerebras 402 (paid), Mistral 429 (~1 RPM), NVIDIA NIM 404/410 (retired models) + timeouts. |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` | off (`nova-2`) | **Optional, paid.** If set, Deepgram wins over local whisper.cpp. Leave empty to stay 100 % local/free. |
| `WHISPER_CLI_PATH` | auto-detect | Overrides binary discovery (searches `.whisper/…`, `bin/whisper-win-x64/whisper-cli.exe`, `bin/whisper-cli`). |
| `WHISPER_MODEL_PATH` | auto-detect | Overrides model discovery (`models/ggml-*.bin`). |
| `WHISPER_LANGUAGE` | `auto` | e.g. `ur`, `hi`, `en`. `auto` detects the spoken language (needed for Urdu/Hindi/Punjabi). |
| `WHISPER_THREADS` | half your cores (2–8) | CPU threads for whisper. |
| `FFMPEG_PATH` | `ffmpeg-static` | Point at your own `ffmpeg.exe` if the npm download failed. Must be FFmpeg ≥ 5.1 (the pipeline uses `-fps_mode`; `-vsync` was removed in 7). |
| `PORT` | `3000` | Next.js port. |
| `ALLOWED_DEV_ORIGINS` | `*.e2b.app` (built in) | Extra hostnames allowed for dev assets (tunnels, LAN). Comma-separated, no scheme/port. |
| `WORKER_CONCURRENCY` | `1` | Clips rendered in parallel. Keep at 1 on a normal PC: each job runs FFmpeg + a headless Chrome render. |
| `REMOTION_CONCURRENCY` | auto (half the cores) | Chrome tabs Remotion uses per render. |
| `REMOTION_LOG_LEVEL` | `info` | `verbose` when debugging a render. |
| `REMOTION_TIMEOUT_MINUTES` | `60` | Per-render ceiling. |
| `OFFTHREAD_VIDEO_CACHE_MB` | Remotion default | Raise (e.g. `2048`) only if a render fails with "No frame found at position" on a machine with plenty of RAM. |
| `OFFTHREAD_VIDEO_THREADS` | Remotion default | Compositor frame-extraction threads. |
| `ENABLE_YT_IMPORT` | off | Set `1` to re-enable the (fragile) YouTube download path on the upload page. |
| `PROFANITY_AUDIO_MODE` | `mute` | Render-time audio handling of profane words from the transcript: `mute` (silence the word), `beep` (1 kHz tone), `off` (leave audio alone). Captions/overlay text are masked **regardless**; the stored transcript keeps the original words, so changing this only needs a re-render. |
| `UPLOAD_DIR` | `uploads` | Where source videos + in-progress upload sessions are stored. |
| `MAX_UPLOAD_MB` | `0` (unlimited) | Optional guard rail for a single upload. Long podcasts need no limit — leave at 0. |
| `UPLOAD_CHUNK_MB` | `8` | Chunk size the resumable uploader sends. |
| `MAX_MULTIPART_MB` | `256` | Size cap for the single-request `POST /api/upload` (it buffers the body in RAM). The UI never uses that endpoint. |
| `UPLOAD_SESSION_TTL_HOURS` | `24` | Unfinished upload sessions are deleted after this long. |

---

## 4. Start MongoDB + Redis

```powershell
npm run db:up      # docker compose up -d  (mongo:7 + redis:7-alpine)
npm run db:logs    # watch the logs
npm run db:down    # stop
```

Data survives restarts in the named Docker volumes `clipcraft-mongo` /
`clipcraft-redis`. Neither service has auth — they are for local single-user use
only. Do not expose these ports to the internet.

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

## 7. Run the app (three processes)

```powershell
# 1. databases
npm run db:up

# 2. worker (transcription + rendering) — leave this running
npm run worker

# 3. web app
npm run dev
```

(or double-click **`start-clipcraft.bat`** to do all of the above at once)

Open <http://localhost:3000>, then **visit `/startup-validation` first**. That page
checks MongoDB, Redis, FFmpeg, the transcription engine (using the *same* discovery
logic as the real run), the AI provider chain, and the Remotion renderer, and tells
you exactly what to fix.

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
3. The worker transcribes with whisper.cpp (or Deepgram, if you opted in) and
   stores word-level timestamps in MongoDB.
4. **Detect viral segments** asks the Gemini chain (5-slot fallback) for
   `{start, end, hookText, ctaText, reason, score}` — with an automatic **top-up
   pass** if it returns fewer than the requested count. Clip count, minimum clip
   length (max is fixed internally at 90 s), and the hook/CTA switches are
   per-video options persisted in your browser.
5. **Render** (per clip): a second LLM pass picks the most gripping moment in the
   clip → it is duplicated to the **start** as a **fixed 3 s hook** with a 0.5 s
   dip-to-black → active-speaker layout planning (`worker/asd/` +
   `worker/layout.ts`) → FFmpeg (mirror + animated crop + colour + hook concat) →
   captions via the clip's **caption engine** (`remotion` default, or `native`
   fast ASS burn-in) → on-screen hook/CTA cards from your style presets
   (solid or **gradient** backgrounds).
6. Output: `generated-clips/001_my_recording/<clip title>.mp4`, tracked in
   MongoDB. The dashboard plays it through `/api/media/...` (Range-enabled, so
   seeking works).

---

## 8. Troubleshooting

**`YuNet face detection is unavailable` / `No faces were detected in this clip window`**
Speaker layouts have no fallback detector by design: run `npm run setup:yunet`
(model), and if a face genuinely can't be found, pick a window where the speaker
is visible, reasonably large and well lit — then re-render.

**"Compositor error: No frame found at position N"**
Two known causes, both handled: (1) the hook+base clip used to be stitched with
FFmpeg `-c copy`, leaving the second segment's timestamps unusable for Remotion's
compositor — the concat step now re-encodes into one clean CFR file; (2) a
too-small offthread video frame cache on low-memory machines — raise
`OFFTHREAD_VIDEO_CACHE_MB`. If it still happens, post the processed clip and
`npx remotion versions` output at https://remotion.dev/report.

**"Not allowed to load local resource: file:///…" / "Can only download URLs
starting with http:// or https://"**
Remotion renders inside headless Chrome, which **cannot read the filesystem** —
video sources must be http(s)/data: URLs (or `staticFile()`). The worker serves the
processed clip from a throwaway `127.0.0.1` HTTP server for the duration of the
render (`worker/clip-http-server.ts`) and passes that URL as `videoSrc`. The worker
logs the served URL: `[Remotion Renderer] Serving clip to Remotion via
http://127.0.0.1:PORT/clip.mp4`.

**Rendered clip has no video / black frames**
Check the worker log line `[Remotion Renderer] Source: WxH @ Nfps …` — if the
source probe failed, the FFmpeg stage produced a bad intermediate. If it looks
correct, confirm the "Serving clip" line appears right after it and the URL is
reachable in a browser tab on the same machine.

**Rendered clip is silent**
The renderer sets `enforceAudioTrack: true` and the FFmpeg stage muxes a silent
`anullsrc` track when the source has no audio, so the track always exists. (Note:
profanity `mute` mode intentionally silences short windows — see
`PROFANITY_AUDIO_MODE`.) If the log prints `WARNING: the rendered clip has no audio
stream`, the processed clip lost its audio — check the `-map` output in the worker
log.

**Captions out of sync / clip plays at the wrong speed**
fps is derived from the source (`normalizeFps`) and passed to both the FFmpeg stage
(`-r` + cfr) and `renderMedia`. If sync is off, check the `[FFmpeg]` probe lines in
the worker log.

**Crop is on the wrong side of the speaker**
Sample frames are extracted with `hflip` applied, because the render chain is
`hflip,crop=…` — crop coordinates must live in *mirrored* space. If you change the
pipeline, keep sampling and cropping in the same space.

**Re-rendering a clip does nothing**
BullMQ silently drops a job when the `jobId` already exists. `lib/queue.ts`
removes any completed/failed job with the same id first, and returns HTTP 409 if
that clip is still actively rendering.

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

**Video stuck in `transcribing` forever**
The worker is not running (`npm run worker`), or Redis is unreachable.
Transcription happens in the queue, not the HTTP request — a page refresh can no
longer orphan it.

**MongoDB/Redis connection refused on Windows + Docker Desktop**
Use `127.0.0.1` instead of `localhost` in `.env.local`. If Docker runs inside WSL2,
make sure the ports are published (they are, in `docker-compose.yml`).

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
Remotion fetches its headless Chrome shell on the first `renderMedia` call (and
`npm run studio` needs it too) — a one-time download of a few hundred MB. If your
network blocks it, allow the Chrome-for-Testing CDN, or run
`npx remotion browser ensure`.

---

## 9. Useful commands

```powershell
npm run db:up            # start MongoDB + Redis
npm run worker           # BullMQ worker (transcription + rendering)
npm run dev              # Next.js dev server
npm run studio           # Remotion Studio — inspect CaptionComposition frame by frame
npm run setup:whisper    # whisper.cpp binary (non-Windows) + ggml model
npm run setup:yunet      # (re)download + verify the YuNet face model
npm run typecheck        # tsc --noEmit
npm run test:worker      # node:test unit tests (tsx --test tests/*.test.ts)
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
lib/ffmpeg.ts              ffmpeg-static path resolution + probe + spawn wrapper
lib/whisper.ts             cross-platform whisper.cpp discovery & transcription
lib/deepgram.ts            optional cloud STT override (REST, no SDK)
lib/queue.ts               BullMQ queues: transcription + clip render
lib/llm.ts                 Gemini fallback chain (config array + plain fetch, no SDKs)
lib/ai.ts                  prompt templates + JSON parsing + exact-count top-up
lib/profanity.ts           word masking + render-time mute/beep windows
lib/overlay-bg.ts          solid/gradient card-background picker helpers
lib/presets.ts             default caption/overlay/text presets
lib/startup-validation.ts  the checks behind /startup-validation
lib/db.ts                  MongoDB client (database: clipcraft)
worker/index.ts            both BullMQ workers, graceful shutdown
worker/processor.ts        per-clip orchestration (hook, layout, engines, masking)
worker/asd/                active-speaker detection: audio.ts, yunet, tracker.ts,
                           speaker.ts (fusion + timeline)
worker/yunet-detector.ts   YuNet ONNX detector (OpenCV-exact pre/post-processing)
worker/frame-sampler.ts    mirrored frame sampling + pan smoothing/decimation
worker/layout.ts           speaker-focus vs split-grid plans (peak-concurrent cells)
worker/camera-lock.ts      locked split-pane camera (hold still, re-centre only when the head leaves)
worker/overlay-layout.ts   layout-aware caption / hook / CTA placement (off the faces in a split)
worker/ffmpeg-pipeline.ts  ONE frame-exact pass: hflip → crop → colour → scale → hook intro
                           (0.5 s dip-to-black)
worker/remotion-renderer.ts  "remotion" caption engine (bundle → renderMedia)
worker/native-captions.ts  "native" engine: PNG-sequence hook/CTA overlays
worker/captions-ass.ts     ASS caption generation (karaoke fill, word pop, CTA lift)
worker/clip-http-server.ts throwaway 127.0.0.1 HTTP server for Remotion
remotion/                  CaptionComposition + AnimatedWord + Hook/CTA overlays
scripts/setup-whisper.*    binary + ggml model downloader (.mjs and .ps1)
scripts/setup-yunet.mjs    YuNet model downloader with SHA-256 verification
models/yunet/              committed YuNet face-detection model (232 KB)
bin/whisper-win-x64/       committed Windows x64 whisper.cpp build (whisper-cli + DLLs)
```
