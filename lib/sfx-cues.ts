import fs from 'fs';
import path from 'path';
import type { ClipVisualOverlay, OverlayStylePreset } from './types';

 type SfxAssetId = 'whoosh' | 'pop' | 'click' | 'typewriter-tick' | 'ding';

 type OverlaySfxChoice = 'default' | 'none' | SfxAssetId;

 type SfxCueSource =
  | 'hook-entrance'
  | 'hook-typewriter'
  | 'hook-transition'
  | 'cta-entrance'
  | 'visual-in'
  | 'visual-out'
  | 'keyword-pop';

 interface SfxCue {
  /** Timestamp in seconds on the final output timeline (including any prepended hook segment). */
  t: number;
  /** Which built-in sound effect to trigger. */
  sfx: SfxAssetId;
  /** Linear amplitude multiplier (0..1). */
  gain: number;
  /** Diagnostic label for what triggered this cue. */
  source: SfxCueSource;
}

 const DEFAULT_SFX_LEVEL_DB = -14;
 const TYPEWRITER_CHARS_PER_SECOND = 20;
export const TYPEWRITER_MAX_TICKS = 14;
 const TYPEWRITER_MIN_TICK_INTERVAL_SECONDS = 0.095;

export function dbToLinearGain(db: number): number {
  if (!Number.isFinite(db)) return Math.pow(10, DEFAULT_SFX_LEVEL_DB / 20);
  const clampedDb = Math.max(-48, Math.min(0, db));
  return Math.pow(10, clampedDb / 20);
}

function roundTime(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000) / 1000);
}

function roundGain(gain: number): number {
  return Math.max(0.01, Math.min(0.85, Math.round(gain * 10000) / 10000));
}

 interface VisualCueWindowInput {
  id?: string;
  kind?: 'photo-card' | 'keyword-pop' | 'zoom-beat';
  start: number;
  end: number;
  animation?: string;
  sfxChoice?: OverlaySfxChoice;
}

 interface BuildSfxCueSheetOptions {
  /** Main clip duration (`end - start`) in seconds. */
  segmentDuration: number;
  /** Prepended hook intro duration in seconds (`0` when disabled). */
  hookDuration: number;
  /** Dip-to-black transition half-window in seconds (default 0.5). */
  hookTransitionDuration?: number;
  hookText?: string;
  hookAnimationStyle?: OverlayStylePreset['animationStyle'];
  hookSfxChoice?: OverlaySfxChoice;
  ctaDuration: number;
  ctaText?: string;
  ctaAnimationStyle?: OverlayStylePreset['animationStyle'];
  ctaSfxChoice?: OverlaySfxChoice;
  /** Visual windows already mapped to the output timeline. */
  visualWindows?: VisualCueWindowInput[];
  /** Or full ClipVisualOverlay items whose `outputWindows` will be expanded. */
  visualOverlays?: ClipVisualOverlay[];
  /** Master SFX toggle (default true). */
  sfxEnabled?: boolean;
  /** Master SFX level in dB (default -14 dB). */
  sfxVolumeDb?: number;
}

function isSpecificSfx(choice: OverlaySfxChoice | undefined): choice is SfxAssetId {
  return Boolean(choice && choice !== 'default' && choice !== 'none');
}

/**
 * Pure function computing the SFX cue sheet (`[{ t, sfx, gain, source }]`) on the
 * final output timeline (`totalDuration = hookDuration + segmentDuration`).
 */
export function buildSfxCueSheet(options: BuildSfxCueSheetOptions): SfxCue[] {
  if (options.sfxEnabled === false) return [];

  const segmentDuration = Math.max(0.1, options.segmentDuration);
  const hookDuration = Math.max(0, options.hookDuration || 0);
  const totalDuration = hookDuration + segmentDuration;
  const transition =
    hookDuration > 0
      ? Math.max(0, Math.min(options.hookTransitionDuration ?? 0.5, hookDuration / 2))
      : 0;
  const hookVisibleDuration = Math.max(0, hookDuration - transition);
  const transitionStart = hookDuration - transition;
  const transitionEnd = hookDuration + transition;

  const masterGain = dbToLinearGain(options.sfxVolumeDb ?? DEFAULT_SFX_LEVEL_DB);
  const cues: SfxCue[] = [];

  // 1. Hook entrance, typewriter reveal ticks, and hook -> main transition
  const hookText = (options.hookText ?? '').trim();
  const hookChoice = options.hookSfxChoice ?? 'default';
  const hookAnim = options.hookAnimationStyle ?? 'pop';

  if (hookDuration > 0 && hookVisibleDuration > 0.15 && hookText.length > 0 && hookChoice !== 'none') {
    const entranceSfx: SfxAssetId = isSpecificSfx(hookChoice)
      ? hookChoice
      : hookAnim === 'slide-up'
        ? 'whoosh'
        : 'pop';

    cues.push({
      t: roundTime(0.04),
      sfx: entranceSfx,
      gain: roundGain(masterGain * 0.95),
      source: 'hook-entrance',
    });

    if (hookAnim === 'typewriter') {
      const cleanChars = hookText.replace(/\s+/g, '').length;
      // 1 tick per ~2 non-space characters, capped at TYPEWRITER_MAX_TICKS so it never machine-guns
      const rawTicks = Math.max(1, Math.ceil(cleanChars / 2));
      const tickCount = Math.min(TYPEWRITER_MAX_TICKS, rawTicks);
      const typingWindow = Math.max(
        0.2,
        Math.min(hookVisibleDuration - 0.18, hookText.length / TYPEWRITER_CHARS_PER_SECOND)
      );
      const interval = Math.max(
        TYPEWRITER_MIN_TICK_INTERVAL_SECONDS,
        typingWindow / Math.max(1, tickCount)
      );

      for (let i = 0; i < tickCount; i += 1) {
        const tickTime = 0.08 + i * interval;
        if (tickTime >= hookVisibleDuration - 0.08) break;
        cues.push({
          t: roundTime(tickTime),
          sfx: 'typewriter-tick',
          gain: roundGain(masterGain * 0.65),
          source: 'hook-typewriter',
        });
      }
    }
  }

  if (hookDuration > 0 && transition > 0.05 && hookChoice !== 'none') {
    const transitionTime = Math.max(0.1, hookDuration - transition * 0.5);
    cues.push({
      t: roundTime(transitionTime),
      sfx: 'whoosh',
      gain: roundGain(masterGain * 0.9),
      source: 'hook-transition',
    });
  }

  // 2. Visual card in/out & keyword pops on the output timeline
  const windows: VisualCueWindowInput[] = [...(options.visualWindows ?? [])];
  if (options.visualOverlays?.length) {
    for (const overlay of options.visualOverlays) {
      if (overlay.status === 'removed' || overlay.status === 'skipped') continue;
      const overlayKind = overlay.kind ?? 'photo-card';
      for (const win of overlay.outputWindows ?? []) {
        windows.push({
          id: `${overlay.id}_${win.segment}`,
          kind: overlayKind,
          start: win.start,
          end: win.end,
          animation: overlay.animation,
        });
      }
    }
  }

  for (const win of windows) {
    if (win.sfxChoice === 'none') continue;
    if (win.kind === 'zoom-beat') continue;
    if (win.end <= win.start || win.start < 0 || win.start >= totalDuration) continue;
    // Skip cues that land inside the blanked hook->main transition window
    if (
      hookDuration > 0 &&
      transition > 0 &&
      win.start > transitionStart + 0.02 &&
      win.start < transitionEnd - 0.02
    ) {
      continue;
    }

    if (win.kind === 'keyword-pop') {
      const popSfx: SfxAssetId = isSpecificSfx(win.sfxChoice) ? win.sfxChoice : 'pop';
      cues.push({
        t: roundTime(win.start),
        sfx: popSfx,
        gain: roundGain(masterGain * 0.95),
        source: 'keyword-pop',
      });
    } else {
      const inSfx: SfxAssetId = isSpecificSfx(win.sfxChoice)
        ? win.sfxChoice
        : win.animation === 'slide-up'
          ? 'whoosh'
          : 'pop';
      cues.push({
        t: roundTime(win.start),
        sfx: inSfx,
        gain: roundGain(masterGain * 0.9),
        source: 'visual-in',
      });

      const dur = win.end - win.start;
      const outTime = Math.min(totalDuration - 0.08, win.end - 0.18);
      if (dur >= 1.2 && outTime > win.start + 0.4 && outTime < totalDuration - 0.1) {
        cues.push({
          t: roundTime(outTime),
          sfx: 'whoosh',
          gain: roundGain(masterGain * 0.55),
          source: 'visual-out',
        });
      }
    }
  }

  // 3. CTA entrance on the output timeline (accounts for duplicated hookDuration)
  const ctaDuration = Math.max(0, options.ctaDuration || 0);
  const ctaText = (options.ctaText ?? '').trim();
  const ctaChoice = options.ctaSfxChoice ?? 'default';
  const ctaAnim = options.ctaAnimationStyle ?? 'pop';

  if (ctaDuration > 0 && ctaText.length > 0 && ctaChoice !== 'none') {
    const ctaStart = Math.max(hookDuration, totalDuration - ctaDuration);
    if (ctaStart < totalDuration - 0.05) {
      const ctaSfx: SfxAssetId = isSpecificSfx(ctaChoice)
        ? ctaChoice
        : ctaAnim === 'slide-up'
          ? 'whoosh'
          : 'click';
      cues.push({
        t: roundTime(ctaStart),
        sfx: ctaSfx,
        gain: roundGain(masterGain * 0.95),
        source: 'cta-entrance',
      });
    }
  }

  // Sort chronologically and de-collide identical SFX triggered within 35ms of each other
  cues.sort((a, b) => a.t - b.t || a.sfx.localeCompare(b.sfx));
  const deduped: SfxCue[] = [];
  for (const cue of cues) {
    const prevSame = [...deduped].reverse().find((c) => c.sfx === cue.sfx);
    if (prevSame && Math.abs(cue.t - prevSame.t) < 0.035) {
      prevSame.gain = Math.max(prevSame.gain, cue.gain);
      continue;
    }
    deduped.push(cue);
  }

  return deduped;
}

export function resolveSfxFilePath(sfx: SfxAssetId, customDir?: string): string {
  const dir = customDir
    ? path.resolve(customDir)
    : path.resolve(process.cwd(), 'public', 'sfx');
  return path.join(dir, `${sfx}.wav`);
}

export function filterPlayableSfxCues(
  cues: SfxCue[],
  customDir?: string
): Array<SfxCue & { filePath: string }> {
  const playable: Array<SfxCue & { filePath: string }> = [];
  for (const cue of cues) {
    const filePath = resolveSfxFilePath(cue.sfx, customDir);
    if (fs.existsSync(filePath)) {
      playable.push({ ...cue, filePath });
    }
  }
  return playable;
}
