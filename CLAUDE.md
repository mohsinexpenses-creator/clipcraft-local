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
