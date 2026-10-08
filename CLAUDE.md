@AGENTS.md

## Repository-specific persistence and queue rules

- Persistence is local SQLite through `better-sqlite3` in `lib/db.ts`; there is no MongoDB, Redis, BullMQ, or Docker-backed database setup.
- Keep `lib/db.ts` and database access in server routes / server processes only. Do not import it from client components.
- Use typed row helpers, prepared statements, JSON serialization helpers, and additive schema migrations. The shared database file is configured with `DATABASE_PATH` (default `./data/clipcraft.db`), WAL, and `busy_timeout=5000`; restart both web and worker processes if the path changes.
- Queue state lives in the SQLite `jobs` table. Preserve atomic claims, independent transcription/render polling loops, bounded retries with exponential backoff, restart recovery, and deletion cleanup. Run one worker process per DB; concurrency is within its render loop because startup recovery resets all running jobs.
- Keep changes to persistence/queue boundaries; do not change the video pipeline. Run `npm test`, `npm run typecheck`, and `npm run lint` after relevant changes.

## Repository-specific automatic-pipeline and UI rules

- The upload -> transcript -> viral-detection -> render chain is the product's default path. Keep every step a `jobs` row (never an in-process promise) so a reload or restart resumes at the interrupted step; `lib/pipeline.ts` owns the hand-offs and `recoverAutoPipelines()` runs at worker startup.
- Per-video automation (autoDetect, autoRender, AI clip options) is stored in `videos.pipeline_json` at upload time. `lib/pipeline-defaults.ts` is the only place those defaults and their limits are defined, and it must stay dependency-free (no `lib/db`, no `lib/ai`) because the browser imports it too.
- Never derive pipeline progress from a stored "stage" column: `lib/pipeline-status.ts` recomputes it from queue + clip rows so the UI can't lie. Keep `VideoRecord.status` inside the existing enum.
- Client components must not import `lib/db.ts`; pipeline data reaches the UI through `hooks/use-pipeline.ts` and the `/api/videos/[id]/pipeline` route. `lib/pipeline-ui.ts` holds the presentation-only derivations.
- The clip grid is the single review surface: every tile shows its score and the AI analysis, and Edit + re-render affects one clip only (`POST /api/clips`). Do not add a page-level "render everything" dialog back.

## Repository-specific settings rules

- `lib/app-settings.ts` is the only resolver for app-level defaults: stored row → `.env.local` → built-in default. New settings are added as a section of the `app_settings` table (`pipeline|render|ai|worker|profanity`, one JSON row per section, overrides only — never a mirror of env). Do not write a second env-fallback chain in a feature module; ask the resolver instead. `resolveSettings()` stays pure (no SQLite, no `process.env` writes) so precedence is unit-testable in `tests/app-settings.test.ts`.
- `lib/pipeline-defaults.ts` remains the single definition of clip options and their limits; `app_settings` re-reads them through `OPTION_LIMITS`/`DEFAULT_VIRAL_OPTIONS` instead of copying numbers, and `sanitizeSettingsSection('pipeline', …)` delegates to `sanitizePipelineOptions`. Per-video `videos.pipeline_json` still wins over stored pipeline defaults: defaults are snapshotted at upload so a running pipeline is never changed under the worker.
- Secrets never leave the server in full. The API returns `maskSecret()` placeholders; a masked entry on save means "keep that stored key" (resolved by a mask lookup, so the pool can be reordered and unknown masks are dropped). `app/api/settings/verify` is the only route that sends a key upstream, and it reports `unreachable` rather than guessing.
- Worker loop counts are read once at process start (`worker/index.ts`) — that is a documented restart requirement, so do not "fix" it by mutating `process.env` from a route. `applyStoredRuntimeSettings()` re-reads the table before every job for the per-job settings (profanity mode, and the `REMOTION_CONCURRENCY` slot the renderer still reads).
- `/settings` is client-state-light by design: `hooks/use-settings.ts` owns fetch/save/reset/verify, and cards that hold a local draft rebuild through a `key={revision}` remount rather than a state-setting effect (the repo lints with `react-hooks/set-state-in-effect`, which rejects the effect form).

