import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildOverlayFrameCacheKey,
  clearOverlayFrameCache,
  createOverlayFrameCacheStagingDirectory,
  enforceOverlayFrameCacheLimit,
  getOverlayFrameCacheSettings,
  materializeOverlayFrameCache,
  publishOverlayFrameCache,
  readOverlayFrameCache,
  type OverlayFrameCacheDescriptor,
  type OverlayFrameCacheSettings,
} from "../worker/overlay-frame-cache";
import { DEFAULT_CAPTION_PRESETS, DEFAULT_OVERLAY_STYLE_PRESETS } from "../lib/presets";
import {
  buildBrollOverlayFrameCacheKey,
  buildCaptionOverlayFrameCacheKey,
} from "../worker/remotion-renderer";

function temporaryCache(maxBytes = 8 * 1024 * 1024): {
  root: string;
  settings: OverlayFrameCacheSettings;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-overlay-frame-cache-"));
  return {
    root,
    settings: {
      enabled: true,
      directory: path.join(root, "cache"),
      maxBytes,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    },
  };
}

/** Header is enough for the cache's cheap structural PNG guard. */
function pngHeader(width: number, height: number, bytes = 64): Buffer {
  const data = Buffer.alloc(Math.max(26, bytes));
  Buffer.from("89504e470d0a1a0a", "hex").copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  data[24] = 8;
  data[25] = 6;
  return data;
}

function descriptor(key: string, frameCount = 2): OverlayFrameCacheDescriptor {
  return {
    kind: "caption",
    key,
    frameCount,
    canvas: { x: 0, y: 1000, width: 1080, height: 500 },
  };
}

function writeFrames(directory: string, count: number, bytes = 64): void {
  fs.mkdirSync(directory, { recursive: true });
  for (let frame = 1; frame <= count; frame += 1) {
    fs.writeFileSync(
      path.join(directory, `ov_${String(frame).padStart(5, "0")}.png`),
      pngHeader(1080, 500, bytes),
    );
  }
}

function bytesUnder(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    total += entry.isDirectory() ? bytesUnder(candidate) : fs.statSync(candidate).size;
  }
  return total;
}

function publish(settings: OverlayFrameCacheSettings, key: string, bytes = 64) {
  const entry = descriptor(key);
  const staging = createOverlayFrameCacheStagingDirectory(settings, entry.kind, entry.key);
  assert.ok(staging);
  if (!staging) throw new Error("Expected cache staging directory");
  writeFrames(staging, entry.frameCount, bytes);
  const published = publishOverlayFrameCache(settings, entry, staging);
  assert.ok(published);
  if (!published) throw new Error("Expected published entry");
  return { entry, published };
}

test("overlay-frame cache keys are canonical and invalidate every visual input", () => {
  const first = buildOverlayFrameCacheKey({
    composition: "CaptionOverlayComposition",
    words: [{ word: "hello", start: 1, end: 1.2 }],
    canvas: { x: 0, y: 0, width: 1080, height: 1920 },
  });
  const reordered = buildOverlayFrameCacheKey({
    canvas: { height: 1920, width: 1080, y: 0, x: 0 },
    words: [{ end: 1.2, start: 1, word: "hello" }],
    composition: "CaptionOverlayComposition",
  });
  const changedHook = buildOverlayFrameCacheKey({
    composition: "CaptionOverlayComposition",
    words: [{ word: "hello", start: 1, end: 1.2 }],
    hookText: "A different hook",
    canvas: { x: 0, y: 0, width: 1080, height: 1920 },
  });
  const cropped = buildOverlayFrameCacheKey({
    composition: "CaptionOverlayComposition",
    words: [{ word: "hello", start: 1, end: 1.2 }],
    canvas: { x: 0, y: 1000, width: 1080, height: 500 },
  });

  assert.equal(first, reordered, "object insertion order never creates a needless miss");
  assert.notEqual(first, changedHook, "visible hook text invalidates its sequence");
  assert.notEqual(first, cropped, "physical canvas geometry invalidates its sequence");
});

test("published entries validate, materialize into a job workdir, and survive a clear while in use", () => {
  const fixture = temporaryCache();
  try {
    const key = buildOverlayFrameCacheKey({ case: "materialize" });
    const { entry } = publish(fixture.settings, key);
    const hit = readOverlayFrameCache(fixture.settings, entry);
    assert.ok(hit);
    if (!hit) throw new Error("Expected cache hit");

    const workdir = path.join(fixture.root, "job-frames");
    const input = materializeOverlayFrameCache(hit, workdir);
    assert.equal(input, path.join(workdir, "ov_%05d.png"));
    assert.ok(fs.existsSync(path.join(workdir, "ov_00001.png")));

    const cleared = clearOverlayFrameCache(fixture.settings);
    assert.equal(cleared.entries, 1);
    assert.equal(readOverlayFrameCache(fixture.settings, entry), null);
    assert.ok(
      fs.existsSync(path.join(workdir, "ov_00001.png")),
      "a hard-linked/copied active job input remains usable after Settings clears the cache",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("overlay-frame cache bounds settings and prunes least-recently-used complete entries", () => {
  const fixture = temporaryCache(2_000);
  try {
    const one = publish(
      fixture.settings,
      buildOverlayFrameCacheKey({ case: "old" }),
      1_024,
    );
    const two = publish(
      fixture.settings,
      buildOverlayFrameCacheKey({ case: "new" }),
      1_024,
    );
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(two.published.directory, new Date(), new Date());
    fs.utimesSync(one.published.directory, old, old);

    // Keep exactly the newer entry: include its manifest bytes, not only the
    // frame payload reported by the public entry shape.
    fixture.settings.maxBytes = bytesUnder(two.published.directory) + 16;
    enforceOverlayFrameCacheLimit(fixture.settings);
    assert.equal(readOverlayFrameCache(fixture.settings, one.entry), null);
    assert.ok(readOverlayFrameCache(fixture.settings, two.entry));

    const bounded = getOverlayFrameCacheSettings({
      OVERLAY_RENDER_CACHE_DIR: fixture.settings.directory,
      OVERLAY_RENDER_CACHE_ENABLED: "0",
      OVERLAY_RENDER_CACHE_MAX_MB: "99999",
      OVERLAY_RENDER_CACHE_MAX_AGE_DAYS: "999",
    });
    assert.equal(bounded.enabled, false);
    assert.equal(bounded.maxBytes, 8_192 * 1024 * 1024);
    assert.equal(bounded.maxAgeMs, 90 * 24 * 60 * 60 * 1_000);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("hook-only edits invalidate the combined caption sequence but reuse independent B-roll card frames", () => {
  const preset = DEFAULT_CAPTION_PRESETS[0];
  const hookStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((style) => style.kind === "hook");
  const ctaStyle = DEFAULT_OVERLAY_STYLE_PRESETS.find((style) => style.kind === "cta");
  assert.ok(hookStyle);
  assert.ok(ctaStyle);
  if (!hookStyle || !ctaStyle) throw new Error("Expected seeded overlay styles");
  const phase = { startFrame: 0, endFrame: 89, frameCount: 90, startAtSeconds: 0 };
  const canvas = { x: 0, y: 0, width: 1080, height: 1920 };
  const props = {
    hookText: "FIRST HOOK",
    hookDuration: 3,
    hookStart: 0,
    hookTransitionDuration: 0.5,
    ctaText: "FOLLOW",
    ctaDuration: 2.5,
    totalDuration: 63,
    words: [{ word: "hello", start: 3.2, end: 3.5 }],
    preset,
    hookStyle,
    ctaStyle,
    captionLiftScale: 1,
  };
  const captionBefore = buildCaptionOverlayFrameCacheKey({
    props,
    phase,
    fps: 30,
    durationInFrames: 1890,
    canvas,
    customFonts: [],
  });
  const captionAfter = buildCaptionOverlayFrameCacheKey({
    ...{
      props: { ...props, hookText: "REVISED HOOK" },
      phase,
      fps: 30,
      durationInFrames: 1890,
      canvas,
      customFonts: [],
    },
  });
  assert.notEqual(captionBefore, captionAfter, "the changed visible hook cannot reuse stale text frames");

  const card = {
    id: "card-1",
    kind: "landscape" as const,
    start: 12,
    end: 15,
    imageUrl: "http://127.0.0.1:41001/broll-0.jpg",
    cacheIdentity: "prepared-jpeg-hash:1234:999",
    card: { x: 122, y: 1071, width: 836, height: 425 },
  };
  const brollKey = (imageUrl: string) => buildBrollOverlayFrameCacheKey({
    items: [{ ...card, imageUrl }],
    phase: { startFrame: 360, endFrame: 449, frameCount: 90, startAtSeconds: 12 },
    fps: 30,
    totalFrames: 1890,
    canvas: { x: 82, y: 1031, width: 916, height: 537 },
    captionTextColor: "#fff",
    captionBand: { top: 1230, bottom: 1440 },
  });
  assert.equal(
    brollKey("http://127.0.0.1:41001/broll-0.jpg"),
    brollKey("http://127.0.0.1:49999/broll-0.jpg"),
    "a hook-only rerender creates a new loopback server but keeps the immutable card-frame cache hit",
  );
});
