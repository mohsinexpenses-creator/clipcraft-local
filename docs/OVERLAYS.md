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

### Fields

| Field | Meaning |
| --- | --- |
| `fontFamily`, `fontSize`, `fontWeight` | Typography (weights: `normal`/`bold`/`extra-bold`/`black`) |
| `textColor`, `backgroundColor`, `borderColor`, `borderWidth`, `borderRadius` | Card styling. `backgroundColor` is any CSS color **or gradient** (e.g. `linear-gradient(135deg, rgba(34,197,94,0.94), rgba(14,165,233,0.94))`) — the style editor has a visual **Solid / Gradient** picker (two color stops + per-stop opacity + angle) that writes this field |
| `textTransform` | `uppercase` or `none` |
| `positionY` | Card position as **% from the top** of the 9:16 frame (hook default 12, CTA default 64) |
| `animationStyle` | `pop` · `fade` · `slide-up` · `none` — the entrance animation |
| `showBadge`, `badgeText` | (Hook only) the small chip above the text, e.g. "Hook Intro" |

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

Both caption engines honour the style presets and prepare transparent frames that
FFmpeg composites with the source crop in the single final video pass:

- **Remotion** — `CaptionOverlayComposition` paints the full-timeline captions,
  hook and CTA into one transparent PNG sequence.
- **Native (fast)** — ASS captions are burned straight onto the video by libass
  (transparent caption PNGs are impossible on current FFmpeg); hook/CTA cards are still
  painted by `HookOverlayComposition` / `CtaOverlayComposition`.

Neither engine encodes the source video, so switching engines does not introduce
an extra lossy video generation.

The worker resolves the clip's `hookStylePresetId` / `ctaStylePresetId` (defaults
`hook-bold-yellow` / `cta-gradient-green`). Each clip can pick its own pair — see
the **Hook style** / **CTA style** selects on the clip card (and in
`POST /api/clips` payloads).

The hook window still follows `getCtaWindow`/`getCtaBottomLiftPercent` timing logic:
the hook overlays the first `hookDuration` seconds of the clip, the CTA the final
seconds before `clipEnd`.

Related: [LAYOUTS.md](./LAYOUTS.md) (how the video behind the overlays is framed),
[SETUP.md](../SETUP.md) (running the worker).
