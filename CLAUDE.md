@AGENTS.md

## Repository-specific persistence and queue rules

- Persistence is local SQLite through `better-sqlite3` in `lib/db.ts`; there is no MongoDB, Redis, BullMQ, or Docker-backed database setup.
- Keep `lib/db.ts` and database access in server routes / server processes only. Do not import it from client components.
- Use typed row helpers, prepared statements, JSON serialization helpers, and additive schema migrations. The shared database file is configured with `DATABASE_PATH` (default `./data/clipcraft.db`), WAL, and `busy_timeout=5000`; restart both web and worker processes if the path changes.
- Queue state lives in the SQLite `jobs` table. Preserve atomic claims, independent transcription/render polling loops, bounded retries with exponential backoff, restart recovery, and deletion cleanup. Run one worker process per DB; concurrency is within its render loop because startup recovery resets all running jobs.
- Keep changes to persistence/queue boundaries; do not change the video pipeline. Run `npm test`, `npm run typecheck`, and `npm run lint` after relevant changes.
