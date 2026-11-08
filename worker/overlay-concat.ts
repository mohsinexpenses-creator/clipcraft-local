import path from "path";

/**
 * One already-rendered transparent sequence that can be joined into a single
 * FFmpeg concat-demuxer input. `framePaths` must be ordered and every frame is
 * displayed for exactly one target-fps period.
 */
export interface OverlayConcatSource {
  name: string;
  startAtSeconds: number;
  framePaths: string[];
}

function concatPath(filePath: string): string {
  // ffconcat accepts POSIX-style absolute paths on all supported worker hosts.
  // Its single-quote escape syntax mirrors the shell form accepted by FFmpeg.
  const absolute = path.resolve(filePath).replace(/\\/g, "/");
  return absolute.replace(/'/g, "'\\''");
}

function fileLine(filePath: string): string {
  return `file '${concatPath(filePath)}'`;
}

function durationLine(seconds: number): string {
  // ffconcat stores timestamps in microseconds internally; nine decimals keep
  // NTSC frame periods accurate until that final, unavoidable rounding.
  return `duration ${Math.max(0, seconds).toFixed(9)}`;
}

/**
 * Build an ffconcat manifest for non-overlapping sparse transparent sequences.
 *
 * Blank frames occupy gaps so one compact image stream preserves each sequence's
 * final-timeline start. A trailing blank (rather than a duplicated final artwork
 * frame) gives the last PNG its full frame duration without painting it one
 * frame too long after the intended end.
 *
 * Returns null when an input is malformed or intervals overlap. Callers can then
 * keep the proven direct-per-sequence FFmpeg graph as a visual-safe fallback.
 */
export function buildOverlayConcatManifest(
  sources: readonly OverlayConcatSource[],
  blankFramePath: string,
  fps: number,
): string | null {
  if (sources.length < 2 || !Number.isFinite(fps) || fps <= 0) return null;
  if (!blankFramePath) return null;

  const frameDuration = 1 / fps;
  const epsilon = Math.min(0.0001, frameDuration / 100);
  const lines = ["ffconcat version 1.0"];
  let cursorFrame = 0;

  for (const source of sources) {
    if (
      !Number.isFinite(source.startAtSeconds) ||
      source.startAtSeconds < -epsilon ||
      source.framePaths.length === 0 ||
      source.framePaths.some((framePath) => !framePath)
    ) {
      return null;
    }

    const start = Math.max(0, source.startAtSeconds);
    const startFrame = Math.round(start * fps);
    // image2 inputs are inherently frame-timed. Do not quantize a custom
    // fractional start into a different paint time: retain direct compositing.
    if (Math.abs(start - startFrame * frameDuration) > epsilon) return null;
    if (startFrame < cursorFrame) {
      // Interleaved alpha art needs the existing ordered overlay graph; concat
      // is safe only when each layer's sparse ranges never overlap.
      return null;
    }

    // With `-r <fps>` on concat's image decoder, every manifest entry must be
    // one frame. A single blank with a long duration is not portable across
    // FFmpeg versions: older builds decode it as one frame and collapse the gap.
    for (let frame = cursorFrame; frame < startFrame; frame += 1) {
      lines.push(fileLine(blankFramePath), durationLine(frameDuration));
    }

    for (const framePath of source.framePaths) {
      lines.push(fileLine(framePath), durationLine(frameDuration));
    }
    cursorFrame = startFrame + source.framePaths.length;
  }

  // ffconcat determines a file's duration from the following entry. This final
  // transparent frame preserves the last art frame's duration while ensuring
  // the layer is transparent immediately after its scheduled range.
  lines.push(fileLine(blankFramePath));
  return `${lines.join("\n")}\n`;
}
