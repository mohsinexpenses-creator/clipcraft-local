PROJECT: Personal-use AI clip generator (Next.js, no Python)

> **This file is the original product specification and is kept unchanged.**
> For installation, environment variables, running the worker and troubleshooting,
> see **[SETUP.md](./SETUP.md)**.


GOAL
Build a personal-use (not for production/multi-user deployment) web app that takes a
long-form landscape video (e.g. a YouTube video) and automatically produces several
short, portrait (9:16) clips optimized for virality — each with smart cropping,
color filters, a duplicated "hook" intro, an AI-generated hook text overlay, and
styled animated captions.

HARD CONSTRAINTS
- No Python anywhere in the stack. Everything must run in Node.js/TypeScript.
- Personal use only — single user, runs locally, no need for multi-tenant auth,
  billing, or horizontal scaling. Optimize for simplicity over scalability.
- Do NOT use the "fluent-ffmpeg" npm package (unmaintained). Use "ffmpeg-static"
  (binary) + Node's native child_process.spawn to build ffmpeg commands directly.
- Deployment target: runs entirely on the user's local machine (Next.js dev/build +
  a separate worker process + local Redis via Docker + local MongoDB or MongoDB
  Atlas free tier). This will NOT be deployed to Vercel — heavy processing needs a
  long-running local worker, not serverless functions.

TECH STACK
- Next.js (App Router) + TypeScript + Tailwind CSS — frontend + lightweight API routes
- MongoDB — stores video metadata, transcripts, prompt templates, clip records,
  caption presets, job status
- BullMQ + local Redis (Docker container) — background job queue for heavy processing
- A separate long-running Node.js worker process (not inside Next.js API routes)
  that consumes BullMQ jobs and does the actual video processing
- ffmpeg-static + child_process.spawn — cutting, mirroring, cropping, filters, concat
- whisper.cpp (compiled binary, called via child_process) — speech-to-text with
  word-level timestamps. No Python whisper.
- face-api.js (or @vladmandic/face-api, tfjs-node backend) — face detection for
  smart crop, running fully locally, no paid vision API
- Google AI Studio API (Gemini Flash) — LLM analysis: (1) analyzing the full
  transcript to identify potentially viral segments with start/end timestamps,
  (2) picking the most gripping moment inside a clip for the suspense hook intro,
  and (3) generating short on-screen hook/CTA text. The provider chain
  (`LLM_PROVIDER_CHAIN` in `lib/llm.ts`) is a config array - currently two Gemini
  Flash slots (separate daily pools) - and other providers can be appended to it
- Remotion + @remotion/player — renders animated, styled captions and gives a live
  in-app preview of caption styles before final render

FULL PROCESSING PIPELINE (per uploaded video)
1. Upload video via a Next.js API route, save to local disk (e.g.
   /videos/{videoId}/original.mp4). No S3/cloud storage needed.
2. Extract audio with ffmpeg, run whisper.cpp on it to get a transcript with
   word-level timestamps. Store transcript JSON in MongoDB.
3. Send the transcript to Claude API with a user-editable prompt template
   (store prompt templates in a MongoDB collection so they're easy to tweak).
   Ask for strict JSON output: an array of { start, end, hookText, reason, score }
   for the most promising short segments.
4. For each identified segment, enqueue a BullMQ job with the video ID, clip
   timestamps, and any user-chosen crop/filter/caption-preset settings.
5. Worker picks up each job and, in as few ffmpeg passes as possible:
   a. Trims the segment (-ss / -to)
   b. Mirrors it horizontally (hflip)
   c. Runs face detection (face-api.js) on sampled frames of the mirrored clip and
      builds a speaker face track: when several people are visible it follows the
      largest face (the speaker), and when the shot cuts to another person the 9:16
      crop window pans over to them smoothly (EMA + slew limit, evaluated by ffmpeg
      as a per-frame crop expression)
   d. Applies a color filter preset (ffmpeg eq/saturation, e.g. "vibrant",
      "warm", "cinematic" — store these as ffmpeg filter strings in MongoDB)
      Combine steps a–d into a single ffmpeg filter_complex call where possible
      to minimize re-encodes.
6. Find the most engaging moment inside the clip (the LLM picks it from the
   clip's word timings - a "suspense hook") and duplicate N seconds of it
   (configurable, e.g. 3–5s) as a standalone "hook" segment, concatenating it
   onto the front of the clip (re-encoded, NOT stream-copied) — so the clip
   opens with the best beat first, then plays through normally and the viewer
   watches it build back up to that same moment. The join uses a short
   dip-to-black transition (video fade out/in + audio afade) instead of a hard
   cut, and keeps the total duration exactly hook + base so the caption
   timeline stays in sync.
7. Send that clip's transcript text to Claude API with a separate prompt to
   generate a short, punchy on-screen hook text overlay (distinct from the
   viral-segment-detection prompt in step 3).
8. Render captions with Remotion:
   - During the duplicated hook portion (0 to hookDuration), overlay the
     LLM-generated hook text
   - For the rest of the clip, render normal word-synced animated captions from
     the transcript (remember to time-shift transcript timestamps by
     +hookDuration since the video timeline has changed)
   - Caption appearance must come from a user-selectable "caption preset"
     (font, size, weight, color, highlight color, stroke, position, animation
     style e.g. karaoke-fill/word-pop/fade-in) stored in a MongoDB
     "captionPresets" collection, so new styles can be added without code changes
   - The user can choose the CAPTION ENGINE per clip (clip card → "Caption
     engine"), stored on the clip as `captionEngine`:
     - `remotion` (default, "Premium") — every frame is rendered through
       headless Chrome: smoothest spring animations, but slow on long clips
       (tens of minutes for a 3-minute clip).
     - `native` ("Fast") — captions are generated as an ASS file
       (worker/captions-ass.ts: word karaoke fill, line pop/fade entrances,
       CTA lift) and burned in a single FFmpeg pass at ~real-time speed; the
       hook text and CTA card keep their Remotion design but are rendered as
       short transparent PNG sequences (worker/native-captions.ts +
       remotion/OverlayCompositions.tsx) and composited by the same FFmpeg
       pass. Trade-off: captions use eased animations instead of spring
       physics.
9. Save the final rendered clip to local disk (e.g.
   /generated-clips/{videoId}/{clipId}.mp4) and write/update a record in a
   MongoDB "clips" collection tracking: source video, timestamps, crop data,
   filter preset used, caption preset used, hook text, viral score, file path,
   and job status (pending/processing/done/failed).

FRONTEND REQUIREMENTS
- Upload page for source videos
- A dashboard listing generated clips per video with status, viral score, and
  a way to preview/download each clip
- A caption-preset picker with a live preview (using @remotion/player) so the
  user can see caption style changes before triggering a full render
- A simple way to view/edit the LLM prompt templates used in steps 3 and 7

COST PRIORITY
Everything should run free/local except the two Claude API calls (viral segment
detection and hook text generation), which are cheap (Claude Haiku-tier) and are
the one place worth paying for since output quality matters most there.

WHAT I NEED FROM YOU
1. Confirm you understand this scope, then create a new git branch (do not
   touch main/master directly).
2. Propose a clear project folder structure (Next.js app + separate /worker
   directory for the BullMQ consumer) before writing code.
3. Implement incrementally: (a) upload + storage, (b) transcript pipeline,
   (c) LLM viral-segment + hook-text integration with editable prompts, (d)
   BullMQ + Redis job queue wiring, (e) ffmpeg processing chain (mirror, smart
   crop via face-api.js, filters, hook duplication/concat), (f) Remotion
   caption rendering with presets and live preview, (g) dashboard UI.
4. After each major step, tell me what env vars, local services (Docker
   commands for Redis, MongoDB connection string, etc.), or API keys
   (Anthropic API key) I need to set up on my machine to run/test it.
5. Push all work to the feature branch as you go so I can review commits
   before I merge to main myself.