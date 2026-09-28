/**
 * YuNet detection pipeline tests with a MOCKED onnxruntime session.
 *
 * Exercises the real blob pre-processing (RGB planes, 32-pad), the exact
 * OpenCV face_detect.cpp v2 decode math, confidence gating, NMS and clipping -
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
 * Build the 12 named outputs for a frame padded to padW x padH.
 * `detections` sets cells at a given stride: { stride, r, c, cls, obj, dx, dy, w, h, kps? }.
 */
function makeOutputs(
  padW: number,
  padH: number,
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
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
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
  // 64x64 frame -> pad 64x64. Face at rows=2, cols=3 of the stride-8 grid.
  const outputs = makeOutputs(64, 64, [
    { stride: 8, r: 2, c: 3, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(64, 64, () => [200, 100, 50]));

  assert.equal(faces.length, 1);
  const face = faces[0];
  // cx=(3+0.5)*8=28, cy=(2+0.5)*8=20, w=exp(ln2)*8=16, h=16
  // (float32 storage of the exp/log widths makes these ~1e-8 inexact)
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ~ ${expected}`);
  near(face.box.x, 20);
  near(face.box.y, 12);
  near(face.box.width, 16);
  near(face.box.height, 16);
  near(face.score, 0.9);

  // Landmark 0 with kps offset (0,0): ((0+3)*8, (0+2)*8) = (24, 16)
  near(face.landmarks.points[0].x, 24);
  near(face.landmarks.points[0].y, 16);
  // Landmark 2 (nose) offset (0.5, 0.5): (28, 20)
  near(face.landmarks.points[2].x, 28);
  near(face.landmarks.points[2].y, 20);
});

test('pre-processing is NCHW RGB planes (swapRB), no normalization', async () => {
  let captured: Tensor | null = null;
  const outputs = makeOutputs(64, 64, []);
  const runtime = makeRuntime(outputs, (t) => {
    captured = t;
  });

  await detectFacesYunet(
    runtime,
    rgbaFrame(64, 64, (x, y) => (x === 0 && y === 0 ? [10, 20, 30] : [0, 0, 0]))
  );

  assert.ok(captured);
  const tensor = captured as unknown as Tensor;
  assert.deepEqual(tensor.dims, [1, 3, 64, 64]);
  const plane = 64 * 64;
  // Pixel (0,0) = R10 G20 B30 -> blob[0]=10 (R), blob[plane]=20 (G), blob[2*plane]=30 (B)
  assert.equal(tensor.data[0], 10);
  assert.equal(tensor.data[plane], 20);
  assert.equal(tensor.data[2 * plane], 30);
});

test('confidence gate: score = sqrt(cls*obj) must reach 0.6', async () => {
  // 0.25 * 0.25 -> score 0.25: below threshold, dropped.
  const weak = makeOutputs(64, 64, [
    { stride: 8, r: 2, c: 3, cls: 0.25, obj: 0.25, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(weak), rgbaFrame(64, 64, () => [1, 2, 3]));
  assert.equal(faces.length, 0);
});

test('greedy NMS keeps the stronger face of an overlapping pair', async () => {
  // Two 32px faces in neighbouring stride-8 cells overlap heavily.
  const outputs = makeOutputs(64, 64, [
    { stride: 8, r: 2, c: 3, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 4, hCells: 4 },
    { stride: 8, r: 2, c: 4, cls: 0.64, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 4, hCells: 4 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(64, 64, () => [1, 2, 3]));
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].score - 0.9) < 1e-5);
});

test('detections centred in the pad area are clipped away', async () => {
  // Frame 40x40 pads to 64x64. A face at cell (7,7) centers at (60,60) - in the pad.
  const outputs = makeOutputs(64, 64, [
    { stride: 8, r: 7, c: 7, cls: 0.81, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(40, 40, () => [1, 2, 3]));
  assert.equal(faces.length, 0);
});

test('multi-level detections are unioned and sorted by score', async () => {
  const outputs = makeOutputs(128, 128, [
    { stride: 8, r: 2, c: 2, cls: 0.64, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 3, hCells: 3 },
    { stride: 32, r: 1, c: 1, cls: 1.0, obj: 1.0, dx: 0.5, dy: 0.5, wCells: 2, hCells: 2 },
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), rgbaFrame(128, 128, () => [1, 2, 3]));
  assert.equal(faces.length, 2);
  assert.ok(faces[0].score > faces[1].score, 'sorted by score descending');
});
