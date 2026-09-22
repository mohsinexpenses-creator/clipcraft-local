import * as faceapi from 'face-api.js';
import fs from 'fs';
import { Jimp } from 'jimp';
import path from 'path';
import { AppError, toErrorMessage } from '../lib/errors';
import { runFfmpeg } from '../lib/ffmpeg';

let isFaceApiInitialized = false;

async function initFaceApi() {
  if (isFaceApiInitialized) return;

  const modelsDir = path.join(process.cwd(), 'models');
  if (fs.existsSync(path.join(modelsDir, 'tiny_face_detector_model-shard1'))) {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir);
    console.log('[FaceDetector] Loaded TinyFaceDetector models from disk.');
  }

  isFaceApiInitialized = true;
}

export interface CropWindowResult {
  cropW: number;
  cropH: number;
  cropX: number;
  cropY: number;
  cropFilter: string;
}

export async function detectFaceCropWindow(
  videoPath: string,
  start: number,
  duration: number,
  videoWidth: number,
  videoHeight: number
): Promise<CropWindowResult> {
  const targetAspect = 9 / 16;
  let cropH = videoHeight;
  let cropW = Math.floor(cropH * targetAspect);

  if (cropW > videoWidth) {
    cropW = videoWidth;
    cropH = Math.floor(cropW / targetAspect);
  }

  const tempFramesDir = path.join(
    process.cwd(),
    '.tmp',
    `frames_${Date.now()}_${Math.random().toString(36).substring(7)}`
  );

  try {
    fs.mkdirSync(tempFramesDir, { recursive: true });

    const sampleFps = 2;
    const frameArgs = [
      '-y',
      '-ss', start.toString(),
      '-t', duration.toString(),
      '-i', videoPath,
      '-vf', `fps=${sampleFps},scale=640:-1`,
      path.join(tempFramesDir, 'frame_%03d.jpg'),
    ];

    await runFfmpeg(frameArgs);

    const frameFiles = fs.readdirSync(tempFramesDir)
      .filter((file) => file.endsWith('.jpg'))
      .sort();

    if (frameFiles.length === 0) {
      throw new AppError('Smart crop failed because no sample frames were extracted.', {
        resolution: 'Check the selected clip timestamps and verify FFmpeg can decode the source video.',
      });
    }

    await initFaceApi();

    const detectedCenters: number[] = [];

    for (const frameFile of frameFiles) {
      const framePath = path.join(tempFramesDir, frameFile);
      const faceX = await detectFaceCenterInFrame(framePath, videoWidth);
      if (faceX !== null) {
        detectedCenters.push(faceX);
      }
    }

    if (detectedCenters.length === 0) {
      throw new AppError('Smart crop could not find a face-like subject in the selected segment.', {
        resolution:
          'Choose a segment where the speaker is visible on screen, or widen the clip range so a face appears in the sampled frames.',
      });
    }

    const smoothedXs = applyMovingAverage(detectedCenters, 3);
    const avgCenterX = smoothedXs.reduce((sum, value) => sum + value, 0) / smoothedXs.length;

    let cropX = Math.floor(avgCenterX - cropW / 2);
    cropX = Math.max(0, Math.min(videoWidth - cropW, cropX));
    const cropY = Math.max(0, Math.floor((videoHeight - cropH) / 2));

    console.log(
      `[FaceDetector] Calculated smart crop for ${videoWidth}x${videoHeight}: crop=${cropW}:${cropH}:${cropX}:${cropY} (Face Center: ${avgCenterX.toFixed(1)}px)`
    );

    return {
      cropW,
      cropH,
      cropX,
      cropY,
      cropFilter: `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Smart face crop detection failed.', {
      details: toErrorMessage(error),
      resolution:
        'Inspect the selected video segment, confirm FFmpeg extracted frames correctly, and retry rendering.',
    });
  } finally {
    try {
      if (fs.existsSync(tempFramesDir)) {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors.
    }
  }
}

async function detectFaceCenterInFrame(framePath: string, originalWidth: number): Promise<number | null> {
  try {
    const image = await Jimp.read(framePath);
    const width = image.bitmap.width;
    const scaleFactor = originalWidth / width;

    let totalSkinX = 0;
    let skinPixelCount = 0;

    image.scan(0, 0, width, image.bitmap.height, (x, _y, idx) => {
      const r = image.bitmap.data[idx + 0];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];

      const isSkin =
        r > 95 &&
        g > 40 &&
        b > 20 &&
        Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
        Math.abs(r - g) > 15 &&
        r > g &&
        r > b;

      if (isSkin) {
        totalSkinX += x;
        skinPixelCount++;
      }
    });

    if (skinPixelCount > 50) {
      return (totalSkinX / skinPixelCount) * scaleFactor;
    }
  } catch {
    return null;
  }

  return null;
}

function applyMovingAverage(values: number[], windowSize: number): number[] {
  if (values.length === 0) return [];

  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(values.length, i + Math.floor(windowSize / 2) + 1);
    const window = values.slice(start, end);
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    result.push(average);
  }

  return result;
}
