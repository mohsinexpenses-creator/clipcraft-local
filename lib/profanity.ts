/**
 * On-screen profanity masking for captions and hook/CTA overlays.
 *
 * Captions render whatever the transcript says verbatim, which gets clips
 * demonetized / community-guidelines struck on YouTube, TikTok and Reels. This
 * masks offensive words in the TEXT THAT IS DRAWN ON SCREEN ONLY:
 *
 *   - the stored transcript (SQLite) and the worker log are NEVER touched, so
 *     re-renders with different rules never require a re-transcription,
 *   - the mask keeps the FIRST and LAST character and replaces everything
 *     between with `*`, preserving the original casing of those letters:
 *       "fuck" -> "f**k"   "FUCK" -> "F**K"   "motherfucker" -> "m**********r"
 *
 * Matching is case-insensitive and word-boundary based, so innocent words that
 * merely CONTAIN a profanity ("classic", "pass", "glass", "cocktail",
 * "assemble") are never masked. "ass" only matches standalone "ass"/"asses"
 * ("asshole" is its own entry), never the "ass" inside other words.
 */

/**
 * The masked word list. Edit here to configure which words are masked - this
 * is the single source of truth for the mask. Milder words ("damn", "hell",
 * "crap") are included on purpose: for platform safety they are masked by
 * default, and dropping them from this array is how you turn them off.
 */
export const PROFANITY_WORDS: readonly string[] = [
  'motherfucker',
  'fucking',
  'fucked',
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'asses',
  'ass',
  'bastard',
  'damn',
  'dick',
  'pussy',
  'cock',
  'cunt',
  'whore',
  'slut',
  'nigger',
  'nigga',
  'faggot',
  'crap',
  'piss',
  'tits',
  'boob',
  'hell',
];

/**
 * Precompiled, longest-word-first, case-insensitive, word-boundary matcher.
 * Longest-first keeps "motherfucker" from being shadowed by "fuck", and the
 * `\b` on both sides is what protects "classic"/"pass"/"glass"/"cocktail".
 */
const PROFANITY_RE = new RegExp(
  `\\b(?:${[...PROFANITY_WORDS].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'gi'
);

/**
 * Mask every profane word in `text`, leaving its first and last character and
 * filling the middle with `*`. Non-profanity text (including punctuation and
 * the casing of the surviving letters) is returned unchanged.
 */
export function maskProfanity(text: string): string {
  if (!text) return text;
  return text.replace(PROFANITY_RE, (match) => {
    if (match.length <= 2) return match;
    return match.charAt(0) + '*'.repeat(match.length - 2) + match.charAt(match.length - 1);
  });
}

/** True when the word itself is profane (word-boundary, case-insensitive). */
export function containsProfanity(text: string): boolean {
  if (!text) return false;
  PROFANITY_RE.lastIndex = 0; // the matcher is /g/ - .test() would otherwise be stateful
  return PROFANITY_RE.test(text);
}

/**
 * How the AUDIO of a profane word is treated at render time
 * (PROFANITY_AUDIO_MODE in .env):
 *  - `mute` (default): the word is replaced with silence,
 *  - `beep`:           the word is replaced with a 1 kHz tone,
 *  - `off`:            the audio is untouched (captions are still masked).
 */
export type ProfanityAudioMode = 'mute' | 'beep' | 'off';

export function getProfanityAudioMode(): ProfanityAudioMode {
  const raw = (process.env.PROFANITY_AUDIO_MODE || 'mute').trim().toLowerCase();
  if (raw === 'beep' || raw === 'off') return raw;
  return 'mute';
}

/**
 * The [start, end) windows - on the FINAL clip timeline (hook intro + base) -
 * where a profane word is actually spoken. The transcript word timestamps live
 * on the BASE timeline, so every window is shifted by hookDuration; words that
 * also fall inside the duplicated hook-intro window get a second window at the
 * front of the clip. Overlapping windows are merged.
 */
export function buildProfanityWindows(
  words: { start: number; end: number; word: string }[],
  hookStart: number,
  hookDuration: number,
  baseDuration: number
): [number, number][] {
  if (!words || words.length === 0) return [];
  const hookDur = Math.max(0, hookDuration);
  const hookOffset = Math.max(0, hookStart);
  const windows: [number, number][] = [];

  for (const w of words) {
    if (!containsProfanity(w.word)) continue;
    const ws = Math.max(0, w.start);
    const we = Math.min(baseDuration, w.end);
    if (we <= ws) continue;

    // The word inside the main (base) part of the final clip.
    windows.push([ws + hookDur, we + hookDur]);

    // The same word also plays during the hook intro preview (the clip's own
    // [hookStart, hookStart+hookDur] window duplicated onto 0..hookDur).
    if (hookDur > 0 && we > hookOffset && ws < hookOffset + hookDur) {
      const s0 = Math.max(0, ws - hookOffset);
      const e0 = Math.min(hookDur, we - hookOffset);
      if (e0 > s0) windows.push([s0, e0]);
    }
  }

  windows.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of windows) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export interface ProfanityAudioFilter {
  /**
   * Extra ffmpeg inputs the filter needs (the 1 kHz tone for beep mode).
   * The caller must know the index of the tone input inside the full command.
   */
  extraArgs: string[];
  /** filter_complex segments referencing `[0:a]` (and the tone input). */
  filters: string[];
  /** The resulting audio stream label, e.g. `[pa]`. */
  audioLabel: string;
}

/**
 * Build the FFmpeg filter that applies `mode` to the given final-timeline
 * windows. The clip's own audio is always input 0; in beep mode a full-length
 * 1 kHz sine is expected on input `toneInputIndex` (caller supplies it via
 * `extraArgs`). Returns null when there is nothing to do.
 */
export function buildProfanityAudioFilter(
  windows: [number, number][],
  mode: ProfanityAudioMode,
  totalDurationSeconds: number,
  toneInputIndex: number,
  baseAudioLabel = '0:a'
): ProfanityAudioFilter | null {
  if (mode === 'off' || windows.length === 0) return null;

  const f = (n: number) => n.toFixed(3);
  const muteIn = (w: [number, number]) =>
    `volume=enable='between(t,${f(w[0])},${f(w[1])})':volume=0`;
  // Silence the tone OUTSIDE the window (timeline `enable` passes the signal
  // through untouched when disabled, so a single filter can't do 0/1 by itself).
  // The tail is extended by 100ms: the base-mute frame quantisation lags the
  // window end by up to a few frames, and the extra tone tail (a natural
  // bleep release) bridges that gap so no part of the word can leak through.
  const gateOut = (w: [number, number]) =>
    `volume=0.25,volume=enable='lt(t,${f(w[0])})+gt(t,${f(w[1] + 0.1)})':volume=0`;

  if (mode === 'mute') {
    return {
      extraArgs: [],
      filters: [`[${baseAudioLabel}]${windows.map(muteIn).join(',')}[pa]`],
      audioLabel: '[pa]',
    };
  }

  // beep: mute every window on the base audio, then mix in the 1 kHz tone,
  // which only plays inside the windows (0.25 gain = a clear but not painful
  // bleep; normalize=0 keeps the surrounding audio at its original level).
  const k = windows.length;
  const filters: string[] = [`[${toneInputIndex}:a]asplit=${k}${Array.from({ length: k }, (_, i) => `[s${i}]`).join('')}`];
  for (let i = 0; i < k; i += 1) {
    filters.push(`[s${i}]${gateOut(windows[i])}[g${i}]`);
  }
  filters.push(`[${baseAudioLabel}]${windows.map(muteIn).join(',')}[base]`);
  filters.push(
    `[base]${Array.from({ length: k }, (_, i) => `[g${i}]`).join('')}` +
    `amix=inputs=${k + 1}:normalize=0:dropout_transition=0[pa]`
  );

  return {
    extraArgs: [
      '-f', 'lavfi',
      '-t', f(Math.max(0.1, totalDurationSeconds)),
      '-i', 'sine=frequency=1000:sample_rate=44100',
    ],
    filters,
    audioLabel: '[pa]',
  };
}
