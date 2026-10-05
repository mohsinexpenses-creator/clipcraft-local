# SQLite migration inventory

Inventory of the persistence and job-queue behavior in the pre-migration code (`lib/db.ts`, `lib/queue.ts`, `worker/index.ts`, and `lib/types.ts`). This document was written before continuing the SQLite implementation. It describes the legacy storage contract to preserve where practical.

## MongoDB collections

Mongo database: `clipcraft`. All documents use Mongo's implicit, unique `_id` index. The application declares no additional Mongo indexes (`createIndex` is not used); filters and sorts below therefore rely on collection scans apart from `_id` lookups.

| Collection | Stored fields and shape | Lookups / mutations |
|---|---|---|
| `videos` | `_id`; `originalName`; `fileName`; optional `fileBase`; `filePath`; `duration`; `width`; `height`; `fileSize`; `status` (`uploaded` / `transcribing` / `transcribed` / `failed`); optional `transcript` (`text`, `segments[]` with `id`, `start`, `end`, `text`, optional `words[]`; top-level `words[]`; each word has `word`, `start`, `end`, optional `confidence`); optional `transcriptionProvider` (`deepgram` / `whisper.cpp`); optional `transcriptionModel`; optional `error`; `createdAt`; `updatedAt`. | `getVideo` by `_id`; `listVideos` sorted `createdAt` descending; `saveVideo` upserts by `_id`; `deleteVideo` deletes the video and every `clips` document with matching `videoId`. |
| `clips` | `_id`; `videoId`; optional `videoTitle`; `start`; `end`; `hookDuration`; `hookText`; optional `ctaText`, `ctaDuration`; `filterPreset`; `captionPresetId`; optional embedded `captionPreset` (same fields as `captionPresets`); optional `layout` (`speaker-focus` / `split-screen`), `layoutNote`, `captionEngine` (`remotion` / `native`), `hookStylePresetId`, `ctaStylePresetId`, `cropData` (`x`, `y`, `width`, `height`); `viralScore`; optional `viralReason`, `title`, `hookLine`, `hookLineStart`, `hookLineEnd`, `hashtags[]`, `retentionStrength` (`Weak` / `Medium` / `Strong` / `Extreme`), `psychologicalTrigger`, `safetyRisk` (`Low` / `Medium` / `High`), `safetyNotes`, `scores` (`viral`, `retention`, `controversy`, `shareability`); optional `outputPath`, `outputFileSize`, `outputFps`; `status` (`pending` / `processing` / `done` / `failed`); optional `progress`, `error`, `cancelling`; `createdAt`; `updatedAt`. | `getClip` by `_id`; `listClips` optionally filtered by `videoId`, sorted `createdAt` descending; `saveClip` upserts by `_id`; `deleteClip` deletes only the clip document. Video deletion cascades to clips in application code. |
| `promptTemplates` | `_id`; `type` (`viral_detection` / `hook_generation` / `cta_generation`); `name`; `description`; `systemPrompt`; `template`; `updatedAt`. | List all; `getPromptTemplate` matches `_id` **or** `type`; upsert by `_id`; shipped defaults are inserted only when absent, and explicit reset overwrites the shipped IDs while retaining custom IDs. |
| `captionPresets` | `_id`; `name`; `fontFamily`; `fontSize`; `fontWeight` (`normal` / `bold` / `extra-bold` / `black`); `textColor`; `highlightColor`; `strokeColor`; `strokeWidth`; `positionY`; `animationStyle` (`karaoke` / `word-pop` / `fade-in` / `static`); optional `uppercase`, `isDefault`, `createdAt`, `updatedAt`. | List all; get/delete by `_id`; upsert by `_id`; default presets cannot be deleted. |
| `overlayStylePresets` | `_id`; `kind` (`hook` / `cta`); `name`; optional `description`; `fontFamily`; `fontSize`; `fontWeight`; `textColor`; `backgroundColor`; `borderColor`; `borderWidth`; `borderRadius`; `textTransform` (`uppercase` / `none`); `positionY`; `animationStyle` (`pop` / `fade` / `slide-up` / `none`); optional `showBadge`, `badgeText`, `isDefault`, `createdAt`, `updatedAt`. | List optionally filtered by `kind`, sorted by `kind` then `name`; get/delete by `_id`; upsert by `_id`; default styles cannot be deleted; explicit reset restores shipped IDs and preserves custom IDs. |
| `textPresets` | `_id`; `kind` (`hook` / `cta`); `text`; `createdAt`; `updatedAt`. | List optionally filtered by `kind`; upsert/delete by `_id`; shipped defaults are inserted only when absent. |

`saveVideo`, `saveClip`, and preset/template save functions generally use `$set` upserts. `createdAt` is assigned only if missing; `updatedAt` is refreshed on save. The legacy code does not use Mongo transactions or enforce relational foreign keys.

## BullMQ / Redis queues

Both queues use Redis and BullMQ defaults of 2 attempts with exponential backoff starting at 2,000 ms (retry delay grows to 4,000 ms). Completed jobs are retained up to 50 jobs / 1 hour; failed jobs up to 200 jobs / 7 days. Stable job IDs are the related record IDs. Before enqueue, a queued/terminal job with that ID is removed; an active job is rejected with HTTP 409. A queued job for a clip is marked `pending`, its progress reset to 0, and its prior error cleared.

| Queue name | BullMQ job name / ID | Payload | Worker behavior |
|---|---|---|---|
| `clip-processing` | `process-clip` / `clipId` | `JobData`: `clipId`, `videoId`, `start`, `end`, `hookDuration`, optional `hookText`, `ctaText`, `ctaDuration`, `layout`, `captionEngine`, `hookStylePresetId`, `ctaStylePresetId`; required `filterPreset`, `captionPresetId`. | `WORKER_CONCURRENCY` (positive integer, default 1); lock duration 120 s, stalled interval 60 s. Reports processor progress through BullMQ `updateProgress`; clip record progress is also updated during rendering. |
| `transcription` | `transcribe-video` / `videoId` | `TranscriptionJobData`: `videoId`, `filePath`, optional `retry`. | Concurrency 1 because whisper.cpp uses the assigned CPU threads. No transcription progress callback. |

Clip lifecycle is normally `pending` → `processing` → `done`, or `failed`; cancellation is represented by `cancelling` while active and then `failed` with `Cancelled by user.` Worker shutdown handles SIGINT/SIGTERM by closing both workers after active jobs (with a 30-second forced-exit limit). BullMQ's stalled-job handling reclaims interrupted work. Queue deletion was not coupled to Mongo document deletion in the legacy API; `deleteVideo` removed video/clip documents, and `deleteClip` removed just one clip document.

## Scope notes

Uploads, generated media, and resumable-upload session metadata also use the filesystem; they are not Mongo collections. Mongo-to-SQLite data migration is optional and is not part of this inventory. A fresh SQLite database is acceptable if migration is omitted, provided that choice is documented for users.
