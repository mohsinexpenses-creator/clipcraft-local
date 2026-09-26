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
    description:
      'Expert social-strategy prompt: ranks transcript moments by viral potential and returns full clip packaging (hook, CTA, title, hashtags, safety, scores) as JSON',
    systemPrompt:
      'You are an expert Social Media Strategist and professional Short-Form Content Clipper for platforms like TikTok, Instagram Reels, and YouTube Shorts. You deeply analyze entire video conversations and extract the TOP most viral moments that can be turned into short-form clips. You always follow every strict rule exactly, you never invent timestamps, and you always return strict, valid JSON.',
    template: `Analyze the entire transcript below and extract the TOP {{clipCount}} most viral moments that can be turned into short-form clips.

STRICT RULES (MUST FOLLOW):
- Every selected clip MUST be between {{minClipDuration}} and {{maxClipDuration}} seconds long. NEVER shorter than {{minClipDuration}} seconds. NEVER longer than {{maxClipDuration}} seconds.
- Use ONLY timestamps directly supported by the transcript. Do not invent or estimate timestamps. "start" and "end" must fall inside the transcript's own timestamps.
- Start clips as close as possible to the emotional trigger or curiosity point. Remove unnecessary setup unless it increases retention.
- Prioritize clips that create immediate emotional tension within the first 1-3 seconds.
- DO NOT order clips by the order they appear in the transcript. First analyze all possible viral moments, then rank them by highest viral potential. The array MUST be sorted with the MOST viral clip first.
- Clips must NOT overlap. Every clip must have completely different timings.

When selecting clips, focus on:
- High Emotion: anger, excitement, intense laughter, tension, or sadness.
- Controversy / Hot Takes: strong opinions or statements that can trigger debate in the comments.
- Storytelling: engaging stories with a strong setup and payoff.
- High Value: powerful advice, insights, lessons, or mindset shifts.

For every clip, perform this full analysis and fold it into the JSON fields:
1. Hook Line Analysis - identify the single strongest spoken line that can be used as a cold-open hook: the exact line (hookLine) plus its exact transcript timestamp (hookLineStart, hookLineEnd). Also write a punchy on-screen hook text (hookText, MAX 8 WORDS) that makes viewers stop scrolling.
2. Retention Analysis - what creates curiosity in the first 3 seconds, where the payoff happens, and what open loop keeps viewers watching till the end. Summarize this into "reason" and rate retentionStrength (Weak / Medium / Strong / Extreme).
3. Psychological Trigger Analysis - the dominant trigger for the clip: one of Curiosity, Anger, Inspiration, Shock, Validation, Fear, Controversy, Humor.
4. TikTok / Shorts Safety & Eligibility Analysis - check the spoken words for policy-sensitive wording, monetization risk, reused-content risk, and algorithm suppression risk. Set safetyRisk (Low / Medium / High). In safetyNotes write the EXACT risky words or phrases clearly (never hidden references like "f-word" - write the actual word) followed by a safer replacement after "->". If the clip is clean, set safetyNotes to "No risky wording detected."
5. Viral Packaging - provide: hookText (Hook Text On Video), title (a curiosity-driven, high-retention TikTok/Reels/Shorts title), ctaText (end-screen CTA that encourages comments or arguments - slightly controversial is preferred if it stays platform-safe, MAX 10 WORDS), and hashtags (3-5 highly relevant viral hashtags, each starting with #).
6. Viral Scoring System - give "score" as the overall viral potential (out of 10) and fill "scores" with viral, retention, controversy, and shareability, each out of 10.

Return ONLY a strict JSON array (no markdown fences, no commentary) with EXACTLY this schema per clip:
[
  {
    "start": 120.5,
    "end": 182.0,
    "title": "curiosity-driven short-form title",
    "score": 9.4,
    "reason": "Why this will go viral: the psychology of why viewers will keep watching, comment, and share (2-3 sentences)",
    "hookText": "ON-SCREEN HOOK TEXT (MAX 8 WORDS)",
    "hookLine": "the exact spoken cold-open line",
    "hookLineStart": 122.1,
    "hookLineEnd": 125.8,
    "ctaText": "END SCREEN CTA (MAX 10 WORDS)",
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "retentionStrength": "Strong",
    "psychologicalTrigger": "Curiosity",
    "safetyRisk": "Low",
    "safetyNotes": "No risky wording detected.",
    "scores": { "viral": 9, "retention": 9, "controversy": 6, "shareability": 8 }
  }
]

Relevant emojis are welcome inside string fields (title, hookText, ctaText) where they improve stop-scroll power.

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
  {
    _id: 'prompt-cta-generation',
    type: 'cta_generation',
    name: 'End CTA Generator',
    description: 'Generates a short end-of-clip call to action that feels native to short-form video',
    systemPrompt: 'You are a short-form video strategist. You write concise end-of-video calls to action that feel natural, boost engagement, and fit as on-screen text overlays.',
    template: `Generate one short end-of-video CTA overlay (MAX 10 WORDS) for this clip transcript.
The CTA should encourage engagement such as follow, comment, save, share, or watch the next clip.
It must feel punchy, platform-native, and safe to place in the final 2 to 3 seconds.
Use ALL CAPS or strong action phrasing. Return ONLY the CTA text string without quotes.

Clip Transcript:
{{clipTranscript}}`,
    updatedAt: new Date().toISOString(),
  },
];
