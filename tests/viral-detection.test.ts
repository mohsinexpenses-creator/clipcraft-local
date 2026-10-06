/**
 * End-to-end tests for the new AI response format: the real detectViralSegments
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
import { normalizeViralResponse } from '../lib/viral-response';
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

test('detectViralSegments reads the { clips: [...] } response and keeps the full analysis', async (t) => {
  createTemporaryDatabase(t);
  const { calls } = fakeLlm(t, () => aiResponse([clipAt(0), clipAt(1), clipAt(2)]));

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.equal(calls.length, 1, 'all three clips came back in one pass');
  assert.deepEqual(
    segments.map((segment) => [segment.rank, segment.start, segment.end]),
    [
      [1, 60, 125],
      [2, 180, 245],
      [3, 300, 365],
    ]
  );
  assert.ok(segments.every((segment) => segment.analysis?.schemaVersion === 1));
  assert.equal(segments[0].hookLine, 'Hook line of clip 1');
  assert.deepEqual([segments[0].hookLineStart, segments[0].hookLineEnd], [75, 79]);

  // The request itself: the shipped (new-format) prompt, the transcript, and a budget that scales with the clip count.
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
  const highScoreButRank2 = clipAt(0, { rank: 2, scores: { viral_score: 9.9, retention_score: 9, controversy_score: 9, shareability_score: 9 } });
  const lowScoreButRank1 = clipAt(1, { rank: 1, scores: { viral_score: 5, retention_score: 5, controversy_score: 5, shareability_score: 5 } });
  const overlapsRank1 = clipAt(1, { rank: 3, timestamp: { start: mmss(200), end: mmss(265) } });
  const { calls, warnings } = fakeLlm(t, (_call, index) =>
    index === 0 ? aiResponse([highScoreButRank2, lowScoreButRank1, overlapsRank1]) : '{"clips": []}'
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.deepEqual(
    segments.map((segment) => [segment.rank, segment.start]),
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
    segments.map((segment) => [segment.rank, segment.start]),
    [
      [1, 60],
      [2, 180],
      [3, 300],
    ],
    'the top-up answer restarted at rank 1 but is numbered after the clips already kept'
  );

  // The follow-up asks for the same JSON format as the first answer - not "a strict JSON array".
  assert.match(calls[1].prompt, /ALREADY selected/);
  assert.match(calls[1].prompt, /- 60\.0s - 125\.0s/);
  assert.match(calls[1].prompt, /SAME JSON format/);
  assert.doesNotMatch(calls[1].prompt, /strict JSON array/);
  assert.equal(calls[1].maxTokens, detectionMaxTokens(1));
});

test('a response cut off by the output limit keeps its finished clips and the top-up fills the gap', async (t) => {
  createTemporaryDatabase(t);
  const full = aiResponse([clipAt(0), clipAt(1), clipAt(2)]);
  const cut = full.slice(0, full.lastIndexOf('"retention_analysis"') + 30); // dies inside clip #3
  const { warnings } = fakeLlm(t, (_call, index) => (index === 0 ? cut : aiResponse([clipAt(2, { rank: 1 })])));

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 3 });

  assert.deepEqual(
    segments.map((segment) => segment.start),
    [60, 180, 300]
  );
  assert.ok(warnings.some((line) => /cut off by the output limit/.test(line)));
});

test('the old flat-array response still works through the same pipeline', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () =>
    JSON.stringify([
      { start: 60, end: 125, score: 7, reason: 'older, weaker', hookText: 'one' },
      { start: 180, end: 245, score: 9, reason: 'newer, stronger', hookText: 'two', hookLineStart: 190, hookLineEnd: 194 },
    ])
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 });

  assert.deepEqual(
    segments.map((segment) => [segment.rank, segment.start, segment.hookText]),
    [
      [1, 180, 'TWO'],
      [2, 60, 'ONE'],
    ],
    'no rank in the old format: highest score first, then numbered'
  );
  assert.deepEqual([segments[0].hookLineStart, segments[0].hookLineEnd], [190, 194]);
});

test('one bad clip is skipped with a warning; the rest of the run survives', async (t) => {
  createTemporaryDatabase(t);
  const { warnings } = fakeLlm(t, () =>
    aiResponse([clipAt(0), clipAt(1, { timestamp: { start: 'garbage', end: 'worse' } }), clipAt(2)])
  );

  const segments = await detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 });

  assert.deepEqual(
    segments.map((segment) => [segment.rank, segment.start]),
    [
      [1, 60],
      [2, 300],
    ]
  );
  assert.ok(warnings.some((line) => /Skipping AI clip #2/.test(line) && /start time is missing or unreadable/.test(line)));
});

test('when no clip has a usable window the error says why, per clip', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () =>
    aiResponse([
      clipAt(0, { timestamp: { start: '', end: '' } }),
      clipAt(1, { timestamp: { start: '09:00', end: '08:00' } }),
    ])
  );

  await assert.rejects(
    () => detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 502);
      assert.match(error.summary, /None of the 2 clip\(s\)/);
      assert.match(error.details ?? '', /clip #1: its start time is missing/);
      assert.match(error.details ?? '', /clip #2: it ends .* at or before it starts/);
      return true;
    }
  );
});

test('text without clip JSON and an empty clip list each get their own clear error', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => 'Sorry, I could not find anything viral in this transcript.');
  await assert.rejects(
    () => detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 }),
    (error: unknown) => error instanceof AppError && /did not return viral clips as JSON/.test(error.summary)
  );
});

test('an empty { "clips": [] } is reported as an empty list', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => '{"clips": []}');
  await assert.rejects(
    () => detectViralSegments(transcriptOf(), VIDEO_SECONDS, { clipCount: 2 }),
    (error: unknown) => error instanceof AppError && /empty viral clip list/.test(error.summary)
  );
});

test('the clip-length rules still apply to new-format clips (short extended, long trimmed)', async (t) => {
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
/* The detect-viral route → SQLite                                     */
/* ------------------------------------------------------------------ */

test('detect-viral stores every mapped field and the complete analysis, and SQLite returns it intact', async (t) => {
  createTemporaryDatabase(t);
  const text = aiResponse([clipAt(0), clipAt(1), clipAt(2)]);
  const { calls } = fakeLlm(t, () => text);
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status, body } = await runDetectRoute('vid', { clipCount: 3 });

  assert.equal(status, 200);
  assert.equal(body.clips?.length, 3);
  assert.equal(calls.length, 1, 'hook and CTA text came with the detection answer - no extra LLM calls');

  const stored = sortClipsForDisplay(await listClips('vid'));
  assert.deepEqual(
    stored.map((clip) => clip.rank),
    [1, 2, 3]
  );
  assert.equal(new Set(stored.map((clip) => clip.createdAt)).size, 1, 'one detection run shares one createdAt');

  const first = stored[0];
  assert.equal(first.videoId, 'vid');
  assert.equal(first.start, 60);
  assert.equal(first.end, 125);
  assert.equal(first.status, 'pending');
  assert.equal(first.viralScore, 9.2);
  assert.match(first.viralReason ?? '', /every founder hides/);
  assert.equal(first.title, 'He quit his job with $400 in the bank 😳');
  assert.equal(first.hookText, 'HE HAD $400 LEFT');
  assert.equal(first.ctaText, 'Would you have done it? 👇');
  assert.equal(first.hookDuration, 3);
  assert.equal(first.ctaDuration, 2.5);
  assert.equal(first.hookLine, 'Hook line of clip 1');
  assert.deepEqual([first.hookLineStart, first.hookLineEnd], [75, 79]);
  assert.deepEqual(first.hashtags, ['#mindset', '#startup', '#risk']);
  assert.equal(first.retentionStrength, 'Strong');
  assert.equal(first.psychologicalTrigger, 'Curiosity');
  assert.equal(first.safetyRisk, 'Medium');
  assert.equal(first.safetyNotes, 'damn -> darn (replace)');
  assert.deepEqual(first.scores, { viral: 9.2, retention: 8.5, controversy: 6, shareability: 8 });
  assert.equal(first.placeBeforeClip, true);

  // The nested analysis made the full trip through JSON/SQLite unchanged.
  const expected = normalizeViralResponse(text, { videoDuration: VIDEO_SECONDS }).segments;
  stored.forEach((clip, index) => assert.deepEqual(clip.analysis, expected[index].analysis));
  assert.equal(first.analysis?.safetyAnalysis.riskyWords[0].saferReplacement, 'darn');
  assert.equal(first.analysis?.retentionAnalysis.likelyToWatchTillEnd, true);
  assert.equal(first.analysis?.psychologicalTrigger.explanation, 'The unanswered "how" keeps people watching to the payoff.');
  assert.equal(first.analysis?.viralPackaging.platformSafe, true);
  assert.equal(first.analysis?.hookLineAnalysis.placeBeforeClip, true);
});

test('includeHookText / includeCta off: the clip renders without them but the AI suggestions are still kept', async (t) => {
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
  assert.equal(clip.analysis?.viralPackaging.hookTextOnVideo, 'He had $400 left');
  assert.equal(clip.analysis?.viralPackaging.ctaText, 'Would you have done it? 👇');
  assert.equal(clip.title, 'He quit his job with $400 in the bank 😳', 'the rest of the packaging is unaffected');
});

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
  const emptyPackaging = {
    hook_text_on_video: '',
    video_title: 'A title',
    cta_text: '',
    hashtags: [],
    platform_safe: true,
    eligibility_or_reach_concerns: '',
    words_to_change: [],
  };
  const { calls } = fakeLlm(t, (call) =>
    call.prompt.startsWith('HOOK PROMPT')
      ? '"stop scrolling"'
      : call.prompt.startsWith('CTA PROMPT')
        ? 'follow for more'
        : aiResponse([clipAt(0, { viral_packaging: emptyPackaging }), clipAt(1)])
  );
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));

  const { status } = await runDetectRoute('vid', { clipCount: 2 });

  assert.equal(status, 200);
  const [withFallback, withAiText] = sortClipsForDisplay(await listClips('vid'));
  assert.equal(withFallback.hookText, 'STOP SCROLLING');
  assert.equal(withFallback.ctaText, 'follow for more'.toUpperCase());
  assert.equal(withAiText.hookText, 'HE HAD $400 LEFT');
  assert.equal(withAiText.ctaText, 'Would you have done it? 👇');
  assert.equal(calls.length, 3, 'one detection call + one hook + one CTA, only for the clip that needed them');
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
  assert.match(calls[1].prompt, /Segment 6 talks about money and risk\./, 'the clip\'s own transcript is injected');
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

  assert.equal(status, 200, 'one clip without hook/CTA text no longer aborts the whole detection');
  assert.equal(body.clips?.length, 3);
  const [bare, second, third] = sortClipsForDisplay(await listClips('vid'));

  assert.equal(bare.hookText, '');
  assert.equal(bare.hookDuration, 0, 'no hook text: the hook overlay is off for this clip, like the card shows');
  assert.equal(bare.ctaText, '');
  assert.equal(bare.ctaDuration, 2.5, 'the CTA keeps its normal slot; the renderer derives its usual last-resort text');
  assert.equal(bare.title, 'A title');
  assert.equal(bare.analysis?.viralPackaging.videoTitle, 'A title');

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
  assert.deepEqual(queued.analysis, clip.analysis);
  assert.equal(queued.rank, 1);
  assert.equal(queued.placeBeforeClip, true);
  assert.deepEqual(queued.scores, clip.scores);

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

  // What processor.ts reads from the stored clip: the hook moment lies inside the clip,
  // so the hook intro is cut from where the AI said it is (15s in) and not clamped.
  assert.ok(queued.hookLineStart !== undefined);
  assert.equal(queued.hookLineStart - queued.start, 15);
  assert.ok(queued.hookLineStart >= queued.start && queued.hookLineStart < queued.end);

  // Delete still works on a clip that carries the new fields.
  const removed = await deleteClipRoute(new Request(`http://localhost/api/clips/${clip._id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: clip._id }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await getClip(clip._id), null);
});

test('detect-viral still answers with a clear error when the model returns nothing usable', async (t) => {
  createTemporaryDatabase(t);
  fakeLlm(t, () => aiResponse([clipAt(0, { timestamp: { start: 'x', end: 'y' } })]));
  await saveVideo(makeVideo('vid', VIDEO_SECONDS));
  t.mock.method(console, 'error', () => {});

  const { status, body } = await runDetectRoute('vid', { clipCount: 1 });

  assert.equal(status, 502);
  assert.match(body.error ?? '', /None of the 1 clip\(s\) the model returned has a usable time window/);
  assert.deepEqual(await listClips('vid'), [], 'nothing half-created');
});
