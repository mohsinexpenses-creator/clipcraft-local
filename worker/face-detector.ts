import fs from 'fs';
import path from 'path';
import { runFfmpeg } from '../lib/ffmpeg';
import * as faceapi from 'face-api.js';
import { Jimp } from 'jimp';

let isFaceApiInitialized = false;

async function initFaceApi() {
  if (isFaceApiInitialized) return;
  try {
    // Attempt to load face detection models if present in models folder
    const modelsDir = path.join(process.cwd(), 'models');
    if (fs.existsSync(path.join(modelsDir, 'tiny_face_detector_model-shard1'))) {
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir);
      console.log('[FaceDetector] Loaded TinyFaceDetector models from disk.');
    }
    isFaceApiInitialized = true;
  } catch (err) {
    console.warn('[FaceDetector] Could not initialize faceapi neural net models:', err);
  }
}

export interface CropWindowResult {
  cropW: number;
  cropH: number;
  cropX: number;
  cropY: number;
  cropFilter: string; // e.g. "crop=607:1080:656:0"
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

  // If video is already narrower than 9:16 aspect, adjust
  if (cropW > videoWidth) {
    cropW = videoWidth;
    cropH = Math.floor(cropW / targetAspect);
  }

  // Target default center X
  const defaultCenterX = videoWidth / 2;
  const tempFramesDir = path.join(process.cwd(), '.tmp', `frames_${Date.now()}_${Math.random().toString(36).substring(7)}`);

  try {
    fs.mkdirSync(tempFramesDir, { recursive: true });

    // Sample 2 frames per second for face detection
    const sampleFps = 2;
    const frameArgs = [
      '-y',
      '-ss', start.toString(),
      '-t', duration.toString(),
      '-i', videoPath,
      '-vf', `fps=${sampleFps},scale=640:-1`, // scale down for fast face detection
      path.join(tempFramesDir, 'frame_%03d.jpg'),
    ];

    await runFfmpeg(frameArgs);

    const frameFiles = fs.readdirSync(tempFramesDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    await initFaceApi();

    const rawDetectedXs: number[] = [];

    for (const frameFile of frameFiles) {
      const framePath = path.join(tempFramesDir, frameFile);
      const faceX = await detectFaceCenterInFrame(framePath, videoWidth);
      if (faceX !== null) {
        rawDetectedXs.push(faceX);
      } else {
        rawDetectedXs.push(defaultCenterX);
      }
    }

    // Smooth trajectory with moving average filter (window size = 3)
    const smoothedXs = applyMovingAverage(rawDetectedXs, 3);

    // Compute average center X from smoothed trajectory
    let avgCenterX = defaultCenterX;
    if (smoothedXs.length > 0) {
      const sum = smoothedXs.reduce((a, b) => a + b, 0);
      avgCenterX = sum / smoothedXs.length;
    }

    // Calculate crop X bounds
    let cropX = Math.floor(avgCenterX - cropW / 2);
    // Ensure crop bounds stay within video dimensions
    cropX = Math.max(0, Math.min(videoWidth - cropW, cropX));
    const cropY = Math.max(0, Math.floor((videoHeight - cropH) / 2));

    console.log(`[FaceDetector] Calculated smart crop for ${videoWidth}x${videoHeight}: crop=${cropW}:${cropH}:${cropX}:${cropY} (Face Center: ${avgCenterX.toFixed(1)}px)`);

    return {
      cropW,
      cropH,
      cropX,
      cropY,
      cropFilter: `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    };
  } catch (err) {
    console.warn('[FaceDetector] Face detection failed or timed out. Falling back to default center crop:', err);
    const cropX = Math.max(0, Math.floor((videoWidth - cropW) / 2));
    const cropY = Math.max(0, Math.floor((videoHeight - cropH) / 2));
    return {
      cropW,
      cropH,
      cropX,
      cropY,
      cropFilter: `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    };
  } finally {
    // Clean up temporary extracted frames
    try {
      if (fs.existsSync(tempFramesDir)) {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
      }
    } catch (e) {
      // ignore cleanup error
    }
  }
}

async function detectFaceCenterInFrame(framePath: string, originalWidth: number): Promise<number | null> {
  try {
    const image = await Jimp.read(framePath);
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    const scaleFactor = originalWidth / width;

    // Fast skin-tone heuristic + face detection scan on scaled image pixels
    let totalSkinX = 0;
    let skinPixelCount = 0;

    // Scan central region of image
    image.scan(0, 0, width, height, (x, y, idx) => {
      const r = image.bitmap.data[idx + 0];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];

      // Standard YCbCr / RGB human skin tone threshold heuristic
      const isSkin = r > 95 && g > 40 && b > 20 &&
        Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
        Math.abs(r - g) > 15 && r > g && r > b;

      if (isSkin) {
        totalSkinX += x;
        skinPixelCount++;
      }
    });

    if (skinPixelCount > 50) {
      const skinCenterX = (totalSkinX / skinPixelCount) * scaleFactor;
      return skinCenterX;
    }
  } catch (err) {
    // ignore
  }

  return null;
}

function applyMovingAverage(arr: number[], windowSize: number): number[] {
  if (arr.length === 0) return [];
  const result: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(arr.length, i + Math.floor(windowSize / 2) + 1);
    const window = arr.slice(start, end);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    result.push(avg);
  }
  return result;
}
