# Hook & CTA overlays

Each clip gets two text overlays on top of the captions:

1. **Hook** — punchy intro text shown during the duplicated hook segment at the start.
2. **CTA** — call-to-action card in the clip's last ~2 seconds.

They are configured in **two independent layers** (both editable in the web app):

| Layer | What it controls | Where |
| --- | --- | --- |
| **Text generation** (AI prompts) | *What the text says* — `hook_text` / `cta_text` come from prompt templates with the transcript context. | Generate → **Prompt templates** (`prompt-hook-generation`, `prompt-cta-generation`) |
| **Text presets** (saved snippets) | Ready-made hook/CTA *lines* you can click onto a clip ("WAIT FOR IT…", "FOLLOW FOR PART 2"). | **Presets → Text presets** (`/text-presets`) + the chips on each clip card |
| **Style presets** | *How it looks* — font, colors, card, position, animation, badge chip. | **Presets → Style presets → "Hook overlay" / "CTA overlay" tabs** |

The layers never mix: a style preset carries **no copy** (except the decorative
badge label), the AI never chooses colors/fonts, and picking a text preset never
changes the styling. Editing the generation prompts is exactly as before — style
presets are additive.

## Style presets

Manage them at `/caption-presets` (tabbed: Captions · Hook overlay · CTA overlay) or via
`GET/POST/PUT/DELETE /api/overlay-presets` (`kind: 'hook' | 'cta'`; `POST {"action":"reset"}`
restores the four defaults). Presets are stored in SQLite (`overlay_style_presets`) and
seeded on first run with four defaults:

| Preset | Kind | Look | Animation |
| --- | --- | --- | --- |
| `hook-bold-yellow` *(default)* | hook | Yellow impact text on a dark card + red "Hook Intro" chip | pop |
| `hook-fire-red` | hook | White text on a red alert card | slide-up |
| `cta-gradient-green` *(default)* | cta | White uppercase CTA on the classic green-blue gradient card | pop |
| `cta-white-pill` | cta | Dark text on a clean white pill | fade |

These four reproduce the previously hardcoded overlay looks 1:1.

### Caption theme matching

The Captions tab also offers the 13 locally bundled Remotion themes: `pop`, `karaoke`,
`kinetic-01`, `kinetic-02`, `hustle`, `grape`, `beast`, `poppin`, `aarit`, `soft-ai`,
`gaming-stream`, `simple-one-word`, and `podcast`. The selected theme is stored additively in
`caption_presets.config_json`; no SQL column migration is needed. Caption words are adapted
from ClipCraft's final (including hook-shifted and profanity-masked) chunks at render time.

The optional **Match Hook + CTA to theme** switch styles both cards with the theme's font,
accent, shape and entrance motion; it does not change their existing copy or timing. Saved Hook/CTA styles,
font sizes, badge content and placement remain independent and can be used again by turning
the switch off. Theme source is vendored under `remotion/caption-themes/vendor` with the
upstream MIT license; local Google font assets carry OFL licenses in `public/fonts/licenses`.

### Fields

| Field | Meaning |
| --- | --- |
| `fontFamily`, `fontSize`, `fontWeight` | Typography (weights: `normal`/`bold`/`extra-bold`/`black`) |
| `textColor`, `backgroundColor`, `borderColor`, `borderWidth`, `borderRadius` | Card styling. `backgroundColor` is any CSS color **or gradient** (e.g. `linear-gradient(135deg, rgba(34,197,94,0.94), rgba(14,165,233,0.94))`) — the style editor has a visual **Solid / Gradient** picker (two color stops + per-stop opacity + angle) that writes this field |
| `textTransform` | `uppercase` or `none` |
| `positionY` | Card position as **% from the top** of the 9:16 frame (hook default 12, CTA default 64) |
| `animationStyle` | `pop` · `fade` · `slide-up` · `none` — the entrance animation |
| `showBadge`, `badgeText`, `badgeBackgroundColor`, `badgeTextColor` | (Hook only) the small chip above the text, e.g. "Hook Intro"; badge colors can be theme-derived |

## Overlays follow the layout

The **captions** own their position (`positionY`, % from the **bottom**, 22–30 by default).
The **hook** and **CTA** cards are always placed **directly above the caption block** — one
fixed gap above the captions' top edge, whatever the layout. That is the single rule, applied
identically in **speaker focus** and **split screen** (`worker/overlay-layout.ts` +
`lib/overlay-stack.ts`):

- The **captions** keep their preset position unless, in a split screen, that position would
  cover a face — then they move to the nearest face-free band (the seam between the two
  heads). The hook and CTA follow the captions wherever they land, staying stacked above them.
- The **hook** and **CTA** cards are stacked directly above the captions, never on top of a
  face and never overlapping the caption block. Card heights are estimated from the style and
  the text so the next element lands exactly one gap above them; if the stack would run off the
  top of the frame it is clamped to a top margin instead.
- Because the cards sit above the captions, the old "lift the captions while the CTA card is on
  screen" behaviour is switched off (`captionLiftScale = 0`) — the cards never share the
  caption area, so there is nothing to lift out of the way.
- Only `positionY` is changed, on a copy: fonts, colours, card styling and animation are exactly
  your preset's, and the preset you saved is never modified.

A face is protected from the brow-line up to a forehead's height above the detector box and
down to the chin, plus a 16 px gap; hair is avoided too, but covering a little of it is
preferred to relocating an overlay far from its preset. Card heights are estimated from the
style and the text (wrapped with deliberately wide glyph widths) and were checked against real
Chrome renders of the default presets: the estimate is never smaller than the rendered card.
The worker log shows what happened:

```
Overlay layout (split screen): captions y 818-986, hook y 588-770, CTA y 1548-1641
  · captions moved from y=1345 to y=818 (the preset position covers a face)
  · hook moved from y=230 to y=588 (the preset position covers a face or the captions)
  · cta moved from y=1229 to y=1548 (the preset position covers a face or the captions)
```

If no completely free spot exists (faces filling their panes) the overlay is placed where it
covers the least, and the log line says so.

## Rendering

The independent Hook/CTA style presets are preserved and composited with the source crop
in the final video pass. `CaptionOverlayComposition` paints the selected caption theme (or
the classic `AnimatedWord` captions), hook and CTA into one transparent PNG sequence;
caption-theme matching is applied to the Hook/CTA cards when enabled. The overlay pass does
not encode the source video, so it introduces no extra lossy video generation.

The worker resolves the clip's `hookStylePresetId` / `ctaStylePresetId` (defaults
`hook-bold-yellow` / `cta-gradient-green`). Each clip can pick its own pair — see
the **Hook style** / **CTA style** selects on the clip card (and in
`POST /api/clips` payloads).

The hook window still follows `getCtaWindow`/`getCtaBottomLiftPercent` timing logic:
the hook overlays the first `hookDuration` seconds of the clip, the CTA the final
seconds before `clipEnd`.

Related: [LAYOUTS.md](./LAYOUTS.md) (how the video behind the overlays is framed),
[SETUP.md](../SETUP.md) (running the worker).

## Full-screen contextual photos

Photos now occupy the complete 1080×1920 canvas. Legacy card aspect, border and
behind-captions placement values are ignored. Layer order is **speaker → photo →
transparent Remotion sequence** (captions, hook, CTA and keyword pops). The debug
encode branches before photos and text; it does not consume their final output.

Downloaded photos are prepared once as `.fullscreen-v1.jpg`: sources with aspect
ratio ≤0.85 use cover-crop; wider sources use a sharp width-fitted photograph over
a darkened, blurred cover copy. Preparation checks the downloaded file's actual
size, not API metadata, and rejects >1.5× required upscale. Blur never runs in the
per-frame filter graph. Full-screen entrances/exits use 0.18s alpha fades and a
2% centered zoom settle (fade-only keeps zoom at 1); projectile motion remains
available for legacy non-full-screen filter callers only.

Run `npx tsx scripts/verify-visual-layering.ts` for four real FFmpeg encodes
(hook on/off × debug on/off) and pixel assertions that white caption text survives
above a bright image. Outputs go under ignored `data/visual-layering-test/`.

### Sentence-level planning

Photo cadence is a target, not a mandate. Prefetch sends numbered, timestamped
segments to one text completion per uncached clip. The planner translates whole
sentence meanings into concrete English subjects and literal/metaphor/theme
searches; it never reconstructs timing by matching translated quote strings.
The selector uses 5.4s buckets with ±1.5s flexibility, default score cutoff 6,
3s displays and at least 2s of speaker between images. It respects Max visuals,
avoids repeated subjects/queries/segments, and stays outside the hook dip.
The legacy clock-based transcript-token filler is removed. Keyword pops remain
separate. Planner responses are validated and cached under `data/visual-plans/`.

### Strict relevance gate

Provider text matching is only a cheap prefilter: at least two matched content
words or a content-token ratio of 0.6. The exact same top-three pool (including
bank entries) is sent to vision and used for selection, keyed by stable candidate
IDs, never positional indices. Vision scores plausibility against the full
sentence, subject, tone, identity and negative cues. Default acceptance is 7/10.
Thumbnails are decoded/resized to at most 256px, with a shared concurrency cap of
four. Up to three vision batches run in parallel per clip.

Strict mode skips photos without a verdict, including timeouts, missing keys and
API errors. Lenient mode is an explicit Render setting allowing text-prefilter
winners only when vision is unavailable; a low vision score never falls back.
`visualsSkippedReason` appears on clip tiles. Rejected photos do not create
arbitrary keyword pops. Render reads only prepared, already-verified local frames
and remaps their time windows to the current hook timeline; no provider lookup,
bank search, vision request or frame preparation runs in render.

Bank tags contain only provider tags/title. Legacy query-tainted bank tags are
ignored when constructing candidates. Verified sentence captions live in
`image_bank_captions`, separate from tags. Recently used images (last 20 clips of
the video) get a soft ranking penalty; assets/content hashes never repeat inside
a clip. `data/visual-debug/<clipId>.json` records sentence, queries tried, top-three
text/vision scores and the final decision.


### Queue/cache boundary

Detection queues one persisted `visual-prefetch` job per clip (concurrency two),
not a whole-video prefetch await. A ready clip may render immediately; video FIFO
still gates later videos. The editor queues the same job and polls its status.
Render only reads locally verified `.fullscreen-v1.jpg` frames, checks their bytes
and source-transcript/meaning/settings fingerprints, then remaps hook windows.
Edited/unresolved/manual frames without server verification are skipped with a
visible reason; render never searches, calls Gemini, or prepares frames. Independent
prefetch timing rows and call counts are written to `data/timings.jsonl`.
