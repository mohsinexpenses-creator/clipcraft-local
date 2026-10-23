import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClipFileName } from '../worker/clip-file-name';

test('clip name includes rank, title, and hashtags without spaces', () => {
  assert.equal(
    buildClipFileName(2, 'A Surprising Story', ['#good news', '#shorts']),
    '2_A Surprising Story_#goodnews#shorts'
  );
});

test('clip name omits absent rank or hashtags and sanitizes unsafe title characters', () => {
  assert.equal(buildClipFileName(undefined, 'A/Title: Here', []), 'A Title Here');
  assert.equal(buildClipFileName(3, 'A Title', undefined), '3_A Title');
});

test('clip name caps the complete filename at 80 characters', () => {
  const name = buildClipFileName(1, 'A'.repeat(100), ['#tag']);
  assert.equal(name.length, 80);
});