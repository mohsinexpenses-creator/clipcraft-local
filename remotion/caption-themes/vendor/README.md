# Vendored Remotion caption themes

Source: [`vshukla7/remotion-captions-themes`](https://github.com/vshukla7/remotion-captions-themes), npm version 1.0.8. The MIT license is kept in this directory.

The retained upstream caption components are embedded locally rather than installed as a package so ClipCraft can keep its existing React 19 / Remotion setup and render without network access. ClipCraft's original compositions use poster, staircase, column, ledger, bracket, quote, waveform, and dial layouts in `themes/additional.tsx` and `themes/modern.tsx`. Retired built-in caption styles are intentionally excluded from the typed catalog and Remotion registry. CSS `transition` declarations were removed because Remotion renders isolated frames; timing and transforms must be driven by the frame. Caption fonts used by the remaining themes are bundled under `public/fonts` with their OFL license files.

ClipCraft adapts final, profanity-masked caption chunks to the theme `lines[].words[].text` shape and supplies one active phrase. `remotion/caption-themes/CaptionThemeOverlay.tsx` is the shared preview/render wrapper; it adds ClipCraft hold timing, position/safe-area placement and theme-matched Hook/CTA cards.
