# Section A — sentence planner

Files: new lib/visual-planner.ts and tests/visual-planner.test.ts; contextual
visuals, pipeline, processor, presets, llm, types, app-settings, render settings,
phase4 tests and OVERLAYS docs.

Removed clock/keyword gap generation. Added schema-based numbered-segment
planning in existing post-detection prefetch, strict ID/time validation,
score-based bucket selection, effective max limit, distinct queries/ideas,
3s image / >=2s speaker spacing, hook-timeline mapping, and validated disk cache.
Setting lives inside Render, default visualizable score 6; no new env vars.
Existing entity metadata and keyword beats are retained.

Checks: npm test 266 passed, 0 skipped; typecheck and lint passed. Planner fixture
covers Roman Urdu (rooftop solar), Urdu (abstract understanding, skipped), Hindi
(dry farmland), direct IDs and cached call count 1. This is a deterministic mocked
completion contract test, NOT a live measurement of Gemini translation quality.
No live provider/Gemini credentials or production transcripts were used; live
relevance and <=25s prefetch timing remain unmeasured. Queue isolation is E;
strict vision and removing render-time resolution are B.
