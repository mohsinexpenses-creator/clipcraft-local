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
