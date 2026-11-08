import assert from "node:assert/strict";
import test from "node:test";
import { buildOverlayConcatManifest } from "../worker/overlay-concat";

test("overlay concat manifest preserves sparse ranges with transparent gaps", () => {
  const manifest = buildOverlayConcatManifest(
    [
      {
        name: "b-roll one",
        startAtSeconds: 0.2,
        framePaths: ["/tmp/one/frame_00001.png", "/tmp/one/frame_00002.png"],
      },
      {
        name: "b-roll two",
        startAtSeconds: 0.4,
        framePaths: ["/tmp/two/frame_00001.png"],
      },
      {
        name: "b-roll three",
        startAtSeconds: 0.8,
        framePaths: ["/tmp/three/frame_00001.png"],
      },
    ],
    "/tmp/transparent.png",
    10,
  );

  assert.equal(
    manifest,
    [
      "ffconcat version 1.0",
      // Keep one transparent entry per target frame. This deliberately works
      // with FFmpeg builds where -r makes an image input ignore long durations.
      "file '/tmp/transparent.png'",
      "duration 0.100000000",
      "file '/tmp/transparent.png'",
      "duration 0.100000000",
      "file '/tmp/one/frame_00001.png'",
      "duration 0.100000000",
      "file '/tmp/one/frame_00002.png'",
      "duration 0.100000000",
      "file '/tmp/two/frame_00001.png'",
      "duration 0.100000000",
      "file '/tmp/transparent.png'",
      "duration 0.100000000",
      "file '/tmp/transparent.png'",
      "duration 0.100000000",
      "file '/tmp/transparent.png'",
      "duration 0.100000000",
      "file '/tmp/three/frame_00001.png'",
      "duration 0.100000000",
      // The tail is transparent, not a duplicate final B-roll frame. That
      // avoids a one-frame timing/animation overrun at the layer's end.
      "file '/tmp/transparent.png'",
      "",
    ].join("\n"),
  );
});

test("overlay concat refuses overlaps and malformed sources so callers can use direct compositing", () => {
  assert.equal(
    buildOverlayConcatManifest(
      [
        { name: "first", startAtSeconds: 0, framePaths: ["/tmp/first.png", "/tmp/second.png"] },
        { name: "overlap", startAtSeconds: 0.1, framePaths: ["/tmp/overlap.png"] },
      ],
      "/tmp/transparent.png",
      10,
    ),
    null,
  );
  assert.equal(
    buildOverlayConcatManifest(
      [
        { name: "only", startAtSeconds: 0, framePaths: ["/tmp/only.png"] },
      ],
      "/tmp/transparent.png",
      10,
    ),
    null,
  );
  assert.equal(
    buildOverlayConcatManifest(
      [
        { name: "first", startAtSeconds: 0, framePaths: ["/tmp/first.png"] },
        { name: "empty", startAtSeconds: 1, framePaths: [] },
      ],
      "/tmp/transparent.png",
      10,
    ),
    null,
  );
  assert.equal(
    buildOverlayConcatManifest(
      [
        { name: "first", startAtSeconds: 0, framePaths: ["/tmp/first.png"] },
        { name: "off-grid", startAtSeconds: 0.15, framePaths: ["/tmp/off-grid.png"] },
      ],
      "/tmp/transparent.png",
      10,
    ),
    null,
  );
});

test("overlay concat escapes quote-containing paths for ffconcat", () => {
  const manifest = buildOverlayConcatManifest(
    [
      { name: "first", startAtSeconds: 0, framePaths: ["/tmp/it's-one.png"] },
      { name: "second", startAtSeconds: 1, framePaths: ["/tmp/second.png"] },
    ],
    "/tmp/it's-transparent.png",
    1,
  );
  assert.match(manifest ?? "", /file '\/tmp\/it'\\''s-one\.png'/);
  assert.match(manifest ?? "", /file '\/tmp\/it'\\''s-transparent\.png'/);
});
