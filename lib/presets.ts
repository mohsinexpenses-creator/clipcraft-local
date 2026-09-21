import { FilterPreset, CaptionPreset, PromptTemplate } from './types';

export const DEFAULT_FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'none',
    name: 'Original',
    description: 'No color filtering applied',
    ffmpegFilter: 'null',
  },
  {
    id: 'vibrant',
    name: 'Vibrant Boost',
    description: 'Boosts saturation and contrast for pop',
    ffmpegFilter: 'eq=saturation=1.35:contrast=1.08:brightness=0.02',
  },
  {
    id: 'warm',
    name: 'Warm Sunset',
    description: 'Warm golden tones with enhanced contrast',
    ffmpegFilter: 'eq=saturation=1.2:contrast=1.05,colorbalance=rs=0.1:gs=0.05:bs=-0.1',
  },
  {
    id: 'cinematic',
    name: 'Cinematic Mood',
    description: 'Rich contrast with slightly muted filmic saturation',
    ffmpegFilter: 'eq=saturation=0.88:contrast=1.25,colorbalance=rs=-0.05:gs=0.02:bs=0.1',
  },
  {
    id: 'cool',
    name: 'Crisp Cool',
    description: 'Clean cool tones with vibrant pop',
    ffmpegFilter: 'eq=saturation=1.15:contrast=1.1,colorbalance=rs=-0.1:bs=0.15',
  },
  {
    id: 'dramatic',
    name: 'High Impact',
    description: 'High contrast punch for maximum eye-catch',
    ffmpegFilter: 'eq=contrast=1.35:saturation=1.1:brightness=-0.02',
  },
];

export const DEFAULT_CAPTION_PRESETS: CaptionPreset[] = [
  {
    _id: 'preset-bold-yellow',
    name: 'Bold Yellow Karaoke',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 50,
    fontWeight: 'black',
    textColor: '#FFFFFF',
    highlightColor: '#FFE600',
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 28,
    animationStyle: 'karaoke',
    uppercase: true,
    isDefault: true,
  },
  {
    _id: 'preset-neon-cyan',
    name: 'Neon Cyber Pop',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 48,
    fontWeight: 'extra-bold',
    textColor: '#FFFFFF',
    highlightColor: '#00E5FF',
    strokeColor: '#000000',
    strokeWidth: 3,
    positionY: 30,
    animationStyle: 'word-pop',
    uppercase: true,
    isDefault: false,
  },
  {
    _id: 'preset-fire-red',
    name: 'Fire Hook Pop',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: 54,
    fontWeight: 'black',
    textColor: '#FFFFFF',
    highlightColor: '#FF3366',
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 26,
    animationStyle: 'word-pop',
    uppercase: true,
    isDefault: false,
  },
  {
    _id: 'preset-clean-fade',
    name: 'Clean Minimal Fade',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 44,
    fontWeight: 'bold',
    textColor: '#F8FAFC',
    highlightColor: '#38BDF8',
    strokeColor: '#000000',
    strokeWidth: 2,
    positionY: 22,
    animationStyle: 'fade-in',
    uppercase: false,
    isDefault: false,
  },
];

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    _id: 'prompt-viral-detection',
    type: 'viral_detection',
    name: 'Viral Short Segments Detection',
    description: 'Analyzes full transcript to detect top engaging candidate clips',
    systemPrompt: 'You are an expert social media video editor specializing in YouTube Shorts, TikTok, and Instagram Reels. Your task is to analyze video transcripts and identify short, highly engaging, self-contained segments that have high potential to go viral.',
    template: `Analyze the following video transcript with timestamps. Identify 3 to 6 of the most engaging, entertaining, educational, or surprising short segments (between 15 and 60 seconds long).

For each segment:
1. Select precise start and end times in seconds.
2. Provide a viral score from 1.0 to 10.0.
3. Give a brief reason why this segment will grab attention.
4. Suggest a short, catchy hook text (max 8 words) for the clip intro.

Return ONLY a strict JSON array of objects with the following schema:
[
  {
    "start": 12.5,
    "end": 42.0,
    "score": 9.2,
    "reason": "Dramatic reveal about productivity secrets",
    "hookText": "THE 1 SECRET YOU WERE NEVER TOLD"
  }
]

Transcript:
{{transcript}}`,
    updatedAt: new Date().toISOString(),
  },
  {
    _id: 'prompt-hook-generation',
    type: 'hook_generation',
    name: 'Punchy Hook Text Generator',
    description: 'Generates a compelling on-screen text overlay for the intro hook portion of a clip',
    systemPrompt: 'You are a master social media copywriter. You create viral, punchy, curiosity-inducing on-screen text overlays for short-form videos.',
    template: `Generate a short, high-impact on-screen hook overlay (MAX 8 WORDS) for this video clip transcript segment.
The hook must make viewers immediately stop scrolling and want to watch the rest of the clip.
Use ALL CAPS or strong action words. Return ONLY the hook text string without quotes.

Clip Transcript:
{{clipTranscript}}`,
    updatedAt: new Date().toISOString(),
  },
];
