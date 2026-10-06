/**
 * Shared fixtures for the viral-response tests: a realistic clip in the NEW AI
 * response format (every field filled in), and a transcript to run detection on.
 * Not a test file itself (no `.test.ts` suffix), like sqlite-test-helpers.ts.
 */
import type { TranscriptData, VideoRecord } from '../lib/types';

export type RawClip = Record<string, unknown>;

/**
 * One clip exactly as the viral_detection prompt's JSON schema describes it.
 * Window: 00:01:05 -> 00:02:10 (65s - 130s). Pass `overrides` to change any
 * top-level key (nested blocks are replaced as a whole).
 */
export function aiClip(overrides: RawClip = {}): RawClip {
  return {
    rank: 1,
    timestamp: { start: '00:01:05', end: '00:02:10' },
    duration: { minutes: 1, seconds: 5, total_seconds: 65 },
    why_this_will_go_viral:
      'He admits the one thing every founder hides, and the 4,000 dollar number makes viewers argue in the comments.',
    hook_line_analysis: {
      hook_line: 'I had four hundred dollars left in my account.',
      hook_timestamp: { start: '00:01:20', end: '00:01:24' },
      why_it_works: 'A concrete number plus a confession opens a curiosity gap.',
      place_before_clip: true,
    },
    retention_analysis: {
      curiosity_first_3_seconds: 'The viewer wants to know how he survived on $400.',
      payoff_location: '00:01:58',
      open_loop: true,
      likely_to_watch_till_end: true,
      predicted_retention: 'Strong',
    },
    psychological_trigger: {
      dominant_trigger: 'Curiosity',
      explanation: 'The unanswered "how" keeps people watching to the payoff.',
    },
    safety_analysis: {
      risk_level: 'Medium',
      monetization_risk: 'Low - one mild swear word.',
      reused_content_risk: 'Low - original conversation.',
      algorithm_suppression_risk: 'Low',
      ineligible_for_fyf_risk: 'Low',
      risky_words: [{ word_or_phrase: 'damn', action: 'replace', safer_replacement: 'darn' }],
    },
    viral_packaging: {
      hook_text_on_video: 'He had $400 left',
      video_title: 'He quit his job with $400 in the bank 😳',
      cta_text: 'Would you have done it? 👇',
      hashtags: ['#mindset', '#startup', '#risk'],
      platform_safe: true,
      eligibility_or_reach_concerns: 'Mild language in the first minute.',
      words_to_change: ['damn'],
    },
    scores: {
      viral_score: 9.2,
      retention_score: 8.5,
      controversy_score: 6,
      shareability_score: 8,
    },
    ...overrides,
  };
}

/** The response body the prompt asks for: `{ "clips": [...] }`. */
export function aiResponse(clips: unknown[]): string {
  return JSON.stringify({ clips });
}

/** A transcript with one segment per 10 seconds, so any window has text to quote. */
export function makeTranscript(durationSeconds: number): TranscriptData {
  const segments = [];
  const words = [];
  for (let start = 0, id = 0; start < durationSeconds; start += 10, id += 1) {
    const end = Math.min(start + 10, durationSeconds);
    segments.push({ id, start, end, text: `Segment ${id} talks about money and risk.` });
    words.push({ word: `segment${id}`, start, end });
  }
  return { text: segments.map((segment) => segment.text).join(' '), segments, words };
}

export function makeVideo(id: string, durationSeconds: number): VideoRecord {
  const now = new Date().toISOString();
  return {
    _id: id,
    originalName: `${id}.mp4`,
    fileName: `${id}.mp4`,
    fileBase: id,
    filePath: `/uploads/${id}.mp4`,
    duration: durationSeconds,
    width: 1920,
    height: 1080,
    fileSize: 1024,
    status: 'transcribed',
    transcript: makeTranscript(durationSeconds),
    createdAt: now,
    updatedAt: now,
  };
}
