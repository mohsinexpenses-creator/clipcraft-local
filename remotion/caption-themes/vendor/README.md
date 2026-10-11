# Vendored Remotion caption themes

Source: [`vshukla7/remotion-captions-themes`](https://github.com/vshukla7/remotion-captions-themes), npm version 1.0.8. The MIT license is kept in this directory.

The 13 upstream theme components are embedded locally rather than installed as a package so ClipCraft can keep its existing React 19 / Remotion setup and render without network access. CSS `transition` declarations were removed because Remotion renders isolated frames; timing and transforms must be driven by the frame. The `beast` theme uses the locally bundled, SIL OFL Bangers face instead of the upstream test player's remote Komika Axis font, and `podcast` uses ClipCraft's bundled Anton face as its deterministic Impact-style fallback. Fonts used by the themes are bundled under `public/fonts` with their OFL license files.

ClipCraft adapts final, profanity-masked caption chunks to the upstream `lines[].words[].text` shape and supplies a single active line (or a two-line pair for `podcast`). `remotion/caption-themes/CaptionThemeOverlay.tsx` is the shared preview/render wrapper; it adds ClipCraft hold timing, position/safe-area placement and theme-matched Hook/CTA cards.
