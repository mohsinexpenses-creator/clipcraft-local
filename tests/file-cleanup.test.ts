import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFileCleanup } from '../lib/db';
import {
  outputPathToDiskPath,
  removePathOrDefer,
  resolveInside,
  sweepDeferredFileCleanup,
} from '../lib/file-cleanup';
import { createTemporaryDatabase } from './sqlite-test-helpers';

test('logical generated outputs and configured-root children cannot escape their roots', () => {
  const root = path.join(os.tmpdir(), 'clipcraft-cleanup-root');
  assert.equal(
    outputPathToDiskPath('/generated-clips/video_1/output.mp4', root),
    path.join(root, 'video_1', 'output.mp4'),
  );
  assert.equal(outputPathToDiskPath('/generated-clips/../outside.mp4', root), null);
  assert.equal(outputPathToDiskPath('/uploads/source.mp4', root), null);
  assert.equal(resolveInside(root, '../outside'), null);
  assert.equal(resolveInside(root, '.'), null, 'the configured root itself is never a deletion target');
});

test('successful cleanup removes files and directories recursively', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-cleanup-test-'));
  const target = path.join(directory, 'nested');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'partial.mp4'), 'partial render');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(await removePathOrDefer(target, 'test-output'), true);
  assert.equal(fs.existsSync(target), false);
});

test('a failed removal is persisted and the startup sweep retries it successfully', async (t) => {
  createTemporaryDatabase(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcraft-cleanup-retry-'));
  const target = path.join(directory, 'locked-output.mp4');
  fs.writeFileSync(target, 'partial render');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const fsPromises = fs.promises as typeof fs.promises & {
    rm: typeof fs.promises.rm;
  };
  const originalRemove = fsPromises.rm;
  fsPromises.rm = async (pathToRemove, options) => {
    if (pathToRemove === target) {
      const error = new Error('EPERM: file is temporarily in use') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return originalRemove(pathToRemove, options);
  };

  try {
    assert.equal(await removePathOrDefer(target, 'render-output'), false);
  } finally {
    fsPromises.rm = originalRemove;
  }

  const deferred = await listFileCleanup();
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]?.path, target);
  assert.equal(deferred[0]?.kind, 'render-output');
  assert.equal(deferred[0]?.attempts, 1);
  assert.equal(fs.existsSync(target), true, 'the file remains until a later sweep can remove it');

  assert.deepEqual(await sweepDeferredFileCleanup(), { removed: 1, remaining: 0 });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(await listFileCleanup(), []);
});
