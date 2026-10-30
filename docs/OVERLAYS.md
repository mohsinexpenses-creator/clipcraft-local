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
re-syncs the shipped styles and removes retired built-ins while preserving custom rows.
Presets are stored in SQLite (`overlay_style_presets`) and seeded on first run with four
distinct defaults:

| Preset | Kind | Look | Animation |
| --- | --- | --- | --- |
| `hook-signal-stamp` *(default)* | hook | Acid-lime editorial label on deep green | typewriter |
| `hook-paper-cut` | hook | Warm paper panel with ink-blue serif lettering | slide-up |
| `cta-afterglow` *(default)* | cta | Coral-to-yellow close card | typewriter |
| `cta-blueprint` | cta | Cyan technical lettering on deep teal | slide-up |

### Caption theme matching

The Captions tab also offers the 13 locally bundled Remotion themes: `pop`, `karaoke`,
`kinetic-01`, `kinetic-02`, `hustle`, `grape`, `beast`, `poppin`, `aarit`, `soft-ai`,
`gaming-stream`, `simple-one-word`, and `podcast`. The selected theme is stored additively in
`caption_presets.config_json`; no SQL column migration is needed. Caption words are adapted
from ClipCraft's final (including hook-shifted and profanity-masked) chunks at render time.

The optional **Match Hook + CTA to theme** switch styles both cards with the theme's accent,
shape and entrance motion. It preserves each overlay's selected font, size, copy, timing,
badge content and caption-relative placement. Theme source is vendored under `remotion/caption-themes/vendor` with the
upstream MIT license; local Google font assets carry OFL licenses in `public/fonts/licenses`.

### Fields

| Field | Meaning |
| --- | --- |
| `fontFamily`, `fontSize`, `fontWeight` | Typography (weights: `normal`/`bold`/`extra-bold`/`black`) |
| `textColor`, `backgroundColor`, `borderColor`, `borderWidth`, `borderRadius` | Card styling. `backgroundColor` is any CSS color **or gradient** (e.g. `linear-gradient(135deg, rgba(34,197,94,0.94), rgba(14,165,233,0.94))`) — the style editor has a visual **Solid / Gradient** picker (two color stops + per-stop opacity + angle) that writes this field |
| `textTransform` | `uppercase` or `none` |
| `positionY` | Derived card position as **% from the top** of the 9:16 frame |
| `captionOffsetPx` | Editable gap: Hook above caption top; CTA below caption bottom |
| `animationStyle` | `pop` · `fade` · `slide-up` · `typewriter` · `none` |
| `showBadge`, `badgeText`, `badgeBackgroundColor`, `badgeTextColor` | (Hook only) the small chip above the text, e.g. "Hook Intro"; badge colors can be theme-derived |

## Overlays follow the layout

The **captions** own their position (`positionY`, % from the **bottom**, 22–30 by default).
The **hook** is anchored above the caption block's top edge; the **CTA** is anchored below its
bottom edge. Their independent gaps are editable per style, and placement follows captions in
**speaker focus** and **split screen** (`worker/overlay-layout.ts` +
`lib/overlay-stack.ts`):

- The **captions** keep their preset position unless, in a split screen, that position would
  cover a face — then they move to the nearest face-free band (the seam between the two
  heads). Hook and CTA placement follows the adjusted caption band.
- Card heights are estimated from the style and text. Both overlays are clamped to frame
  margins when a caption edge or configured gap would otherwise place them off-screen.
- Captions do not lift when the CTA appears (`captionLiftScale = 0`).
- The worker derives `positionY` on a copy; saved style presets are never modified.

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
