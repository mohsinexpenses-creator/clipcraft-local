# Auto B-roll

B-roll puts photos from **Wikimedia Commons** and **stock providers** on top of the
speaker, under the captions: a named person, place or event can take the whole
9:16 frame, and the rest of the speech gets landscape cards framed beside the
captions.

**No image is ever generated.** Every picture is a real photo, downloaded once,
stored with its provider, source URL, author and licence, and shown only after the
rules below pass.

---

## 1. Where it sits in the pipeline

```
upload → transcribe → viral detection → B-ROLL (this) → render → done
```

- The step runs as its own job in the SQLite `jobs` queue (`type = 'broll'`, one
  job per clip, id `broll:<clipId>`), so pressing "re-run" twice cannot stack
  duplicates and a crash mid-step is retried with the queue's backoff.
- `lib/pipeline.ts` owns the hand-off: with `autoBroll` on, detection queues B-roll
  **instead of** the render, and the B-roll job queues the render when it finishes.
- `recoverAutoPipelines()` re-queues a missing plan after a worker restart. A clip
  that already has a plan is never re-planned automatically - only its render is.
- The render **only reads** the stored plan; it never calls a provider, so
  re-rendering is free and cannot change the images.

## 2. What a plan contains

One JSON document on the clip row (`clips.broll_json`, added by schema v6, a purely
additive migration):

```jsonc
{
  "version": 1,
  "clipDuration": 60, "hookDuration": 3, "totalDuration": 63,
  "options": { "autoBroll": true, "enableFullscreen": true, ... },
  "items": [
    {
      "id": "entity-eiffel-tower", "kind": "fullscreen",
      "start": 18.5, "end": 22.5,          // FINAL timeline (hook already added)
      "desiredStart": 15.5, "desiredEnd": 19.5,
      "entityName": "Eiffel Tower", "entityType": "place",
      "attribution": { "provider": "wikimedia", "sourceUrl": "…", "imageUrl": "…",
                       "author": "Benh Lieu Song", "license": "CC BY-SA 3.0",
                       "licenseUrl": "…" },
      "verification": { "confidence": 0.91, "reason": "…", "verifiedAt": "…" },
      "cacheKey": "img-…", "renderFile": "fs-….jpg", "crop": { … }
    }
  ],
  "skipped": [ { "stage": "verify", "entity": "…", "reason": "…" } ],
  "counts": { "targetMin": 10, "targetMax": 15, "fullscreen": 3, "landscape": 9 }
}
```

The clip tile shows this plan: thumbnails, type, time range and attribution, with
per-item **swap** / **remove** and a per-clip **re-run**. The grid is the only review
surface on purpose - there is no page-level "render everything" dialog.

## 3. How many images

`brollImageBudget()` scales the configured "images per 60 s" (default **10–15**) to
the clip length. `lib/broll/scheduler.ts` then places them:

| Rule | Value |
| --- | --- |
| Item length | clamped to 2.5–4 s |
| Gap between items | at least 1.5 s |
| Hook replay window | nothing is scheduled inside it |
| Full-screen vs card | a full-screen image always wins; cards never overlap or touch one |
| Budget | never more than `maxImages`, and the plan reports when it could not reach the minimum |

The minimum is a target, not a quota: an image is never invented or made
irrelevant just to hit it.

## 4. Entities (full screen)

1. The LLM returns `entities[] {type, name, searchQuery, start, end}` and
   `broll[] {visualKeywords[], start, end}` with `json: true`, validated by
   `lib/broll/analysis.ts` (same strictness as the viral response; extra keywords
   that are abstract ideas - "success", "growth" - are dropped).
2. The entity is searched on **Wikimedia Commons only** (`generator=search`,
   File namespace, `iiurlwidth=1080`, `extmetadata` for author/licence). A stock
   lookalike is never used: a photo of a *different* person or place under a name
   is worse than no photo.
3. The best 3–4 candidates (~512 px) go to **Gemini Vision** in ONE request with the
   entity name, Commons title/description/categories, and the sentence being
   spoken. The model answers
   `{pickIndex|null, confidence, reason, hasTextOrWatermark, isSafe}`.
4. The image is shown only if `pickIndex` is set, `confidence ≥ 0.60`,
   `hasTextOrWatermark` is false and `isSafe` is true. Otherwise the mention is
   **skipped**, with the reason stored on the plan and printed in the worker log.
5. Framing: a detected face (YuNet) centres a 9:16 window with head-room; a
   landscape place/event keeps the whole photo on a blurred version of itself.
   Images smaller than 1080×1280, SVG/TIFF/PDF, and unreadable files are rejected.

## 5. Landscape cards

- Every other keyword moment gets a 16:9 photo from the configured provider order
  (**Pexels → Pixabay → Unsplash** by default). A missing key skips that provider,
  429/quota falls through to the next, and only a 401/403 is ever reported as a
  rejected key.
- Cards are 16:9 crops inside a rounded frame, placed by `planCardRect()` between
  the top of the frame and the caption band, avoiding the speaker's face (sampled
  from the clip with YuNet) and shrinking rather than covering anything.
- Unsplash's download endpoint is pinged when a photo is used, and the
  photographer is stored in the attribution.

## 6. Rendering

- `remotion/BrollComposition.tsx` paints each item as its own short transparent PNG
  sequence (`prepareRemotionBrollOverlays`), so 4 s of B-roll costs 4 s of frames -
  not the clip length. Each sequence gets its own `startAtSeconds`.
- In the FFmpeg graph B-roll sequences are added **before** the caption/hook/CTA
  sequence, so captions are always painted on top.
- When a full-screen image is up, the B-roll layer paints a bottom scrim plus a soft
  pill across the caption band, coloured from the caption text's luminance (dark for
  light text, light for dark text). That is how white-on-white and dark-on-dark
  never happen, without touching any caption preset.
- Chromium never fetches a remote URL: the prepared JPEGs are served from a
  throwaway loopback server (`worker/clip-http-server.ts`).
- `whoosh.wav` / `pop.wav` (bundled, CC0, generated by
  `scripts/generate-broll-sfx.mjs`) are delayed to each item's in/out and mixed
  with `amix … normalize=0`, so the voice level never changes. Beeps for profanity
  are already in the voice branch and coexist with them. The effects can be
  switched off per video.

## 6b. Manual renders use the stored plan

"Render now", "Edit & re-render" and the render button in the clip editor render
the plan that is already stored - they never start a provider search. To plan (or
re-plan) B-roll for a clip, use **Re-run B-roll** on its tile; that job queues the
render itself when the video's `autoRender` is on. A clip that has never been
planned simply renders without B-roll, exactly like before the feature existed.

## 7. Configuration

| Where | What |
| --- | --- |
| Settings → **AI providers** | Pexels / Pixabay / Unsplash keys, each with **Test** (a live probe that reports latency and remaining quota) and **Save**. Masked values mean "keep the stored key". |
| Settings → **Pipeline defaults** | B-roll on/off, full-screen and card toggles, sound effects, min/max images per 60 s, provider order. Snapshotted per video at upload. |
| Per video (dashboard) | The same panel, so one video can run without B-roll. |

Keys are only ever stored in SQLite, masked in every API response, and never sent
to the browser in clear text or logged. Wikimedia Commons needs no key; **Gemini
Vision uses the same key pool as viral detection**.

## 8. Manual check

```bash
npm run verify:broll -- <clipId>          # human-readable plan
npm run verify:broll -- <clipId> --json   # the exact stored JSON
```

It runs the same `runBrollJob` the worker runs, prints every image with its
provider, author, licence, time range and vision verdict (plus every skip reason),
and fails if a full-screen image has no verdict or a prepared file is missing.

## 9. Cache

`<data dir>/broll-cache/` (next to `clipcraft.db`, ignored by Git):

- `images/` - downloaded originals (`img-<hash>.jpg`) and prepared frames
  (`fs-<hash>.jpg`, `card-<hash>.jpg`);
- `json/` - provider search results (7 days) and Gemini verdicts (30 days), keyed
  by a hash of the query, so a re-run is fast and cannot silently differ.

Deleting the directory is safe: the next B-roll run downloads again.
