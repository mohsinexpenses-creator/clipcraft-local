import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deepgramAudioContentType,
  deepgramAudioFormatForPath,
  deepgramRequestFailureResolution,
  getDeepgramAudioFormat,
  isDeepgramSlowUpload,
} from '../lib/deepgram';
import { transcriptionAudioCodecArgs } from '../lib/ffmpeg';

test('Deepgram uses compact MP3 by default and keeps explicit lossless/legacy fallbacks', () => {
  assert.equal(getDeepgramAudioFormat({}), 'mp3');
  assert.equal(getDeepgramAudioFormat({ DEEPGRAM_AUDIO_FORMAT: ' FLAC ' }), 'flac');
  assert.equal(getDeepgramAudioFormat({ DEEPGRAM_AUDIO_FORMAT: 'wav' }), 'wav');
  assert.equal(getDeepgramAudioFormat({ DEEPGRAM_AUDIO_FORMAT: 'not-a-format' }), 'mp3');

  assert.deepEqual(transcriptionAudioCodecArgs('mp3'), ['-acodec', 'libmp3lame', '-b:a', '32k']);
  assert.deepEqual(transcriptionAudioCodecArgs('flac'), ['-acodec', 'flac', '-compression_level', '8']);
  assert.deepEqual(transcriptionAudioCodecArgs('wav'), ['-acodec', 'pcm_s16le']);
});

test('Deepgram content type follows the generated file rather than a stale WAV assumption', () => {
  assert.equal(deepgramAudioFormatForPath('/tmp/audio_16k.mp3', 'wav'), 'mp3');
  assert.equal(deepgramAudioFormatForPath('/tmp/audio_16k.flac', 'mp3'), 'flac');
  assert.equal(deepgramAudioFormatForPath('/tmp/audio_16k.wav', 'mp3'), 'wav');
  assert.equal(deepgramAudioContentType('mp3'), 'audio/mpeg');
  assert.equal(deepgramAudioContentType('flac'), 'audio/flac');
  assert.equal(deepgramAudioContentType('wav'), 'audio/wav');
});

test('Deepgram SLOW_UPLOAD explains the transport problem without blaming a valid key', () => {
  const details = '{"err_code":"SLOW_UPLOAD","err_msg":"Request upload timeout."}';
  assert.equal(isDeepgramSlowUpload(408, details), true);
  assert.equal(isDeepgramSlowUpload(401, details), false);
  assert.match(deepgramRequestFailureResolution(408, details), /not an API-key failure/i);
  assert.match(deepgramRequestFailureResolution(408, details), /DEEPGRAM_AUDIO_FORMAT=wav/);
});
