# Section C — full-screen composition (2026-10-16)

Changes: worker placement/filter graph, render settings UI, cached frame preparation
(`lib/visual-frame.ts`, `lib/visual-providers.ts`), valid PNG test fixtures,
placement/graph/quality tests, layering verification script, OVERLAYS and SETUP docs.

Checks: npm test 263/263 passed (0 skipped); typecheck/lint/diff-check passed.
Real FFmpeg 7.0.2 lavfi smoke renders, hook off/on × debug off/on:

| Hook | Debug | White caption pixels | Wall time including decode assertion |
|---|---|---:|---:|
| off | off | 5898 | 3448 ms |
| off | on | 5898 | 4067 ms |
| on | off | 5905 | 4108 ms |
| on | on | 5905 | 5196 ms |

Artifacts are ignored under data/visual-layering-test. No production timings or
Windows GPU measurements were available; these numbers are NOT a <=10% benchmark.
Provider docs confirmed original/full rendition choices, conditional Pixabay
high-resolution access, and Unsplash hotlinking obligations (see SETUP).

Remaining cross-section work: B must remove render-time resolution/preparation,
including legacy bank bypasses. A/B/E/D and live relevance/latency evaluation are
not included in this commit. Native dependencies were built against local Node
headers; test FFmpeg came from the imageio-ffmpeg wheel, not a tracked binary.
