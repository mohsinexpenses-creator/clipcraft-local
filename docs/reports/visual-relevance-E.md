# Section E — independent bounded prefetch (2026-10-16)

Implemented persisted per-clip prefetch, global DB claim cap of two, immediate
individual render handoff, strict video FIFO/recovery/cancellation, queued editor
prefetch, and local-only manual render. Native Gemini 2.5 Flash has shared rotating
keys/RPM, Retry-After, jitter/backoff, one planner/three vision logical calls and
four total HTTP attempts/clip. Whole-plan/verdict/result caching avoids repeat
network requests. Settings stay in existing sections; video snapshots still win.

New boundaries: lib/gemini-pool.ts, visual-prefetch.ts, visual-transcript.ts;
queue/pipeline/worker/API/editor/status/settings/timings integration; byte-bound
server verification and preservation of trusted edit metadata. See git diff for
all files. SETUP and OVERLAYS document quotas, prices, cache paths and scope.

Checks: **275/275 tests pass, 0 skipped**, 32.97s; typecheck, lint and diff-check pass.
An initial FIFO test assumed direct render and was updated to process its new
persisted prefetch prerequisite. The new integration test exposed record_json
not containing scalar clip columns; fixed with a typed synchronous DB row helper
inside the save transaction. No cancellation guard was relaxed.

Synthetic Roman Urdu three-bucket fixture resolves 3/3 images with one planner +
one vision request (two HTTP attempts), comfortably below 25s; replay makes zero
API requests. Queue tests verify two claims maximum, first render while sibling
prefetch is running, later-video block, restart recovery and cancelled handoff.
Pool tests cover rotating keys, RPM/deadline/cooldown, 429/503 and shared retry cap.
Verification tests reject client-injected paths and invalidate changed meaning/
timing. Selector now uses the allowed tolerance to shift the second beat 0.1s
rather than losing it to the mandatory two-second speaker gap.

These use mocked responses/local generated photos, **not live relevance or API
latency measurements**. The 25s budget bounds network waits, not all synchronous
JPEG/DB work. Live 70% fill, 300 clips/day and i5-10500/Windows <=10% render overhead
are unverified. Official Gemini pricing/rate-limit docs were read on 2026-10-16;
limits are per project, not per key, with no invented universal free RPD value.
