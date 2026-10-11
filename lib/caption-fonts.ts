/**
 * Caption fonts that ship inside the repo (public/fonts, all SIL OFL).
 *
 * Dependency-free on purpose: the browser (Remotion Player), the Remotion
 * renderer and the native ASS generator all import it. Every entry is ONE static
 * TTF file, so the weight is baked into the file:
 *  - CSS side (Remotion): registered as FontFace(family, weight).
 *  - ASS side (libass): addressed by `assName`, which is the font's own
 *    family name (name ID 1), with the bold flag forced to 0.
 */
import type { CaptionFontWeight } from "./types";

export type CaptionCssWeight = 400 | 700 | 800 | 900;

export interface CaptionFontFile {
  /** First family name used in a preset's `fontFamily` list. */
  family: string;
  /** CSS weight this file is registered under (see cssWeightFor). */
  weight: CaptionCssWeight;
  /** File name inside public/fonts. */
  file: string;
  /** Family name libass must use (the font's internal family name). */
  assName: string;
}

export const CAPTION_FONT_FILES: CaptionFontFile[] = [
  {
    family: "Poppins",
    weight: 900,
    file: "Poppins-Black.ttf",
    assName: "Poppins Black",
  },
  {
    family: "Poppins",
    weight: 800,
    file: "Poppins-ExtraBold.ttf",
    assName: "Poppins ExtraBold",
  },
  {
    family: "Poppins",
    weight: 700,
    file: "Poppins-SemiBold.ttf",
    assName: "Poppins SemiBold",
  },
  { family: "Anton", weight: 400, file: "Anton-Regular.ttf", assName: "Anton" },
  {
    family: "DM Serif Display",
    weight: 400,
    file: "DMSerifDisplay-Regular.ttf",
    assName: "DM Serif Display",
  },
  {
    family: "Archivo Black",
    weight: 400,
    file: "ArchivoBlack-Regular.ttf",
    assName: "Archivo Black",
  },
  {
    family: "Bebas Neue",
    weight: 400,
    file: "BebasNeue-Regular.ttf",
    assName: "Bebas Neue",
  },
];

export function cssWeightFor(
  weight: CaptionFontWeight | undefined,
): CaptionCssWeight {
  switch (weight) {
    case "black":
      return 900;
    case "extra-bold":
      return 800;
    case "bold":
      return 700;
    default:
      return 400;
  }
}

/** First family of a CSS font-family list, without quotes, lower-cased. */
function firstFamily(fontFamily: string | undefined): string {
  return (fontFamily ?? "")
    .split(",")[0]
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
}

/** The bundled font file for (fontFamily, fontWeight), or undefined if it is not a bundled font. */
export function resolveCaptionFontFile(
  fontFamily: string | undefined,
  fontWeight: CaptionFontWeight | undefined,
): CaptionFontFile | undefined {
  const family = firstFamily(fontFamily);
  const weight = cssWeightFor(fontWeight);
  return CAPTION_FONT_FILES.find(
    (font) => font.family.toLowerCase() === family && font.weight === weight,
  );
}
