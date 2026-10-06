/**
 * Dashboard order of the clips: the newest detection run first and, inside one
 * run, the best rank first (rank 1 = the AI's most viral pick).
 *
 * The detect route stamps every clip of a run with the same `createdAt`, so
 * "same createdAt" identifies a run. Clips without an `aiAnalysis` (created
 * before the new schema) tie with each other and keep the order the API
 * returned them in (newest first).
 */
export function sortClipsForDisplay<T extends { createdAt: string; aiAnalysis?: { rank: number } }>(
  clips: readonly T[]
): T[] {
  return [...clips].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;

    const rankA = a.aiAnalysis?.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.aiAnalysis?.rank ?? Number.POSITIVE_INFINITY;
    if (rankA === rankB) return 0;
    return rankA < rankB ? -1 : 1;
  });
}
