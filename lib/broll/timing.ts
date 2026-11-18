import type { BrollItem } from '../types';

/** B-roll plans use base-clip time; the final render prepends the hook replay. */
export function shiftBrollTimeline<T extends Pick<BrollItem, 'start' | 'end'>>(
  items: readonly T[],
  hookDuration: number,
): Array<T & { start: number; end: number }> {
  const offset = Number.isFinite(hookDuration) ? Math.max(0, hookDuration) : 0;
  return items.map((item) => ({
    ...item,
    start: item.start + offset,
    end: item.end + offset,
  }));
}