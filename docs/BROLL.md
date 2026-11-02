# Auto B-roll

B-roll adds real photos over the speaker and under captions. Named people, places and events use their Wikipedia article image as a full-screen image; keyword moments use landscape cards from stock providers. Images are downloaded locally and attribution is stored on each plan item. No stock lookalike is substituted when a named entity has no usable article image.

## Pipeline

```text
upload -> transcribe -> viral detection -> B-roll planning -> render -> done
```

B-roll planning is its own durable SQLite job. Detection queues this step when enabled, and the step queues rendering when it finishes. A worker restart can recover an interrupted job. Rendering only reads the stored plan and never contacts image providers.

## Plan and scheduling

Each clip stores a plan in `clips.broll_json`. A full-screen item includes its entity name/type, Wikipedia attribution, cache paths, and crop information. Landscape items include stock attribution and a card rectangle. Skips record a stage and reason. Existing plans that contain the retired `wikimedia` or `openverse` provider IDs remain readable; newly generated entity items use `wikipedia`.

The scheduler scales the configured 10-15 images per minute to the clip length, keeps items 2.5-4 seconds long, leaves at least 1.5 seconds between items, avoids the hook replay, and gives full-screen entities priority over cards. The target minimum is not a quota: the plan does not invent an image to reach it.

## Named entities

1. The analysis model returns the entity name and, when known, the exact English Wikipedia article title. Missing titles fall back to the entity name.
2. The worker requests the Wikipedia REST summary. If the title is missing or ambiguous, it resolves one title through Wikipedia OpenSearch and requests that summary once.
3. The summary's `originalimage` is required. File metadata supplies MIME and license information; known non-free files and unsupported formats are skipped. A thumbnail of up to about 1600 pixels is downloaded when available, otherwise the original is used.
4. The image is downloaded and passed to `prepareFullscreen`, which handles small and landscape images with face-aware crop or blurred fill. There is no AI image verification step.

Wikipedia lookups are serialized through a 250 ms limiter. Successful results use the provider cache TTL; empty results are cached briefly. Wikimedia-hosted image downloads are serialized and retry transient 429/5xx failures with `Retry-After` and bounded exponential backoff.

## Keyword cards

Keyword moments use Pexels, Pixabay, and Unsplash in the configured order. Providers without keys are skipped; quota and provider errors fall through. Cards are prepared as 16:9 crops and placed away from the caption band and detected speaker faces. Unsplash's download endpoint is pinged when a photo is used.

## Settings and manual review

Settings -> AI providers stores optional Pexels, Pixabay, and Unsplash keys. Named entity images need no key. Pipeline defaults control B-roll on/off, fullscreen and card toggles, sound effects, image count, and stock provider order. Settings are snapshotted per video at upload.

The clip tile is the review surface: images can be swapped or removed, and B-roll can be rerun per clip. Manual render actions use the currently stored plan and do not start provider searches.

## Rendering and cache

Prepared B-roll frames are rendered as short transparent sequences before captions, hook, and CTA layers. Chromium reads local prepared files served by the worker; it never fetches provider URLs during a render.

The cache lives under `<data dir>/broll-cache/`:

- `images/` stores downloaded originals and prepared frames.
- `json/` stores provider results, including short-lived Wikipedia misses.

Removing the directory is safe; the next B-roll run downloads and prepares images again. Use `npm run verify:broll -- <clipId>` to print the plan and check prepared image files.
