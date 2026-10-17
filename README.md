# ClipCraft Local

Windows-first, single-user video clipping for English celebrity/gossip commentary.
Upload a video, transcribe locally, select complete moments with AI, then render
1080×1920 clips with themed captions, hooks/CTAs and relevant licensed photographs.
Media, SQLite records and the durable job queue stay on your PC. Gemini and optional
image/transcription providers require internet; they may have quotas or charges.

## Quick start

Install Node.js 20+ and the Microsoft Visual C++ x64 Redistributable on Windows.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run setup:whisper
npm run setup:yunet
npm run dev
# In a second terminal, from the same repository:
npm run worker
```

Open `http://localhost:3000`, save keys under **Settings → AI providers**, and check
`/startup-validation`. Alternatively use `start-clipcraft.bat` after setup. Run only
**one worker process per database**. See [SETUP.md](./SETUP.md) for native binaries,
ffprobe, encoders, settings, troubleshooting and Windows acceptance checks.

## Pipeline and persistence

1. Upload resumably to local storage.
2. Transcribe with local whisper.cpp (Deepgram is an optional paid override).
3. Detect complete standalone clips and truthful hook/CTA copy.
4. Persist an independent `visual-prefetch` job per clip. One clip can finish
   prefetch and begin rendering while another is still searching.
5. Paint transparent caption/hook/CTA/generic-pop frames with Remotion, then
   composite onto the video in one final FFmpeg encode.

SQLite (`better-sqlite3`, WAL) stores videos, clips, settings and jobs. Atomic
claims, bounded retries, cancellation and startup recovery survive browser reloads
and worker restarts. Both processes must use the same `DATABASE_PATH`.

**Render is network-free for visual selection:** it consumes only prepared,
locally verified photo frames. Missing/modified frames are skipped, never repaired
with a provider or Gemini call during encoding. Install/cache the browser and
fonts before an offline render; first-time browser installation needs internet.

## Captions and layouts

Exactly **13 shipped caption presets**: first/default `cc-bold-punch` uses
`kinetic-01` with positionY 28, plus 12 `caption-theme-*` presets. There is no classic
caption editor/renderer. Valid themed custom presets survive resets; themeless,
invalid and retired rows are backed up under `data/backups/` before removal, and
clip/default references are repointed. Back up your database before upgrading.

Speaker focus follows the active speaker in one pane. Split screen locks stable
speaker panes rather than reordering people mid-clip. YuNet detects boxes and
landmarks; it does **not** identify people.

The fixed stacking order is **speaker → full-screen photo → transparent
caption/hook/CTA/generic-pop layer**. Photos have only zoom/fade motion: no card
shape, border, face-safe placement or ball-toss path. Photos avoid the hook dip.
Generic word/number pops remain; **celebrity-name animated pops are not a photo
fallback and are removed**.

## Identity-safe photographs

The sole sentence planner reads the whole clip, including pronouns such as
“Kaia Gerber … she has her book club.” Each beat carries entities and a primary
person/place/event/organization. Public-person names are resolved textually using
Wikidata labels and descriptions. **No unambiguous QID means no person photo.**

Sources are the optional credited local library, Wikidata P18/Wikipedia lead,
Commons category, then exact-name Openverse metadata. Stock providers never stand
in for a named person. Identity evidence is metadata/QID-based, not facial
recognition; upstream metadata is not a mathematical guarantee of identity.
Gemini judges suitability, not who a face belongs to. Any-era portraits are valid.
YuNet rejects group photos; portrait framing preserves face/headroom or uses a
sharp fit over a blurred background. QID image caches last 30 days and validate
bytes; reused candidates still pass safety/suitability gates.

If portraits fail, sentence-relevant B-roll must have no prominent face and pass
the vision gate, otherwise the beat is skipped. The target is **7 images/minute**,
roughly one beat every 5–8 seconds, displayed 2.4–3.4 seconds without overlap.
Relevance, identity, configured planning limits and the prefetch deadline win over
fill: the tile reports planned/resolved counts and shortfall reasons. There is no
random-image or celebrity-name-pop padding. No Google/Bing/Getty/social/news scraping.

Use the tile menu’s **Copy photo credits**, or
`GET /api/clips/<id>/credits?format=txt`. Licenses/creator/source links remain in the
manifest; confirm your intended reuse rights. Local library setup is in SETUP.

## Settings and prompts

The five Settings sections are pipeline, render, AI, worker and profanity. A saved
value wins; otherwise the built-in default applies. Form-backed settings do **not**
fall back to `.env.local`. Uploads snapshot pipeline defaults; editing app defaults
must not silently change an existing video. Secrets are masked in API responses.

Edit prompts at `/prompt-templates`. Preserve `{{transcript}}`, `{{clipCount}}`,
`{{minClipDuration}}`, `{{maxClipDuration}}` and strict JSON with a `clips` array.
Ask for complete moments, exact source intervals, concrete payoff and truthful
hooks—never invented gossip or identities. Caption text and hook/CTA copy/styles
are separate layers; editing one must not corrupt source-word timing.

## Checks and diagnostics

```powershell
npm test
npm run typecheck
npm run lint
npm run verify:captions          # real Chromium -> 3 themed PNG sequences -> MP4
npm run eval:visuals -- --recent 20
npm run eval:visuals -- --demo --json
npm run verify:clip -- generated-clips/<video>/<clip>.mp4
```

`verify:captions` writes synthetic test media only under ignored `data/`; it does
not call AI or photo providers. It can take a local Chrome executable as its first
argument. The single visual evaluation CLI reports beat/entity/QID, source/evidence,
face checks, vision scores, decision/reason, images/minute and timing distributions.
It does not claim human-verified relevance or a Windows performance result.

## Repository and attribution

- `app/`, `components/`, `hooks/`: Next.js UI and local API.
- `lib/`: settings, persistence, queue, AI, sentence planner and visual prefetch.
- `worker/`: orchestration, active-speaker detection, layouts and FFmpeg.
- `remotion/`: theme captions, transparent hook/CTA and generic-pop overlays.
- `scripts/`: reproducible setup and documented verification/evaluation tools.
- `tests/`: node:test regressions; no cloud credentials required.

Whisper binaries and YuNet weights are **downloaded, not tracked**. Run their
setup scripts after cloning. Retain vendor licenses. The 13 theme components derive
from [vshukla7/remotion-captions-themes](https://github.com/vshukla7/remotion-captions-themes)
1.0.8 (MIT); animation is frame-driven for Remotion. Bangers/Anton and other local
font licenses remain under `public/fonts/licenses`. The unchanged shadcn 4.21.0
Tailwind variants stylesheet is vendored under `app/vendor/shadcn/` with its MIT
license, avoiding installation of the unused scaffold CLI and its dependency tree. This app is not a Vercel/serverless
service: media processing requires a persistent local worker. No Docker, Redis,
MongoDB or Python is required by the application.
