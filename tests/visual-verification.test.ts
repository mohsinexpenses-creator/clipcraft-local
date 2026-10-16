import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveVerifiedVisualMetadata } from '../lib/clip-edits';
import { visualVerificationHash } from '../lib/visual-providers';
import type { ClipVisualOverlay } from '../lib/types';

test('edits preserve server proof only for unchanged meaning/timing and cannot inject a verified path', () => {
  const original: ClipVisualOverlay = { id: 'beat', quote: 'Solar panels on our roof', visualIntent: 'Rooftop solar panels', searchQueries: ['rooftop solar panels'], category: 'situation', emotionalPolarity: 'neutral', negativeCues: [], sourceStart: 1, sourceEnd: 4, clipRelativeStart: 1, clipRelativeEnd: 4, displayDuration: 3, entityName: '', confidence: 0.9, placement: 'main', framing: 'illustrative', outputWindows: [], animation: 'subtle-zoom', status: 'resolved', localFilePath: '/trusted.fullscreen-v1.jpg', preparedContentHash: 'trusted-bytes', visualVerificationHash: 'trusted-proof' };
  const untrusted = { ...original, localFilePath: '/unreviewed.fullscreen-v1.jpg', visualVerificationHash: 'client-proof' };
  assert.equal(preserveVerifiedVisualMetadata([original], [untrusted])[0].localFilePath, original.localFilePath);
  const changed = preserveVerifiedVisualMetadata([original], [{ ...untrusted, sourceStart: 6, sourceEnd: 9 }])[0];
  assert.equal(changed.status, 'planned'); assert.equal(changed.localFilePath, undefined); assert.equal(changed.visualVerificationHash, undefined);
  assert.equal(preserveVerifiedVisualMetadata([], [untrusted])[0].visualVerificationHash, undefined);
  assert.notEqual(visualVerificationHash(original), visualVerificationHash({ ...original, preparedContentHash: 'different-bytes' }));
});
