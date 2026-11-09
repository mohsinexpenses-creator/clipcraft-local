import { useEffect, useMemo, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { CAPTION_FONT_FILES } from "../lib/caption-fonts";
import type { RemotionCustomFontFace } from "../lib/types";

interface FontFaceSource {
  family: string;
  source: string;
  weight: string;
}

const THEME_FONT_FILES = [
  { family: 'Outfit', file: 'Outfit-Variable.ttf', weight: '100 900' },
  { family: 'Montserrat', file: 'Montserrat-Variable.ttf', weight: '100 900' },
  { family: 'Dancing Script', file: 'DancingScript-Variable.ttf', weight: '100 900' },
  { family: 'Rajdhani', file: 'Rajdhani-Bold.ttf', weight: '700' },
];

const BUNDLED_FONTS: FontFaceSource[] = [
  ...CAPTION_FONT_FILES.map((font) => ({
    family: font.family,
    source: staticFile(`fonts/${font.file}`),
    weight: String(font.weight),
  })),
  ...THEME_FONT_FILES.map((font) => ({
    family: font.family,
    source: staticFile(`fonts/${font.file}`),
    weight: String(font.weight),
  })),
];

const fontLoads = new Map<string, Promise<void>>();

function fontKey(font: FontFaceSource): string {
  return `${font.family}\u0000${font.weight}\u0000${font.source}`;
}

/** Load one face once even when captions and overlays ask for it in the same frame. */
function loadFont(font: FontFaceSource): Promise<void> {
  const key = fontKey(font);
  const cached = fontLoads.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const face = new FontFace(font.family, `url(${font.source})`, { weight: font.weight });
    await face.load();
    document.fonts.add(face);
  })();
  fontLoads.set(key, pending);
  // A temporarily missing/deleted custom file should use its fallback for this
  // render, but a later corrected upload must be able to try the same family.
  pending.catch(() => fontLoads.delete(key));
  return pending;
}

/** Registers every bundled caption font (public/fonts) once per page. */
function loadCaptionFonts(): Promise<void> {
  return Promise.all(BUNDLED_FONTS.map(loadFont)).then(() => undefined);
}

/**
 * Holds the Remotion render (delayRender) until bundled fonts are registered,
 * so the first frame is never painted in a fallback font. A failed file still
 * resolves the handle after its load attempt: CSS can use its fallback stack,
 * but a bad local asset cannot leave Chromium hanging forever.
 */
export function useCaptionFonts(): void {
  const [handle] = useState<number | null>(() =>
    typeof document === "undefined" ? null : delayRender("Loading bundled caption fonts"),
  );
  useEffect(() => {
    if (handle === null) return;
    loadCaptionFonts()
      .catch((error) => console.error("Caption fonts failed to load:", error))
      .finally(() => continueRender(handle));
  }, [handle]);
}

function customFontKey(fonts: RemotionCustomFontFace[] | undefined): string {
  return (fonts ?? [])
    .map((font) => `${font.family}\u0000${font.weight}\u0000${font.source}`)
    .sort()
    .join('\u0001');
}

/**
 * Render/preview font-load barrier for custom fonts. Preview sources are
 * loopback `/api/fonts/<id>` URLs; worker sources are immutable data URLs so a
 * standalone worker never has to discover the Next development port.
 */
export function useCustomFonts(fonts: RemotionCustomFontFace[] | undefined): void {
  const key = useMemo(() => customFontKey(fonts), [fonts]);
  const [handle] = useState<number | null>(() =>
    typeof document === "undefined" || !key ? null : delayRender("Loading custom fonts"),
  );
  useEffect(() => {
    if (handle === null || !fonts?.length) return;
    const sources: FontFaceSource[] = fonts.map((font) => ({
      family: font.family,
      source: font.source,
      weight: String(font.weight),
    }));
    Promise.all(sources.map(loadFont))
      .catch((error) => console.error("Custom font failed to load; using CSS fallback:", error))
      .finally(() => continueRender(handle));
  }, [fonts, handle, key]);
}
