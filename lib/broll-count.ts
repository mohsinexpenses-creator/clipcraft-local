import type { ClipRecord } from './types';

/** Target cadence of ~1 distinct full-screen B-roll image every 7.5s (>= 8 across 60s). */
export const TARGET_SECONDS_PER_BROLL = 7.5;

/**
 * Compute target number of distinct B-roll appearances proportional to clip duration.
 * Pure, dependency-free helper safe in both browser UI components and Node worker code.
 */
export function targetBrollCountForDuration(clipDurationSeconds: number): number {
  const safeDuration = Math.max(0.5, Number.isFinite(clipDurationSeconds) ? clipDurationSeconds : 0.5);
  return Math.max(1, Math.ceil(safeDuration / TARGET_SECONDS_PER_BROLL));
}

export interface ClipBrollSummary {
  enabled: boolean;
  count: number;
  isActualRendered: boolean;
  shortLabel: string;
  label: string;
  tooltip: string;
}

/**
 * Resolve the B-roll image count badge shown on each Clip Card:
 * - Before rendering (`pending` / queued / `processing`): shows how many B-roll images
 *   are planned to be used in the clip (from transcript analysis or proportional target).
 * - After rendering (`done`): shows the exact number of B-roll images actually composited
 *   into the rendered MP4 when recorded on `clip.brollCount`.
 * - When disabled (`enableBroll === false`): clearly shows `B-roll off`.
 */
export function getClipBrollSummary(
  clip: Pick<ClipRecord, 'start' | 'end' | 'enableBroll' | 'brollCount' | 'status'>,
): ClipBrollSummary {
  const enabled = clip.enableBroll !== false;
  if (!enabled) {
    return {
      enabled: false,
      count: 0,
      isActualRendered: clip.status === 'done',
      shortLabel: 'B-roll off',
      label: 'B-roll off',
      tooltip: 'Automatic full-screen B-roll images are disabled for this clip',
    };
  }

  const duration = Math.max(0.5, (clip.end ?? 0) - (clip.start ?? 0));
  const fallbackPlanned = targetBrollCountForDuration(duration);
  const hasRecordedCount = typeof clip.brollCount === 'number' && Number.isFinite(clip.brollCount);
  const count = hasRecordedCount ? Math.max(0, Math.round(clip.brollCount as number)) : fallbackPlanned;
  const unit = count === 1 ? 'image' : 'images';

  if (clip.status === 'done' && hasRecordedCount) {
    return {
      enabled: true,
      count,
      isActualRendered: true,
      shortLabel: `${count} ${unit}`,
      label: `${count} B-roll ${unit}`,
      tooltip:
        count > 0
          ? `${count} full-screen B-roll ${unit} used in this rendered clip`
          : 'No matching B-roll images were found for this clip render',
    };
  }

  return {
    enabled: true,
    count,
    isActualRendered: false,
    shortLabel: `${count} ${unit}`,
    label: `${count} B-roll ${unit}`,
    tooltip: `Up to ${count} full-screen B-roll ${unit} will be used in this ${Math.round(duration)}s clip`,
  };
}
