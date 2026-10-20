import { targetBrollCountForDuration } from '../broll-count';
import { toErrorMessage } from '../errors';
import { completeWithFallback, llmKeysFor } from '../llm';
import { log } from '../logger';
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
  'look', 'listen', 'wait', 'watch', 'see', 'saw', 'seen', 'think', 'thought',
  'know', 'knew', 'known', 'mean', 'meant', 'like', 'liked', 'love', 'loved',
  'say', 'said', 'says', 'saying', 'tell', 'told', 'telling', 'talk', 'talking', 'talked',
  'went', 'going', 'gone', 'get', 'got', 'getting', 'gotten', 'make', 'made', 'making',
  'take', 'took', 'taken', 'taking', 'come', 'came', 'coming', 'want', 'wanted', 'wanting',
  'need', 'needed', 'give', 'gave', 'given', 'put', 'putting', 'let', 'keep', 'kept',
  'start', 'started', 'starting', 'stop', 'stopped', 'try', 'tried', 'trying',
  'use', 'used', 'using', 'find', 'found', 'feel', 'felt', 'feeling', 'seem', 'seemed',
  'leave', 'left', 'call', 'called', 'ask', 'asked', 'work', 'worked', 'working',
  'become', 'became', 'happened', 'happens', 'happen', 'happening', 'wondered', 'wonder',
  'every', 'each', 'some', 'any', 'all', 'both', 'many', 'most', 'much', 'more', 'less',
  'other', 'others', 'another', 'such', 'same', 'own', 'first', 'second', 'third',
  'last', 'next', 'new', 'old', 'good', 'great', 'big', 'small', 'high', 'low',
  'long', 'short', 'right', 'wrong', 'true', 'false', 'real', 'whole', 'better',
  'best', 'worst', 'hard', 'easy', 'fast', 'slow', 'early', 'late', 'young',
  'never', 'always', 'ever', 'sometimes', 'often', 'still', 'already', 'even',
  'today', 'yesterday', 'tomorrow', 'tonight', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand',
  'million', 'billion', 'percent', 'around', 'away', 'back', 'down', 'up', 'out', 'off',
  'almost', 'enough', 'anything', 'everything', 'something', 'nothing',
  'anyone', 'everyone', 'someone', 'nobody', 'everybody', 'somebody',
]);

const GENERIC_NON_VISUAL_NOUNS = new Set([
  'thing', 'things', 'stuff', 'way', 'ways', 'time', 'times', 'people', 'person',
  'guys', 'guy', 'bro', 'dude', 'man', 'men', 'woman', 'women', 'folks',
  'lot', 'lots', 'kind', 'kinds', 'sort', 'part', 'parts', 'piece', 'pieces',
  'point', 'points', 'fact', 'facts', 'reason', 'reasons', 'idea', 'ideas',
  'question', 'questions', 'answer', 'answers', 'problem', 'problems', 'issue',
  'issues', 'moment', 'moments', 'minute', 'minutes', 'second', 'seconds',
  'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'life', 'lives', 'story', 'stories', 'example', 'examples', 'sense', 'level', 'levels',
  'side', 'sides', 'place', 'places', 'number', 'numbers', 'case', 'cases', 'group', 'system',
  'deal', 'truth', 'lie', 'lies', 'word', 'words', 'name', 'names', 'type', 'types',
  'end', 'beginning', 'middle', 'top', 'bottom', 'front', 'mind', 'minds',
  'step', 'steps', 'result', 'results', 'change', 'changes', 'chance', 'choice',
  'video', 'videos', 'clip', 'clips', 'channel', 'comment', 'comments', 'subscribe',
  'follow', 'share', 'watch', 'episode', 'part', 'version', 'matter', 'state',
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
  'mars', 'moon', 'saturn', 'jupiter', 'earth',
]);

const EVENT_HINTS = new Set([
  'olympics', 'olympic', 'world cup', 'super bowl', 'champions league', 'premier league',
  'world series', 'nba finals', 'wimbledon', 'grand prix', 'formula 1', 'f1', 'ufc',
  'wrestlemania', 'oscars', 'academy awards', 'grammy', 'grammys', 'met gala',
  'coachella', 'cannes', 'nobel prize', 'world war', 'cold war', 'civil war',
  'apollo', 'moon landing', 'titanic', 'chernobyl', 'summit', 'election',
  'inauguration', 'protest', 'revolution', 'festival', 'championship', 'tournament',
]);

/** Clean, concise canonical 1-3 word encyclopedia titles that always match Commons & Wikipedia. */
const ORG_AND_BRAND_KNOWN = new Map<string, { canonical: string; fallback?: string; kind: BrollSubjectKind }>([
  ['nasa', { canonical: 'NASA', fallback: 'Space Shuttle', kind: 'organization' }],
  ['spacex', { canonical: 'SpaceX', fallback: 'Falcon 9', kind: 'organization' }],
  ['tesla', { canonical: 'Tesla', fallback: 'Electric car', kind: 'organization' }],
  ['openai', { canonical: 'OpenAI', fallback: 'Artificial intelligence', kind: 'organization' }],
  ['chatgpt', { canonical: 'ChatGPT', fallback: 'Artificial intelligence', kind: 'organization' }],
  ['nvidia', { canonical: 'Nvidia', fallback: 'Graphics processing unit', kind: 'organization' }],
  ['microsoft', { canonical: 'Microsoft', fallback: 'Software', kind: 'organization' }],
  ['google', { canonical: 'Google', fallback: 'Search engine', kind: 'organization' }],
  ['youtube', { canonical: 'YouTube', fallback: 'Online video platform', kind: 'organization' }],
  ['tiktok', { canonical: 'TikTok', fallback: 'Smartphone', kind: 'organization' }],
  ['instagram', { canonical: 'Social media', fallback: 'Smartphone', kind: 'object' }],
  ['apple', { canonical: 'Apple Park', fallback: 'iPhone', kind: 'organization' }],
  ['amazon', { canonical: 'Amazon', fallback: 'Warehouse', kind: 'organization' }],
  ['netflix', { canonical: 'Netflix', fallback: 'Streaming media', kind: 'organization' }],
  ['disney', { canonical: 'Walt Disney Studios', fallback: 'Disneyland', kind: 'organization' }],
  ['boeing', { canonical: 'Boeing', fallback: 'Airliner', kind: 'organization' }],
  ['airbus', { canonical: 'Airbus', fallback: 'Airliner', kind: 'organization' }],
  ['ferrari', { canonical: 'Ferrari', fallback: 'Sports car', kind: 'object' }],
  ['lamborghini', { canonical: 'Lamborghini', fallback: 'Sports car', kind: 'object' }],
  ['porsche', { canonical: 'Porsche', fallback: 'Sports car', kind: 'object' }],
  ['bugatti', { canonical: 'Bugatti', fallback: 'Sports car', kind: 'object' }],
  ['rolex', { canonical: 'Rolex', fallback: 'Wristwatch', kind: 'object' }],
  ['iphone', { canonical: 'iPhone', fallback: 'Smartphone', kind: 'object' }],
  ['bitcoin', { canonical: 'Bitcoin', fallback: 'Cryptocurrency', kind: 'object' }],
  ['ethereum', { canonical: 'Ethereum', fallback: 'Cryptocurrency', kind: 'object' }],
  ['crypto', { canonical: 'Cryptocurrency', fallback: 'Bitcoin', kind: 'object' }],
  ['fbi', { canonical: 'Federal Bureau of Investigation', fallback: 'Police', kind: 'organization' }],
  ['cia', { canonical: 'Central Intelligence Agency', fallback: 'Pentagon', kind: 'organization' }],
  ['nato', { canonical: 'NATO', fallback: 'Diplomacy', kind: 'organization' }],
  ['fifa', { canonical: 'FIFA World Cup', fallback: 'Association football', kind: 'organization' }],
  ['harvard', { canonical: 'Harvard University', kind: 'landmark' }],
  ['stanford', { canonical: 'Stanford University', kind: 'landmark' }],
  ['oxford', { canonical: 'University of Oxford', kind: 'landmark' }],
  ['cambridge', { canonical: 'University of Cambridge', kind: 'landmark' }],
  ['mit', { canonical: 'Massachusetts Institute of Technology', kind: 'landmark' }],
  ['pentagon', { canonical: 'The Pentagon', kind: 'landmark' }],
  ['white house', { canonical: 'White House', kind: 'landmark' }],
  ['wall street', { canonical: 'Wall Street', fallback: 'New York Stock Exchange', kind: 'landmark' }],
  ['silicon valley', { canonical: 'Silicon Valley', kind: 'place' }],
  ['eiffel tower', { canonical: 'Eiffel Tower', kind: 'landmark' }],
  ['statue of liberty', { canonical: 'Statue of Liberty', kind: 'landmark' }],
  ['mount everest', { canonical: 'Mount Everest', kind: 'landmark' }],
  ['golden gate bridge', { canonical: 'Golden Gate Bridge', kind: 'landmark' }],
  ['burj khalifa', { canonical: 'Burj Khalifa', kind: 'landmark' }],
  ['taj mahal', { canonical: 'Taj Mahal', kind: 'landmark' }],
  ['super bowl', { canonical: 'Super Bowl', fallback: 'American football', kind: 'event' }],
  ['world cup', { canonical: 'FIFA World Cup', fallback: 'Stadium', kind: 'event' }],
  ['olympics', { canonical: 'Olympic Games', fallback: 'Gold medal', kind: 'event' }],
  ['world war ii', { canonical: 'World War II', kind: 'event' }],
  ['world war 2', { canonical: 'World War II', kind: 'event' }],
  ['titanic', { canonical: 'RMS Titanic', kind: 'event' }],
]);

/**
 * Everyday podcast / business / tech / health / lifestyle / news topics mapped to
 * crisp, high-resolution photographable Wikipedia / Wikimedia Commons subjects.
 */
const SPOKEN_CONCEPT_VISUALS = new Map<string, string>([
  ['ai', 'Artificial intelligence'],
  ['algorithm', 'Computer code'],
  ['coding', 'Computer programming'],
  ['code', 'Computer programming'],
  ['programmer', 'Software engineer'],
  ['software', 'Laptop'],
  ['computer', 'Laptop'],
  ['laptop', 'Laptop'],
  ['phone', 'Smartphone'],
  ['smartphone', 'Smartphone'],
  ['scrolling', 'Smartphone'],
  ['screen', 'Computer monitor'],
  ['internet', 'Data center'],
  ['cloud', 'Data center'],
  ['money', 'United States dollar'],
  ['cash', 'Banknotes'],
  ['dollars', 'United States dollar'],
  ['dollar', 'United States dollar'],
  ['wealth', 'Gold bar'],
  ['millionaire', 'Luxury yacht'],
  ['billionaire', 'Private jet'],
  ['bank', 'Bank'],
  ['banking', 'Bank'],
  ['debt', 'Credit card'],
  ['credit', 'Credit card'],
  ['loan', 'Mortgage loan'],
  ['tax', 'Tax'],
  ['taxes', 'Tax'],
  ['invest', 'Stock market'],
  ['investing', 'Stock market'],
  ['investment', 'Stock market'],
  ['stocks', 'Stock exchange'],
  ['trading', 'Trading room'],
  ['market', 'Stock exchange'],
  ['inflation', 'Supermarket'],
  ['economy', 'Skyscraper'],
  ['business', 'Office'],
  ['startup', 'Office'],
  ['entrepreneur', 'Businessperson'],
  ['ceo', 'Boardroom'],
  ['meeting', 'Conference hall'],
  ['career', 'Office'],
  ['salary', 'Paycheck'],
  ['sleep', 'Sleep'],
  ['sleeping', 'Bedroom'],
  ['wake', 'Alarm clock'],
  ['waking', 'Sunrise'],
  ['morning', 'Sunrise'],
  ['coffee', 'Coffee'],
  ['caffeine', 'Espresso'],
  ['brain', 'Human brain'],
  ['mindset', 'Human brain'],
  ['memory', 'Human brain'],
  ['focus', 'Chess'],
  ['stress', 'Headache'],
  ['anxiety', 'Meditation'],
  ['depression', 'Rain'],
  ['therapy', 'Psychotherapy'],
  ['gym', 'Fitness center'],
  ['workout', 'Strength training'],
  ['exercise', 'Running'],
  ['running', 'Running'],
  ['muscle', 'Bodybuilding'],
  ['diet', 'Salad'],
  ['sugar', 'Sugar'],
  ['calories', 'Fast food'],
  ['food', 'Cuisine'],
  ['protein', 'Steak'],
  ['heart', 'Human heart'],
  ['blood', 'Red blood cell'],
  ['medicine', 'Pharmaceutical drug'],
  ['doctor', 'Physician'],
  ['hospital', 'Hospital'],
  ['school', 'Classroom'],
  ['college', 'University'],
  ['university', 'University'],
  ['student', 'Student'],
  ['students', 'Classroom'],
  ['book', 'Book'],
  ['books', 'Library'],
  ['reading', 'Library'],
  ['podcast', 'Microphone'],
  ['microphone', 'Microphone'],
  ['interview', 'Television studio'],
  ['news', 'News broadcasting'],
  ['journalist', 'Journalism'],
  ['election', 'Ballot box'],
  ['vote', 'Ballot box'],
  ['government', 'Capitol'],
  ['law', 'Courthouse'],
  ['court', 'Courtroom'],
  ['judge', 'Gavel'],
  ['police', 'Police car'],
  ['crime', 'Crime scene'],
  ['prison', 'Prison'],
  ['war', 'Military'],
  ['army', 'Soldier'],
  ['military', 'Fighter aircraft'],
  ['house', 'House'],
  ['home', 'House'],
  ['housing', 'Suburb'],
  ['rent', 'Apartment'],
  ['apartment', 'Apartment'],
  ['city', 'Cityscape'],
  ['traffic', 'Traffic congestion'],
  ['flight', 'Airliner'],
  ['travel', 'Passport'],
  ['hotel', 'Hotel'],
  ['marriage', 'Wedding'],
  ['wedding', 'Wedding'],
  ['family', 'Family'],
  ['children', 'Child'],
  ['kids', 'Playground'],
  ['climate', 'Glacier'],
  ['energy', 'Solar panel'],
  ['oil', 'Oil platform'],
  ['electricity', 'Power station'],
]);

const CONCRETE_VISUAL_NOUNS = new Set([
  'rocket', 'spacecraft', 'satellite', 'astronaut', 'telescope', 'planet', 'galaxy',
  'airplane', 'aircraft', 'jet', 'helicopter', 'airport', 'submarine', 'ship', 'yacht',
  'cruise', 'boat', 'train', 'locomotive', 'subway', 'car', 'cars', 'supercar', 'truck',
  'bus', 'bicycle', 'motorcycle', 'highway', 'road', 'engine', 'wheel',
  'ambulance', 'tank', 'missile', 'drone', 'robot', 'robots', 'microchip', 'supercomputer',
  'datacenter', 'server', 'laboratory', 'microscope', 'surgery', 'vaccine', 'virus', 'dna',
  'stadium', 'trophy', 'medal', 'basketball', 'football', 'soccer', 'cricket', 'tennis',
  'golf', 'baseball', 'boxing', 'marathon', 'swimming', 'chess',
  'concert', 'stage', 'guitar', 'piano', 'violin', 'drums', 'orchestra',
  'cinema', 'theater', 'camera', 'photograph', 'painting', 'sculpture',
  'skyscraper', 'castle', 'palace', 'cathedral', 'mosque', 'temple', 'church', 'bridge',
  'pyramid', 'statue', 'museum', 'library', 'courtroom', 'parliament', 'lighthouse',
  'wildfire', 'volcano', 'earthquake', 'hurricane', 'tornado', 'tsunami', 'glacier',
  'avalanche', 'flood', 'lightning', 'storm', 'rain', 'snow', 'sun', 'sunset', 'sunrise',
  'desert', 'rainforest', 'jungle', 'forest', 'waterfall', 'river', 'lake',
  'mountain', 'mountains', 'ocean', 'beach', 'island', 'coral', 'cliff', 'canyon',
  'shark', 'whale', 'dolphin', 'lion', 'tiger', 'eagle', 'wolf', 'elephant', 'horse',
  'dog', 'dogs', 'cat', 'cats', 'bird', 'birds', 'snake', 'bear', 'monkey', 'dinosaur',
  'gold', 'silver', 'diamond', 'crown', 'sword', 'shield', 'clock', 'watch', 'compass',
  'factory', 'warehouse', 'farm', 'tractor', 'kitchen', 'chef', 'restaurant', 'bakery',
  'tea', 'bread', 'pizza', 'burger', 'chocolate', 'fruit', 'water', 'fire', 'ice',
  'nuclear', 'wind', 'coal', 'steel', 'glass', 'newspaper', 'letter', 'map', 'flag',
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

export function extractClipWordsForWindow(
  transcript: TranscriptData | undefined,
  clipStart: number,
  clipEnd: number,
): WordTimestamp[] {
  const allWords = transcript?.words ?? [];
  return allWords
    .filter((w) => w.end >= clipStart - 0.5 && w.start <= clipEnd + 0.5)
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start - clipStart),
      end: Math.max(0.1, w.end - clipStart),
    }));
}

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

  const firstIdx = clause.words.findIndex((w) => cleanToken(w.word).toLowerCase() === target[0]);
  if (firstIdx >= 0) {
    const lastIdx = Math.min(clause.words.length - 1, firstIdx + target.length - 1);
    return { start: clause.words[firstIdx].start, end: clause.words[lastIdx].end };
  }
  return { start: clause.start, end: clause.end };
}

function buildQueriesForEntity(phrase: string, kind: BrollSubjectKind): string[] {
  const queries: string[] = [];
  const known = ORG_AND_BRAND_KNOWN.get(phrase.toLowerCase());
  if (known) {
    queries.push(known.canonical);
    if (known.fallback) queries.push(known.fallback);
  }

  queries.push(phrase);

  if (kind === 'person' && phrase.split(/\s+/).length >= 2) {
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

  // 1) AI-analysis proper entity hints
  for (const hint of analysisHints) {
    const cleanHint = hint.trim();
    const key = cleanHint.toLowerCase();
    if (cleanHint.length < 3 || seenLower.has(key) || containsProfanity(cleanHint)) continue;
    if (lowerText.includes(` ${key} `)) {
      seenLower.add(key);
      const { kind, priority } = classifyEntity(cleanHint);
      const span = findWordSpan(clause, cleanHint.split(/\s+/));
      const queries = buildQueriesForEntity(cleanHint, kind);
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

  // 2) Known organizations, brands, landmarks, and events
  for (const [dictKey, meta] of ORG_AND_BRAND_KNOWN.entries()) {
    if (seenLower.has(dictKey)) continue;
    if (lowerText.includes(` ${dictKey} `)) {
      seenLower.add(dictKey);
      const span = findWordSpan(clause, dictKey.split(/\s+/));
      const queries = [meta.canonical, ...(meta.fallback ? [meta.fallback] : [])];
      found.push({
        phrase: meta.canonical,
        queries,
        kind: meta.kind,
        priority: meta.kind === 'landmark' || meta.kind === 'event' ? 94 : 88,
        mentionStart: span.start,
        mentionEnd: span.end,
      });
    }
  }

  // 3) Capitalized proper-noun spans (Celebrities, Politicians, Athletes, Cities, Landmarks)
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

        const tokCap =
          /^[A-Z]/.test(tok) ||
          /^\d{4}$/.test(tok) ||
          /^(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|LVIII|LIX)$/.test(tok);
        if (tokCap && !containsProfanity(tok)) {
          spanTokens.push(tok);
          cursor += 1;
          const prevEndedClause = /[.!?,;:—–]["')]*$/.test(rawTokens[cursor - 1]);
          if (prevEndedClause) break;
          continue;
        }

        const nextTok = cursor + 1 < rawTokens.length ? cleanToken(rawTokens[cursor + 1]) : '';
        if (spanTokens.length > 0 && PROPER_CONNECTORS.has(tokLower) && /^[A-Z]/.test(nextTok)) {
          spanTokens.push(tokLower);
          cursor += 1;
          continue;
        }
        break;
      }

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
        (!isSentenceStart ||
          /^[A-Z]{2,}$/.test(phrase) ||
          PLACE_OR_LANDMARK_HINTS.has(phraseLower) ||
          EVENT_HINTS.has(phraseLower) ||
          phrase.length >= 5);

      if (
        (spanTokens.length >= 2 || validSingleWord) &&
        !seenLower.has(phraseLower) &&
        !GENERIC_NON_VISUAL_NOUNS.has(phraseLower)
      ) {
        seenLower.add(phraseLower);
        const { kind, priority } = classifyEntity(phrase);
        const wordSpan = findWordSpan(clause, spanTokens);
        const queries = buildQueriesForEntity(phrase, kind);
        if (queries.length > 0) {
          found.push({
            phrase,
            queries,
            kind,
            priority: spanTokens.length === 1 && isSentenceStart ? 70 : priority,
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

  // 4) Multi-word lowercase geographical / historical / event matches
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

  // 5) Concrete visual nouns & everyday podcast/tech/business/health visual concepts
  for (let idx = 0; idx < rawTokens.length; idx += 1) {
    const w = cleanToken(rawTokens[idx]).toLowerCase();
    if (!w || w.length < 2 || containsProfanity(w)) continue;
    const singular = w.endsWith('s') && w.length > 4 && !w.endsWith('ss') ? w.slice(0, -1) : w;

    const conceptVisual = SPOKEN_CONCEPT_VISUALS.get(w) ?? SPOKEN_CONCEPT_VISUALS.get(singular);
    if (conceptVisual && !seenLower.has(w) && !seenLower.has(conceptVisual.toLowerCase())) {
      seenLower.add(w);
      seenLower.add(conceptVisual.toLowerCase());
      const span = findWordSpan(clause, [w]);
      found.push({
        phrase: conceptVisual,
        queries: conceptVisual.toLowerCase() === w ? [conceptVisual] : [conceptVisual, w],
        kind: 'object',
        priority: 68,
        mentionStart: span.start,
        mentionEnd: span.end,
      });
      continue;
    }

    if (!CONCRETE_VISUAL_NOUNS.has(w) && !CONCRETE_VISUAL_NOUNS.has(singular)) continue;
    if (seenLower.has(w) || seenLower.has(singular)) continue;

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
      queries: hasUsefulModifier ? [phrase, singular] : [singular],
      kind: PLACE_OR_LANDMARK_HINTS.has(singular) ? 'place' : EVENT_HINTS.has(singular) ? 'event' : 'object',
      priority: hasUsefulModifier ? 66 : 60,
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

/**
 * Pure synchronous planner used during viral clip detection / clip editing so
 * every `ClipRecord` immediately knows how many B-roll images are planned.
 */
export function planClipBrollCount(options: {
  transcript?: TranscriptData;
  clipStart: number;
  clipEnd: number;
  aiAnalysis?: ViralClip;
  enableBroll?: boolean;
}): number {
  if (options.enableBroll === false) return 0;
  const duration = Math.max(0.5, options.clipEnd - options.clipStart);
  const target = targetBrollCountForDuration(duration);
  if (!options.transcript) return target;

  const clipWords = extractClipWordsForWindow(options.transcript, options.clipStart, options.clipEnd);
  const moments = extractBrollMomentsFromTranscript({
    transcript: options.transcript,
    clipWords,
    clipStart: options.clipStart,
    clipEnd: options.clipEnd,
    aiAnalysis: options.aiAnalysis,
  });
  const distinctSubjects = new Set(moments.map((m) => m.primarySubject.toLowerCase())).size;
  return distinctSubjects > 0 ? Math.min(target + 2, Math.max(distinctSubjects, target)) : target;
}

interface LlmVisualCueResponse {
  cues?: Array<{
    timeSeconds?: number;
    query?: string;
    fallbackQuery?: string;
    kind?: string;
  }>;
}

/**
 * Single-shot batched cue extraction via ClipCraft's existing free Gemini key pool
 * (`lib/llm.ts`). Uses `maxTokens: 8192` so Gemini 3.x thinking models complete
 * reliably without `MAX_TOKENS` truncation. Never throws; never called per image.
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
  const clipDuration = Math.max(0.5, clipEnd - clipStart);
  const bucketWidth = Math.max(1.5, clipDuration / Math.max(1, targetCount));
  const coveredBuckets = new Set(
    existingMoments
      .filter((m) => m.priority >= 75)
      .map((m) => Math.min(targetCount - 1, Math.max(0, Math.floor(m.mentionStart / bucketWidth)))),
  );
  if (coveredBuckets.size >= targetCount) {
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
    const desired = Math.max(targetCount + 2, 4);
    const completion = await completeWithFallback({
      task: 'broll visual query extraction',
      system:
        'You select photographable English Wikipedia / Wikimedia Commons subjects to illustrate spoken video clips as full-screen B-roll. ' +
        'RULES: ' +
        '1) Prioritize named celebrities, public figures, athletes, politicians, historical events, cities, countries, landmarks, organizations, brands, and concrete real-world objects/scenes directly relevant to what is being said at that timestamp. ' +
        '2) `query` MUST be a concise 1-to-3 word canonical encyclopedia title with real photographs on Wikipedia/Wikimedia Commons (e.g. "Elon Musk", "Wall Street", "Smartphone", "SpaceX Falcon 9", "Coffee", "Human brain", "Courtroom"). NEVER write long 6-word sentences. ' +
        '3) `fallbackQuery` MUST be a 1-to-2 word broader concrete noun (e.g. "Rocket", "Stock exchange", "Laptop"). ' +
        '4) Distribute cues across the full timeline, using DISTINCT subjects for each cue. ' +
        'Output strict JSON: {"cues":[{"timeSeconds":number,"query":string,"fallbackQuery":string,"kind":"person|landmark|place|event|organization|object"}]}',
      prompt: `Extract up to ${desired} distinct, timestamp-aligned Wikipedia/Wikimedia Commons B-roll subjects for this ${clipDuration.toFixed(1)}s clip:\n\n${formattedLines}`,
      maxTokens: 8_192,
      temperature: 0.2,
      json: true,
    });

    const parsed = JSON.parse(completion.text) as LlmVisualCueResponse;
    if (!Array.isArray(parsed.cues) || parsed.cues.length === 0) {
      return existingMoments;
    }

    const merged = [...existingMoments];
    for (const cue of parsed.cues) {
      const query = typeof cue.query === 'string' ? cue.query.trim() : '';
      const fallback = typeof cue.fallbackQuery === 'string' ? cue.fallbackQuery.trim() : '';
      const time = Number(cue.timeSeconds);
      if (!query || query.length < 2 || containsProfanity(query) || !Number.isFinite(time)) {
        continue;
      }
      const queries = [query, ...(fallback && fallback.toLowerCase() !== query.toLowerCase() && !containsProfanity(fallback) ? [fallback] : [])];
      const clampedTime = Math.max(0, Math.min(clipDuration - 0.3, time));
      const nearestClause =
        clauses.find((c) => clampedTime >= c.start - 0.5 && clampedTime <= c.end + 0.5) ??
        clauses.reduce((best, cur) =>
          Math.abs(cur.start - clampedTime) < Math.abs(best.start - clampedTime) ? cur : best,
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
        queries,
        primarySubject: query,
        subjectKind: kind,
        segmentText: nearestClause.text,
        priority: kind === 'person' ? 95 : kind === 'landmark' || kind === 'event' ? 91 : 84,
      });
    }

    log.detail(`B-roll LLM enriched ${parsed.cues.length} timestamped visual cue(s)`);
    return merged;
  } catch (error) {
    log.warn(`B-roll LLM cue enrichment skipped (using local transcript cues): ${toErrorMessage(error)}`);
    return existingMoments;
  }
}
