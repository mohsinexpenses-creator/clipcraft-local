import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveCaptionFontFile } from "../lib/caption-fonts";
import { DEFAULT_CAPTION_PRESETS } from "../lib/presets";
import { splitCaptionWordsIntoLines } from "../lib/caption-layout";
import { CAPTION_THEME_NAMES } from "../lib/types";

test("the built-in caption catalogue only ships the 13 theme presets", () => {
  assert.deepEqual(
    DEFAULT_CAPTION_PRESETS.map((preset) => preset._id),
    [
      "caption-theme-kinetic-01",
      ...CAPTION_THEME_NAMES.filter((theme) => theme !== "kinetic-01").map(
        (theme) => `caption-theme-${theme}`,
      ),
    ],
  );
  assert.equal(DEFAULT_CAPTION_PRESETS.length, 13);
  assert.equal(
    DEFAULT_CAPTION_PRESETS.filter((preset) => preset.captionTheme).length,
    13,
  );
  assert.equal(
    DEFAULT_CAPTION_PRESETS.filter((preset) => preset.isDefault).length,
    1,
  );
  assert.equal(
    DEFAULT_CAPTION_PRESETS.find((preset) => preset.isDefault)?._id,
    "caption-theme-kinetic-01",
  );
  assert.equal(DEFAULT_CAPTION_PRESETS[0].positionY, 28);
});

test("every font used by every preset line is a bundled font whose file exists in public/fonts", () => {
  for (const preset of DEFAULT_CAPTION_PRESETS) {
    assert.ok(
      preset.lineStyles?.length,
      `${preset._id} must define lineStyles`,
    );
    for (const line of preset.lineStyles ?? []) {
      const font = resolveCaptionFontFile(line.fontFamily, line.fontWeight);
      assert.ok(
        font,
        `${preset._id}: ${line.fontFamily} / ${line.fontWeight} is not a bundled font`,
      );
      assert.ok(
        fs.existsSync(path.join(process.cwd(), "public", "fonts", font.file)),
        `${preset._id}: public/fonts/${font.file} is missing`,
      );
    }
  }
});

test("each theme preset uses the default three-word line capacity unless it has a specific override", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({
    word: `w${i}`,
    start: i,
    end: i + 0.5,
  }));
  const firstLineWords = (id: string) =>
    splitCaptionWordsIntoLines(
      words,
      DEFAULT_CAPTION_PRESETS.find((preset) => preset._id === id)!,
    )[0].words.length;

  assert.equal(firstLineWords("caption-theme-kinetic-01"), 3);
  assert.equal(firstLineWords("caption-theme-kinetic-02"), 3);
  assert.equal(firstLineWords("caption-theme-podcast"), 3);
  assert.equal(firstLineWords("caption-theme-simple-one-word"), 3);
});
