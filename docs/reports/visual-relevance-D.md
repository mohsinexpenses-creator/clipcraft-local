# Section D — evaluation and final validation (2026-10-16)

## Changes

- `scripts/eval-visuals.ts` / `npm run eval:visuals`: read-only video/recent-N
  evaluation, Markdown/JSON output, sentence/English meaning/query/title/vision/
  source timing/decision, candidate debug details and explicit missing-data warnings.
- `lib/visual-evaluation.ts`: fill denominator includes every 5.4s source bucket;
  rejected/removed/keyword/missing/unverified frames cannot inflate acceptance.
  CLI checks prepared frame bytes. Matched genuine render baselines are separate
  from prefetch, cache replays and synthetic benchmarks; missing baselines are N/A.
- `scripts/benchmark-visual-render.ts` / `npm run benchmark:visuals`: Git baseline
  filter builder, no branch switch, alternating-order local lavfi A/B, separately
  labelled timing JSONL and ignored media/summary outputs.
- `tests/visual-evaluation.test.ts` and `tests/fixtures/visual-evaluation-demo.json`:
  metric exclusions, comparable/newer baseline pairing, malformed logs, empty-data
  handling and a CLI Roman Urdu/Urdu/Hindi offline demo that never opens SQLite.
- Per-logical-call Gemini latency/attempt/outcome records in budget, prefetch stats
  and timings; evaluator exposes separate planner/vision p50/p95. Elapsed times
  include limiter/retry waits; parallel totals can overlap.
- Evaluation review hardening: thumbnail semaphore waits/fetches share the clip
  deadline; downloads share a redirect deadline; Unsplash tracking is bounded by
  remaining time; verdict writes are atomic; Retry-After supports seconds/dates.
  Verified bank captions join as separate metadata, never tags or a vision bypass.
  Unchanged editor visual arrays no longer mark caption/style-only edits as new
  semantic plans. Regression coverage added/extended for these boundaries.
- Updated SETUP/OVERLAYS with usage, pricing/quota caveats, cache semantics and the
  precise Windows/live checks still required. No new environment-backed form values.

## Checks

- **npm test: 280/280 pass, 0 failed/cancelled/skipped**, 35.576s.
- **npm run typecheck / npm run lint / git diff --check: pass.**
- Real FFmpeg bright-photo/caption layering: **4/4 pass**, hook on/off × debug
  on/off. White caption pixels: 5,898 without hook, 5,905 with hook. Final run
  encodes took 4.622 / 5.044 / 5.806 / 8.151s respectively while the suite ran;
  these are layering checks, **not performance baselines**.
- A new deadline mock initially lost its event-loop reference because Node's
  AbortSignal timeout is unref'ed. Fixed the fixture to model a real referenced
  socket; the final full suite passes with no skipped/cancelled tests. Product
  deadline assertions were not relaxed.

## Measurements (scope matters)

Three-round **synthetic FFmpeg-filter-only** comparison against starting commit
`f6e4e570d7e5dbb684f4e0028d8f3bd7770832e2`, Linux Xeon 2.60GHz, 10.8s,
1080×1920/30fps, two cached stills, x264 ultrafast, two encode threads and one
filter thread:

| Round | Before ms | After ms | Delta |
| --- | ---: | ---: | ---: |
| 1 | 18,959 | 9,801 | -48.30% |
| 2 | 16,934 | 10,122 | -40.23% |
| 3 | 17,199 | 9,649 | -43.90% |
| Mean | 17,697 | 9,857 | **-44.30%** |

Raw records: ignored `data/visual-render-benchmark/summary.json` and separately
labelled `data/timings.jsonl` row. This excludes Remotion, face analysis, actual
source decode, audio/SFX, prefetch and full worker startup; it is **not** proof of
Windows/i5-10500 full-render overhead. No comparable real full-worker baseline
clips exist in this checkout: evaluator correctly reports 0 pairs / N/A.

Latest **mocked** three-beat Roman Urdu prefetch integration: 3/3 resolved, 1,477ms,
one planner + one vision call, two HTTP attempts. Cache replay: 1ms, zero calls /
attempts. Generated fixture images and stubbed verdicts do **not** establish live
semantic accuracy, provider latency or 70% real-world fill.

## Sample run

`npm run eval:visuals -- --demo` (offline/scripted, no keys/network/SQLite):

| Spoken sentence | English meaning / query | Decision |
| --- | --- | --- |
| Bijli nahi aa rahi, hum chhat par solar panel lagwa rahe hain. | Installing rooftop solar panels / `rooftop solar installation` | Strict skip: live vision not run |
| یہ بات سمجھنا مشکل ہے۔ | This is difficult to understand | Skip: score 3 < 6; no generic clock/portrait filler |
| खेतों में पानी की कमी है। | The fields are short of water / `dry farmland soil` | Strict skip: live vision not run |

Demo fill **0/3 (0%)**, target unmet deliberately. Full demo output is generated
locally in `.tmp/visual-evaluation-demo.md`; no unrelated photo was substituted.
Use `npm run eval:visuals -- --video VIDEO_ID --recent 20 --baseline data/before-timings.jsonl`
for actual local evidence after processing real clips.

## Unverified / required on the user's machine

No live Gemini/provider credentials or API measurements were used. Actual 70%
relevant-image fill, 20–25s prefetch, account-specific 300 clips/day quota/cost and
Windows i5-10500/16GB full-worker <=10% overhead remain unverified. SETUP lists
repeatable Windows caption/encoder/Hook/CTA/keyword/SFX/cancel/restart checks.
Relevance remains fail-closed; a metric shortfall must never admit a wrong image.
