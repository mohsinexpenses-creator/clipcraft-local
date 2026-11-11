import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jimp } from "jimp";
import type { VideoConfig } from "remotion/no-react";
import { getBrollCardCanvasRegion } from "../lib/overlay-canvas";
import {
  inspectPngSequenceVisibility,
  withBrollPhaseCompositionProps,
  type BrollPhaseInputProps,
} from "../worker/remotion-renderer";

function selectedBrollComposition(): VideoConfig {
  return {
    id: "BrollTimelineComposition",
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 180,
    defaultProps: { items: [] },
    // This is intentionally unlike the phase props below. It models the one
    // all-timeline selectComposition() result that caused cropped cards to
    // render with stale full-canvas props.
    props: {
      items: [{ id: "selected-all-timeline", kind: "fullscreen" }],
      captionTextColor: "#000000",
      captionBand: { top: 1, bottom: 2 },
      renderRegion: undefined,
    },
    defaultCodec: null,
    defaultOutName: null,
    defaultVideoImageFormat: null,
    defaultPixelFormat: null,
    defaultProResProfile: null,
    defaultSampleRate: null,
  };
}

test("each cropped B-roll phase replaces resolved composition props, not only render input props", () => {
  const selected = selectedBrollComposition();
  const region = getBrollCardCanvasRegion({ x: 162, y: 1111, width: 756, height: 425 });
  const phaseProps: BrollPhaseInputProps = {
    items: [
      {
        id: "card-phase-only",
        kind: "landscape",
        start: 2,
        end: 4,
        imageUrl: "http://127.0.0.1:41001/card.jpg",
        card: { x: 162, y: 1111, width: 756, height: 425 },
      },
    ],
    captionTextColor: "#ffffff",
    captionBand: { top: 1230, bottom: 1440 },
    renderRegion: region,
  };

  const phaseComposition = withBrollPhaseCompositionProps(selected, phaseProps);

  assert.deepEqual(
    phaseComposition.props,
    phaseProps,
    "renderFrames serializes composition.props, so all phase-visible props must be replaced together",
  );
  assert.notEqual(phaseComposition.props, phaseProps, "the phase props are copied before Chromium uses them");
  assert.equal(phaseComposition.width, 1080, "metadata remains available for the caller to resize physically");
  assert.deepEqual(
    selected.props,
    {
      items: [{ id: "selected-all-timeline", kind: "fullscreen" }],
      captionTextColor: "#000000",
      captionBand: { top: 1, bottom: 2 },
      renderRegion: undefined,
    },
    "the reusable selectComposition result remains untouched for the next phase",
  );
});

async function writeFrame(
  directory: string,
  frame: number,
  color: number,
): Promise<void> {
  const image = new Jimp({ width: 4, height: 3, color });
  await image.write(
    path.join(directory, `ov_${String(frame).padStart(5, "0")}.png`) as `${string}.png`,
  );
}

test("cropped B-roll safety net distinguishes an all-transparent sequence from an entering visible card", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-cropped-broll-safety-"));
  try {
    const transparent = path.join(root, "transparent");
    const visible = path.join(root, "visible");
    fs.mkdirSync(transparent, { recursive: true });
    fs.mkdirSync(visible, { recursive: true });

    await writeFrame(transparent, 1, 0x00000000);
    await writeFrame(transparent, 2, 0x11223300);
    await writeFrame(visible, 1, 0x00000000);
    await writeFrame(visible, 2, 0x3366ccff);

    assert.deepEqual(await inspectPngSequenceVisibility(transparent), {
      kind: "fully-transparent",
      inspectedFrames: 2,
    });
    assert.deepEqual(await inspectPngSequenceVisibility(visible), {
      kind: "visible",
      inspectedFrames: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cropped B-roll safety net does not call an absent or malformed frame set transparent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-cropped-broll-unreadable-"));
  try {
    const inspection = await inspectPngSequenceVisibility(root);
    assert.equal(inspection.kind, "unreadable");
    assert.equal(inspection.inspectedFrames, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
