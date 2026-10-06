/**
 * End-to-end tests for the AI response schema: the real detectViralSegments
 * orchestration, the real detect-viral / render / delete route handlers and a
 * real temporary SQLite database. Only the network is faked (the Gemini
 * generateContent call), so nothing here can reach a live LLM.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DELETE as deleteClipRoute } from '../app/api/clips/[id]/route';
import { POST as renderClipRoute } from '../app/api/clips/route';
import { POST as detectViralRoute } from '../app/api/videos/[id]/detect-viral/route';
import { detectionMaxTokens, detectViralSegments } from '../lib/ai';
import { sortClipsForDisplay } from '../lib/clip-order';
import { getClip, listClips, savePromptTemplate, saveVideo } from '../lib/db';
import { AppError } from '../lib/errors';
import { claimNextJob, CLIP_QUEUE_NAME } from '../lib/queue';
import type { ClipRecord, JobData } from '../lib/types';
import { parseTimestamp } from '../lib/viral-response';
import { createTemporaryDatabase } from './sqlite-test-helpers';
import { aiClip, aiResponse, makeVideo, type RawClip } from './viral-fixtures';

const VIDEO_SECONDS = 600;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface LlmCall {
  prompt: string;
  system: string;
  maxTokens: number;
  /** generationConfig.responseMimeType - "application/json" when raw JSON was requested. */
  mimeType?: string;
}

/**
 * Replaces fetch with a fake Gemini endpoint: `reply` returns the model's text
 * for call number `index`. Also silences the app's console noise while
 * collecting its warnings so tests can assert on them.
 */
function fakeLlm(t: TestContext, reply: (call: LlmCall, index: number) => string) {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });

  t.mock.method(console, 'log', () => {});
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });

  const calls: LlmCall[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      prompt: body.contents[0].parts[0].text,
      system: body.systemInstruction?.parts?.[0]?.text ?? '',
      maxTokens: body.generationConfig.maxOutputTokens,
      mimeType: body.generationConfig.responseMimeType,
    });
    const text = reply(calls[calls.length - 1], calls.length - 1);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
      { status: 200 }
    );
  });
  return { calls, warnings };
}

const mmss = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Clip number `index` (0-based) in its own 65s window: 60-125, 180-245,
 * 300-365, 420-485. Rank = index + 1; the hook line sits 15-19s into it.
 */
function clipAt(index: number, overrides: RawClip = {}): RawClip {
  const start = 60 + index * 120;
  return aiClip({
    rank: index + 1,
    timestamp: { start: mmss(start), end: mmss(start + 65) },
    hook_line_analysis: {
      hook_line: `Hook line of clip ${index + 1}`,
      hook_timestamp: { start: mmss(start + 15), end: mmss(start + 19) },
      why_it_works: 'It teases the payoff.',
      place_before_clip: true,
    },
    ...overrides,
  });
}

const transcriptOf = () => makeVideo('v', VIDEO_SECONDS).transcript!;

async function runDetectRoute(videoId: string, options: Record<string, unknown>) {
  const response = await detectViralRoute(
    new Request(`http://localhost/api/videos/${videoId}/detect-viral`, {
      method: 'POST',
      body: JSON.stringify({ options }),
    }),
    { params: Promise.resolve({ id: videoId }) }
  );
  return {
    status: response.status,
    body: (await response.json()) as { success?: boolean; clips?: ClipRecord[]; error?: string },
  };
}

/* ------------------------------------------------------------------ */
/* detectViralSegments                                                 */
/* ------------------------------------------------------------------ */

test('detectViralSegments reads { clips: [...] }: raw JSON is requested and the clips are kept exactly as sent', async (t) => {
  createTemporaryDatabase(t);
  const { calls } = fakeLlm(t, () => aiResponse([clipAt(0), clipAt(1), clipAt(2)]));

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.equal(calls.length, 1, 'all three clips came back in one pass');
  assert.deepEqual(
    segments.map((segment) => [segment.clip.rank, segment.start, segment.end]),
    [
      [1, 60, 125],
      [2, 180, 245],
      [3, 300, 365],
    ]
  );
  assert.deepEqual(segments[0].clip, clipAt(0), 'the clip is exactly what the AI sent');

  // The request: the shipped prompt, the transcript, raw JSON, and a budget that scales with the clip count.
  assert.equal(calls[0].mimeType, 'application/json');
  assert.match(calls[0].prompt, /"clips": \[/);
  assert.match(calls[0].prompt, /exactly 3 items/);
  assert.match(calls[0].prompt, /\[60\.0s - 70\.0s\]: Segment 6 talks about money and risk\./);
  assert.equal(calls[0].maxTokens, detectionMaxTokens(3));
});

test('the output budget grows with the clip count and stays under the model limit', () => {
  assert.ok(detectionMaxTokens(10) >= 20_000, 'ten full analyses must fit');
  assert.ok(detectionMaxTokens(10) > detectionMaxTokens(3));
  assert.ok(detectionMaxTokens(25) <= 40_000);
  assert.ok(detectionMaxTokens(0) > 0);
});

test('clips are ordered by the AI rank (not score) and ranks stay gap-free after an overlap is dropped', async (t) => {
  createTemporaryDatabase(t);
  const scores = (viral: number) => ({
    viral_score: viral,
    retention_score: viral,
    controversy_score: viral,
    shareability_score: viral,
  });
  const highScoreButRank2 = clipAt(0, { rank: 2, scores: scores(9.9) });
  const lowScoreButRank1 = clipAt(1, { rank: 1, scores: scores(5) });
  const overlapsRank1 = clipAt(1, { rank: 3, timestamp: { start: mmss(200), end: mmss(265) } });
  const { calls, warnings } = fakeLlm(t, (_call, index) =>
    index === 0 ? aiResponse([highScoreButRank2, lowScoreButRank1, overlapsRank1]) : '{"clips": []}'
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.deepEqual(
    segments.map((segment) => [segment.clip.rank, segment.start]),
    [
      [1, 180],
      [2, 60],
    ],
    "the AI's #1 stays first even with the lower score; the overlapping #3 is gone"
  );
  assert.equal(calls.length, 2, 'one top-up pass was tried for the missing third clip');
  assert.ok(warnings.some((line) => /Dropping overlapping viral segment/.test(line)));
});

test('top-up clips are appended after the first pass, never replacing it (regression)', async (t) => {
  createTemporaryDatabase(t);
  const { calls } = fakeLlm(t, (_call, index) =>
    index === 0 ? aiResponse([clipAt(0), clipAt(1)]) : aiResponse([clipAt(2, { rank: 1 })])
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    segments.map((segment) => [segment.clip.rank, segment.start]),
    [
      [1, 60],
      [2, 180],
      [3, 300],
    ],
    'the top-up answer restarted at rank 1 but is numbered after the clips already kept'
  );

  // The follow-up asks for the same JSON, also as raw JSON - not "a strict JSON array".
  assert.equal(calls[1].mimeType, 'application/json');
  assert.match(calls[1].prompt, /ALREADY selected/);
  assert.match(calls[1].prompt, /- 60\.0s - 125\.0s/);
  assert.match(calls[1].prompt, /SAME JSON format/);
  assert.doesNotMatch(calls[1].prompt, /strict JSON array/);
  assert.equal(calls[1].maxTokens, detectionMaxTokens(1));
});

test('a top-up answer that is not valid is ignored with a warning; the first pass survives', async (t) => {
  createTemporaryDatabase(t);
  const { warnings } = fakeLlm(t, (_call, index) =>
    index === 0 ? aiResponse([clipAt(0), clipAt(1)]) : '{"clips": [{"rank": 1,'
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.deepEqual(
    segments.map((segment) => segment.start),
    [60, 180]
  );
  assert.ok(warnings.some((line) => /Top-up viral pass .* failed: .*not valid JSON/.test(line)));
});

test('responses that are not the new schema are rejected with a clear error - there is no fallback', async (t) => {
  createTemporaryDatabase(t);
  let reply = '';
  fakeLlm(t, () => reply);
  const rejected = async (text: string) => {
    reply = text;
    try {
      await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 });
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 502);
      return error.message;
    }
    return assert.fail('the response should have been rejected');
  };

  const oldFlat = [{ start: 60, end: 125, score: 7, reason: 'older, weaker', hookText: 'one' }];
  assert.match(await rejected(JSON.stringify(oldFlat)), /must be a JSON object with a "clips" array/);
  assert.match(await rejected(JSON.stringify({ clips: oldFlat })), /clips\[0\]\.rank must be a number/);
  assert.match(await rejected('Sorry, I could not find anything viral in this transcript.'), /not valid JSON/);
  assert.match(await rejected(aiResponse([clipAt(0)]).slice(0, 300)), /not valid JSON/, 'cut-off output is not repaired');
  assert.match(await rejected('{"clips": []}'), /empty "clips" array/);
});

test('one invalid clip rejects the run and the error names the clip and the field', async (t) => {
  createTemporaryDatabase(t);
  const echoedEnum = clipAt(2);
  (echoedEnum.retention_analysis as Record<string, unknown>).predicted_retention = 'Weak | Medium | Strong | Extreme';
  let reply = aiResponse([clipAt(0), clipAt(1, { timestamp: { start: 'garbage', end: 'worse' } }), clipAt(2)]);
  fakeLlm(t, () => reply);

  await assert.rejects(
    () => detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /clips\[1\]\.timestamp must use seconds/);
      return true;
    }
  );

  reply = aiResponse([clipAt(0), clipAt(1), echoedEnum]);
  await assert.rejects(
    () => detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 }),
    (error: unknown) =>
      error instanceof AppError &&
      /clips\[2\]\.retention_analysis\.predicted_retention must be one of: Weak, Medium, Strong, Extreme/.test(error.message)
  );
});

test('the clip-length rules still apply (short extended, long trimmed)', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () =>
    aiResponse([
      clipAt(0, { timestamp: { start: mmss(65), end: mmss(85) } }), // 20s -> extended to the 60s minimum
      clipAt(1, { timestamp: { start: mmss(180), end: mmss(400) } }), // 220s -> trimmed to the 90s maximum
    ])
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 });

  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [
      [65, 125],
      [180, 270],
    ]
  );
});

/* ------------------------------------------------------------------ */
/* The detect-viral route -> SQLite                                    */
/* ------------------------------------------------------------------ */

/** The flat AI-analysis fields the clip record used to carry - now only inside aiAnalysis. */
const REMOVED_FLAT_FIELDS = [
  'viralScore',
  'viralReason',
  'title',
  'rank',
  'hookLine',
  'hookLineStart',
  'hookLineEnd',
  'placeBeforeClip',
  'hashtags',
  'retentionStrength',
  'psychologicalTrigger',
  'safetyRisk',
  'safetyNotes',
  'scores',
  'analysis',
];

test('detect-viral stores the AI clip unchanged on the record; hook text and CTA feed the existing editable fields', async (t) => {
  createTemporaryDatabase(t);
  const clips = [clipAt(0), clipAt(1), clipAt(2)];
  const { calls } = fakeLlm(t, () => aiResponse(clips));
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status, body } = await runDetectRoute('vid', { clipCount: 3 });

  assert.equal(status, 200);
  assert.equal(body.clips?.length, 3);
  assert.equal(calls.length, 1, 'hook and CTA text came with the detection answer - no extra LLM calls');

  const stored = sortClipsForDisplay(await listClips('vid'));
  assert.deepEqual(
    stored.map((clip) => clip.aiAnalysis?.rank),
    [1, 2, 3]
  );
  assert.equal(new Set(stored.map((clip) => clip.createdAt)).size, 1, 'one detection run shares one createdAt');
  stored.forEach((clip, index) =>
    assert.deepEqual(clip.aiAnalysis, clips[index], 'the nested object made the JSON/SQLite round trip unchanged')
  );

  const first = stored[0];
  // The render window (numeric seconds) and the existing fields the card and the worker use.
  assert.equal(first.videoId, 'vid');
  assert.equal(first.start, 60);
  assert.equal(first.end, 125);
  assert.equal(first.status, 'pending');
  assert.equal(first.hookText, 'HE HAD $400 LEFT', 'viral_packaging.hook_text_on_video -> hookText');
  assert.equal(first.ctaText, 'Would you have done it? 👇', 'viral_packaging.cta_text -> ctaText');
  assert.equal(first.hookDuration, 3);
  assert.equal(first.ctaDuration, 2.5);
  assert.equal(first.aiAnalysis?.viral_packaging.video_title, 'He quit his job with $400 in the bank 😳');

  // ...and no second copy of the analysis next to it.
  for (const field of REMOVED_FLAT_FIELDS) assert.equal(field in first, false, `${field} is not stored separately`);
});

test('includeHookText / includeCta off: the clip renders without them but the AI suggestions stay in the analysis', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => aiResponse([clipAt(0)]));
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status } = await runDetectRoute('vid', { clipCount: 1, includeHookText: false, includeCta: false });

  assert.equal(status, 200);
  const [clip] = await listClips('vid');
  assert.equal(clip.hookText, '');
  assert.equal(clip.hookDuration, 0);
  assert.equal(clip.ctaText, '');
  assert.equal(clip.ctaDuration, 0);
  assert.equal(clip.aiAnalysis?.viral_packaging.hook_text_on_video, 'He had $400 left');
  assert.equal(clip.aiAnalysis?.viral_packaging.cta_text, 'Would you have done it? 👇');
  assert.equal(clip.aiAnalysis?.viral_packaging.video_title, 'He quit his job with $400 in the bank 😳');
});

const noHookNoCta = {
  hook_text_on_video: '',
  video_title: 'A title',
  cta_text: '',
  hashtags: [],
  platform_safe: true,
  eligibility_or_reach_concerns: '',
  words_to_change: [],
};

test('hook and CTA fall back to the dedicated templates only for clips where the AI left them empty', async (t) => {
  createTemporaryDatabase(t);
  const now = new Date().toISOString();
  await savePromptTemplate({
    _id: 'prompt-hook-generation',
    type: 'hook_generation',
    name: 'Hook',
    description: '',
    systemPrompt: 'hook system',
    template: 'HOOK PROMPT {{clipTranscript}}',
    updatedAt: now,
  });
  await savePromptTemplate({
    _id: 'prompt-cta-generation',
    type: 'cta_generation',
    name: 'CTA',
    description: '',
    systemPrompt: 'cta system',
    template: 'CTA PROMPT {{clipTranscript}}',
    updatedAt: now,
  });
  const { calls } = fakeLlm(t, (call) =>
    call.prompt.startsWith('HOOK PROMPT')
      ? '"stop scrolling"'
      : call.prompt.startsWith('CTA PROMPT')
        ? 'follow for more'
        : aiResponse([clipAt(0, { viral_packaging: noHookNoCta }), clipAt(1)])
  );
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status } = await runDetectRoute('vid', { clipCount: 2 });

  assert.equal(status, 200);
  const [withFallback, withAiText] = sortClipsForDisplay(await listClips('vid'));
  assert.equal(withFallback.hookText, 'STOP SCROLLING');
  assert.equal(withFallback.ctaText, 'FOLLOW FOR MORE');
  assert.equal(withAiText.hookText, 'HE HAD $400 LEFT');
  assert.equal(withAiText.ctaText, 'Would you have done it? 👇');
  assert.equal(calls.length, 3, 'one detection call + one hook + one CTA, only for the clip that needed them');
  assert.deepEqual(
    calls.map((call) => call.mimeType),
    ['application/json', undefined, undefined],
    'only the detection call asks for raw JSON'
  );
});

test('on a fresh database the hook/CTA fallback still works, using the built-in prompts', async (t) => {
  createTemporaryDatabase(t); // default seeds: no hook_generation / cta_generation rows
  const { calls } = fakeLlm(t, (call) =>
    call.prompt.includes('MAX 8 WORDS')
      ? 'WAIT FOR THE LAST SECOND'
      : call.prompt.includes('MAX 10 WORDS')
        ? 'Comment your answer below'
        : aiResponse([clipAt(0, { viral_packaging: noHookNoCta })])
  );
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status } = await runDetectRoute('vid', { clipCount: 1 });

  assert.equal(status, 200);
  const [clip] = await listClips('vid');
  assert.equal(clip.hookText, 'WAIT FOR THE LAST SECOND');
  assert.equal(clip.hookDuration, 3);
  assert.equal(clip.ctaText, 'COMMENT YOUR ANSWER BELOW');
  assert.equal(clip.ctaDuration, 2.5);
  assert.equal(calls.length, 3);
  assert.match(calls[1].system, /master social media copywriter/);
  assert.match(calls[1].prompt, /Segment 6 talks about money and risk\./, "the clip's own transcript is injected");
});

test('if the fallback cannot produce text the run still completes: that overlay is left empty, nothing else is lost', async (t) => {
  createTemporaryDatabase(t);
  const { warnings } = fakeLlm(t, (call) =>
    call.prompt.includes('MAX 8 WORDS') || call.prompt.includes('MAX 10 WORDS')
      ? 'This answer is far too long to be an on-screen overlay, so the app must refuse to use it as one at all.'
      : aiResponse([clipAt(0, { viral_packaging: noHookNoCta }), clipAt(1), clipAt(2)])
  );
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status, body } = await runDetectRoute('vid', { clipCount: 3 });

  assert.equal(status, 200, 'one clip without hook/CTA text does not abort the whole detection');
  assert.equal(body.clips?.length, 3);
  const [bare, second, third] = sortClipsForDisplay(await listClips('vid'));

  assert.equal(bare.hookText, '');
  assert.equal(bare.hookDuration, 0, 'no hook text: the hook overlay is off for this clip, like the card shows');
  assert.equal(bare.ctaText, '');
  assert.equal(bare.ctaDuration, 2.5, 'the CTA keeps its normal slot; the renderer derives its usual last-resort text');
  assert.equal(bare.aiAnalysis?.viral_packaging.video_title, 'A title');

  for (const healthy of [second, third]) {
    assert.equal(healthy.hookText, 'HE HAD $400 LEFT');
    assert.equal(healthy.hookDuration, 3);
    assert.equal(healthy.ctaText, 'Would you have done it? 👇');
  }
  assert.ok(warnings.some((line) => /left out the hook text and it could not be generated/.test(line)));
  assert.ok(warnings.some((line) => /left out the CTA text and it could not be generated/.test(line)));
});

test('a detected clip renders and deletes like any other: same job payload, analysis untouched', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => aiResponse([clipAt(0)]));
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));
  await runDetectRoute('vid', { clipCount: 1 });
  const [clip] = await listClips('vid');

  // Exactly what the clip card posts when the user presses "Render clip".
  const render = await renderClipRoute(
    new Request('http://localhost/api/clips', {
      method: 'POST',
      body: JSON.stringify({
        clipId: clip._id,
        videoId: clip.videoId,
        start: clip.start,
        end: clip.end,
        hookDuration: clip.hookText.trim() ? 3 : 0,
        hookText: clip.hookText,
        ctaText: clip.ctaText,
        ctaDuration: 2.5,
        filterPreset: 'vibrant',
        captionPresetId: 'preset-bold-yellow',
        captionEngine: 'native',
        layout: 'split-screen',
        hookStylePresetId: 'hook-volt-yellow',
        ctaStylePresetId: 'cta-aurora-gradient',
      }),
    })
  );
  assert.equal(render.status, 200);

  // The render request re-saved the whole clip; nothing the AI said was lost.
  const queued = (await getClip(clip._id))!;
  assert.equal(queued.status, 'pending');
  assert.equal(queued.layout, 'split-screen');
  assert.equal(queued.captionEngine, 'native');
  assert.deepEqual(queued.aiAnalysis, clipAt(0));

  // The worker claims it and gets the payload the processor already understands.
  const job = claimNextJob([CLIP_QUEUE_NAME]);
  assert.ok(job, 'a render job was queued');
  const payload = job.payload as JobData;
  assert.equal(payload.clipId, clip._id);
  assert.equal(payload.videoId, 'vid');
  assert.deepEqual([payload.start, payload.end], [60, 125]);
  assert.equal(payload.hookDuration, 3);
  assert.equal(payload.hookText, 'HE HAD $400 LEFT');
  assert.equal(payload.ctaText, 'Would you have done it? 👇');
  assert.equal(payload.ctaDuration, 2.5);
  assert.equal(payload.layout, 'split-screen');

  // What processor.ts reads from the stored clip: the hook moment is converted to seconds
  // right where it is needed, and lies 15s into the clip (so the hook intro is cut from there).
  const hook = queued.aiAnalysis!.hook_line_analysis;
  assert.equal(parseTimestamp(hook.hook_timestamp.start)! - queued.start, 15);
  assert.equal(hook.hook_line, 'Hook line of clip 1');

  // Delete still works on a clip that carries the analysis.
  const removed = await deleteClipRoute(new Request(`http://localhost/api/clips/${clip._id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: clip._id }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await getClip(clip._id), null);
});

test('detect-viral answers 502 with the clear validation error and creates nothing when the response is invalid', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => aiResponse([clipAt(0), clipAt(1, { timestamp: { start: 'x', end: 'y' } })]));
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));
  t.mock.method(console, 'error', () => {});

  const { status, body } = await runDetectRoute('vid', { clipCount: 2 });

  assert.equal(status, 502);
  assert.match(body.error ?? '', /clips\[1\]\.timestamp must use seconds/);
  assert.deepEqual(await listClips('vid'), [], 'nothing half-created');
});
