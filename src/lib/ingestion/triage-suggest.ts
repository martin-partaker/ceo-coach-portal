import { db } from '@/db';
import { ceos, ceoEmailAliases, coaches, cycles, type RawInput } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface TriageSuggestion {
  ceoId: string;
  ceoName: string;
  ceoEmail: string | null;
  ceoAvatarUrl: string | null;
  coachId: string;
  coachName: string;
  confidence: number; // 0-100
  reasoning: string;
}

export interface TriageCycleSuggestion {
  cycleId: string;
  cycleLabel: string;
  confident: boolean;
}

export interface SubmittedByCoach {
  email: string;
  name: string | null;
}

export interface PendingRowSuggestions {
  rawInputId: string;
  source: string;
  contentType: string;
  occurredAt: Date;
  coachId: string | null;
  coachName: string | null;
  submitterEmail: string | null;
  submitterName: string | null;
  /** Set when an @partaker.com email submitted the form on behalf of a CEO. */
  submittedByCoach: SubmittedByCoach | null;
  textSnippet: string;
  meetingTopic: string | null;
  participantsSummary: string | null;
  matchStatus: string;
  // The big ones:
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
  cycleSuggestion: TriageCycleSuggestion | null;
}

const PUNCT_RX = /[.,;:!?_'"`()\[\]{}<>\/\\|@#&*+=~^-]/g;

function normalizeText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(PUNCT_RX, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean);
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
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  const intersection = new Set([...ta].filter((x) => tb.has(x)));
  const union = new Set([...ta, ...tb]);
  return intersection.size / union.size;
}

function scoreNameMatch(candidate: string, ceoName: string): number {
  const candTokens = tokens(candidate);
  const ceoTokens = tokens(ceoName);
  if (candTokens.length === 0 || ceoTokens.length === 0) return 0;

  const firstCand = candTokens[0];
  const firstCeo = ceoTokens[0];
  const lastCand = candTokens[candTokens.length - 1];
  const lastCeo = ceoTokens[ceoTokens.length - 1];

  const firstRatio = levenshteinRatio(firstCand, firstCeo);
  const tsr = tokenSetRatio(candidate, ceoName);

  if (candTokens.length === 1) return Math.max(firstRatio * 0.95, tsr);
  if (ceoTokens.length === 1) return Math.max(firstRatio, tsr);

  const lastRatio = levenshteinRatio(lastCand, lastCeo);
  if (firstCand === firstCeo && lastCand === lastCeo) return 1;
  const combined = (firstRatio + lastRatio) / 2;
  return Math.max(combined, tsr);
}

interface CeoWithAliases {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  coachId: string;
  coachName: string;
  aliases: string[];
}

async function loadCeoIndex(): Promise<CeoWithAliases[]> {
  const rows = await db
    .select({
      id: ceos.id,
      name: ceos.name,
      email: ceos.email,
      avatarUrl: ceos.avatarUrl,
      coachId: ceos.coachId,
      coachName: coaches.name,
    })
    .from(ceos)
    .innerJoin(coaches, eq(ceos.coachId, coaches.id));

  const aliases = await db
    .select({ ceoId: ceoEmailAliases.ceoId, email: ceoEmailAliases.email })
    .from(ceoEmailAliases);

  const aliasesByCeo = new Map<string, string[]>();
  for (const a of aliases) {
    if (!aliasesByCeo.has(a.ceoId)) aliasesByCeo.set(a.ceoId, []);
    aliasesByCeo.get(a.ceoId)!.push(a.email);
  }

  return rows.map((r) => ({
    ...r,
    aliases: aliasesByCeo.get(r.id) ?? [],
  }));
}

interface ScoredCeo {
  ceo: CeoWithAliases;
  score: number;
  reasoningParts: string[];
}

function scoreCeoForSubmission(args: {
  ceo: CeoWithAliases;
  submitterEmail: string | null;
  submitterName: string | null;
}): ScoredCeo {
  const { ceo, submitterEmail, submitterName } = args;
  let bestScore = 0;
  const reasoningParts: string[] = [];

  // Email-based scoring
  if (submitterEmail) {
    const [submitLocal, submitDomain] = submitterEmail.split('@');

    for (const alias of ceo.aliases) {
      const [aliasLocal, aliasDomain] = alias.split('@');

      // Exact local + close domain → likely typo
      if (submitLocal === aliasLocal && submitDomain && aliasDomain) {
        const domainRatio = levenshteinRatio(submitDomain, aliasDomain);
        if (domainRatio > 0.7 && domainRatio < 1) {
          const score = 0.85 + domainRatio * 0.1;
          if (score > bestScore) {
            bestScore = score;
            reasoningParts.length = 0;
            reasoningParts.push(`domain typo: ${submitDomain} ≈ ${aliasDomain}`);
          }
        }
      }

      // Same domain + close local
      if (submitDomain === aliasDomain && submitLocal !== aliasLocal) {
        const localRatio = levenshteinRatio(submitLocal ?? '', aliasLocal ?? '');
        if (localRatio > 0.7) {
          const score = localRatio * 0.8 + 0.1; // same domain bonus
          if (score > bestScore) {
            bestScore = score;
            reasoningParts.length = 0;
            reasoningParts.push(`same domain, similar address: ${submitLocal} ≈ ${aliasLocal}`);
          }
        }
      }

      // Generic full-string fuzzy
      const ratio = levenshteinRatio(submitterEmail, alias);
      if (ratio > 0.85 && ratio > bestScore) {
        bestScore = ratio;
        reasoningParts.length = 0;
        reasoningParts.push(`email very close to ${alias}`);
      }
    }
  }

  // Name-based scoring (additive — boosts a partial email match)
  if (submitterName && submitterName.length >= 2) {
    const nameScore = scoreNameMatch(submitterName, ceo.name);
    if (nameScore > 0.6) {
      // Combine: if both signals agree, boost; otherwise pick best
      if (bestScore > 0 && reasoningParts.length > 0) {
        // We already have an email signal. Boost if name agrees.
        const combined = Math.min(0.99, bestScore * 0.7 + nameScore * 0.4);
        bestScore = combined;
        reasoningParts.push(`name match: "${submitterName}" ↔ "${ceo.name}"`);
      } else if (nameScore > bestScore) {
        bestScore = nameScore;
        reasoningParts.length = 0;
        reasoningParts.push(`name match: "${submitterName}" ↔ "${ceo.name}"`);
      }
    }
  }

  return { ceo, score: bestScore, reasoningParts };
}

function toSuggestion(scored: ScoredCeo): TriageSuggestion {
  return {
    ceoId: scored.ceo.id,
    ceoName: scored.ceo.name,
    ceoEmail: scored.ceo.email,
    ceoAvatarUrl: scored.ceo.avatarUrl,
    coachId: scored.ceo.coachId,
    coachName: scored.ceo.coachName,
    confidence: Math.round(scored.score * 100),
    reasoning: scored.reasoningParts.join(' · ') || 'weak signal',
  };
}

interface MatchCandidatesShape {
  reason?: string;
  email?: string;
  name?: string;
}
interface FuzzyEntry {
  candidateName?: string;
  candidateEmail?: string | null;
  topMatches?: Array<{ ceoId: string; ceoName: string; score: number }>;
}

/**
 * Compute suggestions for a single pending raw_input. Reads from existing
 * matchCandidates when present (Zoom fuzzy already ran during ingest) and
 * falls back to fresh global scoring for Tally rows.
 *
 * Special case: pending_cycle rows already have a CEO matched — the
 * "suggestion" is just confirming that CEO (high confidence) so the operator
 * can move on to the cycle assignment in the same card.
 */
export async function suggestForPendingRow(
  rawInput: RawInput,
  ceoIndex?: CeoWithAliases[]
): Promise<{
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
}> {
  // pending_cycle: CEO already matched, the work is to pick a cycle
  if (rawInput.matchStatus === 'pending_cycle' && rawInput.ceoId) {
    const idx = ceoIndex ?? (await loadCeoIndex());
    const ceo = idx.find((c) => c.id === rawInput.ceoId);
    if (ceo) {
      return {
        topSuggestion: {
          ceoId: ceo.id,
          ceoName: ceo.name,
          ceoEmail: ceo.email,
          ceoAvatarUrl: ceo.avatarUrl,
          coachId: ceo.coachId,
          coachName: ceo.coachName,
          confidence: 100,
          reasoning:
            'CEO matched by exact email. No cycle covers this date — pick one below.',
        },
        alternatives: [],
      };
    }
  }

  const candidates = rawInput.matchCandidates;

  // Zoom path: re-compute fuzzy scores fresh at triage time using the
  // current matcher logic, so improvements to scoreNameMatch immediately
  // affect what the operator sees (without re-ingesting).
  if (rawInput.source === 'zoom' && rawInput.coachId) {
    const payload = rawInput.payloadJson as {
      participants?: Array<{ name?: string; internal_user?: boolean; user_email?: string }>;
    } | null;
    const externals = (payload?.participants ?? []).filter(
      (p) => !p.internal_user && p.name?.trim()
    );
    if (externals.length > 0) {
      const candidateName = externals[0].name!;
      const idx = ceoIndex ?? (await loadCeoIndex());
      // Scope to the meeting host's roster (coachId is set at ingest)
      const roster = idx.filter((c) => c.coachId === rawInput.coachId);
      const scored = roster
        .map((ceo) => ({ ceo, score: scoreNameMatch(candidateName, ceo.name) }))
        .filter((s) => s.score >= 0.3)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const mapped: TriageSuggestion[] = scored.slice(0, 4).map((s) => ({
          ceoId: s.ceo.id,
          ceoName: s.ceo.name,
          ceoEmail: s.ceo.email,
          ceoAvatarUrl: s.ceo.avatarUrl,
          coachId: s.ceo.coachId,
          coachName: s.ceo.coachName,
          confidence: Math.round(s.score * 100),
          reasoning: `name match: "${candidateName}" ↔ "${s.ceo.name}"`,
        }));
        return { topSuggestion: mapped[0], alternatives: mapped.slice(1, 4) };
      }
    }
  }

  // Legacy fallback for older Zoom rows whose matchCandidates is an array
  // (kept for safety; the live recompute path above should cover all cases
  // where coachId + payload are present).
  if (Array.isArray(candidates)) {
    const fuzzy = candidates as unknown as FuzzyEntry[];
    const top = fuzzy[0]?.topMatches ?? [];
    if (top.length > 0) {
      const idx = ceoIndex ?? (await loadCeoIndex());
      const candidateName = fuzzy[0].candidateName ?? '';
      const mapped: TriageSuggestion[] = top
        .map((m) => {
          const ceo = idx.find((c) => c.id === m.ceoId);
          if (!ceo) return null;
          return {
            ceoId: ceo.id,
            ceoName: ceo.name,
            ceoEmail: ceo.email,
            ceoAvatarUrl: ceo.avatarUrl,
            coachId: ceo.coachId,
            coachName: ceo.coachName,
            confidence: Math.round(m.score * 100),
            reasoning: `name match: "${candidateName}" ↔ "${ceo.name}"`,
          };
        })
        .filter((x): x is TriageSuggestion => x !== null);

      return {
        topSuggestion: mapped[0] ?? null,
        alternatives: mapped.slice(1, 4),
      };
    }
  }

  // Tally path: compute from submitter email + name across the whole index.
  const obj = candidates as MatchCandidatesShape | null;
  const submitterEmail = obj?.email?.toLowerCase().trim() ?? null;
  const submitterName = obj?.name?.trim() ?? null;

  if (!submitterEmail && !submitterName) {
    return { topSuggestion: null, alternatives: [] };
  }

  const idx = ceoIndex ?? (await loadCeoIndex());
  const scored = idx.map((ceo) =>
    scoreCeoForSubmission({ ceo, submitterEmail, submitterName })
  );
  scored.sort((a, b) => b.score - a.score);

  const meaningful = scored.filter((s) => s.score >= 0.3);
  if (meaningful.length === 0) {
    return { topSuggestion: null, alternatives: [] };
  }

  return {
    topSuggestion: toSuggestion(meaningful[0]),
    alternatives: meaningful.slice(1, 4).map(toSuggestion),
  };
}

/**
 * Cycle suggestion for a (ceoId, occurredAt) pair — reused by the triage UI.
 */
export async function suggestCycleFor(args: {
  ceoId: string;
  occurredAt: Date;
}): Promise<TriageCycleSuggestion | null> {
  const occurred = args.occurredAt.toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: cycles.id,
      label: cycles.label,
      periodStart: cycles.periodStart,
      periodEnd: cycles.periodEnd,
    })
    .from(cycles)
    .where(eq(cycles.ceoId, args.ceoId));

  const exact = rows.find(
    (r) =>
      r.periodStart && r.periodEnd && r.periodStart <= occurred && r.periodEnd >= occurred
  );
  if (exact) return { cycleId: exact.id, cycleLabel: exact.label, confident: true };

  const fallback = rows
    .filter((r) => r.periodStart && r.periodStart <= occurred)
    .sort((a, b) => (b.periodStart ?? '').localeCompare(a.periodStart ?? ''))[0];
  if (fallback) return { cycleId: fallback.id, cycleLabel: fallback.label, confident: false };

  return null;
}

export async function loadCeoIndexCached(): Promise<CeoWithAliases[]> {
  return loadCeoIndex();
}
