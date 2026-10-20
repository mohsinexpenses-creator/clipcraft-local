export type BrollSubjectKind =
  | 'person'
  | 'landmark'
  | 'place'
  | 'event'
  | 'organization'
  | 'object';

/**
 * Validated image candidate discovered from the public Wikimedia Commons API.
 */
export interface BrollSearchCandidate {
  /** Normalized source URL used as primary deduplication key. */
  normalizedUrl: string;
  /** Usable HTTPS image URL (pre-scaled Wikimedia thumbnail when gigantic original, else original). */
  sourceUrl: string;
  /** Original full-resolution image URL reported by Wikimedia Commons. */
  originalUrl: string;
  /** Public Wikimedia Commons description page URL, when provided. */
  pageUrl?: string;
  /** Clean file title (without `File:` prefix or file extension). */
  title: string;
  /** Canonical file stem for cross-resolution thumbnail deduplication. */
  canonicalStem: string;
  /** Verified raster MIME type (`image/jpeg`, `image/png`, `image/webp`). */
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Original image pixel dimensions from Wikimedia metadata. */
  width: number;
  height: number;
  /** Reported original byte size, when available. */
  byteSize?: number;
  /** Upstream SHA-1 digest reported by MediaWiki, when available. */
  sha1?: string;
  /** Author / artist / credit attribution text (HTML stripped). */
  attribution?: string;
  /** Human-readable license name (e.g. `CC BY-SA 4.0`, `Public domain`). */
  license?: string;
  /** Short textual description from Commons metadata (HTML stripped). */
  description?: string;
  /** Computed relevance + photographic quality score for the query. */
  relevanceScore: number;
}

/**
 * Metadata persisted in SQLite (`broll_assets` table). Binary image files are
 * stored strictly on disk under the local B-roll cache directory, never in SQLite.
 */
export interface BrollAssetRecord {
  id: string;
  normalizedUrl: string;
  sourceUrl: string;
  pageUrl?: string;
  title?: string;
  contentHash: string;
  /** Relative filename inside `<brollCacheDir>/images` (e.g. `<sha256>.jpg`). */
  localPath: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Original image dimensions persisted for reuse and diagnostics. */
  width: number;
  height: number;
  fileSize: number;
  /** Normalized horizontal/vertical focal point in [0, 1] for 9:16 framing. */
  focalX: number;
  focalY: number;
  attribution?: string;
  license?: string;
  description?: string;
  searchTerms: string[];
  createdAt: string;
  lastUsedAt: string;
}

/** Resolved on-disk B-roll asset ready for FFmpeg rendering. */
export interface ResolvedBrollAsset extends BrollAssetRecord {
  absolutePath: string;
  cacheHit: boolean;
}

/**
 * Timestamped speech interval inside a clip where a specific visual subject
 * is mentioned in the English transcript.
 */
export interface BrollTranscriptMoment {
  id: string;
  segmentIndex: number;
  /** Segment start/end relative to the clip start (`0 .. segmentDuration`). */
  segmentStart: number;
  segmentEnd: number;
  /** Exact word-level mention window inside the segment (`0 .. segmentDuration`). */
  mentionStart: number;
  mentionEnd: number;
  /** Ranked English queries (most specific first, broader entity fallback second). */
  queries: string[];
  /** Primary extracted phrase / named subject. */
  primarySubject: string;
  subjectKind: BrollSubjectKind;
  /** Full spoken clause text for contextual disambiguation. */
  segmentText: string;
  /** Priority score favoring named people, landmarks, events, places, orgs, then objects. */
  priority: number;
}

/**
 * Scheduled full-screen B-roll image appearance on the final output video timeline.
 */
export interface BrollPlacement {
  assetId: string;
  imagePath: string;
  /** Start/end timestamps in seconds on the FINAL output video timeline. */
  startTime: number;
  endTime: number;
  /** Corresponding clip-relative speech interval (`0 .. segmentDuration`). */
  clipRelativeStart: number;
  clipRelativeEnd: number;
  query: string;
  matchedText: string;
  subjectKind: BrollSubjectKind;
  focalX: number;
  focalY: number;
  width: number;
  height: number;
  attribution?: string;
  license?: string;
  relevanceScore: number;
}
