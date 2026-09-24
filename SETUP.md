# ClipCraft Local — Setup & Troubleshooting (Windows-first)

This file is the practical guide. `README.md` is the original product spec — it is kept
unchanged on purpose.

Everything runs on your own PC: Next.js + a separate BullMQ worker + MongoDB/Redis in
Docker. No Python, no cloud video services (except the optional LLM + Deepgram keys).

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js 20+ (LTS) | Next.js 16 + the worker | `node -v` |
| Docker Desktop | MongoDB + Redis containers | `docker compose version` |
| **Microsoft Visual C++ Redistributable (x64)** | `whisper-cli.exe` is a native build and needs `vcruntime140.dll` / `msvcp140.dll` | Install once: <https://aka.ms/vs/17/release/vc_redist.x64.exe> |
| Gemini or Anthropic API key | Viral-segment detection + hook/CTA text | one of the two |

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
- `@remotion/bundler` + `@remotion/renderer` → the headless browser Remotion needs to
  render captions (first run downloads Chromium automatically)
- `@vladmandic/face-api` → **optional** face detection (see §7)

---

## 3. Configure `.env.local`

```powershell
copy .env.example .env.local
```

Then edit `.env.local`. Minimum for a first run:

```ini
MONGODB_URI=mongodb://127.0.0.1:27017
REDIS_URL=redis://127.0.0.1:6379
GEMINI_API_KEY=your-key            # or ANTHROPIC_API_KEY
```

### All variables

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | — | Use `127.0.0.1`, **not** `localhost`, if Docker/WSL2 resolves it to `::1`. |
| `REDIS_URL` | — | Same note as above. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | `gemini-flash-latest` | Rolling alias — never goes stale like `gemini-1.5-flash` did. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | `claude-3-haiku-20240307` is retired and now returns a 404. |
| `AI_PROVIDER` | auto | Force `gemini` or `anthropic` when both keys are set. |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` | off (`nova-2`) | If set, Deepgram wins over local whisper.cpp. |
| `WHISPER_CLI_PATH` | auto-detect | Overrides binary discovery. |
| `WHISPER_MODEL_PATH` | auto-detect | Overrides model discovery (`models/ggml-*.bin`). |
| `WHISPER_LANGUAGE` | `auto` | e.g. `ur`, `hi`, `en`. `auto` lets whisper detect. |
| `WHISPER_THREADS` | half your cores | Raise for faster transcription. |
| `FFMPEG_PATH` | `ffmpeg-static` | Point at your own `ffmpeg.exe` if you prefer. |
| `PORT` | `3000` | Next.js port. |
| `WORKER_CONCURRENCY` | `1` | Clips rendered in parallel. Keep at 1 unless you have ≥32 GB RAM. |
| `REMOTION_CONCURRENCY` | auto (half the cores) | Chrome render threads. |
| `REMOTION_LOG_LEVEL` | `info` | `verbose` when debugging a render. |
| `REMOTION_TIMEOUT_MINUTES` | `60` | Per-render ceiling. |
| `ENABLE_YT_IMPORT` | `0` | Set to `1` to re-enable the fragile YouTube download path. |

---

## 4. Start MongoDB + Redis

```powershell
npm run db:up      # docker compose up -d  (mongo:7 + redis:7-alpine)
npm run db:logs    # watch the logs
npm run db:down    # stop
```

Data survives restarts in the named Docker volumes `clipcraft-mongo` / `clipcraft-redis`.
Neither service has auth enabled — they are bound for local single-user use only. Do not
expose these ports to the internet.

---

## 5. Download whisper.cpp + a model

The repo ships a **Windows x64** whisper.cpp build at `bin/whisper-win-x64/`
(`whisper-cli.exe` + `whisper.dll`), but ggml models are 75 MB–1.5 GB each and are
deliberately **not** committed. Download one with:

```powershell
npm run setup:whisper        # Node script (Windows/macOS/Linux)
npm run setup:whisper:ps     # pure PowerShell equivalent

# options
npm run setup:whisper -- --model small --force
```

That fetches:
1. the latest whisper.cpp release for your OS/arch into `bin/` (skipped on Windows if
   `bin/whisper-win-x64/whisper-cli.exe` already exists), and
2. a ggml model into `models/` (default `base`, mirror fallback included), and
3. writes `WHISPER_CLI_PATH` / `WHISPER_MODEL_PATH` into `.env.local`.

Model choice: `tiny` (fastest, rough), `base` (default), `small` (much better for
Urdu/Hindi), `medium`/`large-v3` (best, slow, big). Non-English audio → use `small` or
better, and set `WHISPER_LANGUAGE=ur` (or leave `auto`).

> If your network blocks GitHub/Hugging Face, download
> `ggml-base.bin` manually from <https://huggingface.co/ggerganov/whisper.cpp/tree/main>
> and drop it in `models/`, then set `WHISPER_MODEL_PATH=models/ggml-base.bin`.

---

## 6. Run the app (three processes)

```powershell
# 1. databases
npm run db:up

# 2. worker (transcription + rendering) — leave this running
npm run worker

# 3. web app
npm run dev
```

Open <http://localhost:3000>, then **visit `/startup-validation` first**. That page
checks MongoDB, Redis, FFmpeg, the transcription engine (using the *same* discovery
logic as the real run), the AI provider, the prompt templates and the Remotion renderer,
and tells you exactly what to fix.

### What happens after you upload

1. `POST /api/upload` **streams** the file to `uploads/` (no more buffering the whole
   video in RAM) and enqueues a **transcription job** — the HTTP request returns
   immediately.
2. The worker transcribes with whisper.cpp (or Deepgram) and stores word-level
   timestamps in MongoDB.
3. "Detect viral segments" asks the LLM for `{start, end, hookText, score}`.
4. Rendering a clip enqueues a BullMQ job → the worker runs:
   smart crop detection → FFmpeg (mirror + crop + colour + hook intro) → Remotion
   (captions + hook/CTA overlays) → `generated-clips/{videoId}/{clipId}.mp4`.
5. The dashboard plays the clip through `/api/media/...` (a normal HTTP origin, with
   HTTP Range support so seeking works).

---

## 7. Optional: real face detection

The smart crop always works out of the box using a **skin-tone heuristic** (crude but
dependency-free). For proper face detection add a TensorFlow.js CPU backend:

```powershell
npm i @tensorflow/tfjs-core@^4 @tensorflow/tfjs-backend-cpu@^4
```

`worker/face-detector.ts` loads `@vladmandic/face-api` + the committed
`models/face/tiny_face_detector` weights **only if** tfjs is present, and silently falls
back to the heuristic otherwise. `face-api.js` (the abandoned fork, which pins tfjs 1.x)
was removed from `package.json`.

---

## 8. Troubleshooting

**"Not allowed to load local resource: file:///…"**
Fixed. The composition now uses `<OffthreadVideo src={absolutePath}>` (frames extracted
with FFmpeg outside the browser) instead of a bare `<video src="file://…">`, which
headless Chrome refuses to load from an `http://` origin. If you ever pass a `videoSrc`
again, pass a plain absolute path — never a `file://` URL.

**Rendered clip has no video / black frames**
Same root cause as above. Also check the worker log line
`[Remotion Renderer] Source: WxH @ Nfps …` — if the source probe failed, the FFmpeg stage
produced a bad intermediate.

**Rendered clip is silent**
The renderer sets `enforceAudioTrack: true` and the FFmpeg stage muxes a silent
`anullsrc` track when the source has no audio, so the track always exists. If the log
prints `WARNING: the rendered clip has no audio stream`, the processed clip lost its
audio — check the `-map` output in the worker log.

**Captions out of sync / clip plays at the wrong speed**
Fixed: fps is now derived from the source (`normalizeFps`) and passed to both the FFmpeg
stage (`-r` + `-vsync cfr`) and `renderMedia`. Previously it was hard-coded to 30fps.

**Crop is on the wrong side of the speaker**
Fixed: sample frames are extracted with `hflip` applied, because the render chain is
`hflip,crop=…` — the crop coordinates must live in *mirrored* space.

**Re-rendering a clip does nothing**
Fixed: BullMQ silently drops a job when the `jobId` already exists. `lib/queue.ts` now
removes any completed/failed job with the same id first, and returns HTTP 409 if that
clip is still actively rendering.

**`whisper-cli.exe` fails with "The code execution cannot proceed because VCRUNTIME140.dll was not found"**
Install the VC++ redistributable (§1).

**Whisper complains about an unknown option (`-ojf`, `-sow`, `-wt`)**
Those are newer whisper.cpp flags. The bundled build supports them; if you point
`WHISPER_CLI_PATH` at an older build, use one that accepts `-ojf` (or re-run
`npm run setup:whisper --force` to fetch the latest release).

**Video stuck in `transcribing` forever**
The worker is not running (`npm run worker`), or Redis is unreachable. Transcription no
longer happens inside the HTTP request, so a page refresh can no longer orphan it.

**MongoDB/Redis connection refused on Windows + Docker Desktop**
Use `127.0.0.1` instead of `localhost` in `.env.local`. If Docker runs inside WSL2, make
sure the ports are published (they are, in `docker-compose.yml`).

**`ffmpeg-static` binary missing after install**
Its postinstall download was blocked. Set `FFMPEG_PATH` to your own `ffmpeg.exe`, or run
`npm rebuild ffmpeg-static`.

**Port 3000 already in use**
`set PORT=3001` (PowerShell: `$env:PORT=3001`) before `npm run dev`.

---

## 8b. Known harmless warnings

**`next build` prints "Static analysis determined that this filesystem access causes the whole project to be traced"**
Expected. `lib/ffmpeg.ts`, `lib/whisper.ts` and `app/api/media/[...path]/route.ts` resolve
paths at runtime (`uploads/`, `generated-clips/`, `models/`, `bin/`) — that is exactly
what this app has to do. Turbopack warns because it matters for a Vercel deployment, and
this project is explicitly **not** deployed (see `README.md` → HARD CONSTRAINTS). The
build still finishes successfully.

**First render downloads a headless browser**
Remotion fetches its headless Chrome/Chromium shell on the first `renderMedia` call (and
`npm run studio` needs it too). That is a one-time download of a few hundred MB. If your
network blocks it, the render fails with a browser-download error — allow
`remotion.media` / the Google Chrome-for-Testing CDN, or run `npx remotion browser ensure`.

**`ffmpeg-static` binary missing after `npm install`**
Its postinstall downloads the binary from GitHub releases. If that was blocked, set
`FFMPEG_PATH` to your own `ffmpeg.exe` in `.env.local` (any FFmpeg 5+ build works) — the
`/startup-validation` page tells you which path was resolved.

---

## 9. Useful commands

```powershell
npm run db:up            # start MongoDB + Redis
npm run worker           # BullMQ worker (transcription + rendering)
npm run dev              # Next.js dev server
npm run studio           # Remotion Studio — inspect CaptionComposition frame by frame
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run build            # production build
```

---

## 9b. What was verified automatically

```
npx tsc --noEmit     -> 0 errors   (worker/, remotion/, lib/ and app/ all type-check)
npx eslint .         -> 0 problems
npx next build       -> compiled successfully, all 16 routes generated
@remotion/bundler    -> remotion/index.tsx bundles cleanly (webpack resolves every import)
```

Plus unit-level smoke tests over the pure logic: `evenSize`, `normalizeFps`,
`computeOutputSize`, `buildCaptionChunks`, the CTA window / caption-lift maths, the
preset ids the app hard-codes (`vibrant`, `preset-bold-yellow`), the LLM model defaults
and the whisper.cpp binary/model discovery. Those caught two real bugs while the fixes
were being written: `computeOutputSize(0, 0)` returned a 2x2 canvas instead of falling
back to 1080x1920, and the face-detector computed a sampling fps it never applied to
`-vf` (so it decoded every frame of the segment).

What could **not** be verified without your machine: an actual FFmpeg run, a whisper.cpp
transcription and a full Remotion render (all three need binaries/downloads that are
blocked in the sandbox). Run one short clip end to end first and read the worker log —
every stage now logs its inputs, its FFmpeg command and a probe of the file it produced.

---

## 10. Where things live

```
app/api/upload/          stream-to-disk upload + transcription enqueue
app/api/media/[...path]/ Range-enabled HTTP file server for uploads/ + generated-clips/
app/startup-validation/  pre-flight checks UI
lib/ffmpeg.ts            ffmpeg-static path resolution + probe + spawn wrapper
lib/whisper.ts           cross-platform whisper.cpp discovery & transcription
lib/deepgram.ts          optional cloud STT (REST, no SDK)
lib/queue.ts             BullMQ queues: clip render + transcription
lib/models.ts            LLM model ids, defaults and retired-model warnings
lib/ai.ts                provider selection (AI_PROVIDER / Gemini / Anthropic)
lib/startup-validation.ts the checks behind /startup-validation
worker/index.ts          both BullMQ workers, graceful shutdown
worker/processor.ts      per-clip orchestration
worker/face-detector.ts  mirrored-frame sampling + crop window
worker/ffmpeg-pipeline.ts hflip → crop → colour → scale → hook concat
worker/remotion-renderer.ts bundle (cached) → selectComposition → renderMedia
remotion/                CaptionComposition + AnimatedWord + Hook/CTA overlays
scripts/setup-whisper.*  binary + ggml model downloader (.mjs and .ps1)
models/face/             committed tiny_face_detector weights (~200 KB)
bin/whisper-win-x64/     committed Windows x64 whisper.cpp build
```
