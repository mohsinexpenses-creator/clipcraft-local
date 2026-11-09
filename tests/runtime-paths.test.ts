import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  saveSettingsSection,
  setSettingsStoreForTests,
} from "../lib/app-settings";
import { getClipsDirValue, getCustomFontsDirValue, getTempDirValue } from "../lib/paths";
import type { AppSettingsSection } from "../lib/types";
import { getUploadDirValue } from "../lib/upload";

test("path settings are reread by worker and media path accessors without a restart", async () => {
  const rows = new Map<AppSettingsSection, Record<string, unknown>>();
  setSettingsStoreForTests({
    read: () => [...rows].map(([key, value]) => ({ key, value })),
    write: (section, value) => {
      if (value === null) rows.delete(section);
      else rows.set(section, value);
      return new Date().toISOString();
    },
  });

  try {
    const uploadDir = path.join(os.tmpdir(), "clipcraft-upload-next-job");
    const clipsDir = path.join(os.tmpdir(), "clipcraft-clips-next-job");
    const tempDir = path.join(os.tmpdir(), "clipcraft-temp-next-job");
    const fontDir = path.join(os.tmpdir(), "clipcraft-fonts-next-job");
    await saveSettingsSection("paths", { uploadDir, clipsDir, tempDir, fontDir });
    assert.equal(getUploadDirValue(), uploadDir);
    assert.equal(getClipsDirValue(), clipsDir);
    assert.equal(getTempDirValue(), tempDir);
    assert.equal(getCustomFontsDirValue(), fontDir);

    const changedTempDir = path.join(os.tmpdir(), "clipcraft-temp-changed-live");
    const changedFontDir = path.join(os.tmpdir(), "clipcraft-fonts-changed-live");
    await saveSettingsSection("paths", { tempDir: changedTempDir, fontDir: changedFontDir });
    assert.equal(getTempDirValue(), changedTempDir);
    assert.equal(getCustomFontsDirValue(), changedFontDir);
  } finally {
    setSettingsStoreForTests(null);
  }
});
