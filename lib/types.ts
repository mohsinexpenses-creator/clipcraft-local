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

/**
 * What happens automatically once a video is on disk. Captured at upload time
 * (stored in `videos.pipeline_json`) so the whole chain - transcript -> viral
 * detection -> render - runs unattended with the settings the user picked, and a
 * later re-run reuses exactly the same configuration.
 */
export interface PipelineOptions {
  /** Start viral detection as soon as the transcript is ready. */
  autoDetect: boolean;
  /** Render every detected clip with the default render configuration. */
  autoRender: boolean;
  /** Options for the detection run (clip count, clip length, hook/CTA text). */
  viral: Required<ViralDetectionOptions>;
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
  /** Automatic chain configured for this video (see `PipelineOptions`). */
  pipeline?: PipelineOptions;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A video as the dashboard list needs it: everything except the (potentially
 * megabyte-sized) transcript JSON, plus the derived facts the library rows show.
 */
export interface VideoSummary extends Omit<VideoRecord, 'transcript'> {
  transcriptReady: boolean;
  transcriptSegmentCount: number;
}

/** Per-status tally of one video's clips; `progress` averages all clip renders. */
export interface ClipCounts {
  clips: number;
  done: number;
  /** Clips the worker is rendering right now. */
  active: number;
  /** Clips waiting for a render job. */
  queued: number;
  failed: number;
  /** Mean render progress over all clips (done = 100, failed = 0). */
  progress: number;
}

/** One row of the dashboard library: the video, its clip tally and its stage. */
export interface VideoListEntry {
  video: VideoSummary;
  counts: ClipCounts;
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
 * Defaults for the automatic upload pipeline: transcribe -> detect -> render.
 * `lib/viral-options.ts` clamps whatever the client sends into this shape.
 */
export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  autoDetect: true,
  autoRender: true,
  viral: { ...DEFAULT_VIRAL_OPTIONS },
};

/**
 * Render configuration a clip gets when the pipeline renders it automatically,
 * i.e. before the user ever opens the editor. Presets are resolved from the
 * database (their configured defaults) - these are the non-preset knobs.
 */
export const DEFAULT_RENDER_OPTIONS = {
  filterPreset: 'vibrant',
  layout: 'speaker-focus',
  captionEngine: 'remotion',
} as const;

/* ==========================================================================
 * App settings (Settings page -> `app_settings` table)
 *
 * Everything here follows one rule: a stored value wins, otherwise the value
 * from `.env.local` is used, otherwise the built-in default. Secrets are only
 * ever stored in the local SQLite file - the same place `.env.local` keeps them
 * - and are never returned by an API response in full (see `maskSecret`).
 * ========================================================================== */

/** One row of `app_settings`; the key is the section name. */
export const APP_SETTINGS_SECTIONS = ['pipeline', 'render', 'ai', 'worker', 'profanity'] as const;
export type AppSettingsSection = (typeof APP_SETTINGS_SECTIONS)[number];

/** Where an effective value came from - shown in the UI so env and app never look magical. */
export type SettingsSource = 'app' | 'env' | 'default';

export interface RenderDefaults {
  /** `remotion` (premium animated overlays) or `native` (FFmpeg ASS captions). */
  captionEngine: CaptionEngine;
  layout: ClipLayout;
  /** Id from `DEFAULT_FILTER_PRESETS`. */
  filterPreset: string;
  /** null = whatever the caption-preset table marks as its default. */
  captionPresetId: string | null;
  /** null = the default overlay style preset of that kind. */
  hookStylePresetId: string | null;
  ctaStylePresetId: string | null;
  /**
   * Hook intro / CTA card length in seconds for clips nobody edited. 0 on the
   * hook means "no hook replay", which is also what a clip with no hook text gets.
   */
  hookDuration: number;
  ctaDuration: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderDefaults = {
  captionEngine: DEFAULT_RENDER_OPTIONS.captionEngine,
  layout: DEFAULT_RENDER_OPTIONS.layout,
  filterPreset: DEFAULT_RENDER_OPTIONS.filterPreset,
  captionPresetId: null,
  hookStylePresetId: null,
  ctaStylePresetId: null,
  hookDuration: 3,
  ctaDuration: 2.5,
};

export type TranscriptionProviderChoice = 'auto' | 'deepgram' | 'whisper';

export interface AiProviderSettings {
  /**
   * Google AI Studio keys, tried in order. Rotation is per model: a key that is
   * rate limited moves on to the next key before the next model is tried.
   * Empty means "use GEMINI_API_KEY from .env.local".
   */
  geminiApiKeys: string[];
  /** Empty means "use DEEPGRAM_API_KEY from .env.local" (and no cloud transcription). */
  deepgramApiKey: string;
  /** Empty means DEEPGRAM_MODEL from .env.local, else `nova-2`. */
  deepgramModel: string;
  /**
   * `auto` prefers Deepgram when a key is configured and falls back to local
   * whisper.cpp. The other two force one engine (and a missing setup then
   * surfaces as a real error, which is what "forced" should mean).
   */
  transcriptionProvider: TranscriptionProviderChoice;
}

export const DEFAULT_AI_SETTINGS: AiProviderSettings = {
  geminiApiKeys: [],
  deepgramApiKey: '',
  deepgramModel: '',
  transcriptionProvider: 'auto',
};

export const CONCURRENCY_LIMITS = { clip: { min: 1, max: 8 }, viral: { min: 1, max: 8 }, remotion: { min: 1, max: 32 } } as const;

export interface WorkerSettings {
  /** Simultaneous clip renders. Each one runs FFmpeg + headless Chrome. */
  clipConcurrency: number;
  /** Simultaneous viral-detection runs (LLM-bound, cheap). */
  viralConcurrency: number;
  /** Chrome tabs per render; null = half the CPU cores. */
  remotionConcurrency: number | null;
}

export interface ProfanitySettings {
  /** What happens to the AUDIO of a profane word; on-screen text is always masked. */
  audioMode: 'mute' | 'beep' | 'off';
}

export const DEFAULT_PROFANITY_SETTINGS: ProfanitySettings = { audioMode: 'mute' };

export interface AppSettings {
  pipeline: PipelineOptions;
  render: RenderDefaults;
  ai: AiProviderSettings;
  worker: WorkerSettings;
  profanity: ProfanitySettings;
}

/** Per-key origin of every effective value, for the UI's `from .env` / `from app` chips. */
export type SettingsSources = {
  [K in AppSettingsSection]?: Partial<Record<string, SettingsSource>>;
};

/** What `.env.local` contributes for one variable, without leaking its value. */
export interface EnvHint {
  name: string;
  /** True when this process can see the variable. */
  present: boolean;
  /** The value from the env file, masked - empty when it is not a usable secret. */
  masked: string;
  /** The name appears in `.env.local` even when this process has not loaded it. */
  inEnvFile: boolean;
}

export interface SettingsLimits {
  clipCount: { min: number; max: number };
  minClipDuration: { min: number; max: number };
  concurrency: typeof CONCURRENCY_LIMITS;
  overlayDuration: { min: number; max: number };
  maxKeyPool: number;
  filterPresets: Array<{ id: string; name: string; description: string }>;
  engines: readonly string[];
  layouts: readonly string[];
  audioModes: readonly string[];
  transcriptionProviders: readonly string[];
}

/**
 * What `GET /api/settings` returns. Secrets are masked everywhere in here; `env` and
 * `limits` let the page explain where a value came from and what it may be set to.
 */
export interface AppSettingsSnapshot {
  /** Stored (raw) values per section - secrets are masked, never sent in full. */
  stored: Partial<Record<AppSettingsSection, unknown>>;
  effective: AppSettings;
  sources: SettingsSources;
  /** Sections the user has actually saved something for. */
  configured: AppSettingsSection[];
  /** Stored values a running worker only picks up again after it is restarted. */
  restartRequired: string[];
  env: Record<string, EnvHint>;
  limits: SettingsLimits;
}

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

export type CaptionFontWeight = 'normal' | 'bold' | 'extra-bold' | 'black';
export type CaptionAnimationStyle = 'karaoke' | 'word-pop' | 'fade-in' | 'static';

/** Optional per-visual-line overrides; missing fields inherit from CaptionPreset. */
export interface CaptionLineStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: CaptionFontWeight;
  textColor?: string;
  highlightColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number;
  /** Maximum transcript words assigned to this visual line (clamped to 1..8). */
  maxWords?: number;
  animationStyle?: CaptionAnimationStyle;
  /** CSS/ASS line-height multiplier. */
  lineHeight?: number;
}

export interface CaptionPreset {
  _id: string;
  name: string;
  fontFamily: string;
  fontSize: number; // e.g. 48
  fontWeight: CaptionFontWeight;
  textColor: string; // hex or rgb
  highlightColor: string; // active word highlight hex or rgb
  strokeColor: string; // text outline stroke
  strokeWidth: number; // e.g. 2
  positionY: number; // percentage from bottom, e.g. 25
  animationStyle: CaptionAnimationStyle;
  uppercase?: boolean;
  /** Optional rich multi-line styling. Omitted presets keep legacy one-line rendering. */
  lineStyles?: CaptionLineStyle[];
  /** Gap between rich visual lines in composition pixels. */
  lineGap?: number;
  /** Horizontal alignment for rich line blocks. */
  lineAlignment?: 'left' | 'center' | 'right';
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
  captionPresetId?: string;
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

/**
 * Queued viral-segment detection. The detection options are read from the video
 * record rather than the payload, so a retry after an app reload still uses the
 * settings the upload was started with.
 */
export interface ViralDetectionJobData {
  videoId: string;
  /** Render every clip the run creates with the default configuration. */
  autoRender?: boolean;
  /** Set when the user re-ran detection by hand. */
  retry?: boolean;
}
