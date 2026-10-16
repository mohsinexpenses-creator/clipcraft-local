# Section B — strict relevance (2026-10-16)

Changes: visual provider prefilter/pools, parallel bounded thumbnails, structured
Gemini scores keyed to stable candidate IDs, bank caption table and tag hygiene,
recent-video diversity penalty, render-only local reads, Render strictness and
vision threshold settings, clip skip-reason UI, debug JSON, and regression tests.

Checks: npm test 269/269 passed, zero skips; typecheck/lint/diff-check passed.
The initial failing assertion expected an absent kind rather than the preserved
photo-card kind; corrected it without relaxing skipped status or vision gating.
Tests include missing keys, provider/API failures, absent verdicts, bank non-bypass,
one-common-word rejection, stable-ID selection and no provider resolver in render.

Current Gemini generateContent docs confirm 2.5 Flash thinkingBudget=0,
responseJsonSchema and increased output budget. No live API credentials were used;
actual relevance/fill rate remains unmeasured. Queue isolation, shared key RPM/
retries and transcript/settings cache scope are E; metrics/evaluation are D.
