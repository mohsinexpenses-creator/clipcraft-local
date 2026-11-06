/**
 * Sound effects for B-roll: a soft whoosh as an image arrives and a short pop as
 * it leaves. Pure cue/filter maths so the timing is unit-tested; the files are
 * bundled under `public/sfx/` (see the README there - they are synthesised for
 * this project and released CC0, not downloaded from a stock library).
 *
 * Mixing rules that matter:
 *  - the voice track is NEVER attenuated: `amix` runs with `normalize=0`, so the
 *    speaker keeps the level the profanity/caption pipeline produced;
 *  - the beep windows inserted for profanity are already in the audio graph
 *    before the mix, so the two coexist;
 *  - a cue too close to the previous one is dropped, which is what stops a
 *    machine-gun of whooshes when two images are 3 s apart;
 *  - nothing is scheduled outside the rendered timeline.
 */

export const BROLL_SFX_VOLUME = 0.28;
export const BROLL_SFX_EXIT_VOLUME = 0.18;
/** Minimum spacing between two cues (s). */
export const BROLL_SFX_MIN_SPACING = 0.35;

export const BROLL_SFX_FILES = {
  enter: "pop.wav",
  exit: "pop.wav",
} as const;

export interface BrollSfxCue {
  /** File name inside `public/sfx/`. */
  file: string;
  /** Render-timeline seconds. */
  atSeconds: number;
  /** `in` on the item's first frame, `out` just before its last. */
  kind: "in" | "out";
  volume: number;
}

/**
 * One whoosh per B-roll item and one pop when it goes away, within the clip.
 * The exit cue is pulled 0.12 s earlier so the pop lands on the fade rather than
 * after the image has gone.
 */
export function buildBrollSfxCues(
  items: Array<{ start: number; end: number }>,
  options: { totalDuration: number; enabled: boolean; minSpacing?: number },
): BrollSfxCue[] {
  if (!options.enabled) return [];
  const spacing = options.minSpacing ?? BROLL_SFX_MIN_SPACING;
  const total = Number.isFinite(options.totalDuration)
    ? Math.max(0, options.totalDuration)
    : 0;

  const raw: BrollSfxCue[] = [];
  for (const item of items) {
    if (Number.isFinite(item.start))
      raw.push({
        file: BROLL_SFX_FILES.enter,
        atSeconds: item.start,
        kind: "in",
        volume: BROLL_SFX_VOLUME,
      });
    if (Number.isFinite(item.end))
      raw.push({
        file: BROLL_SFX_FILES.exit,
        atSeconds: item.end - 0.12,
        kind: "out",
        volume: BROLL_SFX_EXIT_VOLUME,
      });
  }

  raw.sort((a, b) => a.atSeconds - b.atSeconds);
  const cues: BrollSfxCue[] = [];
  for (const cue of raw) {
    if (cue.atSeconds < 0 || cue.atSeconds >= total - 0.02) continue;
    const previous = cues[cues.length - 1];
    if (previous && cue.atSeconds - previous.atSeconds < spacing) continue;
    cues.push(cue);
  }
  return cues;
}

export interface SfxMixPlan {
  statements: string[];
  /** Label (with brackets) holding the final mixed audio. */
  label: string;
}

/**
 * Mixes the (already processed) voice label with every sound-effect stream.
 * `normalize=0` is the important part: without it FFmpeg divides every input by
 * the number of streams and the speaker gets quieter whenever B-roll appears.
 */
export function buildSfxMixPlan(input: {
  baseLabel: string;
  sfxInputIndex: number | null;
}): SfxMixPlan {
  if (input.sfxInputIndex === null) {
    return { statements: [], label: input.baseLabel };
  }
  return {
    statements: [
      `[${input.sfxInputIndex}:a]aformat=channel_layouts=stereo[sfx]`,
      `${input.baseLabel}[sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]`,
    ],
    label: "[amixed]",
  };
}
