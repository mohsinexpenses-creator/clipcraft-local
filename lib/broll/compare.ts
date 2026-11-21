/**
 * Pixel comparison for the native-vs-Remotion B-roll gate.
 *
 * The contract is "identical output", so the gate needs numbers, not eyeballs:
 * SSIM over the card's bounding box and the worst per-channel difference in the
 * whole frame. Both work on straight RGBA buffers (the PNG decode of either
 * renderer), so a failure names the frame and the metric that broke.
 */

export interface ImageBuffer {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Buffer | Uint8Array;
}

export interface CompareResult {
  /** Mean SSIM over the compared region, 0..1. */
  ssim: number;
  /** Largest absolute difference of any R/G/B channel (0..255). */
  maxAbsDiff: number;
  /** Largest absolute difference of the alpha channel (0..255). */
  maxAbsAlphaDiff: number;
  /** Share of pixels whose colour differs by more than `tolerance`. */
  changedFraction: number;
}

export interface CompareOptions {
  /** Restrict the comparison to a box (the card). Defaults to the whole frame. */
  box?: { x: number; y: number; width: number; height: number };
  /** A pixel counts as "changed" above this channel difference. */
  tolerance?: number;
}

const clampBox = (
  box: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } => {
  const x = Math.max(0, Math.min(width, Math.floor(box.x)));
  const y = Math.max(0, Math.min(height, Math.floor(box.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.floor(box.width))),
    height: Math.max(1, Math.min(height - y, Math.floor(box.height))),
  };
};

/**
 * Compare two RGBA buffers of the same size.
 *
 * SSIM uses the standard 8x8-window formulation over luminance, which is what
 * makes a 1/255 rounding difference score ~1.0 and a shifted card score < 0.9.
 */
export function compareImages(a: ImageBuffer, b: ImageBuffer, options: CompareOptions = {}): CompareResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `Cannot compare ${a.width}x${a.height} with ${b.width}x${b.height}.`,
    );
  }
  const tolerance = options.tolerance ?? 2;
  const box = options.box
    ? clampBox(options.box, a.width, a.height)
    : { x: 0, y: 0, width: a.width, height: a.height };

  let maxAbsDiff = 0;
  let maxAbsAlphaDiff = 0;
  let changed = 0;
  let compared = 0;

  const luminance = (data: Buffer | Uint8Array, index: number): number =>
    0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];

  let ssimSum = 0;
  let windows = 0;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const index = (y * a.width + x) * 4;
      const dr = Math.abs(a.data[index] - b.data[index]);
      const dg = Math.abs(a.data[index + 1] - b.data[index + 1]);
      const db = Math.abs(a.data[index + 2] - b.data[index + 2]);
      const da = Math.abs(a.data[index + 3] - b.data[index + 3]);
      const worst = Math.max(dr, dg, db);
      if (worst > maxAbsDiff) maxAbsDiff = worst;
      if (da > maxAbsAlphaDiff) maxAbsAlphaDiff = da;
      if (worst > tolerance) changed += 1;
      compared += 1;
    }
  }

  const windowSize = 8;
  for (let wy = box.y; wy < box.y + box.height; wy += windowSize) {
    for (let wx = box.x; wx < box.x + box.width; wx += windowSize) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      let count = 0;
      for (let y = wy; y < Math.min(wy + windowSize, box.y + box.height); y += 1) {
        for (let x = wx; x < Math.min(wx + windowSize, box.x + box.width); x += 1) {
          const index = (y * a.width + x) * 4;
          const la = luminance(a.data, index);
          const lb = luminance(b.data, index);
          sumA += la;
          sumB += lb;
          sumAA += la * la;
          sumBB += lb * lb;
          sumAB += la * lb;
          count += 1;
        }
      }
      if (count < 2) continue;
      const meanA = sumA / count;
      const meanB = sumB / count;
      const varA = sumAA / count - meanA * meanA;
      const varB = sumBB / count - meanB * meanB;
      const covariance = sumAB / count - meanA * meanB;
      const numerator = (2 * meanA * meanB + C1) * (2 * covariance + C2);
      const denominator = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
      ssimSum += denominator === 0 ? 1 : numerator / denominator;
      windows += 1;
    }
  }

  return {
    ssim: windows === 0 ? 1 : ssimSum / windows,
    maxAbsDiff,
    maxAbsAlphaDiff,
    changedFraction: compared === 0 ? 0 : changed / compared,
  };
}

/** The gate's thresholds, in one place so the script and the tests agree. */
export const NATIVE_GATE = {
  minSsim: 0.995,
  maxAbsDiff: 8,
  maxAbsAlphaDiff: 8,
  maxChangedFraction: 0.02,
} as const;

export function passesNativeGate(result: CompareResult): boolean {
  return (
    result.ssim >= NATIVE_GATE.minSsim &&
    result.maxAbsDiff <= NATIVE_GATE.maxAbsDiff &&
    result.maxAbsAlphaDiff <= NATIVE_GATE.maxAbsAlphaDiff &&
    result.changedFraction <= NATIVE_GATE.maxChangedFraction
  );
}
