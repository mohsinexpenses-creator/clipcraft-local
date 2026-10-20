import { completeWithFallback, llmKeysFor } from '../llm';
import { containsProfanity } from '../profanity';
import type { TranscriptData, TranscriptSegment, ViralClip, WordTimestamp } from '../types';
import type { BrollSubjectKind, BrollTranscriptMoment } from './types';

const SENTENCE_STARTER_STOPWORDS = new Set([
  'i', 'im', "i'm", 'ive', "i've", 'id', "i'd", 'ill', "i'll",
  'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself', 'youre', "you're", 'youve', "you've",
  'he', 'him', 'his', 'himself', 'hes', "he's",
  'she', 'her', 'hers', 'herself', 'shes', "she's",
  'it', 'its', "it's", 'itself',
  'we', 'us', 'our', 'ours', 'ourselves', 'were', "we're", 'weve', "we've",
  'they', 'them', 'their', 'theirs', 'themselves', 'theyre', "they're",
  'this', 'that', 'these', 'those', 'there', 'here', 'where', 'when', 'while',
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'the', 'a', 'an', 'and', 'but', 'or', 'nor', 'so', 'yet', 'for', 'of', 'in',
  'on', 'at', 'to', 'from', 'by', 'with', 'about', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'over', 'again',
  'further', 'then', 'once', 'if', 'because', 'until', 'although', 'though',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'yes', 'yeah', 'yep', 'nah', 'okay', 'ok', 'well', 'now', 'just',
  'only', 'also', 'very', 'too', 'quite', 'really', 'actually', 'basically',
  'honestly', 'literally', 'seriously', 'obviously', 'clearly', 'suddenly',
  'finally', 'eventually', 'meanwhile', 'however', 'therefore', 'instead',
  'maybe', 'perhaps', 'probably', 'definitely', 'certainly', 'absolutely',
  'look', 'listen', 'wait', 'watch', 'see', 'think', 'know', 'mean', 'like',
  'say', 'said', 'says', 'tell', 'told', 'talk', 'talking', 'went', 'going',
  'get', 'got', 'getting', 'make', 'made', 'making', 'take', 'took', 'come',
  'came', 'want', 'wanted', 'need', 'needed', 'give', 'gave', 'put', 'let',
  'keep', 'kept', 'start', 'started', 'stop', 'stopped', 'try', 'tried',
  'every', 'each', 'some', 'any', 'all', 'both', 'many', 'most', 'other',
  'another', 'such', 'same', 'own', 'first', 'second', 'third', 'last', 'next',
  'new', 'old', 'good', 'great', 'big', 'small', 'high', 'low', 'long', 'short',
  'right', 'wrong', 'true', 'false', 'real', 'whole', 'better', 'best', 'worst',
  'never', 'always', 'ever', 'sometimes', 'often', 'still', 'already', 'even',
  'today', 'yesterday', 'tomorrow', 'tonight', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand',
  'million', 'billion', 'percent',
]);

const GENERIC_NON_VISUAL_NOUNS = new Set([
  'thing', 'things', 'stuff', 'way', 'ways', 'time', 'times', 'people', 'person',
  'guys', 'guy', 'bro', 'dude', 'man', 'men', 'woman', 'women', 'folks', 'everybody',
  'everyone', 'somebody', 'someone', 'nobody', 'anyone', 'anything', 'everything',
  'something', 'nothing', 'lot', 'lots', 'kind', 'kinds', 'sort', 'part', 'parts',
  'point', 'points', 'fact', 'facts', 'reason', 'reasons', 'idea', 'ideas',
  'question', 'questions', 'answer', 'answers', 'problem', 'problems', 'issue',
  'issues', 'moment', 'moments', 'minute', 'minutes', 'second', 'seconds',
  'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'life', 'world', 'story', 'stories', 'example', 'sense', 'level', 'levels',
  'side', 'sides', 'place', 'number', 'case', 'cases', 'group', 'system',
  'deal', 'truth', 'lie', 'lies', 'word', 'words', 'name', 'names', 'type',
  'end', 'beginning', 'middle', 'top', 'bottom', 'front', 'back', 'mind',
  'head', 'hand', 'hands', 'eyes', 'face', 'voice', 'money', 'dollars',
  'work', 'job', 'jobs', 'business', 'company', 'companies', 'game', 'games',
  'video', 'videos', 'podcast', 'episode', 'clip', 'channel', 'comment', 'comments',
]);

const PROPER_CONNECTORS = new Set(['of', 'the', 'and', '&', 'de', 'la', 'del', 'al', 'bin', 'von', 'van']);

const PERSON_TITLES = new Set([
  'president', 'prime', 'king', 'queen', 'prince', 'princess', 'pope',
  'senator', 'governor', 'mayor', 'judge', 'justice', 'general', 'admiral',
  'doctor', 'dr', 'professor', 'prof', 'coach', 'ceo', 'founder', 'sir', 'saint', 'st',
]);

const PLACE_OR_LANDMARK_HINTS = new Set([
  'tower', 'bridge', 'palace', 'castle', 'cathedral', 'mosque', 'temple', 'church',
  'statue', 'monument', 'memorial', 'museum', 'stadium', 'arena', 'airport',
  'harbor', 'island', 'islands', 'mountain', 'mount', 'mt', 'peak', 'canyon',
  'desert', 'falls', 'river', 'lake', 'ocean', 'sea', 'bay', 'valley', 'park',
  'square', 'street', 'avenue', 'boulevard', 'wall', 'house', 'capitol', 'pentagon',
  'kremlin', 'colosseum', 'acropolis', 'pyramids', 'everest', 'niagara', 'sahara',
  'hollywood', 'manhattan', 'brooklyn', 'vegas', 'miami', 'chicago', 'texas',
  'california', 'florida', 'new york', 'los angeles', 'san francisco', 'washington',
  'london', 'paris', 'tokyo', 'dubai', 'rome', 'berlin', 'madrid', 'barcelona',
  'moscow', 'kyiv', 'beijing', 'shanghai', 'hong kong', 'singapore', 'sydney',
  'toronto', 'mumbai', 'delhi', 'lahore', 'karachi', 'islamabad', 'cairo', 'istanbul',
  'jerusalem', 'mecca', 'medina', 'america', 'united states', 'united kingdom',
  'england', 'france', 'germany', 'italy', 'spain', 'japan', 'china', 'india',
  'pakistan', 'russia', 'ukraine', 'israel', 'brazil', 'canada', 'australia',
  'mexico', 'korea', 'saudi arabia', 'africa', 'europe', 'asia', 'antarctica',
  'mars', 'moon', 'saturn', 'jupiter',
]);

const EVENT_HINTS = new Set([
  'olympics', 'olympic', 'world cup', 'super bowl', 'champions league', 'premier league',
  'world series', 'nba finals', 'wimbledon', 'grand prix', 'formula 1', 'f1', 'ufc',
  'wrestlemania', 'oscars', 'academy awards', 'grammy', 'grammys', 'met gala',
  'coachella', 'cannes', 'nobel prize', 'world war', 'cold war', 'civil war',
  'apollo', 'moon landing', 'titanic', 'chernobyl', 'summit', 'election',
  'inauguration', 'protest', 'revolution', 'festival', 'championship', 'tournament',
]);

const ORG_AND_BRAND_KNOWN = new Map<string, { canonical: string; kind: BrollSubjectKind }>([
  ['nasa', { canonical: 'NASA', kind: 'organization' }],
  ['spacex', { canonical: 'SpaceX', kind: 'organization' }],
  ['tesla', { canonical: 'Tesla', kind: 'organization' }],
  ['openai', { canonical: 'OpenAI', kind: 'organization' }],
  ['nvidia', { canonical: 'Nvidia', kind: 'organization' }],
  ['microsoft', { canonical: 'Microsoft', kind: 'organization' }],
  ['google', { canonical: 'Google', kind: 'organization' }],
  ['apple', { canonical: 'Apple Park', kind: 'organization' }],
  ['amazon', { canonical: 'Amazon headquarters', kind: 'organization' }],
  ['netflix', { canonical: 'Netflix', kind: 'organization' }],
  ['disney', { canonical: 'Walt Disney Studios', kind: 'organization' }],
  ['boeing', { canonical: 'Boeing aircraft', kind: 'organization' }],
  ['airbus', { canonical: 'Airbus aircraft', kind: 'organization' }],
  ['ferrari', { canonical: 'Ferrari sports car', kind: 'object' }],
  ['lamborghini', { canonical: 'Lamborghini sports car', kind: 'object' }],
  ['porsche', { canonical: 'Porsche sports car', kind: 'object' }],
  ['bugatti', { canonical: 'Bugatti hypercar', kind: 'object' }],
  ['rolex', { canonical: 'Rolex watch', kind: 'object' }],
  ['iphone', { canonical: 'iPhone smartphone', kind: 'object' }],
  ['bitcoin', { canonical: 'Bitcoin cryptocurrency', kind: 'object' }],
  ['ethereum', { canonical: 'Ethereum cryptocurrency', kind: 'object' }],
  ['fbi', { canonical: 'FBI headquarters', kind: 'organization' }],
  ['cia', { canonical: 'CIA headquarters', kind: 'organization' }],
  ['nato', { canonical: 'NATO summit', kind: 'organization' }],
  ['fifa', { canonical: 'FIFA World Cup trophy', kind: 'organization' }],
  ['harvard', { canonical: 'Harvard University', kind: 'landmark' }],
  ['stanford', { canonical: 'Stanford University', kind: 'landmark' }],
  ['oxford', { canonical: 'University of Oxford', kind: 'landmark' }],
  ['cambridge', { canonical: 'University of Cambridge', kind: 'landmark' }],
  ['mit', { canonical: 'Massachusetts Institute of Technology', kind: 'landmark' }],
  ['pentagon', { canonical: 'The Pentagon', kind: 'landmark' }],
  ['white house', { canonical: 'White House Washington', kind: 'landmark' }],
  ['wall street', { canonical: 'Wall Street New York Stock Exchange', kind: 'landmark' }],
  ['silicon valley', { canonical: 'Silicon Valley California', kind: 'place' }],
  ['eiffel tower', { canonical: 'Eiffel Tower Paris', kind: 'landmark' }],
  ['statue of liberty', { canonical: 'Statue of Liberty New York', kind: 'landmark' }],
  ['mount everest', { canonical: 'Mount Everest', kind: 'landmark' }],
  ['golden gate bridge', { canonical: 'Golden Gate Bridge', kind: 'landmark' }],
  ['burj khalifa', { canonical: 'Burj Khalifa Dubai', kind: 'landmark' }],
  ['taj mahal', { canonical: 'Taj Mahal', kind: 'landmark' }],
  ['super bowl', { canonical: 'Super Bowl stadium', kind: 'event' }],
  ['world cup', { canonical: 'FIFA World Cup', kind: 'event' }],
  ['olympics', { canonical: 'Olympic Games stadium', kind: 'event' }],
  ['world war ii', { canonical: 'World War II', kind: 'event' }],
  ['world war 2', { canonical: 'World War II', kind: 'event' }],
  ['titanic', { canonical: 'RMS Titanic', kind: 'event' }],
]);

const CONCRETE_VISUAL_NOUNS = new Set([
  'rocket', 'spacecraft', 'satellite', 'astronaut', 'telescope', 'planet', 'galaxy',
  'airplane', 'aircraft', 'jet', 'helicopter', 'airport', 'submarine', 'ship', 'yacht',
  'cruise', 'train', 'locomotive', 'subway', 'car', 'supercar', 'truck', 'motorcycle',
  'ambulance', 'police', 'tank', 'missile', 'drone', 'robot', 'microchip', 'supercomputer',
  'datacenter', 'server', 'laboratory', 'microscope', 'hospital', 'surgery', 'vaccine',
  'stadium', 'trophy', 'medal', 'basketball', 'football', 'soccer', 'cricket', 'tennis',
  'boxing', 'marathon', 'concert', 'stage', 'microphone', 'guitar', 'piano', 'orchestra',
  'cinema', 'theater', 'camera', 'skyscraper', 'castle', 'palace', 'cathedral', 'bridge',
  'pyramid', 'statue', 'museum', 'library', 'university', 'courtroom', 'prison', 'parliament',
  'wildfire', 'volcano', 'earthquake', 'hurricane', 'tornado', 'tsunami', 'glacier',
  'avalanche', 'flood', 'lightning', 'desert', 'rainforest', 'jungle', 'waterfall',
  'mountain', 'ocean', 'beach', 'island', 'coral', 'shark', 'whale', 'lion', 'tiger',
  'eagle', 'wolf', 'elephant', 'dinosaur', 'gold', 'diamond', 'stock market', 'factory',
  'oil rig', 'nuclear', 'solar panel', 'wind turbine',
]);

interface ClauseWindow {
  index: number;
  start: number;
  end: number;
  text: string;
  words: WordTimestamp[];
}

interface ExtractedEntity {
  phrase: string;
  queries: string[];
  kind: BrollSubjectKind;
  priority: number;
  mentionStart: number;
  mentionEnd: number;
}

function cleanToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '');
}

function splitCamelCaseHashtag(tag: string): string {
  const bare = tag.replace(/^#+/, '').trim();
  if (!bare) return '';
  return bare
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect canonical entity names mentioned in `clip.aiAnalysis` (title, hook line,
 * hashtags) so even lowercase Whisper transcripts can recognize multi-word names.
 */
function collectKnownHintsFromAnalysis(aiAnalysis?: ViralClip): string[] {
  if (!aiAnalysis) return [];
  const hints: string[] = [];
  const sources = [
    aiAnalysis.viral_packaging?.video_title ?? '',
    aiAnalysis.hook_line_analysis?.hook_line ?? '',
    aiAnalysis.why_this_will_go_viral ?? '',
  ];

  for (const tag of aiAnalysis.viral_packaging?.hashtags ?? []) {
    const expanded = splitCamelCaseHashtag(tag);
    if (expanded.length >= 3 && !SENTENCE_STARTER_STOPWORDS.has(expanded.toLowerCase())) {
      hints.push(expanded);
    }
  }

  for (const source of sources) {
    const matches = source.match(/\b([A-Z][a-zA-Z0-9'.-]+(?:\s+(?:of|the|de|and|&|[A-Z][a-zA-Z0-9'.-]+)){0,3})\b/g) ?? [];
    for (const raw of matches) {
      const words = raw.trim().split(/\s+/);
      while (words.length > 0 && SENTENCE_STARTER_STOPWORDS.has(words[0].toLowerCase())) {
        words.shift();
      }
      const phrase = words.join(' ').trim();
      if (phrase.length >= 3 && !GENERIC_NON_VISUAL_NOUNS.has(phrase.toLowerCase())) {
        hints.push(phrase);
      }
    }
  }

  return [...new Set(hints)];
}

/**
 * Break clip speech into crisp ~2.5s–6.5s spoken clauses with exact clip-relative
 * word timestamps (`0 .. clipDuration`), preserving original casing from segments.
 */
function buildSpeechClauses(
  transcript: TranscriptData | undefined,
  clipWords: WordTimestamp[],
  clipStart: number,
  clipEnd: number,
): ClauseWindow[] {
  const clipDuration = Math.max(0.1, clipEnd - clipStart);
  const words = clipWords
    .filter((w) => w.end > 0 && w.start < clipDuration && Boolean(w.word.trim()))
    .map((w) => ({
      ...w,
      start: Math.max(0, Math.min(clipDuration, w.start)),
      end: Math.max(0.05, Math.min(clipDuration, w.end)),
    }));

  // Map segment cased tokens onto words if words themselves lost capitalization/punctuation.
  const rawSegments: TranscriptSegment[] = (transcript?.segments ?? [])
    .filter((seg) => seg.end > clipStart && seg.start < clipEnd && Boolean(seg.text?.trim()))
    .map((seg, idx) => ({
      id: idx,
      start: Math.max(0, seg.start - clipStart),
      end: Math.min(clipDuration, seg.end - clipStart),
      text: seg.text.trim(),
    }));

  if (words.length === 0) {
    return rawSegments.map((seg, idx) => ({
      index: idx,
      start: seg.start,
      end: Math.max(seg.start + 0.4, seg.end),
      text: seg.text,
      words: [],
    }));
  }

  // Enrich word casing from segment text when Whisper/caller provided lowercase words.
  const hasAnyUpperInWords = words.some((w) => /[A-Z]/.test(w.word));
  const enrichedWords = hasAnyUpperInWords
    ? words
    : enrichWordCasingFromSegments(words, rawSegments);

  const clauses: ClauseWindow[] = [];
  let bucket: WordTimestamp[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    clauses.push({
      index: clauses.length,
      start: bucket[0].start,
      end: Math.max(bucket[0].start + 0.3, bucket[bucket.length - 1].end),
      text: bucket.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim(),
      words: bucket,
    });
    bucket = [];
  };

  for (let i = 0; i < enrichedWords.length; i += 1) {
    const current = enrichedWords[i];
    const next = enrichedWords[i + 1];
    bucket.push(current);

    const span = current.end - bucket[0].start;
    const gapToNext = next ? next.start - current.end : 1;
    const endsSentence = /[.!?]["')]*$/.test(current.word);
    const endsClause = /[,;:—–]$/.test(current.word);

    if (
      !next ||
      (endsSentence && span >= 1.6) ||
      (endsClause && span >= 3.4) ||
      (gapToNext >= 0.45 && span >= 2.2) ||
      span >= 5.5 ||
      bucket.length >= 16
    ) {
      flushBucket();
    }
  }
  flushBucket();

  return clauses;
}

function enrichWordCasingFromSegments(
  words: WordTimestamp[],
  segments: TranscriptSegment[],
): WordTimestamp[] {
  const out = words.map((w) => ({ ...w }));
  let wordCursor = 0;
  for (const seg of segments) {
    const segTokens = seg.text.split(/\s+/).filter(Boolean);
    let tokenIdx = 0;
    while (wordCursor < out.length && out[wordCursor].start < seg.end + 0.25 && tokenIdx < segTokens.length) {
      const wNorm = cleanToken(out[wordCursor].word).toLowerCase();
      // Look ahead up to 3 tokens in segment to stay aligned across punctuation splits
      for (let look = 0; look <= 3 && tokenIdx + look < segTokens.length; look += 1) {
        if (cleanToken(segTokens[tokenIdx + look]).toLowerCase() === wNorm) {
          out[wordCursor] = { ...out[wordCursor], word: segTokens[tokenIdx + look] };
          tokenIdx = tokenIdx + look + 1;
          break;
        }
      }
      wordCursor += 1;
    }
  }
  return out;
}

function classifyEntity(phrase: string): { kind: BrollSubjectKind; priority: number } {
  const lower = phrase.toLowerCase();
  const known = ORG_AND_BRAND_KNOWN.get(lower);
  if (known) {
    const base = known.kind === 'landmark' || known.kind === 'event' ? 94 : 88;
    return { kind: known.kind, priority: base };
  }

  for (const hint of EVENT_HINTS) {
    if (lower.includes(hint)) return { kind: 'event', priority: 95 };
  }
  for (const hint of PLACE_OR_LANDMARK_HINTS) {
    if (lower === hint || lower.endsWith(` ${hint}`) || lower.startsWith(`${hint} `)) {
      return { kind: hint.length > 4 ? 'landmark' : 'place', priority: 92 };
    }
  }

  const parts = phrase.split(/\s+/);
  if (parts.length >= 2 && PERSON_TITLES.has(parts[0].toLowerCase().replace(/\.$/, ''))) {
    return { kind: 'person', priority: 98 };
  }
  if (/^[A-Z]{2,6}$/.test(phrase)) {
    return { kind: 'organization', priority: 84 };
  }
  if (parts.length >= 2) {
    // Two-or-more capitalized words (e.g. "Elon Musk", "Taylor Swift", "Barack Obama")
    return { kind: 'person', priority: 96 };
  }
  return { kind: 'person', priority: 78 };
}

function findWordSpan(
  clause: ClauseWindow,
  phraseWords: string[],
): { start: number; end: number } {
  if (clause.words.length === 0 || phraseWords.length === 0) {
    return { start: clause.start, end: clause.end };
  }
  const target = phraseWords.map((w) => cleanToken(w).toLowerCase()).filter(Boolean);
  if (target.length === 0) return { start: clause.start, end: clause.end };

  for (let i = 0; i <= clause.words.length - target.length; i += 1) {
    let matches = true;
    for (let j = 0; j < target.length; j += 1) {
      if (cleanToken(clause.words[i + j].word).toLowerCase() !== target[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        start: clause.words[i].start,
        end: clause.words[i + target.length - 1].end,
      };
    }
  }

  // Fallback partial first-token anchor inside clause
  const firstIdx = clause.words.findIndex((w) => cleanToken(w.word).toLowerCase() === target[0]);
  if (firstIdx >= 0) {
    const lastIdx = Math.min(clause.words.length - 1, firstIdx + target.length - 1);
    return { start: clause.words[firstIdx].start, end: clause.words[lastIdx].end };
  }
  return { start: clause.start, end: clause.end };
}

function buildQueriesForEntity(phrase: string, kind: BrollSubjectKind, clauseText: string): string[] {
  const queries: string[] = [];
  const known = ORG_AND_BRAND_KNOWN.get(phrase.toLowerCase());
  if (known) queries.push(known.canonical);

  queries.push(phrase);

  // Add contextual disambiguation query if another concrete noun/event appears in the same clause.
  const lowerClause = clauseText.toLowerCase();
  for (const eventHint of EVENT_HINTS) {
    if (lowerClause.includes(eventHint) && !phrase.toLowerCase().includes(eventHint)) {
      queries.unshift(`${phrase} ${eventHint}`);
      break;
    }
  }

  if (kind === 'person' && phrase.split(/\s+/).length >= 2) {
    // Also provide portrait-friendly fallback query if needed
    queries.push(`${phrase} portrait`);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const cleaned = q.replace(/\s+/g, ' ').trim();
    if (!cleaned || containsProfanity(cleaned) || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    deduped.push(cleaned);
  }
  return deduped;
}

function extractEntitiesFromClause(
  clause: ClauseWindow,
  analysisHints: string[],
): ExtractedEntity[] {
  const found: ExtractedEntity[] = [];
  const seenLower = new Set<string>();
  const rawTokens = clause.text.split(/\s+/).filter(Boolean);
  const lowerText = ` ${rawTokens.map((t) => cleanToken(t).toLowerCase()).join(' ')} `;

  // 1) Check multi-word known dictionary entries and AI-analysis proper hints first (works even on all-lowercase text!)
  for (const hint of analysisHints) {
    const cleanHint = hint.trim();
    const key = cleanHint.toLowerCase();
    if (cleanHint.length < 3 || seenLower.has(key) || containsProfanity(cleanHint)) continue;
    if (lowerText.includes(` ${key} `)) {
      seenLower.add(key);
      const { kind, priority } = classifyEntity(cleanHint);
      const span = findWordSpan(clause, cleanHint.split(/\s+/));
      const queries = buildQueriesForEntity(cleanHint, kind, clause.text);
      if (queries.length > 0) {
        found.push({
          phrase: cleanHint,
          queries,
          kind,
          priority: priority + 4,
          mentionStart: span.start,
          mentionEnd: span.end,
        });
      }
    }
  }

  for (const [dictKey, meta] of ORG_AND_BRAND_KNOWN.entries()) {
    if (seenLower.has(dictKey)) continue;
    if (lowerText.includes(` ${dictKey} `)) {
      seenLower.add(dictKey);
      const span = findWordSpan(clause, dictKey.split(/\s+/));
      const titleCased = dictKey
        .split(' ')
        .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
        .join(' ');
      found.push({
        phrase: meta.canonical,
        queries: [meta.canonical, titleCased],
        kind: meta.kind,
        priority: meta.kind === 'landmark' || meta.kind === 'event' ? 94 : 88,
        mentionStart: span.start,
        mentionEnd: span.end,
      });
    }
  }

  // 2) Extract capitalized proper-noun spans (People, Celebrities, Places, Landmarks, Events, Orgs)
  let i = 0;
  while (i < rawTokens.length) {
    const prevRaw = i > 0 ? rawTokens[i - 1] : '';
    const isSentenceStart = i === 0 || /[.!?]["')]*$/.test(prevRaw);
    const cleaned = cleanToken(rawTokens[i]);
    const lower = cleaned.toLowerCase();

    const isCapitalized =
      cleaned.length >= 2 &&
      /^[A-Z]/.test(cleaned) &&
      !containsProfanity(cleaned);
    const isTitlePrefix = PERSON_TITLES.has(lower.replace(/\.$/, ''));

    if (isCapitalized || isTitlePrefix) {
      const spanTokens: string[] = [];
      let cursor = i;
      while (cursor < rawTokens.length) {
        const tok = cleanToken(rawTokens[cursor]);
        const tokLower = tok.toLowerCase();
        if (!tok) break;

        const tokCap = /^[A-Z]/.test(tok) || /^\d{4}$/.test(tok) || /^(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|LVIII|LIX)$/.test(tok);
        if (tokCap && !containsProfanity(tok)) {
          spanTokens.push(tok);
          cursor += 1;
          const prevEndedClause = /[.!?,;:—–]["')]*$/.test(rawTokens[cursor - 1]);
          if (prevEndedClause) break;
          continue;
        }

        // Allow internal proper connectors like "Statue of Liberty", "United States of America"
        const nextTok = cursor + 1 < rawTokens.length ? cleanToken(rawTokens[cursor + 1]) : '';
        if (spanTokens.length > 0 && PROPER_CONNECTORS.has(tokLower) && /^[A-Z]/.test(nextTok)) {
          spanTokens.push(tokLower);
          cursor += 1;
          continue;
        }
        break;
      }

      // Trim leading sentence-starter stop words (e.g. "When Elon Musk" -> "Elon Musk")
      while (
        spanTokens.length > 0 &&
        SENTENCE_STARTER_STOPWORDS.has(spanTokens[0].toLowerCase())
      ) {
        spanTokens.shift();
      }
      while (
        spanTokens.length > 0 &&
        (SENTENCE_STARTER_STOPWORDS.has(spanTokens[spanTokens.length - 1].toLowerCase()) ||
          PROPER_CONNECTORS.has(spanTokens[spanTokens.length - 1].toLowerCase()))
      ) {
        spanTokens.pop();
      }

      const phrase = spanTokens.join(' ').trim();
      const phraseLower = phrase.toLowerCase();
      const validSingleWord =
        spanTokens.length === 1 &&
        phrase.length >= 3 &&
        !SENTENCE_STARTER_STOPWORDS.has(phraseLower) &&
        !GENERIC_NON_VISUAL_NOUNS.has(phraseLower) &&
        (!isSentenceStart || /^[A-Z]{2,}$/.test(phrase) || PLACE_OR_LANDMARK_HINTS.has(phraseLower) || EVENT_HINTS.has(phraseLower));

      if ((spanTokens.length >= 2 || validSingleWord) && !seenLower.has(phraseLower) && !GENERIC_NON_VISUAL_NOUNS.has(phraseLower)) {
        seenLower.add(phraseLower);
        const { kind, priority } = classifyEntity(phrase);
        const wordSpan = findWordSpan(clause, spanTokens);
        const queries = buildQueriesForEntity(phrase, kind, clause.text);
        if (queries.length > 0) {
          found.push({
            phrase,
            queries,
            kind,
            priority,
            mentionStart: wordSpan.start,
            mentionEnd: wordSpan.end,
          });
        }
      }

      i = Math.max(i + 1, cursor);
      continue;
    }

    i += 1;
  }

  // 3) Multi-word lowercase geographical / historical / event matches
  for (const placeOrEvent of [...PLACE_OR_LANDMARK_HINTS, ...EVENT_HINTS]) {
    if (!placeOrEvent.includes(' ') || seenLower.has(placeOrEvent)) continue;
    if (lowerText.includes(` ${placeOrEvent} `)) {
      seenLower.add(placeOrEvent);
      const display = placeOrEvent
        .split(' ')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
      const kind: BrollSubjectKind = EVENT_HINTS.has(placeOrEvent) ? 'event' : 'landmark';
      const wordSpan = findWordSpan(clause, placeOrEvent.split(' '));
      found.push({
        phrase: display,
        queries: [display],
        kind,
        priority: kind === 'event' ? 93 : 90,
        mentionStart: wordSpan.start,
        mentionEnd: wordSpan.end,
      });
    }
  }

  // 4) Concrete visual noun phrases (e.g. "electric car", "rocket launch", "football stadium")
  for (let idx = 0; idx < rawTokens.length; idx += 1) {
    const w = cleanToken(rawTokens[idx]).toLowerCase();
    const singular = w.endsWith('s') && w.length > 4 && !w.endsWith('ss') ? w.slice(0, -1) : w;
    if (!CONCRETE_VISUAL_NOUNS.has(w) && !CONCRETE_VISUAL_NOUNS.has(singular)) continue;
    if (seenLower.has(w) || seenLower.has(singular)) continue;

    // Include descriptive preceding modifier when informative (e.g. "electric car", "golden retriever", "private jet")
    const prev = idx > 0 ? cleanToken(rawTokens[idx - 1]).toLowerCase() : '';
    const hasUsefulModifier =
      prev.length >= 3 &&
      /^[a-z]+$/.test(prev) &&
      !SENTENCE_STARTER_STOPWORDS.has(prev) &&
      !GENERIC_NON_VISUAL_NOUNS.has(prev) &&
      !containsProfanity(prev);
    const phraseTokens = hasUsefulModifier ? [prev, w] : [w];
    const phrase = phraseTokens.join(' ');
    if (seenLower.has(phrase)) continue;
    seenLower.add(phrase);
    seenLower.add(w);

    const span = findWordSpan(clause, phraseTokens);
    found.push({
      phrase,
      queries: hasUsefulModifier ? [phrase, w] : [w],
      kind: PLACE_OR_LANDMARK_HINTS.has(singular) ? 'place' : EVENT_HINTS.has(singular) ? 'event' : 'object',
      priority: hasUsefulModifier ? 66 : 58,
      mentionStart: span.start,
      mentionEnd: span.end,
    });
  }

  return found.sort((a, b) => b.priority - a.priority || a.mentionStart - b.mentionStart);
}

/**
 * Extract timestamp-aligned English visual subjects across a clip's transcript.
 */
export function extractBrollMomentsFromTranscript(options: {
  transcript?: TranscriptData;
  clipWords: WordTimestamp[];
  clipStart: number;
  clipEnd: number;
  aiAnalysis?: ViralClip;
}): BrollTranscriptMoment[] {
  const { transcript, clipWords, clipStart, clipEnd, aiAnalysis } = options;
  const clauses = buildSpeechClauses(transcript, clipWords, clipStart, clipEnd);
  const analysisHints = collectKnownHintsFromAnalysis(aiAnalysis);
  const moments: BrollTranscriptMoment[] = [];

  for (const clause of clauses) {
    const entities = extractEntitiesFromClause(clause, analysisHints);
    for (const entity of entities) {
      moments.push({
        id: `moment-${clause.index}-${moments.length}`,
        segmentIndex: clause.index,
        segmentStart: clause.start,
        segmentEnd: clause.end,
        mentionStart: entity.mentionStart,
        mentionEnd: Math.max(entity.mentionStart + 0.25, entity.mentionEnd),
        queries: entity.queries,
        primarySubject: entity.phrase,
        subjectKind: entity.kind,
        segmentText: clause.text,
        priority: entity.priority,
      });
    }
  }

  return moments;
}

interface LlmVisualCueResponse {
  cues?: Array<{
    timeSeconds?: number;
    query?: string;
    kind?: string;
  }>;
}

/**
 * Optional single-shot batched cue extraction via ClipCraft's existing free
 * Gemini key pool (`lib/llm.ts`). Invoked AT MOST ONCE per clip only when
 * free LLM keys are configured AND deterministic extraction found fewer
 * concrete subjects than needed (e.g. heavy pronoun/implication speech).
 * Never throws; never called per image.
 */
export async function maybeEnrichMomentsWithFreeLlm(options: {
  transcript?: TranscriptData;
  clipWords: WordTimestamp[];
  clipStart: number;
  clipEnd: number;
  existingMoments: BrollTranscriptMoment[];
  targetCount: number;
}): Promise<BrollTranscriptMoment[]> {
  const { transcript, clipWords, clipStart, clipEnd, existingMoments, targetCount } = options;
  const uniqueSubjects = new Set(existingMoments.map((m) => m.primarySubject.toLowerCase()));
  if (uniqueSubjects.size >= Math.max(3, Math.ceil(targetCount * 0.6))) {
    return existingMoments;
  }

  let keys: string[] = [];
  try {
    keys = await llmKeysFor();
  } catch {
    return existingMoments;
  }
  if (keys.length === 0) return existingMoments;

  const clauses = buildSpeechClauses(transcript, clipWords, clipStart, clipEnd);
  if (clauses.length === 0) return existingMoments;

  const formattedLines = clauses
    .map((c) => `[${c.start.toFixed(1)}s-${c.end.toFixed(1)}s] ${c.text}`)
    .join('\n');

  try {
    const completion = await completeWithFallback({
      task: 'broll visual query extraction',
      system:
        'Extract concrete, photographable English Wikimedia Commons search subjects for B-roll from timestamped speech. ' +
        'Prioritize named celebrities/public figures, events, places, landmarks, organizations, and specific real-world objects. ' +
        'Never invent unrelated subjects. Output JSON: {"cues":[{"timeSeconds":number,"query":string,"kind":"person|landmark|place|event|organization|object"}]}',
      prompt: `Return up to ${Math.max(4, targetCount)} concrete English Wikimedia Commons search cues aligned to these clip timestamps:\n\n${formattedLines}`,
      maxTokens: 700,
      temperature: 0.2,
      json: true,
    });

    const parsed = JSON.parse(completion.text) as LlmVisualCueResponse;
    if (!Array.isArray(parsed.cues) || parsed.cues.length === 0) {
      return existingMoments;
    }

    const clipDuration = Math.max(0.1, clipEnd - clipStart);
    const merged = [...existingMoments];
    for (const cue of parsed.cues) {
      const query = typeof cue.query === 'string' ? cue.query.trim() : '';
      const time = Number(cue.timeSeconds);
      if (!query || query.length < 3 || containsProfanity(query) || !Number.isFinite(time)) {
        continue;
      }
      const clampedTime = Math.max(0, Math.min(clipDuration - 0.3, time));
      const nearestClause =
        clauses.find((c) => clampedTime >= c.start - 0.5 && clampedTime <= c.end + 0.5) ??
        clauses.reduce((best, cur) =>
          Math.abs(cur.start - clampedTime) < Math.abs(best.start - clampedTime) ? cur : best
        );

      const allowedKinds = new Set<BrollSubjectKind>([
        'person', 'landmark', 'place', 'event', 'organization', 'object',
      ]);
      const kind: BrollSubjectKind = allowedKinds.has(cue.kind as BrollSubjectKind)
        ? (cue.kind as BrollSubjectKind)
        : 'object';

      merged.push({
        id: `llm-moment-${merged.length}`,
        segmentIndex: nearestClause.index,
        segmentStart: nearestClause.start,
        segmentEnd: nearestClause.end,
        mentionStart: clampedTime,
        mentionEnd: Math.min(clipDuration, Math.max(clampedTime + 0.8, nearestClause.end)),
        queries: [query],
        primarySubject: query,
        subjectKind: kind,
        segmentText: nearestClause.text,
        priority: kind === 'person' ? 92 : kind === 'landmark' || kind === 'event' ? 88 : 75,
      });
    }

    return merged;
  } catch {
    return existingMoments;
  }
}
