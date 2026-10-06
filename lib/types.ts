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

/**
 * Allowed values of the AI's enum fields, exactly as the viral_detection prompt
 * schema lists them. lib/viral-response.ts rejects any other value.
 */
export const RETENTION_STRENGTHS = ['Weak', 'Medium', 'Strong', 'Extreme'] as const;
export type RetentionStrength = (typeof RETENTION_STRENGTHS)[number];

export const SAFETY_RISKS = ['Low', 'Medium', 'High'] as const;
export type SafetyRisk = (typeof SAFETY_RISKS)[number];

export const PSYCHOLOGICAL_TRIGGERS = [
  'Curiosity',
  'Anger',
  'Inspiration',
  'Shock',
  'Validation',
  'Fear',
  'Controversy',
  'Humor',
] as const;
export type PsychologicalTrigger = (typeof PSYCHOLOGICAL_TRIGGERS)[number];

export const RISKY_WORD_ACTIONS = ['censor', 'replace', 'mute', 'remove'] as const;
export type RiskyWordAction = (typeof RISKY_WORD_ACTIONS)[number];

/**
 * One clip exactly as the viral_detection prompt's JSON schema returns it:
 * `{ "clips": [ViralClip, ...] }`. Same field names, timestamps still strings.
 * lib/viral-response.ts validates it, the detect route stores it unchanged on
 * the clip record (`aiAnalysis`), and the dashboard and the worker read it
 * from there - there is no second copy of this data.
 */
export interface ViralClip {
  /** 1 = most viral. Renumbered 1, 2, 3... after overlapping clips are dropped. */
  rank: number;
  /** What the AI claimed; the window actually rendered is `ClipRecord.start`/`end`. */
  timestamp: { start: string; end: string };
  duration: { minutes: number; seconds: number; total_seconds: number };
  why_this_will_go_viral: string;
  hook_line_analysis: {
    hook_line: string;
    hook_timestamp: { start: string; end: string };
    why_it_works: string;
    /** Stored only - the renderer always prepends the hook intro when hook text is on. */
    place_before_clip: boolean;
  };
  retention_analysis: {
    curiosity_first_3_seconds: string;
    payoff_location: string;
    open_loop: boolean;
    likely_to_watch_till_end: boolean;
    predicted_retention: RetentionStrength;
  };
  psychological_trigger: { dominant_trigger: PsychologicalTrigger; explanation: string };
  safety_analysis: {
    risk_level: SafetyRisk;
    monetization_risk: string;
    reused_content_risk: string;
    algorithm_suppression_risk: string;
    ineligible_for_fyf_risk: string;
    risky_words: { word_or_phrase: string; action: RiskyWordAction; safer_replacement: string }[];
  };
  viral_packaging: {
    hook_text_on_video: string;
    video_title: string;
    cta_text: string;
    hashtags: string[];
    platform_safe: boolean;
    eligibility_or_reach_concerns: string;
    words_to_change: string[];
  };
  /** Each 0-10. */
  scores: {
    viral_score: number;
    retention_score: number;
    controversy_score: number;
    shareability_score: number;
  };
}

/** A validated AI clip with its numeric render window (seconds), ready to become a ClipRecord. */
export interface ViralSegment {
  start: number;
  end: number;
  clip: ViralClip;
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
 * How transparent caption/overlay frames are prepared before the final FFmpeg
 * video pass:
 * - `remotion`: the full caption + hook + CTA timeline is painted by headless
 *   Chrome (smooth spring animations, slower on long clips).
 * - `native`: ASS captions are rasterized to PNGs; hook/CTA cards are still
 *   designed in Remotion and painted as transparent frame sequences.
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
 * Stored in SQLite (table `text_presets`) and editable in the app - the
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
  /** 0 disables the hook intro; positive enables it. A valid AI hook timestamp supplies its exact duration. */
  hookDuration: number;
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
  /**
   * Set by the worker when the render did NOT use the requested layout (e.g. a
   * split screen was asked for but only one person could be found, so a single
   * speaker window was rendered). Empty/absent when the layout was applied.
   */
  layoutNote?: string;
  /** Caption pass: `remotion` (default, smoothest) or `native` (FFmpeg ASS burn, ~10x faster). */
  captionEngine?: CaptionEngine;
  /** Overlay STYLE presets (font/colors/animation) chosen per clip. */
  hookStylePresetId?: string;
  ctaStylePresetId?: string;
  cropData?: CropWindow;
  /**
   * Everything the AI said about this clip (score, rank, title, hook line,
   * retention, safety, packaging...). The single copy: the card, the analysis
   * panel and the worker (hook moment, output file name) all read it from here.
   * Absent on clips created before the new AI schema.
   */
  aiAnalysis?: ViralClip;
  // relative path to output mp4, e.g. /generated-clips/001_my_recording/<clip title>.mp4
  outputPath?: string;
  outputFileSize?: number; // bytes, 0/undefined means the render did not produce a usable file
  outputFps?: number; // fps actually used for the render
  status: 'pending' | 'processing' | 'done' | 'failed';
  progress?: number; // 0-100
  error?: string;
  /** True once the user asked to stop a running render; the worker honours it. */
  cancelling?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobData {
  clipId: string;
  videoId: string;
  start: number;
  end: number;
  /** 0 disables the hook intro; positive enables it (AI timestamps determine the duration when valid). */
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
