/**
 * The AI response contract (lib/viral-response.ts): exactly { "clips": [...] },
 * every field checked against the schema, anything else a clear error.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../lib/errors';
import { DEFAULT_PROMPT_TEMPLATES } from '../lib/presets';
import { parseTimestamp, parseViralResponse } from '../lib/viral-response';
import { aiClip, aiResponse, validClip } from './viral-fixtures';

const VIDEO_SECONDS = 600;

/** The message of the AppError a response must be rejected with. */
function rejection(text: string, videoDuration = VIDEO_SECONDS): string {
  try {
    parseViralResponse(text, videoDuration);
  } catch (error) {
    assert.ok(error instanceof AppError, 'rejections are AppErrors');
    assert.equal(error.status, 502);
    return error.message;
  }
  return assert.fail('the response should have been rejected');
}

/**
 * The message for a response whose only clip is the valid fixture with the field at
 * `path` replaced by `value` (or removed when `value` is undefined).
 */
function brokenAt(path: string, value: unknown): string {
  const clip = structuredClone(validClip()) as unknown as Record<string, unknown>;
  const keys = path.split('.');
  const last = keys[keys.length - 1];
  const parent = keys
    .slice(0, -1)
    .reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, clip);
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return rejection(aiResponse([clip]));
}

/* ------------------------------------------------------------------ */
/* Timestamps                                                          */
/* ------------------------------------------------------------------ */

test('parseTimestamp reads seconds (the transcript style) and clocks', () => {
  const accepted: Array<[string, number]> = [
    ['12.5', 12.5],
    ['12.5s', 12.5],
    [' 125 ', 125],
    ['01:23', 83],
    ['1:23', 83],
    ['00:01:23', 83],
    ['1:02:03', 3723],
    ['1:02:03.5', 3723.5],
    ['125:30', 7530],
  ];
  for (const [text, seconds] of accepted) assert.equal(parseTimestamp(text), seconds, text);
});

test('parseTimestamp has no other formats: everything else is null', () => {
  for (const text of ['', 'abc', '-5', '1m23s', '12.5 seconds', '[01:23]', '1,5', '01:75', '00:61:00', '00:00:75', '1:2:3:4']) {
    assert.equal(parseTimestamp(text), null, JSON.stringify(text));
  }
});

/* ------------------------------------------------------------------ */
/* The happy path                                                      */
/* ------------------------------------------------------------------ */

test('a valid response gives numeric windows and the clips exactly as the AI sent them', () => {
  const second = { ...validClip(), rank: 2, timestamp: { start: '180.5s', end: '245' } };
  const segments = parseViralResponse(aiResponse([validClip(), second]), VIDEO_SECONDS);

  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [
      [65, 130],
      [180.5, 245],
    ]
  );
  assert.deepEqual(segments[0].clip, validClip(), 'no renaming, coercion or extra copies');
  assert.deepEqual(segments[1].clip, second);
});

test('an end a little past the video is clamped to it', () => {
  const [segment] = parseViralResponse(
    aiResponse([aiClip({ timestamp: { start: '00:08:00', end: '00:12:00' } })]),
    VIDEO_SECONDS
  );
  assert.deepEqual([segment.start, segment.end], [480, VIDEO_SECONDS]);
});

/* ------------------------------------------------------------------ */
/* Only { "clips": [...] } is accepted                                 */
/* ------------------------------------------------------------------ */

test('anything but a JSON object with a clips array is rejected with a clear message', () => {
  const oldFlatClip = { start: 10, end: 80, score: 8, reason: 'x', hookText: 'y' };
  const cases: Array<[string, string, RegExp]> = [
    ['plain text', 'Sorry, nothing viral here.', /not valid JSON/],
    ['markdown-fenced JSON', `\`\`\`json\n${aiResponse([validClip()])}\n\`\`\``, /not valid JSON/],
    ['cut-off JSON', aiResponse([validClip()]).slice(0, 300), /not valid JSON/],
    ['a bare array', JSON.stringify([validClip()]), /"clips" array/],
    ['a single clip object', JSON.stringify(validClip()), /"clips" array/],
    ['clips that is not an array', '{"clips": {}}', /"clips" array/],
    ['an empty clips array', '{"clips": []}', /empty "clips" array/],
    ['the old flat array', JSON.stringify([oldFlatClip]), /"clips" array/],
    ['old flat clips inside clips', JSON.stringify({ clips: [oldFlatClip] }), /clips\[0\]\.rank must be a number \(got undefined\)/],
    ['a non-object clip', '{"clips": ["clip"]}', /clips\[0\] must be an object \(got "clip"\)/],
  ];
  for (const [name, text, expected] of cases) assert.match(rejection(text), expected, name);
});

/* ------------------------------------------------------------------ */
/* Every field is checked, and the error names it                      */
/* ------------------------------------------------------------------ */

test('invalid fields are rejected by path, with the value that was received', () => {
  const cases: Array<[name: string, path: string, value: unknown, expected: RegExp]> = [
    ['missing block', 'scores', undefined, /clips\[0\]\.scores\.viral_score must be a number from 0 to 10 \(got undefined\)/],
    ['rank as a string', 'rank', '1', /clips\[0\]\.rank must be a number \(got "1"\)/],
    ['numeric timestamp', 'timestamp.start', 65, /clips\[0\]\.timestamp\.start must be a string \(got 65\)/],
    ['null instead of ""', 'why_this_will_go_viral', null, /why_this_will_go_viral must be a string \(got null\)/],
    ['missing hook timestamp', 'hook_line_analysis.hook_timestamp', undefined, /hook_timestamp\.start must be a string/],
    ['boolean as a string', 'hook_line_analysis.place_before_clip', 'true', /place_before_clip must be true or false \(got "true"\)/],
    ['score above 10', 'scores.viral_score', 14, /scores\.viral_score must be a number from 0 to 10 \(got 14\)/],
    ['score as "8/10"', 'scores.retention_score', '8/10', /scores\.retention_score must be a number from 0 to 10/],
    ['hashtags as a string', 'viral_packaging.hashtags', '#a #b', /hashtags must be an array of strings/],
    ['hashtag that is not a string', 'viral_packaging.hashtags', [1], /hashtags must be an array of strings/],
    ['words_to_change as objects', 'viral_packaging.words_to_change', [{ word: 'x' }], /words_to_change must be an array of strings/],
    ['risky word as a plain string', 'safety_analysis.risky_words', ['damn'], /risky_words must be an array of \{ word_or_phrase, action, safer_replacement \}/],
    ['risky word with an unknown action', 'safety_analysis.risky_words.0.action', 'delete', /action: censor, replace, mute, remove/],
  ];
  for (const [name, path, value, expected] of cases) assert.match(brokenAt(path, value), expected, name);
});

test('enum fields accept only the project values, spelled exactly - placeholders and wrong case are errors', () => {
  const cases: Array<[name: string, path: string, value: string, expected: RegExp]> = [
    ['echoed placeholder', 'retention_analysis.predicted_retention', 'Weak | Medium | Strong | Extreme', /predicted_retention must be one of: Weak, Medium, Strong, Extreme \(got "Weak \| Medium/],
    ['wrong case', 'psychological_trigger.dominant_trigger', 'curiosity', /dominant_trigger must be one of: Curiosity, Anger, Inspiration, Shock, Validation, Fear, Controversy, Humor/],
    ['unknown value', 'safety_analysis.risk_level', 'Severe', /risk_level must be one of: Low, Medium, High \(got "Severe"\)/],
    ['decorated value', 'retention_analysis.predicted_retention', 'Strong 💪', /predicted_retention must be one of/],
  ];
  for (const [name, path, value, expected] of cases) assert.match(brokenAt(path, value), expected, name);
});

test('one bad clip rejects the whole response and the message says which clip', () => {
  const bad = aiClip({ rank: 3 });
  delete bad.viral_packaging;
  const message = rejection(aiResponse([validClip(), aiClip({ rank: 2 }), bad]));
  assert.match(message, /clips\[2\]\.viral_packaging\.hook_text_on_video must be a string \(got undefined\)/);
});

/* ------------------------------------------------------------------ */
/* The clip window                                                     */
/* ------------------------------------------------------------------ */

test('the window must be readable, start before it ends and lie inside the video', () => {
  const window = (start: string, end: string) => rejection(aiResponse([aiClip({ timestamp: { start, end } })]));

  assert.match(window('soon', 'later'), /clips\[0\]\.timestamp must use seconds \("125\.5s"\) or a clock/);
  assert.match(window('', ''), /must use seconds/);
  assert.match(window('1m5s', '2m10s'), /must use seconds/, 'unit forms are not a format');
  assert.match(window('02:10', '01:05'), /must start before it ends and lie inside the 600s video/);
  assert.match(window('01:05', '01:05'), /must start before it ends/);
  assert.match(window('00:11:00', '00:12:00'), /lie inside the 600s video/);
  assert.match(window('09:59.5', '10:30'), /lie inside the 600s video/, 'under a second left inside the video');
});

/* ------------------------------------------------------------------ */
/* The shipped prompt, the type and the parser stay in sync            */
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

/** The JSON schema example embedded in the shipped viral_detection prompt. */
function shippedSchemaText(): string {
  const template = DEFAULT_PROMPT_TEMPLATES.find((entry) => entry.type === 'viral_detection');
  assert.ok(template, 'the viral_detection default template exists');
  const from = template.template.indexOf('JSON SCHEMA:') + 'JSON SCHEMA:'.length;
  return template.template.slice(from, template.template.indexOf('\n}\n', from) + 2).trim();
}

test('the prompt schema, the ViralClip type (via the typed fixture) and the parser cover the same fields', () => {
  const schema = JSON.parse(shippedSchemaText()) as { clips: unknown[] };
  assert.equal(schema.clips.length, 1, 'the prompt embeds a one-clip schema example');
  assert.deepEqual(
    keyPaths(validClip()).sort(),
    keyPaths(schema.clips[0]).sort(),
    'if the prompt schema changes, update ViralClip (lib/types.ts), FIELDS (lib/viral-response.ts) and tests/viral-fixtures.ts together'
  );
  // ...and the parser needs every one of those fields:
  for (const path of keyPaths(validClip()).filter((entry) => !entry.includes('[]'))) {
    assert.match(brokenAt(path, undefined), new RegExp(`clips\\[0\\]\\.${path.replace(/\./g, '\\.')} must be`), path);
  }
});

test('a model that echoes the prompt schema verbatim is rejected, not turned into data', () => {
  assert.match(rejection(shippedSchemaText()), /clips\[0\]\.retention_analysis\.predicted_retention must be one of/);
});
