import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaUrlForOutputPath } from '../lib/pipeline-ui';

test('media URLs encode output path segments containing URL delimiters', () => {
  assert.equal(
    mediaUrlForOutputPath('/generated-clips/video/1_Story_#shorts.mp4'),
    '/api/media/generated-clips/video/1_Story_%23shorts.mp4'
  );
  assert.equal(mediaUrlForOutputPath(undefined), null);
});
