import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrollPrompt,
  deriveFallbackKeywords,
  isConcreteKeyword,
  parseBrollAnalysis,
  transcriptSentenceAt,
} from '../lib/broll/analysis';
import type { WordTimestamp } from '../lib/types';

/**
 * The model's JSON is untrusted input. These tests pin the accepted shape, the
 * things that must be rejected (naming the field), and the keyword quality bar
 * that keeps stock searches from returning generic mood boards.
 */

test('a well-formed analysis is parsed and clamped to the clip', () => {
  const analysis = parseBrollAnalysis(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Elon Musk', wikipediaTitle: 'Elon Musk', searchQuery: 'Elon Musk', start: 4.2, end: 6.8 },
        { type: 'place', name: 'Eiffel Tower', start: 12, end: 14 },
        { type: 'event', name: 'Olympics', searchQuery: '2024 Summer Olympics', start: 40, end: 999 },
      ],
      broll: [
        { visualKeywords: ['city skyline', 'success'], start: 8, end: 11 },
        { visualKeywords: ['motivation'], start: 20, end: 23 },
      ],
    }),
    60
  );

  assert.equal(analysis.entities.length, 3);
  assert.equal(analysis.entities[0].wikipediaTitle, 'Elon Musk');
  assert.equal(analysis.entities[1].wikipediaTitle, 'Eiffel Tower', 'missing title falls back to the entity name');
  assert.equal(analysis.entities[1].searchQuery, 'Eiffel Tower', 'a missing searchQuery falls back to the name');
  assert.equal(analysis.entities[2].end, 60, 'times past the clip end are clamped');

  // "success" and "motivation" are ideas, not photographs: dropped, not fatal.
  assert.deepEqual(analysis.broll.map((moment) => moment.visualKeywords), [['city skyline']]);
});

test('the B-roll prompt asks for an English Wikipedia title', () => {
  const prompt = buildBrollPrompt({
    clipDuration: 30,
    words: [],
    entityBudget: 2,
    keywordBudget: 0,
  });
  assert.match(prompt, /wikipediaTitle/);
  assert.match(prompt, /exact English Wikipedia article title/);
});

test('a zero-length or reversed mention gets a usable window instead of failing', () => {
  const analysis = parseBrollAnalysis(
    JSON.stringify({
      entities: [{ type: 'place', name: 'Tokyo', start: 10, end: 10 }],
      broll: [{ visualKeywords: ['neon signs'], start: 30, end: 12 }],
    }),
    60
  );
  assert.ok(analysis.entities[0].end > analysis.entities[0].start);
  assert.ok(analysis.broll[0].end > analysis.broll[0].start);
});

test('bad JSON, wrong shapes and bad types are rejected with the field named', () => {
  assert.throws(() => parseBrollAnalysis('not json', 30), /not valid JSON/);
  assert.throws(() => parseBrollAnalysis('[]', 30), /must be a JSON object/);
  assert.throws(() => parseBrollAnalysis('{"entities":{}}', 30), /"entities" must be an array/);
  assert.throws(() => parseBrollAnalysis('{"broll":"x"}', 30), /"broll" must be an array/);
  assert.throws(
    () => parseBrollAnalysis('{"entities":[{"type":"animal","name":"cat","start":0,"end":1}]}', 30),
    /entities\[0\]\.type must be person, place or event/
  );
  assert.throws(
    () => parseBrollAnalysis('{"entities":[{"type":"place","name":"  ","start":0,"end":1}]}', 30),
    /entities\[0\]\.name/
  );
  assert.throws(
    () => parseBrollAnalysis('{"entities":[{"type":"place","name":"Rome","start":"later","end":1}]}', 30),
    /entities\[0\]\.start/
  );
  assert.throws(
    () => parseBrollAnalysis('{"broll":[{"visualKeywords":"skyline","start":0,"end":1}]}', 30),
    /broll\[0\]\.visualKeywords/
  );
});

test('missing arrays are an empty plan, not an error', () => {
  assert.deepEqual(parseBrollAnalysis('{}', 30), { entities: [], broll: [] });
});

test('keyword concreteness: phrases are short and photographable', () => {
  assert.equal(isConcreteKeyword('city skyline'), true);
  assert.equal(isConcreteKeyword('running shoes'), true);
  assert.equal(isConcreteKeyword('success'), false);
  assert.equal(isConcreteKeyword('success mindset'), false);
  assert.equal(isConcreteKeyword('this is a very long phrase indeed'), false);
  assert.equal(isConcreteKeyword('a city at night in the rain with cars'), false);
  assert.equal(isConcreteKeyword('a'), false);
});

test('the surrounding sentence is taken from the word timings', () => {
  const words: WordTimestamp[] = ['We', 'built', 'a', 'rocket', 'and', 'it', 'flew'].map((word, index) => ({
    word,
    start: index,
    end: index + 1,
  }));
  assert.match(transcriptSentenceAt(words, 3.5), /rocket/);
  assert.equal(transcriptSentenceAt([], 1), '');
});

test('fallback keywords are concrete phrases, at most one per 10 s, never a sentence fragment', () => {
  const words: WordTimestamp[] = [];
  const script = ['Mount', 'Everest', 'is', 'tall', 'success', 'growth', 'climbers', 'train'];
  script.forEach((word, index) => words.push({ word, start: index * 1.5, end: index * 1.5 + 1.2 }));

  const analysis = deriveFallbackKeywords(words, 20, 4);
  assert.equal(analysis.entities.length, 0);
  // The 10 s spacing cap is part of the contract: a 12 s span cannot hold 4 cards.
  assert.ok(analysis.broll.length >= 1);
  for (const moment of analysis.broll) {
    assert.equal(moment.visualKeywords.length, 1);
    assert.equal(isConcreteKeyword(moment.visualKeywords[0]), true);
    assert.ok(moment.visualKeywords[0].split(/\s+/).length <= 3, 'never a sentence fragment');
    assert.equal(moment.relevance, 1, 'the lowest relevance, so it loses any conflict');
    assert.ok(moment.start >= 0 && moment.end <= 20 && moment.end > moment.start);
  }
  const starts = analysis.broll.map((moment) => moment.start);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 10 - 1e-6, 'at most one card every 10 s');
  }
  const keywords = analysis.broll.map((moment) => moment.visualKeywords[0]);
  assert.ok(!keywords.includes('success'), 'abstract words never become keywords');
  assert.ok(!keywords.includes('growth'), 'abstract words never become keywords');
  assert.ok(!keywords.some((keyword) => /\bis\b|\bthe\b/.test(keyword)), 'no filler words');
});

test('an empty transcript produces no fallback cards at all', () => {
  const analysis = deriveFallbackKeywords([], 12, 2);
  assert.deepEqual(analysis.broll, [], 'no "documentary stock footage" filler cards');
});

test('the prompt carries the clip-relative transcript and the JSON contract', () => {
  const prompt = buildBrollPrompt({
    clipDuration: 30,
    words: [{ word: 'Everest', start: 1, end: 1.5 }],
    entityBudget: 4,
    keywordBudget: 12,
  });
  assert.match(prompt, /entities/);
  assert.match(prompt, /visualKeywords/);
  assert.match(prompt, /1\.00-1\.50 Everest/);
  assert.match(prompt, /At most 4/);
  assert.match(prompt, /NEVER abstract ideas/);
});

test('fallback stock queries are the concrete phrase, not the surrounding sentence', () => {
  const words: WordTimestamp[] = [
    { word: 'They', start: 0, end: 0.2 },
    { word: 'visited', start: 0.2, end: 0.5 },
    { word: 'the', start: 0.5, end: 0.6 },
    { word: 'Eiffel', start: 0.6, end: 0.9 },
    { word: 'Tower', start: 0.9, end: 1.2 },
    { word: 'during', start: 1.2, end: 1.5 },
    { word: 'sunset', start: 1.5, end: 1.8 },
  ];
  const result = deriveFallbackKeywords(words, 10, 3);
  assert.ok(result.broll.length >= 1);
  const keyword = result.broll[0].visualKeywords[0];
  assert.match(keyword, /Eiffel|Tower/, 'the search keeps the landmark');
  assert.ok(keyword.split(/\s+/).length <= 3, `a 1-3 word phrase (got "${keyword}")`);
  assert.doesNotMatch(keyword, /visited|during/, 'no verbs or filler');
});
