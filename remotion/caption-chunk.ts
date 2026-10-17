import type { WordTimestamp } from '../lib/types';

export interface CaptionChunk {
  id: string;
  words: WordTimestamp[];
  /** Seconds, on the FINAL clip timeline (already shifted by hookDuration). */
  start: number;
  /** Seconds, on the FINAL clip timeline. */
  end: number;
}

