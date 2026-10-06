import type { ClipRecord } from './types';

/**
 * Dashboard order of the clips: the newest detection run first and, inside one
 * run, the best rank first (rank 1 = the AI's most viral pick).
 *
 * The detect route stamps every clip of a run with the same `createdAt`, so
 * "same createdAt" identifies a run. Clips without a rank (created before ranks
 * existed) tie with each other and keep the order the API returned them in
 * (newest first), so existing dashboards look exactly as before.
 */
export function sortClipsForDisplay<T extends Pick<ClipRecord, 'createdAt' | 'rank'>>(clips: readonly T[]): T[] {
  return [...clips].sort((a, b) => {
    const createdA = a.createdAt ?? '';
    const createdB = b.createdAt ?? '';
    if (createdA !== createdB) return createdA < createdB ? 1 : -1;

    const rankA = a.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.rank ?? Number.POSITIVE_INFINITY;
    if (rankA === rankB) return 0;
    return rankA < rankB ? -1 : 1;
  });
}
