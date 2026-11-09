import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertLocalFolderBrowserRequest,
  createFolder,
  isLoopbackHostname,
  listFolders,
  normalizeFolderPath,
  validateWritableFolder,
} from "../lib/folder-browser";

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-folder-browser-"));
}

test("folder browser lists directories only and creates one validated child", () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, "existing"));
    fs.writeFileSync(path.join(root, "not-a-folder.txt"), "nope");

    const listed = listFolders(root);
    assert.equal(listed.path, fs.realpathSync(root));
    assert.deepEqual(listed.entries.map((entry) => entry.name), ["existing"]);
    assert.ok(listed.parent);
    assert.ok(listed.roots.includes(path.resolve(process.cwd())));

    const created = createFolder(root, "new frames");
    assert.equal(path.basename(created.path), "new frames");
    assert.equal(fs.statSync(created.path).isDirectory(), true);
    assert.throws(() => createFolder(root, "../escape"), /path separator/);
    assert.throws(() => createFolder(root, "\u0000bad"), /invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder validation normalizes paths and verifies writability before Settings saves", () => {
  const root = fixture();
  try {
    const destination = path.join(root, "nested", "work");
    assert.equal(normalizeFolderPath(`  ${destination}  `), destination);
    assert.equal(validateWritableFolder(destination), fs.realpathSync(destination));
    assert.equal(fs.existsSync(destination), true);
    assert.throws(() => normalizeFolderPath("bad\u0000path"), /control characters/);
    assert.throws(() => normalizeFolderPath(""), /Choose a folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder browser is limited to direct localhost requests", () => {
  for (const hostname of ["localhost", "localhost.", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  assert.equal(isLoopbackHostname("clipcraft.example"), false);

  assert.doesNotThrow(() =>
    assertLocalFolderBrowserRequest(new Request("http://localhost:3000/api/settings/folders", {
      headers: { origin: "http://127.0.0.1:3000" },
    })),
  );
  assert.doesNotThrow(() =>
    assertLocalFolderBrowserRequest(new Request("http://0.0.0.0:3000/api/settings/folders", {
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    })),
    "Next dev's 0.0.0.0 bind target is valid only for a direct localhost Host",
  );
  assert.throws(
    () => assertLocalFolderBrowserRequest(new Request("https://clipcraft.example/api/settings/folders")),
    /only from localhost/,
  );
  assert.throws(
    () =>
      assertLocalFolderBrowserRequest(new Request("http://localhost:3000/api/settings/folders", {
        headers: { origin: "https://clipcraft.example" },
      })),
    /only from localhost/,
  );
});
