import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { ceos } from '@/db/schema';
import { INGESTION_CONFIG } from './config';

export interface CeoMatchCandidate {
  ceoId: string;
  ceoName: string;
  score: number; // 0-1
}

export interface CeoMatchResult {
  bestMatch: CeoMatchCandidate | null;
  topCandidates: CeoMatchCandidate[];
}

const PUNCT_RX = /[.,;:!?_'"`()\[\]{}<>\/\\|@#&*+=~^-]/g;

function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(PUNCT_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function levenshteinRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  const intersection = new Set([...ta].filter((x) => tb.has(x)));
  const union = new Set([...ta, ...tb]);
  return intersection.size / union.size;
}

/**
 * Score a candidate name against a CEO record. Combines first + last name
 * Levenshtein ratios so that:
 *   "Dave Dieter" ↔ "David Dieter"  (shared last name, nickname first) → high
 *   "Dave Dieter" ↔ "Dave Snyder"   (only shared first name)            → medium
 * Falls back to token-set ratio for unusual structures.
 */
function scoreNameMatch(candidateName: string, ceoName: string): number {
  const candTokens = tokens(candidateName);
  const ceoTokens = tokens(ceoName);
  if (candTokens.length === 0 || ceoTokens.length === 0) return 0;

  const firstCand = candTokens[0];
  const firstCeo = ceoTokens[0];
  const lastCand = candTokens[candTokens.length - 1];
  const lastCeo = ceoTokens[ceoTokens.length - 1];

  const firstRatio = levenshteinRatio(firstCand, firstCeo);
  const tsr = tokenSetRatio(candidateName, ceoName);

  // Single-token candidate (e.g. "Chris" or "Milos") — match against CEO's
  // first name only, since there's nothing else to compare.
  if (candTokens.length === 1) {
    return Math.max(firstRatio * 0.95, tsr);
  }

  // Multi-token candidate, single-token CEO record — match against the CEO's
  // first name OR token-set, whichever is higher.
  if (ceoTokens.length === 1) {
    return Math.max(firstRatio, tsr);
  }

  // Both have first + last. Combine evenly so that exact last-name + fuzzy
  // first-name beats exact first-name + unrelated last-name.
  const lastRatio = levenshteinRatio(lastCand, lastCeo);
  const combined = (firstRatio + lastRatio) / 2;

  // Bonus when BOTH parts agree strongly — exact matches on both dominate.
  const bothExact = firstCand === firstCeo && lastCand === lastCeo;
  if (bothExact) return 1;

  return Math.max(combined, tsr);
}

/**
 * Find the best CEO match for a candidate name, scoped to a coach's roster.
 * Scoping is what makes single-name candidates ("Chris", "Steve") tractable.
 */
export async function fuzzyMatchCeoForCoach(args: {
  coachId: string;
  candidateName: string;
}): Promise<CeoMatchResult> {
  const roster = await db
    .select({ id: ceos.id, name: ceos.name })
    .from(ceos)
    .where(eq(ceos.coachId, args.coachId));

  const scored: CeoMatchCandidate[] = roster.map((r) => ({
    ceoId: r.id,
    ceoName: r.name,
    score: scoreNameMatch(args.candidateName, r.name),
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  const best = top[0] ?? null;

  return {
    bestMatch: best && best.score >= INGESTION_CONFIG.fuzzyMatchThreshold ? best : null,
    topCandidates: top,
  };
}
