import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectVariableFrameRate,
  parseFfprobeJsonOutput,
  parseFrameRate,
  parseVideoMetadataFromFfprobe,
} from '../lib/ffmpeg';
import { getCaptionOffsetMs, shiftCaptionWords } from '../worker/caption-timing';
import {
  buildAudioTimestampReset,
  buildVfrNormalizationFilters,
  computeSeekPhase,
} from '../worker/ffmpeg-pipeline';

const probeFixture = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '24000/1001',
      r_frame_rate: '30000/1001',
      start_time: '0.083000',
      duration: '60.060000',
      bit_rate: '8000000',
      side_data_list: [{ rotation: 0 }],
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
      start_time: '0.000000',
      duration: '60.100000',
      bit_rate: '192000',
    },
  ],
  format: { duration: '60.200000', start_time: '0.000000', bit_rate: '8200000' },
});

test('parse FFprobe rational rates and classify CFR versus VFR with a rounding tolerance', () => {
  assert.ok(Math.abs((parseFrameRate('24000/1001') ?? 0) - 23.976) < 0.001);
  assert.equal(detectVariableFrameRate('30000/1001', '30/1'), false);
  assert.equal(detectVariableFrameRate('24000/1001', '30000/1001'), true);
  assert.equal(detectVariableFrameRate('0/0', '30/1'), null);
});

test('structured FFprobe metadata retains per-stream starts/durations and bitrate', () => {
  const parsed = parseFfprobeJsonOutput(probeFixture);
  const video = parseVideoMetadataFromFfprobe(parsed);
  assert.equal(video.fps, 24000 / 1001);
  assert.equal(video.isVariableFrameRate, true);
  assert.equal(video.videoStartTime, 0.083);
  assert.equal(video.audioStartTime, 0);
  assert.ok(Math.abs((video.audioStartTime ?? 0) - video.videoStartTime + 0.083) < 1e-9);
  assert.equal(video.videoDuration, 60.06);
  assert.equal(video.audioDuration, 60.1);
  assert.equal(video.duration, 60.2);
  assert.equal(video.formatBitRate, 8_200_000);
  assert.equal(video.videoBitRate, 8_000_000);
  assert.equal(video.audioBitRate, 192_000);
});

test('VFR normalization emits an explicit fps filter and timestamp reset', () => {
  assert.deepEqual(buildVfrNormalizationFilters(23.976), [
    'fps=fps=24000/1001:round=near',
    'setpts=PTS-STARTPTS',
  ]);
});

test('accurate seek phase is calculated against the stream start time', () => {
  assert.ok(Math.abs(computeSeekPhase(10.616333, 10.5, 0.083) - 0.033333) < 0.00001);
  assert.equal(computeSeekPhase(10.5, 10.5, 0.083), 0, 'a rebased/early PTS is rejected');
  assert.equal(computeSeekPhase(12, 10.5, 0.083), 0, 'an implausible phase is rejected');
});

test('audio timestamps retain the stream offset and reset each concat segment to zero', () => {
  assert.equal(
    buildAudioTimestampReset(0),
    'asetpts=PTS-STARTPTS,aresample=async=1000:first_pts=0'
  );
  assert.equal(
    buildAudioTimestampReset(0.125),
    'asetpts=PTS-STARTPTS+0.125000/TB,aresample=async=1000:first_pts=0'
  );
  assert.equal(
    buildAudioTimestampReset(-0.05),
    'asetpts=PTS-STARTPTS-0.050000/TB,aresample=async=1000:first_pts=0'
  );
});

test('CAPTION_OFFSET_MS shifts caption words only, with positive = later and safe invalid fallbacks', () => {
  assert.equal(getCaptionOffsetMs({}), 0);
  assert.equal(getCaptionOffsetMs({ CAPTION_OFFSET_MS: '125' }), 125);
  assert.equal(getCaptionOffsetMs({ CAPTION_OFFSET_MS: '-250' }), -250);
  assert.equal(getCaptionOffsetMs({ CAPTION_OFFSET_MS: 'not-a-number' }), 0);
  assert.equal(getCaptionOffsetMs({ CAPTION_OFFSET_MS: '10001' }), 0);

  const words = [{ word: 'hello', start: 1, end: 1.4, confidence: 0.9 }];
  assert.deepEqual(shiftCaptionWords(words, 125), [
    { word: 'hello', start: 1.125, end: 1.525, confidence: 0.9 },
  ]);
  assert.deepEqual(words, [{ word: 'hello', start: 1, end: 1.4, confidence: 0.9 }], 'source transcript remains unchanged');
});
