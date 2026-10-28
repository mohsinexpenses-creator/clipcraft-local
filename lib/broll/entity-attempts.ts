import type { BrollEntity } from "./analysis";
import type { BrollCandidate } from "./providers/types";

export type EntityAttemptMode = "context" | "name-only";
export interface EntityAttempt {
  label: string;
  query: string;
  mode: EntityAttemptMode;
}

const TYPE_HINTS: Record<BrollEntity["type"], string[]> = {
  person: ["portrait", "headshot", "photo"],
  place: ["exterior", "landmark", "aerial view"],
  event: ["photo", "ceremony", "crowd"],
};

/** Ordered ladder: context first, then name only, then name + type hint. */
export function buildEntityAttempts(entity: BrollEntity): EntityAttempt[] {
  const name = entity.name.trim();
  const raw: EntityAttempt[] = [
    { label: "context", query: entity.contextQuery?.trim() || entity.searchQuery, mode: "context" },
    { label: "name", query: name, mode: "name-only" },
    ...TYPE_HINTS[entity.type].map((hint) => ({
      label: `name+${hint}`,
      query: `${name} ${hint}`,
      mode: "name-only" as const,
    })),
  ];
  const seen = new Set<string>();
  return raw.filter((attempt) => {
    const key = attempt.query.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function candidateKey(candidate: BrollCandidate): string {
  return candidate.imageUrl;
}

/** Portrait images first (they fill 9:16 with the least cropping); landscape only as filler. */
export function preferPortrait(list: BrollCandidate[]): BrollCandidate[] {
  const isPortrait = (c: BrollCandidate) => c.height >= c.width * 0.95;
  return [...list.filter(isPortrait), ...list.filter((c) => !isPortrait(c))];
}

/** Interleave several provider lists, drop duplicates. */
export function mergeCandidates(...lists: BrollCandidate[][]): BrollCandidate[] {
  const out: BrollCandidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      const c = list[i];
      if (c && !seen.has(candidateKey(c))) {
        seen.add(candidateKey(c));
        out.push(c);
      }
    }
  }
  return out;
}