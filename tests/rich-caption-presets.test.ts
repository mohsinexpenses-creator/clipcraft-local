import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveCaptionFontFile } from "../lib/caption-fonts";
import {
  DEFAULT_CAPTION_PRESETS,
  RETIRED_CAPTION_PRESET_IDS,
} from "../lib/presets";
import { splitCaptionWordsIntoLines } from "../lib/caption-layout";

const EXPECTED_IDS = [
  "cc-bold-punch",
  "cc-spotlight",
  "cc-storyteller",
  "cc-authority",
  "cc-composite",
  "cc-minimalist",
  "cc-kinetic",
  "cc-cinematic",
];

test("the built-in caption catalogue is exactly the eight new styles, with one default", () => {
  assert.deepEqual(
    DEFAULT_CAPTION_PRESETS.map((preset) => preset._id),
    EXPECTED_IDS,
  );
  assert.equal(
    DEFAULT_CAPTION_PRESETS.filter((preset) => preset.isDefault).length,
    1,
  );
  assert.equal(
    DEFAULT_CAPTION_PRESETS.find((preset) => preset.isDefault)?._id,
    "cc-bold-punch",
  );
  // tests/overlay-layout.test.ts relies on the first preset sitting at positionY 28.
  assert.equal(DEFAULT_CAPTION_PRESETS[0].positionY, 28);
});

test("no retired preset id is reused by the new catalogue", () => {
  const retired = new Set(RETIRED_CAPTION_PRESET_IDS);
  assert.equal(retired.size, 26);
  assert.ok(
    DEFAULT_CAPTION_PRESETS.every((preset) => !retired.has(preset._id)),
  );
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

test("each style groups words into the line capacities it was designed for", () => {
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
  assert.equal(firstLineWords("cc-bold-punch"), 3);
  assert.equal(firstLineWords("cc-kinetic"), 2);
  assert.equal(firstLineWords("cc-minimalist"), 6);
  assert.equal(firstLineWords("cc-composite"), 2);
});
