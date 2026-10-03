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
restores the four defaults). Presets are stored in Mongo (`overlayStylePresets`) and
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

The preset positions — captions (`positionY`, % from the **bottom**, 22–30 by default), hook
(% from the top, 12) and CTA (% from the top, 64–66) — were designed for **speaker focus**: one
person, face near the upper third, torso below. Speaker focus uses them exactly as saved.

In a **split screen** those same pixels land on the two faces (the caption on the lower
person's eyes, the CTA on their forehead, the hook on the upper person's brow), so the
placement is recomputed from where the heads really are on the 1080×1920 canvas
(`worker/overlay-layout.ts`):

- **A preset position that does not cover a face is kept** — nothing moves unless it has to.
  In a split screen the position setting is therefore a *preference*.
- Otherwise the **captions** move to the seam between the panes (the free band between the two
  heads), the **hook** to the nearest free spot (normally above the upper head), and the
  **CTA** to the nearest free spot (normally just below the captions).
- Overlays never cover each other, and the usual "lift the captions while the CTA card is on
  screen" is switched off (the CTA no longer shares their area).
- The hook and the CTA are only on screen for a few seconds, so each is placed against where
  the faces are **during those seconds** (the replayed hook moment, the last 2.5 s) — a person
  who briefly stands up at 0:24 does not push the end card around for the whole clip. Captions
  are always on screen, so they avoid every place a face ever goes.
- Only `positionY` is changed, on a copy: fonts, colours, card styling and animation are exactly
  your preset's, and the preset you saved is never modified.

A face is protected from the brow-line up to a forehead's height above the detector box and
down to the chin, plus a 16 px gap; hair is avoided too, but covering a little of it is
preferred to relocating an overlay far from its preset. Card heights are estimated from the
style and the text (wrapped with deliberately wide glyph widths) and were checked against real
Chrome renders of the default presets: the estimate is never smaller than the rendered card.
The worker log shows what happened:

```
Overlay layout (split screen): captions y 874-1042, hook y 84-266, CTA y 1150-1243
  · captions moved from y=1345 to y=874 (the preset position covers a face)
  · hook moved from y=230 to y=84 (the preset position covers a face or the captions)
  · cta moved from y=1229 to y=1150 (the preset position covers a face or the captions)
```

If no completely free spot exists (faces filling their panes) the overlay is placed where it
covers the least, and the log line says so.

## Rendering

Both caption engines honour the style presets:

- **Remotion** — `CaptionComposition` → `HookOverlay` / `CTAOverlay` receives the
  resolved preset as `hookStyle` / `ctaStyle`.
- **Native (fast)** — `renderNativeCaptions` renders the transparent
  `HookOverlayComposition` / `CtaOverlayComposition` PNG sequences with the same
  `hookStyle` / `ctaStyle` input props, so style changes show up in both engines.

The worker resolves the clip's `hookStylePresetId` / `ctaStylePresetId` (defaults
`hook-bold-yellow` / `cta-gradient-green`). Each clip can pick its own pair — see
the **Hook style** / **CTA style** selects on the clip card (and in
`POST /api/clips` payloads).

The hook window still follows `getCtaWindow`/`getCtaBottomLiftPercent` timing logic:
the hook overlays the first `hookDuration` seconds of the clip, the CTA the final
seconds before `clipEnd`.

Related: [LAYOUTS.md](./LAYOUTS.md) (how the video behind the overlays is framed),
[SETUP.md](../SETUP.md) (running the worker).
