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
  filePath: string;
  duration: number; // in seconds
  width: number;
  height: number;
  fileSize: number;
  status: 'uploaded' | 'transcribing' | 'transcribed' | 'failed';
  transcript?: TranscriptData;
  createdAt: string;
  updatedAt: string;
}

export interface ViralSegment {
  start: number;
  end: number;
  hookText: string;
  reason: string;
  score: number;
}

export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  type: 'viral_detection' | 'hook_generation';
  name: string;
  description: string;
  systemPrompt: string;
  template: string; // Prompt text containing handlebars/variables like {{transcript}}
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
  filterPreset: string; // filter preset id
  captionPresetId: string;
  captionPreset?: CaptionPreset;
  cropData?: CropWindow;
  viralScore: number;
  viralReason?: string;
  outputPath?: string; // relative path to output mp4
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
  filterPreset: string;
  captionPresetId: string;
}
