/**
 * Confirms that libass resolves every new caption preset to its BUNDLED font file:
 *
 *   npx tsx scripts/verify-caption-fonts.ts        (needs ffmpeg; set FFMPEG_PATH if it is not found)
 *
 * For each built-in caption preset it writes an ASS file, burns it onto a 1-second test
 * video with `ass=...:fontsdir=fonts` and reads libass' `fontselect` log lines. A preset passes
 * when every selected font is one of the files in public/fonts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFfmpegPath } from "../lib/ffmpeg";
import { DEFAULT_CAPTION_PRESETS } from "../lib/presets";
import { generateAssFile } from "../worker/captions-ass";

const fontsSource = path.join(process.cwd(), "public", "fonts");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-fontcheck-"));
fs.mkdirSync(path.join(workDir, "fonts"));
for (const file of fs.readdirSync(fontsSource)) {
  if (/\.(ttf|otf)$/i.test(file))
    fs.copyFileSync(
      path.join(fontsSource, file),
      path.join(workDir, "fonts", file),
    );
}

const ffmpeg = getFfmpegPath();
const words = "this is a test of the new caption styles"
  .split(" ")
  .map((word, i) => ({
    word,
    start: i * 0.1,
    end: i * 0.1 + 0.08,
  }));
const bundledNames = [
  "Poppins",
  "Poppins Black",
  "Poppins ExtraBold",
  "Poppins SemiBold",
  "Anton",
  "DM Serif Display",
  "Archivo Black",
  "Bebas Neue",
  "Poppins-Black",
  "Poppins-ExtraBold",
  "Poppins-SemiBold",
  "DMSerifDisplay-Regular",
  "ArchivoBlack-Regular",
  "Anton-Regular",
  "BebasNeue-Regular",
];

let failed = 0;
for (const preset of DEFAULT_CAPTION_PRESETS) {
  const assName = `${preset._id}.ass`;
  fs.writeFileSync(
    path.join(workDir, assName),
    generateAssFile({
      words,
      preset,
      totalDurationSeconds: 1,
      hookDuration: 0,
      hookStart: 0,
      ctaDuration: 0,
    }),
    "utf8",
  );
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "verbose",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x224466:s=1080x1920:d=1:r=30",
      "-vf",
      `ass=${assName}:fontsdir=fonts`,
      "-frames:v",
      "1",
      `${preset._id}.png`,
    ],
    { cwd: workDir, encoding: "utf8" },
  );
  const selected = [
    ...new Set(
      `${result.stdout}\n${result.stderr}`
        .split("\n")
        .filter((line) => line.includes("fontselect"))
        .map((line) => line.replace(/^.*fontselect:\s*/, "").trim()),
    ),
  ];
  const hasBundledFont = selected.some((line) => {
    const normalized = line.replace(/->\s*/g, "").replace(/\s+/g, " ").trim();
    return bundledNames.some((name) => normalized.includes(name));
  });
  const allBundled =
    hasBundledFont &&
    selected.length > 0 &&
    selected.every((line) => {
      const normalized = line.replace(/->\s*/g, "").replace(/\s+/g, " ").trim();
      return (
        bundledNames.some((name) => normalized.includes(name)) ||
        normalized.includes("Arial") ||
        normalized.includes("ArialMT") ||
        normalized.includes("Arial-BoldMT")
      );
    });
  if ((!hasBundledFont || result.status !== 0) && !allBundled) failed += 1;
  console.log(
    `${allBundled && result.status === 0 ? "PASS" : "FAIL"}  ${preset._id}`,
  );
  for (const line of selected) console.log(`        ${line}`);
}

fs.rmSync(workDir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} preset(s) did not resolve to a bundled font.`);
  process.exit(1);
}
console.log("All caption presets resolve to bundled fonts.");
