/**
 * Tests for the AI-response normalization layer (lib/viral-response.ts):
 * timestamp parsing, pulling the clip list out of messy model text, the exact
 * field mapping onto ViralSegment, preservation of the nested analysis, enum
 * placeholders, malformed input, and the legacy flat format.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipFieldsFromSegment,
  DEFAULT_VIRAL_SCORE,
  extractViralClips,
  fitHookToWindow,
  NO_RISKY_WORDING_NOTE,
  normalizeViralClips,
  normalizeViralResponse,
  parseTimestamp,
  splitTimestampRange,
} from '../lib/viral-response';
import { DEFAULT_PROMPT_TEMPLATES } from '../lib/presets';
import type { ViralSegment } from '../lib/types';
import { aiClip, aiResponse, type RawClip } from './viral-fixtures';

const VIDEO_SECONDS = 600;

/** Normalizes a single raw clip and returns its segment (fails the test if it was skipped). */
function normalizeOne(clip: unknown, videoDuration = VIDEO_SECONDS): ViralSegment {
  const { segments, issues } = normalizeViralClips([clip], { videoDuration });
  assert.equal(issues.length, 0, `unexpected issues: ${JSON.stringify(issues)}`);
  assert.equal(segments.length, 1);
  return segments[0];
}

/* ------------------------------------------------------------------ */
/* Timestamps                                                          */
/* ------------------------------------------------------------------ */

test('parseTimestamp reads plain seconds, numbers and the transcript "12.5s" style', () => {
  assert.equal(parseTimestamp(12.5), 12.5);
  assert.equal(parseTimestamp(0), 0);
  assert.equal(parseTimestamp('12.5'), 12.5);
  assert.equal(parseTimestamp(' 125 '), 125);
  assert.equal(parseTimestamp('12.5s'), 12.5);
  assert.equal(parseTimestamp('90 seconds'), 90);
});

test('parseTimestamp reads mm:ss and hh:mm:ss clocks', () => {
  assert.equal(parseTimestamp('01:23'), 83);
  assert.equal(parseTimestamp('1:23'), 83);
  assert.equal(parseTimestamp('00:01:23'), 83);
  assert.equal(parseTimestamp('1:02:03'), 3723);
  assert.equal(parseTimestamp('1:02:03.5'), 3723.5);
  assert.equal(parseTimestamp('01:23,500'), 83.5);
  assert.equal(parseTimestamp('125:30'), 7530, 'minutes may exceed 59 in mm:ss');
  assert.equal(parseTimestamp('[01:23]'), 83, 'surrounding brackets are ignored');
});

test('parseTimestamp reads unit forms', () => {
  assert.equal(parseTimestamp('1m23s'), 83);
  assert.equal(parseTimestamp('1m 23s'), 83);
  assert.equal(parseTimestamp('2 min'), 120);
  assert.equal(parseTimestamp('1h 2m 3s'), 3723);
});

test('parseTimestamp refuses to guess: junk, negatives, impossible clocks', () => {
  for (const bad of ['', '   ', 'abc', '-5', '01:75', '00:61:00', '00:00:75', '1:2:3:4', '500ms', 'at 01:23']) {
    assert.equal(parseTimestamp(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [], true]) {
    assert.equal(parseTimestamp(bad as unknown), null);
  }
});

test('splitTimestampRange splits "start - end" strings in the usual notations', () => {
  assert.deepEqual(splitTimestampRange('01:23 - 02:30'), ['01:23', '02:30']);
  assert.deepEqual(splitTimestampRange('1:23 – 2:30'), ['1:23', '2:30']);
  assert.deepEqual(splitTimestampRange('12.5s to 20s'), ['12.5s', '20s']);
  assert.deepEqual(splitTimestampRange('[00:01:23 - 00:02:30]'), ['00:01:23', '00:02:30']);
  assert.equal(splitTimestampRange('01:23'), null);
  assert.equal(splitTimestampRange('1 - 2 - 3'), null);
  assert.equal(splitTimestampRange(12), null);
});

/* ------------------------------------------------------------------ */
/* Finding the clips inside the model's text                           */
/* ------------------------------------------------------------------ */

test('extractViralClips reads the top-level { clips: [...] } object', () => {
  const extracted = extractViralClips(aiResponse([aiClip(), aiClip({ rank: 2 })]));
  assert.ok(extracted);
  assert.equal(extracted.clips.length, 2);
  assert.equal(extracted.truncated, false);
});

test('extractViralClips ignores prose, brackets in prose, and ```json fences', () => {
  const body = aiResponse([aiClip()]);
  const wrapped = `Sure! Here are the clips [as requested]:\n\n\`\`\`json\n${body}\n\`\`\`\n\nLet me know if you need more {anything}.`;
  const extracted = extractViralClips(wrapped);
  assert.ok(extracted);
  assert.equal(extracted.clips.length, 1);
});

test('extractViralClips still reads the old bare-array format and a single clip object', () => {
  const legacy = extractViralClips('[{"start": 10, "end": 80, "reason": "x"}]');
  assert.equal(legacy?.clips.length, 1);

  const single = extractViralClips(JSON.stringify(aiClip()));
  assert.equal(single?.clips.length, 1);
});

test('extractViralClips distinguishes "empty list" from "nothing found"', () => {
  assert.deepEqual(extractViralClips('{"clips": []}'), { clips: [], truncated: false });
  assert.deepEqual(extractViralClips('[]'), { clips: [], truncated: false });
  assert.equal(extractViralClips('I could not find any viral moments, sorry.'), null);
  assert.equal(extractViralClips(''), null);
});

test('extractViralClips tolerates trailing commas', () => {
  const extracted = extractViralClips('{"clips": [{"timestamp": {"start": "1:00", "end": "2:00",},},],}');
  assert.equal(extracted?.clips.length, 1);
});

test('extractViralClips salvages the finished clips when the output was cut off', () => {
  const full = aiResponse([aiClip({ rank: 1 }), aiClip({ rank: 2 }), aiClip({ rank: 3 })]);
  // Cut in the middle of the third clip, inside a nested array.
  const cut = full.slice(0, full.lastIndexOf('"risky_words"') + 20);
  const extracted = extractViralClips(cut);
  assert.ok(extracted);
  assert.equal(extracted.truncated, true);
  assert.equal(extracted.clips.length, 2);
  assert.deepEqual(
    extracted.clips.map((clip) => (clip as RawClip).rank),
    [1, 2]
  );
});

test('extractViralClips returns null when the output was cut off before any clip finished', () => {
  const full = aiResponse([aiClip()]);
  assert.equal(extractViralClips(full.slice(0, 200)), null);
});

test('extractViralClips keeps the good clips when ONE clip is malformed', () => {
  const good1 = JSON.stringify(aiClip({ rank: 1 }));
  const broken = '{"rank": 2, "timestamp": {"start": "1:00" "end": "2:00"}}'; // missing comma
  const good3 = JSON.stringify(aiClip({ rank: 3 }));
  const extracted = extractViralClips(`{"clips": [${good1}, ${broken}, ${good3}]}`);
  assert.ok(extracted);
  assert.equal(extracted.truncated, false);
  assert.deepEqual(
    extracted.clips.map((clip) => (clip as RawClip).rank),
    [1, 3]
  );
});

test('extractViralClips is not fooled by braces, brackets or quotes inside strings', () => {
  const tricky = aiClip({
    why_this_will_go_viral: 'He says "}]" and then {"clips": [ in the middle of a sentence\\.',
  });
  const full = aiResponse([tricky, aiClip({ rank: 2 })]);
  const extracted = extractViralClips(full);
  assert.equal(extracted?.clips.length, 2);

  const cut = extractViralClips(full.slice(0, full.length - 40));
  assert.equal(cut?.truncated, true);
  assert.equal(cut?.clips.length, 1);
  assert.equal((cut?.clips[0] as RawClip).why_this_will_go_viral, tricky.why_this_will_go_viral);
});

/* ------------------------------------------------------------------ */
/* Field mapping (the contract from the task)                          */
/* ------------------------------------------------------------------ */

test('every mapped field lands where the app expects it', () => {
  const segment = normalizeOne(aiClip());

  assert.equal(segment.start, 65, 'timestamp.start -> start');
  assert.equal(segment.end, 130, 'timestamp.end -> end');
  assert.equal(segment.rank, 1, 'rank -> rank');
  assert.equal(segment.reason, aiClip().why_this_will_go_viral, 'why_this_will_go_viral -> reason (viralReason)');
  assert.equal(segment.score, 9.2, 'scores.viral_score -> score (viralScore)');
  assert.equal(segment.hookLine, 'I had four hundred dollars left in my account.', 'hook_line -> hookLine');
  assert.equal(segment.hookLineStart, 80, 'hook_timestamp.start -> hookLineStart');
  assert.equal(segment.hookLineEnd, 84, 'hook_timestamp.end -> hookLineEnd');
  assert.equal(segment.retentionStrength, 'Strong', 'predicted_retention -> retentionStrength');
  assert.equal(segment.psychologicalTrigger, 'Curiosity', 'dominant_trigger -> psychologicalTrigger');
  assert.equal(segment.safetyRisk, 'Medium', 'risk_level -> safetyRisk');
  assert.equal(segment.title, 'He quit his job with $400 in the bank 😳', 'video_title -> title');
  assert.equal(segment.hookText, 'HE HAD $400 LEFT', 'hook_text_on_video -> hookText (upper-cased like before)');
  assert.equal(segment.ctaText, 'Would you have done it? 👇', 'cta_text -> ctaText');
  assert.deepEqual(segment.hashtags, ['#mindset', '#startup', '#risk'], 'hashtags -> hashtags');
  assert.equal(segment.placeBeforeClip, true, 'place_before_clip is kept');
  assert.deepEqual(segment.scores, { viral: 9.2, retention: 8.5, controversy: 6, shareability: 8 });
  assert.equal(segment.safetyNotes, 'damn -> darn (replace)', 'risky words are summarised for the old safety box');
});

test('clipFieldsFromSegment carries every AI-derived field onto the clip record', () => {
  const segment = normalizeOne(aiClip());
  const fields = clipFieldsFromSegment(segment);

  assert.equal(fields.viralScore, segment.score);
  assert.equal(fields.viralReason, segment.reason);
  assert.equal(fields.rank, 1);
  assert.equal(fields.title, segment.title);
  assert.equal(fields.hookLine, segment.hookLine);
  assert.equal(fields.hookLineStart, 80);
  assert.equal(fields.hookLineEnd, 84);
  assert.equal(fields.placeBeforeClip, true);
  assert.deepEqual(fields.hashtags, segment.hashtags);
  assert.equal(fields.retentionStrength, 'Strong');
  assert.equal(fields.psychologicalTrigger, 'Curiosity');
  assert.equal(fields.safetyRisk, 'Medium');
  assert.equal(fields.safetyNotes, segment.safetyNotes);
  assert.deepEqual(fields.scores, segment.scores);
  assert.strictEqual(fields.analysis, segment.analysis);

  assert.equal(
    clipFieldsFromSegment({ ...segment, reason: '' }).viralReason,
    undefined,
    'an empty reason is not stored as an empty string'
  );
});

/* ------------------------------------------------------------------ */
/* Nothing nested is thrown away                                       */
/* ------------------------------------------------------------------ */

test('the complete nested analysis is preserved', () => {
  const { analysis } = normalizeOne(aiClip());
  assert.deepEqual(analysis, {
    schemaVersion: 1,
    whyThisWillGoViral: aiClip().why_this_will_go_viral,
    duration: { minutes: 1, seconds: 5, totalSeconds: 65 },
    hookLineAnalysis: {
      hookLine: 'I had four hundred dollars left in my account.',
      hookTimestamp: { start: 80, end: 84 },
      whyItWorks: 'A concrete number plus a confession opens a curiosity gap.',
      placeBeforeClip: true,
    },
    retentionAnalysis: {
      curiosityFirst3Seconds: 'The viewer wants to know how he survived on $400.',
      payoffLocation: '00:01:58',
      openLoop: true,
      likelyToWatchTillEnd: true,
      predictedRetention: 'Strong',
    },
    psychologicalTrigger: {
      dominantTrigger: 'Curiosity',
      explanation: 'The unanswered "how" keeps people watching to the payoff.',
    },
    safetyAnalysis: {
      riskLevel: 'Medium',
      monetizationRisk: 'Low - one mild swear word.',
      reusedContentRisk: 'Low - original conversation.',
      algorithmSuppressionRisk: 'Low',
      ineligibleForFypRisk: 'Low',
      riskyWords: [{ wordOrPhrase: 'damn', action: 'replace', saferReplacement: 'darn' }],
    },
    viralPackaging: {
      hookTextOnVideo: 'He had $400 left',
      videoTitle: 'He quit his job with $400 in the bank 😳',
      ctaText: 'Would you have done it? 👇',
      hashtags: ['#mindset', '#startup', '#risk'],
      platformSafe: true,
      eligibilityOrReachConcerns: 'Mild language in the first minute.',
      wordsToChange: ['damn'],
    },
    scores: { viral: 9.2, retention: 8.5, controversy: 6, shareability: 8 },
  });
});

test('the preserved analysis keeps the AI original even though hookText is upper-cased', () => {
  const segment = normalizeOne(aiClip());
  assert.equal(segment.hookText, 'HE HAD $400 LEFT');
  assert.equal(segment.analysis?.viralPackaging.hookTextOnVideo, 'He had $400 left');
});

test('a normalized segment survives a JSON round trip unchanged (what SQLite stores)', () => {
  const segment = normalizeOne(aiClip());
  assert.deepEqual(JSON.parse(JSON.stringify(segment)), segment);
});

test('place_before_clip false is kept as false, not dropped', () => {
  const segment = normalizeOne(
    aiClip({
      hook_line_analysis: {
        hook_line: 'x',
        hook_timestamp: { start: '01:20', end: '01:24' },
        place_before_clip: false,
      },
    })
  );
  assert.equal(segment.placeBeforeClip, false);
  assert.equal(segment.analysis?.hookLineAnalysis.placeBeforeClip, false);
});

/* ------------------------------------------------------------------ */
/* Enum placeholders                                                   */
/* ------------------------------------------------------------------ */

test('the echoed schema placeholder is never stored as a literal value', () => {
  const segment = normalizeOne(
    aiClip({
      retention_analysis: { predicted_retention: 'Weak | Medium | Strong | Extreme' },
      psychological_trigger: {
        dominant_trigger: 'Curiosity | Anger | Inspiration | Shock | Validation | Fear | Controversy | Humor',
        explanation: 'x',
      },
      safety_analysis: {
        risk_level: 'Low | Medium | High',
        risky_words: [{ word_or_phrase: 'damn', action: 'censor | replace | mute | remove', safer_replacement: 'darn' }],
      },
    })
  );
  assert.equal(segment.retentionStrength, undefined);
  assert.equal(segment.psychologicalTrigger, undefined);
  assert.equal(segment.safetyRisk, undefined);
  assert.equal(segment.analysis?.retentionAnalysis.predictedRetention, undefined);
  assert.equal(segment.analysis?.psychologicalTrigger.dominantTrigger, undefined);
  assert.equal(segment.analysis?.safetyAnalysis.riskLevel, undefined);
  assert.equal(segment.analysis?.safetyAnalysis.riskyWords[0].action, undefined);
  assert.equal(segment.analysis?.safetyAnalysis.riskyWords[0].wordOrPhrase, 'damn', 'the rest of the entry survives');
});

test('enum fields accept any casing and decoration around exactly one allowed value', () => {
  const pick = (retention: string, trigger: string, risk: string, action: string) =>
    normalizeOne(
      aiClip({
        retention_analysis: { predicted_retention: retention },
        psychological_trigger: { dominant_trigger: trigger },
        safety_analysis: { risk_level: risk, risky_words: [{ word_or_phrase: 'w', action }] },
      })
    );

  const a = pick('strong', 'curiosity', 'high', 'Mute');
  assert.deepEqual(
    [a.retentionStrength, a.psychologicalTrigger, a.safetyRisk, a.analysis?.safetyAnalysis.riskyWords[0].action],
    ['Strong', 'Curiosity', 'High', 'mute']
  );

  const b = pick('EXTREME 🔥', 'Humor (laughing at himself)', 'Low risk overall', 'remove it');
  assert.deepEqual(
    [b.retentionStrength, b.psychologicalTrigger, b.safetyRisk, b.analysis?.safetyAnalysis.riskyWords[0].action],
    ['Extreme', 'Humor', 'Low', 'remove']
  );
});

test('a value naming two allowed options is ambiguous and dropped, not guessed', () => {
  const segment = normalizeOne(
    aiClip({
      retention_analysis: { predicted_retention: 'Strong to Extreme' },
      psychological_trigger: { dominant_trigger: 'Shock and Fear' },
      safety_analysis: { risk_level: 'Medium-High' },
    })
  );
  assert.equal(segment.retentionStrength, undefined);
  assert.equal(segment.psychologicalTrigger, undefined);
  assert.equal(segment.safetyRisk, undefined);
});

test('values outside the allowed set are dropped', () => {
  const segment = normalizeOne(
    aiClip({
      retention_analysis: { predicted_retention: 'Amazing' },
      psychological_trigger: { dominant_trigger: 'Nostalgia' },
      safety_analysis: { risk_level: 'Severe' },
    })
  );
  assert.equal(segment.retentionStrength, undefined);
  assert.equal(segment.psychologicalTrigger, undefined);
  assert.equal(segment.safetyRisk, undefined);
});

/* ------------------------------------------------------------------ */
/* Numbers, arrays and objects are validated                           */
/* ------------------------------------------------------------------ */

test('scores are coerced to numbers and clamped to 0-10', () => {
  const segment = normalizeOne(
    aiClip({
      scores: { viral_score: '8.5', retention_score: '9/10', controversy_score: 14, shareability_score: -3 },
    })
  );
  assert.deepEqual(segment.scores, { viral: 8.5, retention: 9, controversy: 10, shareability: 0 });
  assert.equal(segment.score, 8.5);
});

test('unusable scores are left out; a missing viral score falls back to the legacy default', () => {
  const segment = normalizeOne(
    aiClip({
      scores: { viral_score: 'high', retention_score: null, controversy_score: 7, shareability_score: Number.NaN },
    })
  );
  assert.equal(segment.score, DEFAULT_VIRAL_SCORE);
  assert.equal(segment.scores, undefined, 'the four-score summary needs all four numbers');
  assert.deepEqual(segment.analysis?.scores, { controversy: 7 }, 'but the valid score is still preserved');
});

test('all four scores present gives the complete summary the old UI needs', () => {
  const segment = normalizeOne(aiClip());
  assert.deepEqual(Object.keys(segment.scores ?? {}).sort(), ['controversy', 'retention', 'shareability', 'viral']);
  for (const value of Object.values(segment.scores ?? {})) assert.equal(typeof value, 'number');
});

test('hashtags: strings, missing #, duplicates, junk and the empty schema placeholder', () => {
  const messy = normalizeOne(
    aiClip({
      viral_packaging: { hashtags: ['mindset', '#Mindset', '  #start up ', '', 7, null, '#'] },
    })
  );
  assert.deepEqual(messy.hashtags, ['#mindset', '#startup']);

  const fromString = normalizeOne(aiClip({ viral_packaging: { hashtags: '#a #b, c' } }));
  assert.deepEqual(fromString.hashtags, ['#a', '#b', '#c']);

  const placeholder = normalizeOne(aiClip({ viral_packaging: { hashtags: ['', '', ''] } }));
  assert.equal(placeholder.hashtags, undefined);
  assert.deepEqual(placeholder.analysis?.viralPackaging.hashtags, []);

  const many = normalizeOne(aiClip({ viral_packaging: { hashtags: Array.from({ length: 40 }, (_, i) => `#tag${i}`) } }));
  assert.equal(many.hashtags?.length, 15);
});

test('risky_words and words_to_change accept strings and objects, and skip junk entries', () => {
  const segment = normalizeOne(
    aiClip({
      safety_analysis: {
        risk_level: 'High',
        risky_words: [
          { word_or_phrase: 'damn', action: 'replace', safer_replacement: 'darn' },
          'hell',
          { word: 'crap' },
          { action: 'mute' },
          42,
          null,
          { word_or_phrase: '' },
        ],
      },
      viral_packaging: {
        words_to_change: ['damn', { word_or_phrase: 'hell', safer_replacement: 'heck' }, { word: 'crap' }, 5, {}],
      },
    })
  );
  assert.deepEqual(segment.analysis?.safetyAnalysis.riskyWords, [
    { wordOrPhrase: 'damn', action: 'replace', saferReplacement: 'darn' },
    { wordOrPhrase: 'hell' },
    { wordOrPhrase: 'crap' },
  ]);
  assert.deepEqual(segment.analysis?.viralPackaging.wordsToChange, ['damn', 'hell → heck', 'crap']);
  assert.equal(segment.safetyNotes, 'damn -> darn (replace); hell; crap');
});

test('a clip with no risky words gets the "no risky wording" note the dashboard hides', () => {
  const segment = normalizeOne(aiClip({ safety_analysis: { risk_level: 'Low', risky_words: [] } }));
  assert.equal(segment.safetyNotes, NO_RISKY_WORDING_NOTE);
  assert.deepEqual(segment.analysis?.safetyAnalysis.riskyWords, []);
});

test('booleans accept real booleans and clear yes/no strings only', () => {
  const segment = normalizeOne(
    aiClip({
      retention_analysis: { open_loop: 'true', likely_to_watch_till_end: 'No' },
      viral_packaging: { platform_safe: 'true | false' },
    })
  );
  assert.equal(segment.analysis?.retentionAnalysis.openLoop, true);
  assert.equal(segment.analysis?.retentionAnalysis.likelyToWatchTillEnd, false);
  assert.equal(segment.analysis?.viralPackaging.platformSafe, undefined);
});

test('wrongly typed blocks and fields never crash the clip: they just come out empty', () => {
  const segment = normalizeOne(
    aiClip({
      hook_line_analysis: 'oops',
      retention_analysis: ['a'],
      psychological_trigger: 5,
      safety_analysis: null,
      viral_packaging: 'none',
      scores: '9',
      duration: 'a minute',
      why_this_will_go_viral: { text: 'nope' },
    })
  );
  assert.equal(segment.start, 65, 'the time window is still good');
  assert.equal(segment.end, 130);
  assert.equal(segment.reason, '');
  assert.equal(segment.hookText, '');
  assert.equal(segment.score, DEFAULT_VIRAL_SCORE);
  assert.equal(segment.title, undefined);
  assert.deepEqual(segment.analysis?.hookLineAnalysis, {});
  assert.deepEqual(segment.analysis?.safetyAnalysis, { riskyWords: [] });
  assert.deepEqual(segment.analysis?.viralPackaging, { hashtags: [], wordsToChange: [] });
  assert.deepEqual(segment.analysis?.scores, {});
});

test('text fields are trimmed, single-spaced, capped, and never split an emoji', () => {
  const longTitle = `${'a'.repeat(158)}😳😳😳`;
  const segment = normalizeOne(
    aiClip({
      viral_packaging: { video_title: longTitle, cta_text: '  Would   you\n  do it?  ' },
      why_this_will_go_viral: 'x'.repeat(5000),
    })
  );
  assert.equal(segment.ctaText, 'Would you do it?');
  assert.equal(Array.from(segment.title ?? '').length, 160);
  assert.ok(!/[\ud800-\udbff]$/.test(segment.title ?? ''), 'no dangling half of a surrogate pair');
  assert.equal(segment.reason.length, 600);
});

test('rank is read from numbers and strings; junk ranks are dropped', () => {
  assert.equal(normalizeOne(aiClip({ rank: 3 })).rank, 3);
  assert.equal(normalizeOne(aiClip({ rank: '2' })).rank, 2);
  assert.equal(normalizeOne(aiClip({ rank: 'Clip #4' })).rank, 4);
  assert.equal(normalizeOne(aiClip({ rank: 0 })).rank, undefined);
  assert.equal(normalizeOne(aiClip({ rank: 'first' })).rank, undefined);
  assert.equal(normalizeOne(aiClip({ rank: undefined })).rank, undefined);
});

/* ------------------------------------------------------------------ */
/* The clip's time window                                              */
/* ------------------------------------------------------------------ */

test('timestamps in every notation give the same window', () => {
  const variants: unknown[] = [
    { start: '00:01:05', end: '00:02:10' },
    { start: '01:05', end: '02:10' },
    { start: '65', end: '130' },
    { start: '65.0s', end: '130.0s' },
    { start: 65, end: 130 },
    { start: '1m5s', end: '2m10s' },
    '01:05 - 02:10',
    '65s to 130s',
  ];
  for (const timestamp of variants) {
    const segment = normalizeOne(aiClip({ timestamp }));
    assert.deepEqual([segment.start, segment.end], [65, 130], JSON.stringify(timestamp));
  }
});

test('flattened start/end beside the nested blocks are accepted', () => {
  const clip = aiClip();
  delete clip.timestamp;
  const segment = normalizeOne({ ...clip, start: '01:05', end: '02:10' });
  assert.deepEqual([segment.start, segment.end], [65, 130]);
});

test('a missing end is rebuilt from the reported duration', () => {
  const segment = normalizeOne(aiClip({ timestamp: { start: '01:05', end: '' }, duration: { total_seconds: 70 } }));
  assert.deepEqual([segment.start, segment.end], [65, 135]);
});

test('an end past the video is clamped to the video length', () => {
  const segment = normalizeOne(aiClip({ timestamp: { start: '00:08:00', end: '00:12:00' } }));
  assert.deepEqual([segment.start, segment.end], [480, VIDEO_SECONDS]);
});

test('clips with an untrustworthy window are skipped and reported - the rest survive', () => {
  const clips = [
    aiClip({ rank: 1 }),
    aiClip({ rank: 2, timestamp: { start: '02:10', end: '01:05' } }), // ends before it starts
    aiClip({ rank: 3, timestamp: { start: 'soon', end: 'later' } }), // unreadable
    aiClip({ rank: 4, timestamp: { start: '00:11:00', end: '00:12:00' } }), // after the 10 min video
    aiClip({ rank: 5, timestamp: { start: '01:05', end: '01:05' } }), // zero length
    aiClip({ rank: 6, timestamp: { start: '09:59.5', end: '10:30' } }), // < 1s inside the video
    'not even an object',
    aiClip({ rank: 8, timestamp: { start: '03:00', end: '04:00' } }),
  ];
  const { segments, issues } = normalizeViralClips(clips, { videoDuration: VIDEO_SECONDS });

  assert.deepEqual(
    segments.map((segment) => segment.rank),
    [1, 8]
  );
  assert.deepEqual(
    issues.map((issue) => issue.index),
    [1, 2, 3, 4, 5, 6]
  );
  assert.match(issues[0].message, /at or before it starts/);
  assert.match(issues[1].message, /start time is missing or unreadable/);
  assert.match(issues[2].message, /past the end of the 600\.0s video/);
  assert.match(issues[4].message, /only 0\.5s of it lies inside/);
  assert.match(issues[5].message, /not a JSON object/);
});

test('an unusable videoDuration does not reject clips (no upper bound is applied)', () => {
  const segment = normalizeOne(aiClip({ timestamp: { start: '50:00', end: '51:00' } }), Number.NaN);
  assert.deepEqual([segment.start, segment.end], [3000, 3060]);
});

/* ------------------------------------------------------------------ */
/* The hook line's moment                                              */
/* ------------------------------------------------------------------ */

const hookBlock = (hook_timestamp: unknown) => ({
  hook_line: 'the line',
  hook_timestamp,
  why_it_works: 'because',
  place_before_clip: true,
});

test('a hook inside the clip is used as given', () => {
  const segment = normalizeOne(aiClip({ hook_line_analysis: hookBlock({ start: '01:20', end: '01:24' }) }));
  assert.deepEqual([segment.hookLineStart, segment.hookLineEnd], [80, 84]);
  assert.deepEqual(segment.analysis?.hookLineAnalysis.hookTimestamp, { start: 80, end: 84 });
});

test('a hook outside the clip is dropped (the renderer falls back to the first seconds) but its text is kept', () => {
  for (const timestamp of [
    { start: '00:00:10', end: '00:00:14' }, // before the clip
    { start: '00:05:00', end: '00:05:04' }, // after the clip
  ]) {
    const segment = normalizeOne(aiClip({ hook_line_analysis: hookBlock(timestamp) }));
    assert.equal(segment.hookLineStart, undefined);
    assert.equal(segment.hookLineEnd, undefined);
    assert.equal(segment.analysis?.hookLineAnalysis.hookTimestamp, undefined);
    assert.equal(segment.hookLine, 'the line');
    assert.equal(segment.analysis?.hookLineAnalysis.whyItWorks, 'because');
  }
});

test('a hook straddling the clip edge is clamped; a start-only hook keeps just its start', () => {
  const straddle = normalizeOne(aiClip({ hook_line_analysis: hookBlock({ start: '01:00', end: '01:10' }) }));
  assert.deepEqual([straddle.hookLineStart, straddle.hookLineEnd], [65, 70]);

  const startOnly = normalizeOne(aiClip({ hook_line_analysis: hookBlock({ start: '01:30', end: 'x' }) }));
  assert.equal(startOnly.hookLineStart, 90);
  assert.equal(startOnly.hookLineEnd, undefined);
  assert.equal(startOnly.analysis?.hookLineAnalysis.hookTimestamp, undefined, 'a range needs both ends');

  const reversed = normalizeOne(aiClip({ hook_line_analysis: hookBlock({ start: '01:30', end: '01:20' }) }));
  assert.equal(reversed.hookLineStart, 90);
  assert.equal(reversed.hookLineEnd, undefined);

  const asString = normalizeOne(aiClip({ hook_line_analysis: hookBlock('01:20 - 01:24') }));
  assert.deepEqual([asString.hookLineStart, asString.hookLineEnd], [80, 84]);

  const unreadable = normalizeOne(aiClip({ hook_line_analysis: hookBlock({ start: '', end: '' }) }));
  assert.equal(unreadable.hookLineStart, undefined);
});

test('fitHookToWindow clamps to the window and rejects non-overlapping hooks', () => {
  const window = { start: 100, end: 160 };
  assert.deepEqual(fitHookToWindow({ start: 110, end: 114 }, window), { start: 110, end: 114 });
  assert.deepEqual(fitHookToWindow({ start: 90, end: 105 }, window), { start: 100, end: 105 });
  assert.deepEqual(fitHookToWindow({ start: 150, end: 170 }, window), { start: 150, end: 160 });
  assert.equal(fitHookToWindow({ start: 80, end: 100 }, window), undefined);
  assert.equal(fitHookToWindow({ start: 160, end: 170 }, window), undefined);
  assert.deepEqual(fitHookToWindow({ start: 99.5 }, window), { start: 100 }, 'start-only hooks get 1s of slack');
  assert.equal(fitHookToWindow({ start: 90 }, window), undefined);
  assert.equal(fitHookToWindow(undefined, window), undefined);
});

/* ------------------------------------------------------------------ */
/* normalizeViralResponse: text or parsed JSON in, segments out        */
/* ------------------------------------------------------------------ */

test('normalizeViralResponse accepts the raw model text', () => {
  const text = `Here you go:\n\`\`\`json\n${aiResponse([aiClip({ rank: 1 }), aiClip({ rank: 2 })])}\n\`\`\``;
  const result = normalizeViralResponse(text, { videoDuration: VIDEO_SECONDS });
  assert.equal(result.found, true);
  assert.equal(result.truncated, false);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.issues, []);
});

test('normalizeViralResponse accepts an already-parsed object or array', () => {
  const fromObject = normalizeViralResponse({ clips: [aiClip()] }, { videoDuration: VIDEO_SECONDS });
  assert.equal(fromObject.segments.length, 1);
  const fromArray = normalizeViralResponse([aiClip(), aiClip()], { videoDuration: VIDEO_SECONDS });
  assert.equal(fromArray.segments.length, 2);
});

test('normalizeViralResponse reports "nothing found" instead of throwing', () => {
  for (const junk of ['no json here', '', null, 42, { unrelated: true }]) {
    const result = normalizeViralResponse(junk, { videoDuration: VIDEO_SECONDS });
    assert.equal(result.found, false);
    assert.deepEqual(result.segments, []);
  }
});

test('normalizeViralResponse flags a cut-off response but keeps the finished clips', () => {
  const full = aiResponse([aiClip({ rank: 1 }), aiClip({ rank: 2 })]);
  const result = normalizeViralResponse(full.slice(0, full.length - 120), { videoDuration: VIDEO_SECONDS });
  assert.equal(result.truncated, true);
  assert.equal(result.segments.length, 1);
});

/* ------------------------------------------------------------------ */
/* The previous flat format still works                                */
/* ------------------------------------------------------------------ */

const legacyClip = {
  start: 120.5,
  end: 182,
  title: 'He quit his job with $400 in the bank 😳',
  score: 9.4,
  reason: 'Immediate emotional tension.',
  hookText: 'he quit with $400 left',
  hookLine: 'I literally had four hundred dollars in my account',
  hookLineStart: 122.1,
  hookLineEnd: 125.8,
  ctaText: 'Would you have done it? 👇',
  hashtags: ['#mindset', '#startup', '#risk'],
  retentionStrength: 'Strong',
  psychologicalTrigger: 'Curiosity',
  safetyRisk: 'Low',
  safetyNotes: 'No risky wording detected.',
  scores: { viral: 9, retention: 9, controversy: 7, shareability: 8 },
};

test('an old flat clip maps exactly as it did before the schema change', () => {
  const segment = normalizeOne(legacyClip);
  assert.equal(segment.start, 120.5);
  assert.equal(segment.end, 182);
  assert.equal(segment.score, 9.4);
  assert.equal(segment.reason, 'Immediate emotional tension.');
  assert.equal(segment.hookText, 'HE QUIT WITH $400 LEFT');
  assert.equal(segment.title, legacyClip.title);
  assert.equal(segment.ctaText, legacyClip.ctaText);
  assert.equal(segment.hookLine, legacyClip.hookLine);
  assert.equal(segment.hookLineStart, 122.1);
  assert.equal(segment.hookLineEnd, 125.8);
  assert.deepEqual(segment.hashtags, legacyClip.hashtags);
  assert.equal(segment.retentionStrength, 'Strong');
  assert.equal(segment.psychologicalTrigger, 'Curiosity');
  assert.equal(segment.safetyRisk, 'Low');
  assert.equal(segment.safetyNotes, 'No risky wording detected.');
  assert.deepEqual(segment.scores, legacyClip.scores);
  assert.equal(segment.rank, undefined, 'the old format had no rank');
});

test('old flat safetyNotes text is carried over verbatim', () => {
  const segment = normalizeOne({ ...legacyClip, safetyNotes: 'damn -> darn; hell -> heck' });
  assert.equal(segment.safetyNotes, 'damn -> darn; hell -> heck');
});

test('an old flat clip without a reason is no longer fatal', () => {
  const { reason: _reason, ...withoutReason } = legacyClip;
  void _reason;
  const segment = normalizeOne(withoutReason);
  assert.equal(segment.reason, '');
  assert.equal(segment.start, 120.5);
});

test('the old bare-array response normalizes end to end', () => {
  const text = JSON.stringify([legacyClip, { ...legacyClip, start: 300, end: 360, score: 7 }]);
  const result = normalizeViralResponse(text, { videoDuration: VIDEO_SECONDS });
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].start, 300);
});

test('old flat string enums are validated too (no literal placeholders)', () => {
  const segment = normalizeOne({ ...legacyClip, retentionStrength: 'Weak | Medium | Strong | Extreme', safetyRisk: 'High' });
  assert.equal(segment.retentionStrength, undefined);
  assert.equal(segment.safetyRisk, 'High');
});

/* ------------------------------------------------------------------ */
/* The shipped prompt and the normalizer stay in sync                  */
/* ------------------------------------------------------------------ */

/** Every key path of a JSON value; arrays descend into their first object element as "path[]". */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    const first = value[0];
    return first !== null && typeof first === 'object' ? keyPaths(first, `${prefix}[]`) : [prefix];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function shippedSchemaClip(): RawClip {
  const template = DEFAULT_PROMPT_TEMPLATES.find((entry) => entry.type === 'viral_detection');
  assert.ok(template, 'the viral_detection default template exists');
  const schema = extractViralClips(template.template.slice(template.template.indexOf('JSON SCHEMA:')));
  assert.equal(schema?.clips.length, 1, 'the prompt embeds a one-clip schema example');
  return schema.clips[0] as RawClip;
}

test('the shipped prompt schema has exactly the fields the tests (and so the normalizer) cover', () => {
  assert.deepEqual(
    keyPaths(aiClip()).sort(),
    keyPaths(shippedSchemaClip()).sort(),
    'if the prompt schema changes, update tests/viral-fixtures.ts and lib/viral-response.ts together'
  );
});

test('a model that echoes the schema verbatim never produces placeholder data', () => {
  const echoed = shippedSchemaClip();

  // The schema example has empty timestamps: that clip is skipped, not invented.
  const skipped = normalizeViralClips([echoed], { videoDuration: VIDEO_SECONDS });
  assert.equal(skipped.segments.length, 0);
  assert.match(skipped.issues[0].message, /start time is missing or unreadable/);

  // With only the time window filled in, every placeholder string is dropped.
  const segment = normalizeOne({ ...echoed, timestamp: { start: '01:05', end: '02:10' } });
  assert.equal(segment.retentionStrength, undefined);
  assert.equal(segment.psychologicalTrigger, undefined);
  assert.equal(segment.safetyRisk, undefined);
  assert.equal(segment.title, undefined);
  assert.equal(segment.ctaText, undefined);
  assert.equal(segment.hookText, '');
  assert.equal(segment.hashtags, undefined);
  assert.equal(segment.hookLineStart, undefined);
  assert.deepEqual(segment.analysis?.safetyAnalysis.riskyWords, []);
  assert.equal(segment.safetyNotes, NO_RISKY_WORDING_NOTE);
});
