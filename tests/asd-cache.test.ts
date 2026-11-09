import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAsdResultCacheKey,
  enforceAsdCacheLimit,
  getAsdCacheSettings,
  getAsdSourceIdentity,
  readAsdResultCache,
  readAsdSourceProfile,
  writeAsdResultCache,
  writeAsdSourceProfile,
  type AsdCacheSettings,
} from "../worker/asd/cache";
import type { AsdResult } from "../worker/asd";

function temporaryCache(): { root: string; settings: AsdCacheSettings; source: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-asd-cache-test-"));
  const source = path.join(root, "source.mp4");
  fs.writeFileSync(source, "source-v1");
  return {
    root,
    source,
    settings: { enabled: true, directory: path.join(root, "cache"), maxBytes: 1_000_000 },
  };
}

const result: AsdResult = {
  tracks: [],
  speakerSegments: [],
  speakerCount: 0,
  method: "yunet",
  hasLandmarks: false,
  hasAudio: true,
  maxFacesSeen: 0,
  framesUsed: 0,
  framesTotal: 20,
  sampleFps: 4,
  voicedRatio: 0,
};

test("ASD cache key includes immutable source metadata, clip window, and detector profile", () => {
  const fixture = temporaryCache();
  try {
    const source = getAsdSourceIdentity(fixture.source);
    assert.ok(source);
    if (!source) throw new Error("Expected source identity");
    const base = {
      source,
      start: 12,
      duration: 20,
      videoWidth: 1920,
      videoHeight: 1080,
      hasAudio: true,
      adaptive: true,
      initialProfile: "balanced",
      detectionConcurrency: 2,
      skipFullFrameOnWideShots: true,
    };
    assert.notEqual(
      buildAsdResultCacheKey(base),
      buildAsdResultCacheKey({ ...base, start: 12.1 }),
    );
    assert.notEqual(
      buildAsdResultCacheKey(base),
      buildAsdResultCacheKey({ ...base, initialProfile: "legacy-fast" }),
    );

    fs.writeFileSync(fixture.source, "source-v2-with-different-size");
    const changedSource = getAsdSourceIdentity(fixture.source);
    assert.notEqual(changedSource?.key, source.key);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ASD result and source-quality caches are reusable and opt-out safely", () => {
  const fixture = temporaryCache();
  try {
    const source = getAsdSourceIdentity(fixture.source);
    assert.ok(source);
    if (!source) throw new Error("Expected source identity");
    const key = buildAsdResultCacheKey({
      source,
      start: 0,
      duration: 15,
      videoWidth: 1920,
      videoHeight: 1080,
      hasAudio: true,
      adaptive: true,
      initialProfile: "balanced",
      detectionConcurrency: 2,
      skipFullFrameOnWideShots: true,
    });

    assert.equal(writeAsdResultCache(fixture.settings, key, result), true);
    assert.deepEqual(readAsdResultCache(fixture.settings, key), result);
    assert.equal(readAsdSourceProfile(fixture.settings, source), null);
    assert.equal(writeAsdSourceProfile(fixture.settings, source, "quality"), true);
    assert.equal(readAsdSourceProfile(fixture.settings, source), "quality");
    assert.equal(readAsdResultCache({ ...fixture.settings, enabled: false }, key), null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ASD cache settings are bounded and cleanup removes least-recently-used files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-asd-cache-limit-test-"));
  try {
    const settings = getAsdCacheSettings({
      ASD_CACHE_DIR: root,
      ASD_CACHE_MAX_MB: "99999",
      ASD_CACHE_ENABLED: "0",
    });
    assert.equal(settings.enabled, false);
    assert.equal(settings.maxBytes, 4_096 * 1024 * 1024);

    const cleanupSettings: AsdCacheSettings = { enabled: true, directory: root, maxBytes: 150 };
    const oldPath = path.join(root, "old.json");
    const newPath = path.join(root, "new.json");
    fs.writeFileSync(oldPath, "o".repeat(100));
    fs.writeFileSync(newPath, "n".repeat(100));
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(oldPath, old, old);
    enforceAsdCacheLimit(cleanupSettings);
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(newPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
