# Setup and troubleshooting — Windows first

See [README.md](./README.md) for product behavior. Use English celebrity/gossip
videos for the intended visual-planning workflow.

## 1. Install and start

Requirements: Node.js 20+ LTS, a current browser, adequate free disk space for
source videos/PNG sequences, and on Windows the
[Visual C++ x64 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe).

```powershell
npm ci
Copy-Item .env.example .env.local
npm run setup:whisper
npm run setup:yunet
npm run dev
# Second terminal, same repository and environment:
npm run worker
```

Open `http://localhost:3000`. Save a Gemini key in **Settings → AI providers**;
use its Test button and `/startup-validation`. `start-clipcraft.bat` is the Windows
launcher after installation. Run exactly one worker per DB; its polling loops
provide internal concurrency. Restart both processes after a database-path change,
and restart the worker after worker-loop settings or an upgrade change.

`better-sqlite3` and `onnxruntime-node` are native modules. If installation fails,
use a supported x64 Node LTS build, install the VC++ runtime, and rerun `npm ci`.
A SQLite source build additionally requires the platform's C++ build toolchain.
Do not copy `node_modules` between operating systems.

### Local engines and browser

- FFmpeg normally comes from `ffmpeg-static` during `npm ci`. If its download is
  blocked, install a full FFmpeg distribution and set `FFMPEG_PATH`.
- ffprobe is a separate executable. Install it beside FFmpeg/on PATH or set
  `FFPROBE_PATH`. Without it, text probing can work, but VFR and stream diagnostics
  are incomplete; verification commands require ffprobe.
- Remotion installs/caches a compatible headless browser on first use. Run a test
  render while online before expecting an offline workflow. Use local fonts; do not
  replace bundled font loading with Google Fonts/network fetches during rendering.
- `setup:whisper` fetches the Windows whisper.cpp release and the selected ggml
  model and writes their paths. Large models need substantial RAM/disk. On other
  platforms build [whisper.cpp](https://github.com/ggml-org/whisper.cpp) locally and
  set `WHISPER_CLI_PATH` and `WHISPER_MODEL_PATH` to your own compatible build/model.
- `setup:yunet` downloads the official OpenCV Zoo 2023mar model, validating size
  232589 and SHA-256
  `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.
  Weights/binaries are ignored, not committed. Run setup again after a fresh clone.
  YuNet runs in Node through ONNX Runtime, using RGBA decoding/resizing and box
  detection only—no embeddings or face recognition. Missing weights/runtime fail
  face-required work clearly; person/B-roll safety never silently bypasses it.

## 2. Settings versus environment

**Settings → pipeline/render/AI/worker/profanity:** saved value, otherwise built-in
default. `.env.local` is not a fallback for these form-backed fields. API key masks
mean “keep this saved key,” not a new key. The explicit Import environment action
is the only supported way to copy legacy env-backed form values into Settings.

Per-video pipeline options are snapshotted at upload and win over later default
changes. Use the clip editor to change an existing clip. The database is local
SQLite with WAL and a durable jobs table, not a separate database/queue service.

Environment values without form fields remain supported; `.env.example` is the
full inventory. Common examples:

| Value | Purpose |
| --- | --- |
| `DATABASE_PATH` | Shared DB; default `./data/clipcraft.db` |
| `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH` | Local engine and ggml weights |
| `WHISPER_LANGUAGE` | `en` for this workflow; `auto` for multilingual inputs |
| `WHISPER_THREADS` | Local transcription CPU budget |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Optional executable overrides |
| `VIDEO_ENCODER` | `x264` (default), `qsv`, or `nvenc` |
| `VIDEO_CRF`, `VIDEO_PRESET` | Software encode quality/speed; see template |
| `REMOTION_TIMEOUT_MINUTES` | Bound long browser renders |
| `SAVE_PRECAPTION_DEBUG` | Keep an extra pre-caption video for diagnosing layers |
| `ALLOWED_DEV_ORIGINS` | Comma-separated development tunnel/LAN hosts |

QSV/NVENC require supported hardware and working drivers. The worker runs a short
probe for the requested encoder and falls back to x264 when hardware is unavailable.
Choose `x264` for a portable CPU baseline; lower CRF means higher
quality/larger files. Browser frame rendering and photo preparation still use CPU
and are not accelerated merely by choosing a hardware final encoder.

## 3. Caption themes and layout

There are 13 shipped themed presets. `cc-bold-punch` is first/default: kinetic-01,
positionY 28. The 12 other built-ins use `caption-theme-*` IDs. POST/PUT require a
valid `captionTheme`. There is no classic caption mode or unused classic styling
panel. Reset restores shipped themes without deleting valid custom themes or
replacing a valid custom default.

Upgrade retirement backs up invalid/themeless/retired rows **before** deletion to
`data/backups/caption-presets-removed-<timestamp>-<id>.json`. Raw config bytes are
preserved, including malformed JSON. Corrupt built-ins are reseeded in the same
transaction/open, and clip/render-default references are repointed. Keep a backup
of the DB and these JSON files if you may want to reconstruct an old style.

The layer order is speaker video → full-screen photograph → transparent Remotion
captions/hook/CTA/generic pops. Photo movement is zoom/fade, not animated cards.
Hook replay follows the detected hook interval; its dip/fades must stay free of
photos/text. Speaker focus uses active-speaker tracking; split layouts keep stable
panes. Generic word/number pops remain. Names of celebrities are never substituted
as animated text when photos cannot be found.

## 4. Celebrity library and licensed sources

Configure a meaningful **Wikimedia User-Agent** in AI settings, e.g.
`ClipCraftLocal/1.0 (contact: your-real-email@example.org)` with your actual contact.
Wikidata resolution uses exact labels/aliases and English descriptions to choose a
QID; ambiguous matches and private people do not get person photos. The planner
uses whole-clip context for pronouns, not just the nearest sentence.

Source preference: credited local library → Wikidata P18/Wikipedia lead → Commons
category → exact-name Openverse metadata. Named people never use stock substitutes.
Any-era portraits can be used. Identity evidence is QID/category/full-name metadata;
Gemini must only judge suitability, not recognize the person. Metadata can be wrong:
review the actual output and do not treat the gate as an identity guarantee.

Optional local library, with a credited sidecar **for every image**:

```text
data/celebrity-library/Kaia Gerber/portrait.jpg
data/celebrity-library/Kaia Gerber/portrait.jpg.json
```

```json
{
  "qid": "Q22673974",
  "creator": "Actual photographer",
  "license": "CC BY 4.0",
  "sourcePageUrl": "https://commons.wikimedia.org/wiki/File:YOUR_ACTUAL_FILE.jpg"
}
```

Replace the example file URL/creator with the actual source. The folder must match
the resolved canonical name (spacing/punctuation are normalized). Supply only
correctly identified public-figure images you have rights to reuse. Missing or
mismatched QID/credit/license metadata skips that file. Supported local inputs are
JPEG, PNG and WebP. Avoid large collections of huge files; only a bounded subset is
considered. This is not permission to download copyrighted agency/news/social photos.

YuNet requires one detected face for a person portrait and rejects groups. The
prefetch frame planner centers the face with headroom or fits it sharply over a
blurred background if a crop would cut it. Resolution/upscale, reuse rights,
watermarks, collages, distortions and suitability remain gated. QID caches use
30-day TTL plus byte hashes; new candidate reuse still runs face/suitability checks.

If no portrait passes, the fallback is relevant objects/venues/books/magazines
with **no prominent face**, verified by YuNet and vision, or nothing. No lookalikes,
random people, name pops, Google/Bing/Getty/social/news scraping or render-time
hotlink repair. Generic stock providers only serve applicable illustrative queries;
review each provider's export/cache terms before enabling it (especially Unsplash,
whose display/hotlink requirements are not blanket permission for a persistent bank).

The target is 7 images/60 seconds with 5–8-second sentence beats and 2.4–3.4-second
nonoverlapping displays. Strict selection tries lower text-score eligibility when
short, but identity/face/vision gates do not drop. Later coreferent sentences may
use another verified entity image. Planning caps, shortages, quota and deadlines
can yield fewer; the tile and debug output explain skipped beats/shortfalls.
Use **Copy photo credits** in the tile menu, or download
`/api/clips/<id>/credits?format=txt&download=1`.

### Wikimedia/API compatibility

The implementation uses `wbsearchentities` (English labels/descriptions),
`wbgetentities` (`claims|sitelinks`), claims P18/P373, Wikipedia `pageimages` with
`piprop=name` and `pilicense=free`, and Commons `imageinfo` with
`url|size|extmetadata|timestamp`. Category requests use `generator=categorymembers`,
`gcmtype=file`. License/artist/description metadata is obtained separately; “free
page image” alone is not complete attribution. Read-only GETs include the configured
User-Agent, `maxlag=5`, bounded concurrency/timeouts and positive caching. HTTP
429/503/maxlag fail closed rather than creating a retry storm. Do not assume an
universal fixed requests/second limit: honor service responses and policies.

References: [Wikidata API](https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities),
[Commons API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki),
[MediaWiki etiquette](https://www.mediawiki.org/wiki/API:Etiquette).

## 5. Gemini models, quotas and failures

Visual planner/vision use the same model chain as `lib/llm.ts`; no separate hidden
visual model. At worker start, `GET https://generativelanguage.googleapis.com/v1beta/models`
checks available `generateContent` models; startup validation reports the discovered
choice. A configured name is not proof your key/project has access. Completion uses
`POST /v1beta/models/<actual-name>:generateContent`, keys in `x-goog-api-key`.

- **404:** unavailable/deleted/wrong model. The process negative-caches it and logs
  once, then tries the next chain model. Correct the chain if none are discovered;
  restart after fixing access/model configuration.
- **429:** rate/daily quota exhaustion. Honor Retry-After and project limits; adding
  keys for the same project does not multiply quota. Cool down/retry later.
- **503/5xx:** transient service failure; bounded backoff/fallback, not a bypass.
- **Invalid key:** retest in Settings and save the correct one. Never paste secrets
  in logs/issues. Startup cannot certify account entitlement without a live key.

An uncached clip has one logical planner and up to three vision batches. The
per-clip attempt budget is four charged attempts; 404/429/5xx and network
failures are refunded so trying the next model does not exhaust that cap.
Responses are read as a stream, and the per-call timeout is an **idle cap**, not
a total-time cap: the planner is cut off only when it sends nothing for 20
seconds and vision after 10 seconds, while a slow-but-working connection may keep
streaming. The whole prefetch has a 60-second budget with 15 seconds reserved for
the vision relevance check after the plan arrives; local decode/face
inference/frame preparation and disk writes can add time. Up to two persisted
prefetch jobs run independently; render does not wait for all siblings.

If the tile says `Visual prefetch unavailable`, the parenthetical names the task
and the real cause, and the next chain model is still tried: `no response for
20s` means the planner went silent for longer than the idle cap (a very slow,
throttled or blocked link), `DNS lookup failed` means this machine cannot resolve
`generativelanguage.googleapis.com`, `connection failed (ECONNRESET /
ECONNREFUSED)` means a firewall/ISP blocks it, and `TLS handshake failed` means a
proxy or VPN is intercepting HTTPS. For the last two, fix the network/VPN first;
when an HTTP(S) proxy is required, start Node with `--use-env-proxy` (or set
`NODE_OPTIONS=--use-env-proxy`) so Node's `fetch` honours `HTTPS_PROXY` /
`NO_PROXY`, and import the proxy's CA with `NODE_EXTRA_CA_CERTS` if TLS is
intercepted. Use **Settings → AI providers → Test** to confirm the key and host
from this machine before re-queuing visuals.

Failed prefetches are not cached. Legacy cached reasons starting “Visual prefetch
unavailable” are ignored. Timed-transcript/settings hashes key whole-clip caches;
vision verdicts bind candidate identity and local bytes. Rerenders with unchanged
meaning/settings reuse frames. A changed query requires an explicit new prefetch,
not network work during render. Deleting a clip/video cancels pending handoffs.

Use [models.list](https://ai.google.dev/api/models#method:-models.list),
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and
[pricing](https://ai.google.dev/gemini-api/docs/pricing) for your actual model/tier.
Limits are project-based RPM/TPM/RPD, not a promised per-key allowance. Model names,
free-tier availability and prices can change; this guide does not promise a daily
volume or fixed per-clip cost.

## 6. Verify and diagnose

```powershell
npm test
npm run typecheck
npm run lint
npm run verify:captions
# Optional installed Chrome path instead of Remotion's browser:
npm run verify:captions -- "C:\Program Files\Google\Chrome\Application\chrome.exe"
npx tsx scripts/verify-visual-layering.ts
npm run eval:visuals -- --recent 20
npm run eval:visuals -- --video VIDEO_ID --json --output data/evaluation.json
npm run eval:visuals -- --demo --json
npm run verify:clip -- generated-clips/<video>/<clip>.mp4
# Optional synthetic filter A/B, NOT an end-to-end speed claim:
npm run benchmark:visuals -- --baseline 09b7432 --rounds 3
node scripts/generate-sfx.mjs
```

`verify:captions` renders kinetic-01/pop/podcast through real Chromium to transparent
PNGs, composites a photo above synthetic speaker video but below captions with
FFmpeg, then checks 1080×1920 H.264 output and caption pixels with ffprobe. Outputs
stay in ignored `data/final-render-validation/`. It does not call AI or providers.
The layering script covers hook on/off × debug on/off. The visual evaluation CLI is
read-only: beats, entity/QID, source/evidence, face checks, vision, decision/reason,
images/minute and timing distributions; metadata acceptance is not human review.

Checks performed in Linux on 2026-10-17: 292 unit tests (zero skipped), typecheck
with noUnusedLocals/noUnusedParameters, lint with unused errors, actual Node YuNet
inference, and real Chromium→PNG→FFmpeg MP4s for the three themes (1.2 seconds, 36
frames, 1080×1920, captions verified above a full-screen image). All four hook/debug layering combinations also passed (5,898–5,905
caption pixels visible above the image). A single synthetic filter-only A/B round
measured 16.730s → 13.494s against the preserved checkpoint; that is not a Windows
or full-pipeline speed claim. Synthetic media is
not proof of full uploaded-video transcription/AI behavior or live identity accuracy.

**Still requires the target Windows PC and real credentials:** whisper executable
and VC++ runtime, QSV/NVENC driver/encoder smoke tests, a full upload→transcribe→AI
selection→prefetch→render, real named-person/coreference review, actual model
entitlement/quota recovery, long-clip fill rates, the 60-second prefetch budget,
and cancellation/restart while real native jobs run. Test those before production.

If text is hidden, compare the pre-caption debug encode and check stacking, not card
placement controls (removed). If photos are missing, inspect the skipped reason,
QID/evidence, face count, license, resolution, vision verdict and deadline before
changing settings. A missing/modified verified frame intentionally renders without
that image. Never lower gates just to fill a quota.

Production `npm run build` also passed. Turbopack reports dynamic-filesystem tracing
warnings in the local media/worker paths; this is not a standalone/serverless deployment.
