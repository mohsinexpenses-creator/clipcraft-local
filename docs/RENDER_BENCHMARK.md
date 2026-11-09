# Render benchmark contract

`lib/render-benchmark.ts` defines one **static, opt-in benchmark fixture**:
`STATIC_SPEAKER_FOCUS_BENCHMARK` (`static-speaker-focus-v1`). It freezes the
selection of visual defaults below so before/after render runs do not accidentally
compare different layouts or overlay treatments.

| Input | Frozen value |
| --- | --- |
| Layout | `speaker-focus` |
| Filter | `vibrant` (Vibrant Boost) |
| Caption preset | `caption-theme-kinetic-01` (Kinetic 01) |
| Hook style | `hook-signal-stamp` (Signal Stamp) |
| CTA style | `cta-afterglow` (Afterglow) |
| Hook fallback duration | `3` seconds |
| CTA duration | `2.5` seconds |
| Output fade | `1` second |

The fixture holds direct shipped preset IDs rather than relying on whatever a
local database currently marks as default. It is immutable and intentionally
does **not** write settings, mutate clips, or alter ordinary renders on import.
That non-application is the safe fallback: normal dashboard/database defaults
continue to work exactly as before. To execute a future benchmark, apply these
values to the exact target clip (or use the exported `renderDefaults` in an
integration harness), then keep the same source file, clip start/end, hardware,
and relevant environment settings for every run. If a local user edited one of
the shipped preset rows, reset that row to its shipped style before comparing
runs; the fixture freezes IDs, not a private copy of mutable SQLite rows.
Source-derived FPS is not forced by this fixture; record the normalized FPS
reported by the worker as part of the run metadata.

## Timing output

Every clip job ends with one grep-friendly `[JOB-TIMING]` line. `wall` is the
only end-to-end elapsed time; nested stages can overlap their parents and must
not be summed into a second total. Phase 0 adds these diagnostic entries when
the corresponding work runs:

| Summary key | What it includes |
| --- | --- |
| `asd.ffmpeg-frame-extraction` | FFmpeg sampled-frame extraction, including a quality retry when one occurs |
| `asd.audio-envelope` | PCM extraction plus voice-envelope construction |
| `asd.yunet-detection` | sampled JPEG decode and YuNet face inference |
| `asd.tracking-speaker-fusion` | tracking/motion work, track-fragment merge, interpolation, and speaker fusion |
| `caption-remotion.bundle` | Remotion bundle loading/build wait for the caption overlay pass |
| `caption-remotion.select-composition` | Caption composition selection |
| `caption-remotion.render-frames` | All caption-overlay frame render phases |
| `caption-remotion.frame-normalization` | Caption PNG sequence normalization |
| `broll-remotion.*` | The same four Remotion substages for B-roll, if B-roll is rendered |

A suffix such as `×2` means the named substage ran twice (for example, an ASD
quality retry or two sparse Remotion ranges). Diagnostic callbacks are guarded:
a timing sink failure is logged and cannot fail a render.

## Required run record

When FFmpeg, FFprobe, Chromium, and a representative source fixture are
available, each phase comparison should retain:

1. the exact source checksum/path and clip time range;
2. this fixture ID plus every visual and performance-related environment flag;
3. the complete `[JOB-TIMING]` line and output probe metadata;
4. reference-frame paths/timestamps and the calculated SSIM or equivalent
   image comparison;
5. audio/SFX checks and a human visual-equivalence review.

## Phase 4 cropped-canvas / concurrency gate

Phase 4 adds two **default-off** experimental flags:

| Flag | Trial | Safe fallback |
| --- | --- | --- |
| `BROLL_CARD_CROPPED_CANVAS=1` | Landscape-card Remotion frames use only a guarded card rectangle; FFmpeg overlays it at the recorded `x,y`. | `0` uses the original 1080×1920 transparent PNG canvas. |
| `CAPTION_BAND_CROPPED_CANVAS=1` | The combined caption/Hook/CTA composition uses a guarded full-width vertical band; its child layout still sees a virtual 1080×1920 canvas. | `0` uses the original 1080×1920 transparent PNG canvas. |

Before enabling either by default, run the frozen benchmark once with both flags at
`0`, then enable one trial at a time and capture five timestamps for **each visible
overlay type**: fullscreen B-roll, landscape B-roll card, caption, Hook, and CTA.
Use an entry, settled/hold, active-word or internal-motion point, pre-exit, and exit
point when that overlay's timing permits. Compare each cropped frame against the
matching full-canvas frame (pixel diff / SSIM plus human review), then verify the
output audio stream and every B-roll SFX cue are unchanged. Record the flags,
exact timestamps, comparison method/results, and full `[JOB-TIMING]` lines.

The split-screen parallel broadened path is also gated: a split clip with
fullscreen-only B-roll may overlap ASD, while any split landscape card must retain
the sequential face-band path. `RENDER_PARALLEL_BROLL_CONCURRENCY` remains at its
baseline-safe default of `2`; do not raise it until the same representative host
has a measured concurrency sweep. No alpha-video branch is included: retain the
single PNG/FFmpeg composite unless measurements show it is still the bottleneck.

## Current gate status

This checkout is being implemented in **static-only** mode. There is currently
no usable FFmpeg/FFprobe executable, no normal source-media fixture, and no
working local Headless Chrome path for Remotion, so no real render duration,
output probe, reference frame, SSIM, audio/SFX, or visual-equivalence value is
asserted here. Those gates are **blocked/deferred**, not estimated. In particular,
Phase 4 has no cropped/full frame diffs, audio/SFX comparison, or concurrency
measurement recorded yet; both cropped-canvas flags therefore remain default-off
and the Chrome cap remains `2`. The static tests only lock the benchmark
configuration and timing aggregation contract; they are not a substitute for the
deferred render gates.
