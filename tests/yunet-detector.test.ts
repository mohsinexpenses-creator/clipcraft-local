/**
 * YuNet detection pipeline tests with a MOCKED onnxruntime session.
 *
 * Exercises the real blob pre-processing (bilinear resize to the model's
 * STATIC 640x640 input, NCHW RGB planes), the exact OpenCV face_detect.cpp
 * v2 decode math, confidence gating, NMS, frame-space rescaling and clipping -
 * without needing the 232 KB model binary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectFacesYunet, YuNetRuntime } from '../worker/yunet-detector';

type Tensor = { data: Float32Array; dims: number[]; type: string };

function emptyLevel(cells: number): { cls: Float32Array; obj: Float32Array; bbox: Float32Array; kps: Float32Array } {
  return {
    cls: new Float32Array(cells),
    obj: new Float32Array(cells),
    bbox: new Float32Array(cells * 4),
    kps: new Float32Array(cells * 10),
  };
}

/**
 * Build the 12 named outputs for a model-space grid of size x size
 * (the 2023mar ONNX always decodes 640x640 -> 80x80 / 40x40 / 20x20 cells).
 * `detections` sets cells at a given stride: { stride, r, c, cls, obj, dx, dy, w, h, kps? }.
 */
function makeOutputs(
  size: number,
  detections: Array<{
    stride: number;
    r: number;
    c: number;
    cls: number;
    obj: number;
    dx: number;
    dy: number;
    wCells: number;
    hCells: number;
    kps?: number[];
  }>
): Record<string, Tensor> {
  const outputs: Record<string, Tensor> = {};
  for (const stride of [8, 16, 32]) {
    const cols = Math.floor(size / stride);
    const rows = Math.floor(size / stride);
    const level = emptyLevel(rows * cols);
    for (const det of detections.filter((d) => d.stride === stride)) {
      const idx = det.r * cols + det.c;
      level.cls[idx] = det.cls;
      level.obj[idx] = det.obj;
      level.bbox[idx * 4 + 0] = det.dx;
      level.bbox[idx * 4 + 1] = det.dy;
      level.bbox[idx * 4 + 2] = Math.log(det.wCells);
      level.bbox[idx * 4 + 3] = Math.log(det.hCells);
      const kps = det.kps ?? [0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1];
      for (let i = 0; i < 10; i += 1) level.kps[idx * 10 + i] = kps[i];
    }
    outputs[`cls_${stride}`] = { data: level.cls, dims: [1, 1, rows * cols], type: 'float32' };
    outputs[`obj_${stride}`] = { data: level.obj, dims: [1, 1, rows * cols], type: 'float32' };
    outputs[`bbox_${stride}`] = { data: level.bbox, dims: [1, 1, rows * cols * 4], type: 'float32' };
    outputs[`kps_${stride}`] = { data: level.kps, dims: [1, 1, rows * cols * 10], type: 'float32' };
  }
  return outputs;
}

function makeRuntime(outputs: Record<string, Tensor>, capture?: (tensor: Tensor) => void): YuNetRuntime {
  return {
    inputName: 'input',
    session: {
      inputNames: ['input'],
      outputNames: Object.keys(outputs),
      run: async (feeds: Record<string, Tensor>) => {
        if (capture) capture(feeds.input);
        return outputs;
      },
    },
  } as unknown as YuNetRuntime;
}

function rgbaFrame(width: number, height: number, fill: (x: number, y: number) => [number, number, number]) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('decodes YuNet v2 outputs into boxes and landmarks (stride-8 cell)', async () => {
  // 640x640 frame -> identity resize, model space == frame space.
  // Face at rows=2, cols=3 of the stride-8 grid (80x80 cells).
  // wCells must be >= 5 (40px): anything smaller is dropped by the min-width
  // filter (tiny boxes are almost never real faces).
  const outputs = makeOutputs(640, [
    { stride: 8, r: 2, c: 3, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 5, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(640, 640, () => [200, 100, 50]));

  assert.equal(faces.length, 1);
  const face = faces[0];
  // cx=(3+0.5)*8=28, cy=(2+0.5)*8=20, w=exp(ln5)*8=40, h=16
  // (float32 storage of the exp/log widths makes these ~1e-8 inexact)
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ~ ${expected}`);
  near(face.box.x, 8);
  near(face.box.y, 12);
  near(face.box.width, 40);
  near(face.box.height, 16);
  near(face.score, 0.9);

  // Landmark 0 with kps offset (0,0): ((0+3)*8, (0+2)*8) = (24, 16)
  near(face.landmarks.points[0].x, 24);
  near(face.landmarks.points[0].y, 16);
  // Landmark 2 (nose) offset (0.5, 0.5): (28, 20)
  near(face.landmarks.points[2].x, 28);
  near(face.landmarks.points[2].y, 20);
});

test('decoded boxes are rescaled from 640x640 model space to the frame space', async () => {
  // 320x320 frame: the model still decodes at 640, so every coordinate is
  // scaled back by 0.5. wCells=6 -> 48px in 640 space (>= the 40px min width),
  // 24px in frame space.
  const outputs = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 6, hCells: 6 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(320, 320, () => [200, 100, 50]));

  assert.equal(faces.length, 1);
  const face = faces[0];
  // model: cx=(40+0.5)*8=324, cy=(20+0.5)*8=164, w=h=48
  // frame: cx=162, cy=82, w=h=24 -> box.x = 162-12 = 150, box.y = 82-12 = 70
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ~ ${expected}`);
  near(face.box.x, 150);
  near(face.box.y, 70);
  near(face.box.width, 24);
  near(face.box.height, 24);
  // Landmark 0 offset (0,0): model (40*8, 20*8) = (320, 160) -> frame (160, 80)
  near(face.landmarks.points[0].x, 160);
  near(face.landmarks.points[0].y, 80);
});

test('pre-processing is NCHW RGB planes (swapRB), no normalization', async () => {
  let captured: Tensor | null = null;
  const outputs = makeOutputs(640, []);
  const runtime = makeRuntime(outputs, (t) => {
    captured = t;
  });

  await detectFacesYunet(
    runtime,
    // 640x640 source -> identity resize keeps pixel values exact.
    rgbaFrame(640, 640, (x, y) => (x === 0 && y === 0 ? [10, 20, 30] : [0, 0, 0]))
  );

  assert.ok(captured);
  const tensor = captured as unknown as Tensor;
  assert.deepEqual(tensor.dims, [1, 3, 640, 640]);
  const plane = 640 * 640;
  // Pixel (0,0) = R10 G20 B30 -> blob[0]=10 (R), blob[plane]=20 (G), blob[2*plane]=30 (B)
  assert.equal(tensor.data[0], 10);
  assert.equal(tensor.data[plane], 20);
  assert.equal(tensor.data[2 * plane], 30);
});

test('confidence gate: score = sqrt(cls*obj) must reach 0.6', async () => {
  // 0.25 * 0.25 -> score 0.25: below threshold, dropped.
  const weak = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.25, obj: 0.25, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(weak), rgbaFrame(640, 640, () => [1, 2, 3]));
  assert.equal(faces.length, 0);
});

test('faces narrower than 40px in 640 model space are dropped (passers-by filter)', async () => {
  // wCells=4 -> 32px in 640 space: high score, but too small to be a real
  // face in this use case (walls, posters, background people).
  const tiny = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.95, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 4, hCells: 4 },
  ]);
  assert.equal((await detectFacesYunet(makeRuntime(tiny), rgbaFrame(640, 640, () => [1, 2, 3]))).length, 0);

  // The same cell at wCells=5 -> 40px exactly is kept.
  const real = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.95, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 5, hCells: 5 },
  ]);
  assert.equal((await detectFacesYunet(makeRuntime(real), rgbaFrame(640, 640, () => [1, 2, 3]))).length, 1);

  // On a 320px frame the same 40px model-space box is 20px wide in frame
  // space - the filter measures model space, so it is kept.
  const small = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.95, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 5, hCells: 5 },
  ]);
  assert.equal((await detectFacesYunet(makeRuntime(small), rgbaFrame(320, 320, () => [1, 2, 3]))).length, 1);
});

test('greedy NMS keeps the stronger face of an overlapping pair', async () => {
  // Two 48px faces in neighbouring stride-8 cells overlap heavily (width is
  // >= 40px in 640 space so both survive the min-width filter and reach NMS).
  const outputs = makeOutputs(640, [
    { stride: 8, r: 20, c: 40, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 6, hCells: 6 },
    { stride: 8, r: 20, c: 41, cls: 0.64, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 6, hCells: 6 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(640, 640, () => [1, 2, 3]));
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].score - 0.9) < 1e-5);
});

test('detections centred outside the frame are clipped away', async () => {
  // A cell at the model origin with a strongly negative offset decodes to a
  // centre at (-5.6, -5.6): outside the frame, so it is dropped.
  const outputs = makeOutputs(640, [
    { stride: 8, r: 0, c: 0, cls: 0.81, obj: 1.0, dx: -0.7, dy: -0.7, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(640, 640, () => [1, 2, 3]));
  assert.equal(faces.length, 0);
});

test('multi-level detections are unioned and sorted by score', async () => {
  const outputs = makeOutputs(640, [
    { stride: 8, r: 20, c: 20, cls: 0.64, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 6, hCells: 6 },
    { stride: 32, r: 1, c: 1, cls: 1.0, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(640, 640, () => [1, 2, 3]));
  assert.equal(faces.length, 2);
  assert.ok(faces[0].score > faces[1].score, 'sorted by score descending');
});
