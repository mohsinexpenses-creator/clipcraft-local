/**
 * ClipCraft's render-time safety lexicon.
 *
 * This is deliberately data only. `lib/profanity.ts` turns these roots, aliases,
 * inflections and phrases into boundary-safe matchers for captions and audio. Keep
 * every moderated term here so product policy can be reviewed without hunting
 * through regexes. The transcript itself is never changed.
 */

export type SafetyLexiconCategory =
  | 'profanity'
  | 'sexual'
  | 'slur-hate'
  | 'violence-self-harm'
  | 'drugs';

export interface SafetyWordEntry {
  /** Canonical lower-case spelling. */
  term: string;
  /** Common spellings, contractions and compact obfuscations. */
  aliases?: readonly string[];
  /** Safe suffixes appended to this root by the matcher. */
  suffixes?: readonly string[];
}

export interface SafetyPhraseEntry {
  /** Words in their normal spoken order. Matching is punctuation/case insensitive. */
  phrase: readonly string[];
  /** Alternative word sequences (for example an abbreviated spelling). */
  aliases?: readonly (readonly string[])[];
}

export interface SafetyLexiconCategoryEntries {
  words: readonly SafetyWordEntry[];
  phrases: readonly SafetyPhraseEntry[];
}

/**
 * The one source of truth for render-time language moderation. This intentionally
 * includes language that is often merely "edgy": the product promises a child-safe,
 * platform-safe output, not a minimum legal threshold.
 */
export const SAFETY_LEXICON: Readonly<Record<SafetyLexiconCategory, SafetyLexiconCategoryEntries>> = {
  profanity: {
    words: [
      { term: 'fuck', aliases: ['fck', 'fuk', 'fuq'], suffixes: ['s', 'ed', 'er', 'ers', 'ing', 'in', 'in g', 'in\''] },
      { term: 'motherfucker', aliases: ['motherfucker', 'motherfuker', 'mfer'], suffixes: ['s'] },
      { term: 'shit', aliases: ['shyt'], suffixes: ['s', 'ty', 'ting', 'ted'] },
      { term: 'bullshit', aliases: ['bullshyt'], suffixes: ['s', 'ting'] },
      { term: 'bitch', aliases: ['biatch'], suffixes: ['es', 'y', 'ing'] },
      { term: 'bastard', suffixes: ['s', 'ized', 'ising', 'izing'] },
      { term: 'ass', aliases: ['arse'], suffixes: ['es'] },
      { term: 'asshole', aliases: ['arsehole'], suffixes: ['s'] },
      { term: 'dumbass', aliases: ['dumb arse'], suffixes: ['es'] },
      { term: 'jackass', suffixes: ['es'] },
      { term: 'badass', suffixes: ['es'] },
      { term: 'goddamn', aliases: ['goddam', 'goddamm', 'g d damn'], suffixes: ['ed', 'ing'] },
      { term: 'damn', suffixes: ['ed', 'ing'] },
      { term: 'hell', suffixes: ['s'] },
      { term: 'crap', suffixes: ['s', 'py'] },
      { term: 'piss', suffixes: ['ed', 'ing', 'es', 'y'] },
    ],
    phrases: [
      { phrase: ['son', 'of', 'a', 'bitch'], aliases: [['sons', 'of', 'bitches']] },
      { phrase: ['piece', 'of', 'shit'] },
      { phrase: ['for', 'fucks', 'sake'], aliases: [['for', 'fucks', 'sake']] },
      { phrase: ['what', 'the', 'fuck'] },
      { phrase: ['holy', 'shit'] },
    ],
  },
  sexual: {
    words: [
      { term: 'sex', aliases: ['sexx'], suffixes: ['y', 'ual', 'ually', 'ing', 'ed'] },
      { term: 'porn', aliases: ['porno', 'pr0n'], suffixes: ['s', 'ographic', 'ography'] },
      { term: 'nude', aliases: ['nudie'], suffixes: ['s', 'ity'] },
      { term: 'dick', aliases: ['dik'], suffixes: ['s', 'head', 'heads'] },
      { term: 'cock', aliases: ['cok'], suffixes: ['s', 'head', 'heads'] },
      { term: 'pussy', aliases: ['pussie'], suffixes: ['s'] },
      { term: 'cunt', suffixes: ['s'] },
      { term: 'whore', aliases: ['hoe'], suffixes: ['s', 'ing'] },
      { term: 'slut', suffixes: ['s', 'ty'] },
      { term: 'boob', aliases: ['boobie'], suffixes: ['s'] },
      { term: 'tit', aliases: ['titty'], suffixes: ['s'] },
      { term: 'breast', suffixes: ['s'] },
      { term: 'penis', suffixes: ['es'] },
      { term: 'vagina', suffixes: ['s'] },
      { term: 'anus', suffixes: ['es'] },
      { term: 'anal', suffixes: ['ly'] },
      { term: 'cum', aliases: ['cumm', 'jizz'], suffixes: ['s', 'ing'] },
      { term: 'semen', suffixes: [] },
      { term: 'orgasm', suffixes: ['s', 'ic'] },
      { term: 'masturbate', aliases: ['masturbation'], suffixes: ['s', 'd', 'ing', 'ory'] },
      { term: 'hentai', suffixes: [] },
    ],
    phrases: [
      { phrase: ['blow', 'job'], aliases: [['blowjob']] },
      { phrase: ['hand', 'job'], aliases: [['handjob']] },
      { phrase: ['oral', 'sex'] },
      { phrase: ['strip', 'club'] },
      { phrase: ['only', 'fans'], aliases: [['onlyfans']] },
    ],
  },
  'slur-hate': {
    words: [
      { term: 'nigger', aliases: ['nigga', 'niggaah', 'n1gger'], suffixes: ['s'] },
      { term: 'faggot', aliases: ['fag', 'f4g'], suffixes: ['s'] },
      { term: 'retard', aliases: ['retarded'], suffixes: ['s', 'ed', 'ing'] },
      { term: 'kike', suffixes: ['s'] },
      { term: 'spic', suffixes: ['s'] },
      { term: 'chink', suffixes: ['s'] },
      { term: 'raghead', suffixes: ['s'] },
      { term: 'tranny', suffixes: ['s'] },
    ],
    phrases: [
      { phrase: ['go', 'back', 'to', 'your', 'country'] },
      { phrase: ['racial', 'slur'] },
    ],
  },
  'violence-self-harm': {
    words: [
      { term: 'suicide', aliases: ['suicidal'], suffixes: ['s'] },
      { term: 'murder', suffixes: ['s', 'ed', 'er', 'ers', 'ing'] },
      { term: 'rape', suffixes: ['s', 'd', 'r', 'rs', 'ing'] },
      { term: 'torture', suffixes: ['s', 'd', 'r', 'rs', 'ing'] },
      { term: 'slaughter', suffixes: ['s', 'ed', 'ing'] },
      { term: 'massacre', suffixes: ['s', 'd'] },
    ],
    phrases: [
      { phrase: ['kill', 'yourself'], aliases: [['kys'], ['go', 'kill', 'yourself']] },
      { phrase: ['hurt', 'yourself'] },
      { phrase: ['cut', 'yourself'] },
      { phrase: ['hang', 'yourself'] },
      { phrase: ['shoot', 'yourself'] },
      { phrase: ['end', 'your', 'life'] },
      { phrase: ['self', 'harm'], aliases: [['selfharm']] },
      { phrase: ['make', 'a', 'bomb'] },
      { phrase: ['how', 'to', 'kill'] },
    ],
  },
  drugs: {
    words: [
      { term: 'cocaine', aliases: ['coke'], suffixes: [] },
      { term: 'heroin', suffixes: [] },
      { term: 'meth', aliases: ['methamphetamine', 'crystal meth'], suffixes: [] },
      { term: 'fentanyl', aliases: ['fent'], suffixes: [] },
      { term: 'opioid', aliases: ['opiate'], suffixes: ['s'] },
      { term: 'ecstasy', aliases: ['mdma', 'molly'], suffixes: [] },
      { term: 'marijuana', aliases: ['weed', 'cannabis'], suffixes: [] },
      { term: 'ketamine', aliases: ['ket'], suffixes: [] },
      { term: 'lsd', aliases: ['acid'], suffixes: [] },
      { term: 'crack', suffixes: [] },
    ],
    phrases: [
      { phrase: ['snort', 'cocaine'] },
      { phrase: ['take', 'drugs'] },
      { phrase: ['sell', 'drugs'] },
      { phrase: ['shoot', 'up'] },
    ],
  },
} as const;

/**
 * Full phrase allowlist for legitimate proper names and product terms. The matcher
 * applies this before masking, so the broad safety roots never create a classic
 * Scunthorpe-style false positive.
 */
export const SAFETY_ALLOWLIST: readonly (readonly string[])[] = [
  ['scunthorpe'],
  ['dick', 'van', 'dyke'],
  ['dick', 'cheney'],
  ['cocktail'],
  ['class'],
  ['assess'],
  ['assessment'],
  ['hello'],
] as const;
