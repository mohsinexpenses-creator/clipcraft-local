import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { CAPTION_FONT_FILES } from "../lib/caption-fonts";

let loading: Promise<void> | null = null;

const THEME_FONT_FILES = [
  { family: 'Outfit', file: 'Outfit-Variable.ttf', weight: '100 900' },
  { family: 'Montserrat', file: 'Montserrat-Variable.ttf', weight: '100 900' },
  { family: 'Dancing Script', file: 'DancingScript-Variable.ttf', weight: '100 900' },
  { family: 'Rajdhani', file: 'Rajdhani-Bold.ttf', weight: '700' },
  { family: 'Bangers', file: 'Bangers-Regular.ttf', weight: '400' },
];

const FONT_FACE_FILES = [
  ...CAPTION_FONT_FILES.map((font) => ({
    family: font.family,
    file: font.file,
    weight: String(font.weight),
  })),
  ...THEME_FONT_FILES,
];

/** Registers every bundled caption font (public/fonts) once per page. */
function loadCaptionFonts(): Promise<void> {
  if (!loading) {
    loading = Promise.all(
      FONT_FACE_FILES.map(async (font) => {
        const face = new FontFace(
          font.family,
          `url(${staticFile(`fonts/${font.file}`)})`,
          {
            weight: String(font.weight),
          },
        );
        await face.load();
        document.fonts.add(face);
      }),
    ).then(() => undefined);
  }
  return loading;
}

/**
 * Holds the Remotion render (delayRender) until the caption fonts are registered, so the
 * first frame is never painted in a fallback font. A load failure is logged and the render
 * continues with the CSS fallback stack instead of hanging.
 */
export function useCaptionFonts(): void {
  const [handle] = useState<number | null>(() =>
    typeof document === "undefined"
      ? null
      : delayRender("Loading caption fonts"),
  );
  useEffect(() => {
    if (handle === null) return;
    loadCaptionFonts()
      .catch((error) => console.error("Caption fonts failed to load:", error))
      .finally(() => continueRender(handle));
  }, [handle]);
}
