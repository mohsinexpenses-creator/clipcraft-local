export interface WordTimestamp {
  word: string;
  start: number; // in seconds
  end: number;   // in seconds
  confidence?: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: WordTimestamp[];
}

export interface TranscriptData {
  text: string;
  segments: TranscriptSegment[];
  words: WordTimestamp[];
}

export interface VideoRecord {
  _id: string;
  originalName: string;
  /** Sanitised on-disk name inside UPLOAD_DIR (never user-controlled path parts). */
  fileName: string;
  /**
   * Stored file name without extension, e.g. `001_my_recording` - the
   * `NNN_` sequence prefix plus the user's original file name. Names the
   * per-video output folder (`generated-clips/001_my_recording/`). Optional
   * only because pre-convention uploads do not have it.
   */
  fileBase?: string;
  filePath: string;
  duration: number; // in seconds
  width: number;
  height: number;
  fileSize: number;
  status: 'uploaded' | 'transcribing' | 'transcribed' | 'failed';
  transcript?: TranscriptData;
  transcriptionProvider?: 'deepgram' | 'whisper.cpp';
  transcriptionModel?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * User-facing knobs for a viral detection run, collected on the dashboard
 * before the AI is called.
 */
export interface ViralDetectionOptions {
  /** How many clips to return, ranked by viral potential (highest first). */
  clipCount: number;
  /** Hard minimum clip length in seconds (clips shorter than this are dropped). */
  minClipDuration: number;
  /**
   * Hard maximum clip length in seconds (longer clips are trimmed to this).
   * Fixed internally at 90s (clips are packaged 60-90s) and NOT exposed in the
   * UI - users only configure the minimum.
   */
  maxClipDuration: number;
  /** When false, no on-screen hook text is generated or rendered. */
  includeHookText: boolean;
  /** When false, no on-screen CTA card is generated or rendered. */
  includeCta: boolean;
}

export const DEFAULT_VIRAL_OPTIONS: ViralDetectionOptions = {
  clipCount: 10,
  minClipDuration: 60,
  maxClipDuration: 90,
  includeHookText: true,
  includeCta: true,
};

/** Per-dimension engagement scores produced by the viral prompt (each /10). */
export interface ClipScores {
  viral: number;
  retention: number;
  controversy: number;
  shareability: number;
}

export type RetentionStrength = 'Weak' | 'Medium' | 'Strong' | 'Extreme';
export type SafetyRisk = 'Low' | 'Medium' | 'High';

export interface ViralSegment {
  start: number;
  end: number;
  hookText: string;
  reason: string;
  score: number;
  /** Curiosity-driven short-form title from the viral prompt. */
  title?: string;
  /** End-screen call-to-action text. */
  ctaText?: string;
  /** Exact spoken line the prompt picked as the cold-open hook. */
  hookLine?: string;
  /** Transcript timestamps of the hook line (absolute, video-relative seconds). */
  hookLineStart?: number;
  hookLineEnd?: number;
  hashtags?: string[];
  retentionStrength?: RetentionStrength;
  psychologicalTrigger?: string;
  safetyRisk?: SafetyRisk;
  /** Exact risky words / phrases (or "No risky wording detected."). */
  safetyNotes?: string;
  scores?: ClipScores;
}

export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How the 9:16 output frames a multi-person clip.
 * - `speaker-focus`: a single window that smoothly pans to whoever is talking.
 * - `split-screen`: an adaptive 2/3/4-person grid that keeps everyone visible.
 */
export type ClipLayout = 'speaker-focus' | 'split-screen';

/** Visual styling for the hook intro overlay and the end-of-clip CTA overlay. */
export interface OverlayStylePreset {
  _id: string;
  kind: 'hook' | 'cta';
  name: string;
  description?: string;
  fontFamily: string;
  /** Overlay text size in composition pixels (1080x1920 canvas). */
  fontSize: number;
  fontWeight: 'normal' | 'bold' | 'extra-bold' | 'black';
  textColor: string;
  /** Card background behind the text (any CSS color, rgba or gradient). */
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  textTransform: 'uppercase' | 'none';
  /** Vertical position of the card, % from the TOP of the frame. */
  positionY: number;
  animationStyle: 'pop' | 'fade' | 'slide-up' | 'none';
  /** Hook only: small chip shown above the text ("Hook Intro"). */
  showBadge?: boolean;
  badgeText?: string;
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How the caption pass is produced:
 * - `remotion`: every frame rendered through headless Chrome (smoothest spring
 *   animations, but slow on long clips).
 * - `native`: captions burned with FFmpeg (ASS) in a single fast pass; hook/CTA
 *   cards are still designed in Remotion but rendered as tiny transparent
 *   frame sequences.
 */
export type CaptionEngine = 'remotion' | 'native';

export interface FilterPreset {
  id: string;
  name: string;
  description: string;
  ffmpegFilter: string; // e.g. "eq=saturation=1.3:contrast=1.1"
}

export interface CaptionPreset {
  _id: string;
  name: string;
  fontFamily: string;
  fontSize: number; // e.g. 48
  fontWeight: 'normal' | 'bold' | 'extra-bold' | 'black';
  textColor: string; // hex or rgb
  highlightColor: string; // active word highlight hex or rgb
  strokeColor: string; // text outline stroke
  strokeWidth: number; // e.g. 2
  positionY: number; // percentage from bottom, e.g. 25
  animationStyle: 'karaoke' | 'word-pop' | 'fade-in' | 'static';
  uppercase?: boolean;
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptTemplate {
  _id: string;
  type: 'viral_detection' | 'hook_generation' | 'cta_generation';
  name: string;
  description: string;
  systemPrompt: string;
  template: string; // Prompt text containing handlebars/variables like {{transcript}}
  updatedAt: string;
}

/**
 * A reusable on-screen text preset: either an intro HOOK line or an end CTA.
 * Stored in MongoDB (collection "textPresets") and editable in the app - the
 * clip card offers them as quick-fill options next to the hook/CTA inputs.
 */
export interface TextPreset {
  _id: string;
  kind: 'hook' | 'cta';
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClipRecord {
  _id: string;
  videoId: string;
  videoTitle?: string;
  start: number; // start time in original video
  end: number;   // end time in original video
  hookDuration: number; // duration of duplicated hook intro in seconds (e.g. 3)
  hookText: string; // short punchy text overlay during hook intro
  ctaText?: string; // short CTA text shown near the end of the clip
  ctaDuration?: number; // duration of CTA overlay in seconds
  filterPreset: string; // filter preset id
  captionPresetId: string;
  captionPreset?: CaptionPreset;
  /**
   * Output framing mode:
   * - `speaker-focus`: the 9:16 window follows the active speaker.
   * - `split-screen`: everyone relevant is shown in an adaptive grid (2/3/4).
   */
  layout?: ClipLayout;
  /** Caption pass: `remotion` (default, smoothest) or `native` (FFmpeg ASS burn, ~10x faster). */
  captionEngine?: CaptionEngine;
  /** Overlay STYLE presets (font/colors/animation) chosen per clip. */
  hookStylePresetId?: string;
  ctaStylePresetId?: string;
  cropData?: CropWindow;
  viralScore: number;
  viralReason?: string;
  /** Curiosity-driven short-form title suggested by the viral prompt. */
  title?: string;
  /** Exact spoken cold-open line picked by the prompt analysis. */
  hookLine?: string;
  /**
   * Transcript timestamp (absolute, seconds) where the hook line starts /
   * ends. The renderer duplicates exactly this window as the intro hook -
   * no second LLM call is needed to find the gripping moment.
   */
  hookLineStart?: number;
  hookLineEnd?: number;
  hashtags?: string[];
  retentionStrength?: RetentionStrength;
  psychologicalTrigger?: string;
  safetyRisk?: SafetyRisk;
  safetyNotes?: string;
  scores?: ClipScores;
  // relative path to output mp4, e.g. /generated-clips/001_my_recording/<clip title>.mp4
  outputPath?: string;
  outputFileSize?: number; // bytes, 0/undefined means the render did not produce a usable file
  outputFps?: number; // fps actually used for the render
  status: 'pending' | 'processing' | 'done' | 'failed';
  progress?: number; // 0-100
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobData {
  clipId: string;
  videoId: string;
  start: number;
  end: number;
  hookDuration: number;
  hookText?: string;
  ctaText?: string;
  ctaDuration?: number;
  filterPreset: string;
  captionPresetId: string;
  /** Framing mode for the 9:16 output (default `speaker-focus`). */
  layout?: ClipLayout;
  /** Caption pass: `remotion` (default) or `native` (fast FFmpeg ASS burn). */
  captionEngine?: CaptionEngine;
  /** Overlay STYLE presets (font/colors/animation) chosen per clip. */
  hookStylePresetId?: string;
  ctaStylePresetId?: string;
}

/**
 * Queued by the upload/transcript API routes and consumed by the worker, so a
 * dev-server reload can no longer orphan an in-flight transcription.
 */
export interface TranscriptionJobData {
  videoId: string;
  filePath: string;
  /** Set when the user pressed "Transcribe again" on the dashboard. */
  retry?: boolean;
}
