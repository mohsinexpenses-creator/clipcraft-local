/**
 * YuNet detection pipeline tests with a MOCKED onnxruntime session.
 *
 * Exercises the real blob pre-processing (LETTERBOX into the model's STATIC
 * 640x640 input, NCHW RGB planes), the tiling of wide frames, the exact OpenCV
 * face_detect.cpp v2 decode math, confidence gating, cross-pass NMS, seam
 * handling, frame-space rescaling and clipping - without needing the model
 * binary. One test at the bottom runs the REAL model to pin the tensor contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectFacesYunet,
  loadYuNet,
  planDetectionRegions,
  YuNetRuntime,
} from '../worker/yunet-detector';

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

/**
 * `outputs` may be a function of the call index: a wide frame is scanned in
 * several passes (full frame, then one call per tile - in that order), and the
 * tests need each pass to "see" something different.
 */
function makeRuntime(
  outputs: Record<string, Tensor> | ((call: number) => Record<string, Tensor>),
  capture?: (tensor: Tensor, call: number) => void
): YuNetRuntime {
  let call = -1;
  return {
    inputName: 'input',
    session: {
      inputNames: ['input'],
      outputNames: Object.keys(typeof outputs === 'function' ? outputs(0) : outputs),
      run: async (feeds: Record<string, Tensor>) => {
        call += 1;
        if (capture) capture(feeds.input, call);
        return typeof outputs === 'function' ? outputs(call) : outputs;
      },
    },
  } as unknown as YuNetRuntime;
}

/** A detection at a MODEL-space (640x640) centre/size, expressed as a feature-map cell. */
function faceAt(opts: { stride?: 8 | 16 | 32; cx: number; cy: number; w: number; h?: number; score?: number }) {
  const stride = opts.stride ?? 8;
  const col = Math.floor(opts.cx / stride);
  const row = Math.floor(opts.cy / stride);
  return {
    stride,
    r: row,
    c: col,
    cls: (opts.score ?? 0.9) ** 2, // score = sqrt(cls * obj), obj = 1
    obj: 1.0,
    dx: opts.cx / stride - col,
    dy: opts.cy / stride - row,
    wCells: opts.w / stride,
    hCells: (opts.h ?? opts.w) / stride,
  };
}

const NO_FACES = () => makeOutputs(640, []);

function blankFrame(width: number, height: number) {
  return { data: Buffer.alloc(width * height * 4), width, height };
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

test('regression: hosts that are only ~34px wide in a 640px sample are KEPT (the old 40px filter deleted them)', async () => {
  // The reported failure: two hosts in a 1080p wide shot are ~34-36px wide in
  // the 640px sample. A fixed `>= 40px in model space` filter dropped BOTH, the
  // tracker saw no people and the split screen collapsed ("frames=2/480").
  const outputs = makeOutputs(640, [
    faceAt({ cx: 200, cy: 150, w: 34, h: 42, score: 0.85 }),
    faceAt({ cx: 420, cy: 150, w: 36, h: 44, score: 0.8 }),
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(640, 640));
  assert.equal(faces.length, 2);
  assert.ok(faces.every((f) => f.box.width >= 33 && f.box.width <= 37));
});

test('specks narrower than ~1.4% of the frame width are dropped (relative to the frame, not a fixed pixel size)', async () => {
  // 1920x1080, tiling off -> the model scale is 1/3. A 24px-wide box (1.25% of
  // the frame) is a speck; a 30px one (1.56%) is a (small) real face.
  const outputs = makeOutputs(640, [
    faceAt({ cx: 100, cy: 100, w: 8, h: 10, score: 0.95 }), // 24px in the frame
    faceAt({ cx: 300, cy: 150, w: 10, h: 13, score: 0.95 }), // 30px in the frame
  ]);
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(1920, 1080), { tiling: 'off' });
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].box.width - 30) < 0.5, `kept the 30px face (got ${faces[0].box.width})`);

  // The floor is configurable and relative: 10% of a 640px frame = 64px.
  const outputs2 = makeOutputs(640, [faceAt({ cx: 300, cy: 300, w: 40, score: 0.95 })]);
  assert.equal((await detectFacesYunet(makeRuntime(outputs2), blankFrame(640, 640))).length, 1);
  assert.equal(
    (await detectFacesYunet(makeRuntime(outputs2), blankFrame(640, 640), { minFaceFraction: 0.1 })).length,
    0
  );
});

test('frames are LETTERBOXED into the 640x640 input - never stretched', async () => {
  // 640x360 frame, one white-ish marker pixel at (100, 50). A letterbox keeps
  // scale 1:1 (marker at row 50) and pads rows 360+ with zeros; the old stretch
  // would have moved the marker to row ~89 and filled all 640 rows with image.
  const frame = rgbaFrame(640, 360, (x, y) => (x === 100 && y === 50 ? [255, 0, 0] : [10, 10, 10]));
  let captured: Tensor | null = null;
  await detectFacesYunet(
    makeRuntime(NO_FACES(), (t) => {
      captured = t;
    }),
    frame,
    { tiling: 'off' }
  );
  const tensor = captured as unknown as Tensor;
  assert.deepEqual(tensor.dims, [1, 3, 640, 640]);
  const R = (x: number, y: number) => tensor.data[y * 640 + x];
  assert.equal(R(100, 50), 255, 'marker stays at its own coordinates (uniform scale)');
  assert.equal(R(5, 359), 10, 'last image row is content');
  assert.equal(R(5, 360), 0, 'padding starts right below the image');
  assert.equal(R(5, 639), 0, 'bottom is zero padding');
});

test('planDetectionRegions: square frames use one pass, wide frames add overlapping square tiles', () => {
  // Square / near-square: a single full-frame pass.
  assert.equal(planDetectionRegions(640, 640).length, 1);
  assert.equal(planDetectionRegions(1000, 800).length, 1, 'aspect 1.25 < 1.4: no tiles');

  // 16:9 -> full frame + 2 tiles of side = frame height, overlapping.
  const wide = planDetectionRegions(1920, 1080);
  assert.equal(wide.length, 3);
  assert.deepEqual(wide.slice(1).map((r) => [r.x, r.y, r.w, r.h]), [
    [0, 0, 1080, 1080],
    [840, 0, 1080, 1080],
  ]);
  assert.deepEqual(wide[1].seams, { left: false, right: true, top: false, bottom: false });
  assert.deepEqual(wide[2].seams, { left: true, right: false, top: false, bottom: false });
  assert.deepEqual(wide[0].seams, { left: false, right: false, top: false, bottom: false });

  // The same geometry on the 960px sample used by the speaker pipeline.
  assert.deepEqual(planDetectionRegions(960, 540).slice(1).map((r) => [r.x, r.w]), [
    [0, 540],
    [420, 540],
  ]);

  // Ultra-wide: more tiles, every neighbour pair overlaps by >= 20% of a tile.
  const ultra = planDetectionRegions(2560, 1080).slice(1);
  assert.equal(ultra.length, 3);
  for (let i = 1; i < ultra.length; i += 1) {
    const overlap = ultra[i - 1].x + ultra[i - 1].w - ultra[i].x;
    assert.ok(overlap >= 0.2 * 1080, `tiles ${i - 1}/${i} overlap by ${overlap}px`);
  }
  assert.equal(ultra[ultra.length - 1].x + ultra[ultra.length - 1].w, 2560, 'tiles reach the right edge');

  // Portrait: vertical tiles.
  const tall = planDetectionRegions(1080, 1920).slice(1);
  assert.deepEqual(tall.map((r) => [r.x, r.y, r.w, r.h]), [
    [0, 0, 1080, 1080],
    [0, 840, 1080, 1080],
  ]);

  // Tiling can be switched off.
  assert.equal(planDetectionRegions(1920, 1080, 'off').length, 1);
});

test('a small face that ONLY a tile can see is found, at the right frame position', async () => {
  // Pass order on 1920x1080: full frame, tile 0 (x=0), tile 1 (x=840); the tile
  // scale is 640/1080. The face sits in tile 1 at model (320, 320), 64px wide:
  //   frame cx = 840 + 320/0.5926 = 1380, cy = 540, width = 64/0.5926 = 108.
  const outputs = (call: number) =>
    call === 2 ? makeOutputs(640, [faceAt({ cx: 320, cy: 320, w: 64, score: 0.9 })]) : NO_FACES();
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(1920, 1080));
  assert.equal(faces.length, 1);
  const cx = faces[0].box.x + faces[0].box.width / 2;
  const cy = faces[0].box.y + faces[0].box.height / 2;
  assert.ok(Math.abs(cx - 1380) < 1, `cx ${cx}`);
  assert.ok(Math.abs(cy - 540) < 1, `cy ${cy}`);
  assert.ok(Math.abs(faces[0].box.width - 108) < 1, `w ${faces[0].box.width}`);
  // Landmarks are mapped through the same tile transform.
  assert.ok(faces[0].landmarks.points.every((p) => p.x > 840), 'landmarks carry the tile offset');
});

test('the same face seen by the full-frame pass AND a tile is reported once, with the best score', async () => {
  // Full pass (scale 1/3): model (460, 180) w=36 -> frame (1380, 540) w=108.
  // Tile 1 (scale 0.5926): model (320, 320) w=64 -> the same place.
  const outputs = (call: number) => {
    if (call === 0) return makeOutputs(640, [faceAt({ cx: 460, cy: 180, w: 36, score: 0.8 })]);
    if (call === 2) return makeOutputs(640, [faceAt({ cx: 320, cy: 320, w: 64, score: 0.95 })]);
    return NO_FACES();
  };
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(1920, 1080));
  assert.equal(faces.length, 1, 'duplicates across passes are merged');
  assert.ok(Math.abs(faces[0].score - 0.95) < 1e-4, `kept the stronger detection (${faces[0].score})`);
});

test('a face cut in half by an INNER tile seam is discarded; the neighbouring tile keeps it whole', async () => {
  // Frame centre x = 1046. Tile 0 ends at x=1080, so tile 0 only sees the left
  // part of the face (its box touches the seam) - that partial box must go.
  // Tile 1 starts at 840 and sees the whole face.
  const outputs = (call: number) => {
    if (call === 1) return makeOutputs(640, [faceAt({ cx: 620, cy: 300, w: 80, score: 0.93 })]); // cut by the seam
    if (call === 2) return makeOutputs(640, [faceAt({ cx: 122.2, cy: 300, w: 80, score: 0.9 })]); // whole
    return NO_FACES();
  };
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(1920, 1080));
  assert.equal(faces.length, 1);
  const cx = faces[0].box.x + faces[0].box.width / 2;
  assert.ok(Math.abs(cx - 1046) < 2, `kept the whole face from tile 1 (cx ${cx})`);
  assert.ok(Math.abs(faces[0].score - 0.9) < 1e-4, 'the partial (higher-scored) box did not win');
});

test('a face touching the FRAME edge (not a seam) is never treated as cut', async () => {
  // Tile 0's LEFT side is the frame edge, not a seam: a host at the far left
  // must still be detected.
  const outputs = (call: number) =>
    call === 1 ? makeOutputs(640, [faceAt({ cx: 60, cy: 300, w: 80, score: 0.9 })]) : NO_FACES();
  const faces = await detectFacesYunet(makeRuntime(outputs), blankFrame(1920, 1080));
  assert.equal(faces.length, 1);
});

test('REAL YuNet model: every frame shape (16:9, ultra-wide, portrait, tiny) runs through the 640x640 contract', async (t) => {
  // The mocked tests cannot catch a wrong tensor shape - onnxruntime rejects
  // anything but 640x640 ("Got invalid dimensions for input"). Run the real
  // model on blank frames: it must not throw and must find no face in a flat image.
  const runtime = await loadYuNet();
  if (!runtime) {
    t.skip('YuNet model / onnxruntime-node not available (run `npm run setup:yunet`)');
    return;
  }
  const flat = (w: number, h: number) => ({ data: Buffer.alloc(w * h * 4, 128), width: w, height: h });
  for (const [w, h] of [[960, 540], [1280, 720], [2560, 1080], [540, 960], [320, 180], [640, 640]]) {
    const faces = await detectFacesYunet(runtime, flat(w, h));
    assert.equal(faces.length, 0, `${w}x${h}: no faces in a flat grey frame`);
  }
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
