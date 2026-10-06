import {
  FilterPreset,
  CaptionPreset,
  OverlayStylePreset,
  PromptTemplate,
} from "./types";

export const DEFAULT_FILTER_PRESETS: FilterPreset[] = [
  {
    id: "none",
    name: "Original",
    description: "No color filtering applied",
    ffmpegFilter: "null",
  },
  {
    id: "vibrant",
    name: "Vibrant Boost",
    description: "Boosts saturation and contrast for pop",
    ffmpegFilter: "eq=saturation=1.35:contrast=1.08:brightness=0.02",
  },
  {
    id: "warm",
    name: "Warm Sunset",
    description: "Warm golden tones with enhanced contrast",
    ffmpegFilter:
      "eq=saturation=1.2:contrast=1.05,colorbalance=rs=0.1:gs=0.05:bs=-0.1",
  },
  {
    id: "cinematic",
    name: "Cinematic Mood",
    description: "Rich contrast with slightly muted filmic saturation",
    ffmpegFilter:
      "eq=saturation=0.88:contrast=1.25,colorbalance=rs=-0.05:gs=0.02:bs=0.1",
  },
  {
    id: "cool",
    name: "Crisp Cool",
    description: "Clean cool tones with vibrant pop",
    ffmpegFilter:
      "eq=saturation=1.15:contrast=1.1,colorbalance=rs=-0.1:bs=0.15",
  },
  {
    id: "dramatic",
    name: "High Impact",
    description: "High contrast punch for maximum eye-catch",
    ffmpegFilter: "eq=contrast=1.35:saturation=1.1:brightness=-0.02",
  },
];

/**
 * Modern caption styles: tighter strokes, cleaner type, and a single accent
 * color per preset so highlighted words read instantly on mobile.
 */
export const DEFAULT_CAPTION_PRESETS: CaptionPreset[] = [
  {
    _id: "caption-creator-green",
    name: "Creator Green",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 52,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#22E55E",
    strokeColor: "#000000",
    strokeWidth: 5,
    positionY: 28,
    animationStyle: "karaoke",
    uppercase: true,
    isDefault: true,
  },
  {
    _id: "caption-electric-violet",
    name: "Electric Violet",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 48,
    fontWeight: "extra-bold",
    textColor: "#FFFFFF",
    highlightColor: "#A78BFA",
    strokeColor: "#0B0B14",
    strokeWidth: 4,
    positionY: 30,
    animationStyle: "word-pop",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-sunburst",
    name: "Sunburst Pop",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 54,
    fontWeight: "black",
    textColor: "#FFFFFF",
    highlightColor: "#FFB800",
    strokeColor: "#000000",
    strokeWidth: 5,
    positionY: 26,
    animationStyle: "word-pop",
    uppercase: true,
    isDefault: false,
  },
  {
    _id: "caption-clean-studio",
    name: "Clean Studio",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 44,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    highlightColor: "#60A5FA",
    strokeColor: "#000000",
    strokeWidth: 2,
    positionY: 22,
    animationStyle: "fade-in",
    uppercase: false,
    isDefault: false,
  },
  {
    _id: "caption-coral-flow",
    name: "Coral Flow",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 46,
    fontWeight: "extra-bold",
    textColor: "#FFF7F5",
    highlightColor: "#FF6B6B",
    strokeColor: "#1A0B0B",
    strokeWidth: 3,
    positionY: 24,
    animationStyle: "karaoke",
    uppercase: false,
    isDefault: false,
  },
];

/**
 * Modern overlay styles for the intro hook and end CTA. Dark glass cards,
 * solid accent blocks, and pills with restrained borders instead of heavy chrome.
 */
export const DEFAULT_OVERLAY_STYLE_PRESETS: OverlayStylePreset[] = [
  // ── Hook styles ──────────────────────────────────────────────
  {
    _id: "hook-midnight-glass",
    kind: "hook",
    name: "Midnight Glass",
    description:
      "White bold text on a dark translucent card with a subtle accent chip",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 38,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(10, 10, 15, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderWidth: 1,
    borderRadius: 20,
    textTransform: "uppercase",
    positionY: 12,
    animationStyle: "pop",
    showBadge: true,
    badgeText: "Watch This",
    isDefault: true,
  },
  {
    _id: "hook-volt-yellow",
    kind: "hook",
    name: "Volt Yellow",
    description:
      "Black text on a solid yellow block that slides up for instant contrast",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#0A0A0F",
    backgroundColor: "rgba(255, 224, 0, 0.98)",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
    borderRadius: 14,
    textTransform: "uppercase",
    positionY: 13,
    animationStyle: "slide-up",
    showBadge: false,
    isDefault: false,
  },
  {
    _id: "hook-crimson-alert",
    kind: "hook",
    name: "Crimson Alert",
    description:
      "White text on a deep red card with a clean border for high-tension hooks",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 40,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(225, 29, 72, 0.95)",
    borderColor: "rgba(255, 255, 255, 0.22)",
    borderWidth: 1,
    borderRadius: 16,
    textTransform: "uppercase",
    positionY: 14,
    animationStyle: "slide-up",
    showBadge: true,
    badgeText: "Wait For It",
    isDefault: false,
  },
  {
    _id: "hook-soft-light",
    kind: "hook",
    name: "Soft Light",
    description: "Dark text on a frosted white card, calm and editorial",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 36,
    fontWeight: "extra-bold",
    textColor: "#0F172A",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderColor: "rgba(15, 23, 42, 0.08)",
    borderWidth: 1,
    borderRadius: 22,
    textTransform: "none",
    positionY: 12,
    animationStyle: "pop",
    showBadge: false,
    isDefault: false,
  },

  // ── CTA styles ───────────────────────────────────────────────
  {
    _id: "cta-aurora-gradient",
    kind: "cta",
    name: "Aurora Gradient",
    description: "White CTA on a violet-to-blue gradient card",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "black",
    textColor: "#FFFFFF",
    backgroundColor:
      "linear-gradient(135deg, rgba(124,58,237,0.96), rgba(37,99,235,0.96))",
    borderColor: "rgba(255, 255, 255, 0.18)",
    borderWidth: 1,
    borderRadius: 24,
    textTransform: "uppercase",
    positionY: 64,
    animationStyle: "pop",
    isDefault: true,
  },
  {
    _id: "cta-mono-pill",
    kind: "cta",
    name: "Mono Pill",
    description: "Dark text on a clean white pill with a soft fade",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 32,
    fontWeight: "extra-bold",
    textColor: "#0A0A0F",
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderColor: "rgba(10, 10, 15, 0.08)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "none",
    positionY: 66,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-night-outline",
    kind: "cta",
    name: "Night Outline",
    description: "White text on a dark glass pill with a light outline",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 32,
    fontWeight: "extra-bold",
    textColor: "#FFFFFF",
    backgroundColor: "rgba(10, 10, 15, 0.8)",
    borderColor: "rgba(255, 255, 255, 0.25)",
    borderWidth: 1,
    borderRadius: 999,
    textTransform: "uppercase",
    positionY: 65,
    animationStyle: "fade",
    isDefault: false,
  },
  {
    _id: "cta-mint-solid",
    kind: "cta",
    name: "Mint Solid",
    description: "Dark text on a solid mint block that pops in",
    fontFamily: "Montserrat, Inter, system-ui, sans-serif",
    fontSize: 34,
    fontWeight: "black",
    textColor: "#04130B",
    backgroundColor: "rgba(52, 245, 142, 0.98)",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
    borderRadius: 18,
    textTransform: "uppercase",
    positionY: 64,
    animationStyle: "pop",
    isDefault: false,
  },
];

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    _id: "prompt-viral-detection",
    type: "viral_detection",
    name: "Viral Short Segments Detection",
    description:
      "Expert social-strategy prompt: ranks transcript moments by viral potential and returns full clip packaging (hook, CTA, title, hashtags, safety, scores) as JSON",
    systemPrompt:
      "You are an expert Social Media Strategist and professional Short-Form Content Clipper for platforms like TikTok, Instagram Reels, and YouTube Shorts. You deeply analyze entire video conversations and extract the TOP most viral moments that can be turned into short-form clips. You always follow every strict rule exactly, you never invent timestamps, and you always return strict, valid JSON.",
    template: `IMPORTANT STRICT RULES (MUST FOLLOW):

- Every selected clip MUST be between {{minClipDuration}}–{{maxClipDuration}} seconds long.
- NEVER create clips shorter than {{minClipDuration}} seconds.
- Follow all instructions exactly as written.
- Use ONLY timestamps directly supported by the transcript. Do not invent or estimate timestamps.
- Do not skip any required section.
- Do not give generic answers.
- Carefully verify timestamps before selecting clips.
- Start clips as close as possible to the emotional trigger or curiosity point. Remove unnecessary setup unless it increases retention.
- Prioritize clips that create immediate emotional tension within the first 1–3 seconds.
- Use relevant emojis throughout the response to improve readability, visual organization, and emotional understanding.
- DO NOT number clips based on the order they appear in the transcript.
- First analyze all possible viral moments, then rank them by highest viral potential.
- Clip #1 MUST be the MOST viral clip.
- Clip #2 MUST be the second most viral clip.
- Continue numbering strictly based on viral ranking, not transcript order.

When selecting clips, focus on:

- High Emotion: anger, excitement, intense laughter, tension, or sadness.
- Controversy / Hot Takes: strong opinions or statements that can trigger debate in the comments.
- Storytelling: engaging stories with a strong setup and payoff.
- High Value: powerful advice, insights, lessons, or mindset shifts.

For each clip, provide the information in the exact format below:

Clip #[Number]

Timestamp: [Exact Start Time – Exact End Time]
Clip Duration: [Total duration in minutes and seconds]

Why This Will Go Viral:
[Explain the psychology behind why viewers will keep watching, comment, and share it]

Carefully analyze the transcript using verified timestamps and select only highly viral moments. (Lock)

Do not create clips with overlapping timestamps. Every clip must have completely different timings. (Lock)

Now, for each clip, perform these tasks separately:

1. Hook Line Analysis

Carefully read the clip and identify the single strongest line that can be used as a cold open hook at the start of the edited video.

Also provide:

- Exact hook timestamp (start and end)
- Why this hook works psychologically
- Whether the hook should be placed before the actual clip starts for retention

(Lock)

2. Retention Analysis

For every clip, explain:

- What creates curiosity in the first 3 seconds
- Where the payoff happens
- Whether the clip has an "open loop"
- Whether the viewer is likely to watch till the end
- Predicted retention strength: Weak / Medium / Strong / Extreme

(Lock)

3. Psychological Trigger Analysis

Identify the dominant psychological trigger:

- Curiosity
- Anger
- Inspiration
- Shock
- Validation
- Fear
- Controversy
- Humor

Explain why this trigger increases engagement.

(Lock)

4. TikTok / Shorts Safety & Eligibility Analysis

Carefully analyze the clip, including:

- Spoken words
- Captions/subtitles shown on screen
- Potential policy-sensitive wording

Check whether:

- The clip could become "Ineligible For You Feed"
- Any words may reduce reach, monetization, or distribution
- Any wording could trigger moderation or disqualification
- Check for monetization risk, reused-content risk, and algorithm suppression risk

Clearly mention:

- Risk Level: Low / Medium / High
- Exact risky words or phrases
- Which words should be censored, replaced, muted, or removed from captions/voice
- NEVER use hidden/censored references like "f-word", "s-word", "n-word", etc.
- Always write the exact risky word or phrase clearly so there is no confusion.
- If needed, also provide a safer replacement version beside it.

Mention this separately for every clip. (Lock)

5. Viral Packaging

After analyzing the clip, provide:

A. Hook Text On Video
A highly engaging text line for the first seconds of the video that makes viewers stop scrolling.

B. Video Title
A curiosity-driven, high-retention title optimized for TikTok/Reels/Shorts.

[Catchy and engaging title]

C. CTA Text (End Screen)
A short CTA text for the end of the clip that encourages comments, arguments, or engagement. Slightly controversial/questionable CTAs are preferred if they remain platform-safe.

D. Hashtags:
[3–5 highly relevant viral potential hashtags]

Also mention separately:

- Whether the wording is fully platform-safe
- Whether any text could affect eligibility or reach
- Any words that should be changed in captions or voiceover

(Lock)

6. Viral Scoring System

For every clip, provide:

- Viral Score: /10
- Retention Score: /10
- Controversy Score: /10
- Shareability Score: /10

(Lock)

Rank all clips based on viral potential, with the highest viral probability first.

For every clip, keep the same structure:

- Clip Number
- Timestamp
- Title
- Hook
- Viral Analysis
- Retention Analysis
- Psychological Trigger Analysis
- Safety Analysis
- Viral Packaging
- Viral Scores

Make the final output clean, highly organized, professional, and strictly follow every instruction above.

OUTPUT FORMAT (OVERRIDES ALL FORMATTING ABOVE):

Return ONLY a single valid JSON object. No markdown, no code fences, no explanations, no text before or after the JSON.

- All the sections, rules, and analysis above still apply in full. Only the output format changes: the "Clip #" text layout is replaced by the JSON schema below.
- Emojis are allowed ONLY inside string values.
- Use double quotes, escape internal quotes and newlines properly, and use no trailing commas.
- The "clips" array MUST be sorted by viral ranking (rank 1 = most viral), not by transcript order.
- Timestamps must be strings in the same format as the transcript. Durations must be calculated from them.
- Never output null. Use "" or [] if something is not applicable.

JSON SCHEMA:
{
  "clips": [
    {
      "rank": 1,
      "timestamp": { "start": "", "end": "" },
      "duration": { "minutes": 0, "seconds": 0, "total_seconds": 0 },
      "why_this_will_go_viral": "",
      "hook_line_analysis": {
        "hook_line": "",
        "hook_timestamp": { "start": "", "end": "" },
        "why_it_works": "",
        "place_before_clip": true
      },
      "retention_analysis": {
        "curiosity_first_3_seconds": "",
        "payoff_location": "",
        "open_loop": true,
        "likely_to_watch_till_end": true,
        "predicted_retention": "Weak | Medium | Strong | Extreme"
      },
      "psychological_trigger": {
        "dominant_trigger": "Curiosity | Anger | Inspiration | Shock | Validation | Fear | Controversy | Humor",
        "explanation": ""
      },
      "safety_analysis": {
        "risk_level": "Low | Medium | High",
        "monetization_risk": "",
        "reused_content_risk": "",
        "algorithm_suppression_risk": "",
        "ineligible_for_fyf_risk": "",
        "risky_words": [
          { "word_or_phrase": "", "action": "censor | replace | mute | remove", "safer_replacement": "" }
        ]
      },
      "viral_packaging": {
        "hook_text_on_video": "",
        "video_title": "",
        "cta_text": "",
        "hashtags": ["", "", ""],
        "platform_safe": true,
        "eligibility_or_reach_concerns": "",
        "words_to_change": []
      },
      "scores": {
        "viral_score": 0,
        "retention_score": 0,
        "controversy_score": 0,
        "shareability_score": 0
      }
    }
  ]
}

The "clips" array must contain exactly {{clipCount}} items. Output the JSON object and nothing else.

TRANSCRIPT:
{{transcript}}`,
    updatedAt: new Date().toISOString(),
  },
];
