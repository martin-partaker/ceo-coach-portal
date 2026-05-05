import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/db';
import {
  ceos,
  ceoEmailAliases,
  coaches,
  cycles,
  rawInputs,
  type RawInput,
} from '@/db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { INGESTION_CONFIG } from './config';
import { MODELS } from '@/lib/anthropic/models';

const anthropic = new Anthropic();

const NAME_MATCH_AUTO_THRESHOLD = 0.95;

export interface TriageSuggestion {
  ceoId: string;
  ceoName: string;
  ceoEmail: string | null;
  ceoAvatarUrl: string | null;
  /** Null when the suggested CEO is in the Unassigned bucket. */
  coachId: string | null;
  coachName: string | null;
  /** Kept on the type for compatibility with older callers. The new
   *  AI-driven suggester doesn't surface a numeric score — operators
   *  trusted prose explanations more than percentages. */
  confidence: number;
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

export interface ClassifierLite {
  meetingType?: string;
  includeInMonthlySummary?: boolean;
  includeReason?: string;
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
  /** Verdict from the LLM classifier (Zoom only). Kept on the row data
   *  for completeness — the simplified triage card no longer surfaces it
   *  as a separate block; the AI's CEO match reason is the single source
   *  of "AI says X". */
  classification: ClassifierLite | null;
  matchStatus: string;
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
  cycleSuggestion: TriageCycleSuggestion | null;
}

interface CeoWithAliases {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  /** Null when the CEO is in the Unassigned bucket — they still appear
   *  as triage suggestions but the operator may want to assign a coach
   *  before routing inputs to them. */
  coachId: string | null;
  coachName: string | null;
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
    .leftJoin(coaches, eq(ceos.coachId, coaches.id));

  const aliases = await db
    .select({ ceoId: ceoEmailAliases.ceoId, email: ceoEmailAliases.email })
    .from(ceoEmailAliases);

  const aliasesByCeo = new Map<string, string[]>();
  for (const a of aliases) {
    if (!aliasesByCeo.has(a.ceoId)) aliasesByCeo.set(a.ceoId, []);
    aliasesByCeo.get(a.ceoId)!.push(a.email);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    avatarUrl: r.avatarUrl,
    coachId: r.coachId,
    coachName: r.coachName,
    aliases: aliasesByCeo.get(r.id) ?? [],
  }));
}

/**
 * The names of all coaches on the platform. Crucial context for the
 * matcher because Zoom transcripts of coaching sessions feature both
 * the coach AND the CEO speaking — without this list the model treats
 * every named participant as a candidate. Cached per call site.
 */
async function loadCoachNames(): Promise<string[]> {
  const rows = await db.select({ name: coaches.name }).from(coaches);
  return rows.map((r) => r.name).filter(Boolean);
}

// In-process TTL cache for the CEO/coach catalog. The catalog is identical
// across every triageQueue suggestion in the same request and rarely
// changes between requests (only when an admin adds a CEO/alias, which
// also calls `invalidateCatalogCache` below). 60s is a safe ceiling that
// still covers the cron's "ingest a batch and suggest each row" pattern
// without serving stale data for long after a roster mutation.
interface CatalogCache {
  ceoIndex: CeoWithAliases[];
  coachNames: string[];
  expiresAt: number;
}
let catalogCache: CatalogCache | null = null;
const CATALOG_TTL_MS = 60_000;

export function invalidateCatalogCache(): void {
  catalogCache = null;
}

/** Levenshtein-ratio name scorer used by the deterministic short-circuit
 *  for single-participant Zoom rows. Local copy keeps this module free
 *  of circular imports against `match-ceo.ts`. */
function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,;:!?_'"`()\[\]{}<>\/\\|@#&*+=~^-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function nameScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

/**
 * Haiku occasionally wraps JSON output in ```json … ``` fences despite
 * the prompt saying "JSON only". Strip them before parsing so we don't
 * lose the suggestion to a syntax error.
 */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function buildSuggestion(
  ceo: CeoWithAliases | undefined,
  reason: string | undefined,
): TriageSuggestion | null {
  if (!ceo) return null;
  return {
    ceoId: ceo.id,
    ceoName: ceo.name,
    ceoEmail: ceo.email,
    ceoAvatarUrl: ceo.avatarUrl,
    coachId: ceo.coachId,
    coachName: ceo.coachName,
    confidence: 0,
    reasoning: (reason ?? '').trim(),
  };
}

/**
 * Cheap, deterministic short-circuits that bypass the LLM entirely when a
 * row is unambiguously matchable from existing data. Returns a suggestion
 * with `confidence = 100` when it fires; null when none of the rules
 * apply (in which case the caller falls through to the LLM).
 *
 * Rules, ordered cheapest-first:
 *   1. submitter email exact-matches a CEO's primary email or alias
 *      → that CEO. (Tally + Zoom both populate matchCandidates.email
 *      when one is present.)
 *   2. Zoom row with exactly one external (non-coach) participant whose
 *      name fuzzy-matches one CEO ≥0.95 → that CEO.
 *
 * Both rules avoid the catalog-string round-trip through Haiku for the
 * easy 60-70% of submissions, where the LLM was just spelling out what
 * an exact lookup already established.
 */
function deterministicSuggest(
  rawInput: RawInput,
  ceoIndex: CeoWithAliases[],
  coachNames: string[],
): { topSuggestion: TriageSuggestion | null; alternatives: TriageSuggestion[] } | null {
  if (ceoIndex.length === 0) return null;

  const candidates = rawInput.matchCandidates as { email?: string } | null;
  const submitterEmail = candidates?.email?.toLowerCase().trim() ?? null;

  // Rule 1: exact email match against primary or alias.
  if (submitterEmail) {
    const hit = ceoIndex.find(
      (c) =>
        c.email?.toLowerCase().trim() === submitterEmail ||
        c.aliases.some((a) => a.toLowerCase().trim() === submitterEmail),
    );
    if (hit) {
      return {
        topSuggestion: {
          ceoId: hit.id,
          ceoName: hit.name,
          ceoEmail: hit.email,
          ceoAvatarUrl: hit.avatarUrl,
          coachId: hit.coachId,
          coachName: hit.coachName,
          confidence: 100,
          reasoning: `Submitter email ${submitterEmail} matches this CEO directly.`,
        },
        alternatives: [],
      };
    }
  }

  // Rule 2: Zoom row with a single external non-coach participant whose
  // name matches one CEO with very high confidence. We require uniqueness
  // (only ONE CEO above the threshold) so a fuzzy first-name match doesn't
  // fire when two CEOs share a first name.
  if (rawInput.source === 'zoom') {
    const payload = rawInput.payloadJson as {
      participants?: Array<{ name?: string; user_email?: string; internal_user?: boolean }>;
    } | null;
    const coachSet = new Set(coachNames.map((n) => n.toLowerCase().trim()));
    const internalDomains = INGESTION_CONFIG.internalEmailDomains.map((d) => d.toLowerCase());
    const isInternalEmail = (email: string | undefined | null) => {
      const e = email?.toLowerCase().trim();
      if (!e) return false;
      const at = e.lastIndexOf('@');
      if (at < 0) return false;
      const domain = e.slice(at + 1);
      return internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    };
    const externals = (payload?.participants ?? [])
      .filter((p) => !p.internal_user)
      .filter((p) => {
        const name = (p.name ?? '').toLowerCase().trim();
        if (coachSet.has(name)) return false;
        if (isInternalEmail(p.user_email)) return false;
        return !!name;
      });
    // Dedup by name — Zoom often emits the same person multiple times
    // (waiting room / in_meeting transitions show as separate entries).
    const uniqueNames = Array.from(new Set(externals.map((p) => p.name!.trim())));
    if (uniqueNames.length === 1) {
      const candidateName = uniqueNames[0];
      const scored = ceoIndex
        .map((c) => ({ ceo: c, score: nameScore(candidateName, c.name) }))
        .sort((a, b) => b.score - a.score);
      const top = scored[0];
      const second = scored[1];
      if (
        top &&
        top.score >= NAME_MATCH_AUTO_THRESHOLD &&
        (!second || top.score - second.score >= 0.1)
      ) {
        return {
          topSuggestion: {
            ceoId: top.ceo.id,
            ceoName: top.ceo.name,
            ceoEmail: top.ceo.email,
            ceoAvatarUrl: top.ceo.avatarUrl,
            coachId: top.ceo.coachId,
            coachName: top.ceo.coachName,
            confidence: 100,
            reasoning: `Single external participant "${candidateName}" matches "${top.ceo.name}" with high confidence.`,
          },
          alternatives: [],
        };
      }
    }
  }

  return null;
}

/**
 * Ask Haiku which CEO from the roster this raw input belongs to. The
 * model sees: content excerpt, submitter email/name, Zoom participants
 * + topic when present, and the full roster (id + name + email +
 * aliases + coach). It returns one CEO id + a short prose reason, plus
 * up to two alternatives if there's reasonable ambiguity.
 *
 * Prompt structure uses Anthropic ephemeral cache:
 *   - System: rules + output schema (truly static).
 *   - User content[0] (cached): coaches list + CEO catalog. Identical
 *     across every row in a triage run, so the second call onwards hits
 *     the prompt cache and pays the much cheaper cache-read rate.
 *   - User content[1] (variable): the row's submitter / topic / excerpt.
 *
 * Cached portion typically runs 2–4k tokens (well above Haiku's 2048
 * minimum). The variable suffix is ~100–500 tokens. Net effect: input
 * token cost on triage refreshes drops by roughly the catalog/total
 * ratio (~80% on a typical roster).
 */
async function aiSuggestCeoForRawInput(
  rawInput: RawInput,
  ceoIndex: CeoWithAliases[],
  coachNames: string[],
): Promise<{
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
}> {
  if (ceoIndex.length === 0) {
    return { topSuggestion: null, alternatives: [] };
  }

  const candidates = rawInput.matchCandidates as
    | { email?: string; name?: string }
    | null;
  const submitterEmail = candidates?.email ?? null;
  const submitterName = candidates?.name ?? null;

  let topic = '';
  let participantsLine = '';
  /** True when every external (non-Zoom-internal) participant on the
   *  meeting is on the platform's coach list. Strong signal that this
   *  is a coach-to-coach internal meeting (e.g. supervision call, peer
   *  check-in) and shouldn't be matched to ANY CEO — even if a CEO is
   *  named in the topic or transcript. */
  let allParticipantsAreCoaches = false;
  if (rawInput.source === 'zoom') {
    const payload = rawInput.payloadJson as {
      meeting?: { topic?: string };
      participants?: Array<{
        name?: string;
        user_email?: string;
        internal_user?: boolean;
      }>;
    } | null;
    const externals = (payload?.participants ?? []).filter((p) => !p.internal_user);
    if (externals.length > 0) {
      // Annotate each participant with their resolved role so the model
      // doesn't have to cross-reference against the coach list itself.
      // Names are normalised to lowercase for the lookup since Zoom
      // capitalisation varies. We treat someone as a coach when EITHER:
      //   - their name matches a row in the coaches table, or
      //   - their email is on an internal domain (e.g. @partaker.com).
      // The email path catches supervisors/ops folks who aren't in the
      // coaches table but are clearly internal — which is exactly the
      // case that broke the all-coaches detection earlier.
      const coachSet = new Set(coachNames.map((n) => n.toLowerCase().trim()));
      const ceoNameSet = new Set(
        ceoIndex.map((c) => c.name.toLowerCase().trim()),
      );
      const internalDomains = INGESTION_CONFIG.internalEmailDomains.map((d) =>
        d.toLowerCase(),
      );
      const isInternalEmail = (email: string | undefined | null) => {
        const e = email?.toLowerCase().trim();
        if (!e) return false;
        const at = e.lastIndexOf('@');
        if (at < 0) return false;
        const domain = e.slice(at + 1);
        return internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
      };
      const isCoachLike = (p: { name?: string; user_email?: string }) =>
        coachSet.has((p.name ?? '').toLowerCase().trim()) ||
        isInternalEmail(p.user_email);

      const annotated = externals.map((p) => {
        const name = p.name?.trim() ?? '?';
        const role = isCoachLike(p)
          ? '(coach)'
          : ceoNameSet.has(name.toLowerCase())
            ? '(CEO)'
            : '(unknown)';
        const emailTag = p.user_email ? ` <${p.user_email}>` : '';
        return `${name}${emailTag} ${role}`;
      });
      const dedup = Array.from(new Set(annotated));
      participantsLine = dedup.join(', ');
      // Coach-to-coach meeting = every external participant is
      // coach-like (in coaches table OR internal email domain). Unknown
      // participants block the short-circuit since they could still be
      // a CEO we just don't have on the roster yet.
      allParticipantsAreCoaches =
        externals.length > 0 && externals.every(isCoachLike);
    }
    topic = payload?.meeting?.topic ?? '';
  }

  // Hard rule: a Zoom meeting where every participant is a known
  // coach is a coach-to-coach internal meeting (supervision, peer
  // check-in, ops sync). Don't burn a Haiku call — and don't risk the
  // model getting fooled by a CEO name in the topic field. Topic like
  // "Check-in: Jane Doe" + two coaches in the room means the coaches
  // are *discussing* Jane Doe, not coaching her.
  if (allParticipantsAreCoaches) {
    return { topSuggestion: null, alternatives: [] };
  }

  // Compact catalog — no aliases (rarely the deciding signal), no
  // explicit `id=` prefix (the model copies UUIDs reliably without it).
  const catalog = ceoIndex
    .map((c) => {
      const email = c.email ? ` · ${c.email}` : '';
      const coach = c.coachName ? ` · coach: ${c.coachName}` : ' · unassigned';
      return `- ${c.id} · ${c.name}${email}${coach}`;
    })
    .join('\n');

  const coachListLine =
    coachNames.length > 0
      ? coachNames.map((n) => `"${n}"`).join(', ')
      : '(none)';

  // Tight content excerpt. The CEO's name is almost always in the first
  // few hundred chars (Zoom: opening dialogue, Tally: first Q/A pair),
  // so 1500 is plenty and keeps us well under rate limits.
  const excerpt = (rawInput.textContent ?? '').slice(0, 1500).trim();

  // Static portion — same for every row in a triage run. Marked for
  // ephemeral cache so subsequent rows hit the cheap cache-read rate.
  const cachedRosterBlock = `Coaches on the platform (NOT candidates — never return a coach as the match):
${coachListLine}

CEO roster (uuid · name · email · coach):
${catalog}`;

  // Variable portion — one row's submitter / topic / excerpt.
  const variableContentBlock = `Content
- Source: ${rawInput.source}
- Type: ${rawInput.contentType}
- Submitter: ${submitterName ?? '(no name)'}${submitterEmail ? ` <${submitterEmail}>` : ''}
${topic ? `- Meeting topic: ${topic}\n` : ''}${participantsLine ? `- Participants: ${participantsLine}\n` : ''}
Excerpt (truncated):
"""
${excerpt || '(no text content)'}
"""

Return ONLY JSON, no markdown fences:
{ "ceoId": "<uuid from roster or null>", "reason": "≤25 words why", "alternatives": [{ "ceoId": "<uuid>", "reason": "≤20 words" }] }`;

  const systemPrompt = `Match the supplied content to ONE CEO from the roster.

How to decide:
1. **Participants beat topic.** If a CEO appears in the participants list (annotated "(CEO)"), match to that CEO. The meeting topic can be misleading or stale.
2. **A name in the topic is NOT a participant.** If the topic says "Check-in: Jane Doe" but Jane Doe is not in the participants list, the coaches are *discussing* Jane, not coaching her — return ceoId: null. Coach-to-coach supervision and peer check-ins frequently use a CEO's name as the meeting label.
3. **Coach mismatch is a red flag.** If the meeting is hosted by Coach A but the candidate CEO's assigned coach is Coach B, that's almost never a coaching session for that CEO — at most an alternative, never the top match.
4. **For Tally submissions**, look for "Q: name / A: <name>" or "Q: email / A: <email>" patterns in the excerpt, and use the submitter line above.
5. **Return ceoId: null** when (a) all participants are coaches, (b) no CEO from the roster is named as a participant or in the dialogue, or (c) the content is fully ambiguous. Don't guess from a topic alone.
6. Pick exactly one top match. Add up to 2 alternatives only if there's genuine ambiguity.

Output strictly valid JSON only — no markdown fences, no commentary.`;

  let parsed: {
    ceoId?: string | null;
    reason?: string;
    alternatives?: Array<{ ceoId?: string; reason?: string }>;
  };
  try {
    const message = await anthropic.messages.create({
      model: MODELS.classifier,
      max_tokens: 384,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: cachedRosterBlock,
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: variableContentBlock },
          ],
        },
      ],
    });
    const block = message.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      return { topSuggestion: null, alternatives: [] };
    }
    parsed = JSON.parse(stripJsonFences(block.text));
  } catch (err) {
    // Soft-fail: surface no suggestion, operator picks manually. We log
    // server-side so a degraded path is visible in ops.
    console.error('aiSuggestCeoForRawInput failed:', err);
    return { topSuggestion: null, alternatives: [] };
  }

  const byId = new Map(ceoIndex.map((c) => [c.id, c]));
  const top = buildSuggestion(byId.get(parsed.ceoId ?? ''), parsed.reason);
  const alts = (parsed.alternatives ?? [])
    .map((a) => buildSuggestion(byId.get(a.ceoId ?? ''), a.reason))
    .filter((x): x is TriageSuggestion => x !== null && (!top || x.ceoId !== top.ceoId))
    .slice(0, 2);

  return { topSuggestion: top, alternatives: alts };
}

/**
 * Compute suggestions for a single pending raw_input.
 *   - `pending_cycle`: CEO is already known by exact email; the work is
 *     to pick a cycle. Short-circuit so we don't spend an LLM call.
 *   - cheap deterministic match (exact email or single high-confidence
 *     participant): return without calling the model.
 *   - everything else: ask Haiku to pick a CEO from the roster.
 */
export async function suggestForPendingRow(
  rawInput: RawInput,
  ceoIndex?: CeoWithAliases[],
  coachNames?: string[],
): Promise<{
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
}> {
  const idx = ceoIndex ?? (await loadCeoIndex());
  const names = coachNames ?? (await loadCoachNames());

  if (rawInput.matchStatus === 'pending_cycle' && rawInput.ceoId) {
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
            'CEO matched by exact email — pick a cycle below.',
        },
        alternatives: [],
      };
    }
  }

  // Try the deterministic short-circuit before paying for an LLM call.
  const det = deterministicSuggest(rawInput, idx, names);
  if (det) return det;

  return aiSuggestCeoForRawInput(rawInput, idx, names);
}

/**
 * Compute the suggestion for a pending row AND persist it onto the row
 * (`suggested_ceo_id`, `suggested_reason`, `suggested_alternatives`,
 * `suggested_at`). The triage UI reads these columns, so a row's
 * suggestion is computed once per ingestion (or per invalidation) instead
 * of once per page load. Safe to call repeatedly — this is the canonical
 * write path for suggestions on raw_inputs.
 *
 * No-op for rows that aren't in `pending_ceo` / `pending_cycle`. Errors
 * are swallowed (logged) so a flaky LLM run doesn't break ingestion.
 */
export async function computeAndStoreSuggestion(rawInputId: string): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(rawInputs)
      .where(eq(rawInputs.id, rawInputId))
      .limit(1);
    if (!row) return;
    if (row.matchStatus !== 'pending_ceo' && row.matchStatus !== 'pending_cycle') {
      return;
    }

    const { ceoIndex, coachNames } = await getCatalog();
    const result = await suggestForPendingRow(row, ceoIndex, coachNames);

    const top = result.topSuggestion;
    const alts = result.alternatives.map((a) => ({
      ceoId: a.ceoId,
      reason: a.reasoning,
    }));

    await db
      .update(rawInputs)
      .set({
        suggestedCeoId: top?.ceoId ?? null,
        suggestedReason: top?.reasoning ?? null,
        suggestedAlternatives: alts.length > 0 ? alts : null,
        suggestedAt: new Date(),
      })
      .where(eq(rawInputs.id, rawInputId));
  } catch (err) {
    console.error('computeAndStoreSuggestion failed:', { rawInputId, err });
  }
}

/**
 * Mark every pending row's suggestion as stale so the next triageQueue
 * read will recompute. Cheap — a single UPDATE that nulls `suggested_at`
 * — so we can call it generously: on CEO add, alias add, or any other
 * roster change that might shift who a pending row should match.
 */
export async function invalidatePendingSuggestions(opts?: {
  rawInputIds?: string[];
}): Promise<void> {
  invalidateCatalogCache();
  if (opts?.rawInputIds && opts.rawInputIds.length > 0) {
    await db
      .update(rawInputs)
      .set({ suggestedAt: null })
      .where(inArray(rawInputs.id, opts.rawInputIds));
    return;
  }
  await db
    .update(rawInputs)
    .set({ suggestedAt: null })
    .where(inArray(rawInputs.matchStatus, ['pending_ceo', 'pending_cycle']));
}

/**
 * Project the persisted columns back into the runtime suggestion shape
 * the triage card expects. Returns null when the row hasn't been suggested
 * yet (so the caller can lazy-fill).
 */
export function suggestionFromRow(
  row: RawInput,
  ceoIndex: CeoWithAliases[],
): {
  topSuggestion: TriageSuggestion | null;
  alternatives: TriageSuggestion[];
} | null {
  if (!row.suggestedAt) return null;
  const byId = new Map(ceoIndex.map((c) => [c.id, c]));
  const top = buildSuggestion(
    row.suggestedCeoId ? byId.get(row.suggestedCeoId) : undefined,
    row.suggestedReason ?? undefined,
  );
  const altsRaw = (row.suggestedAlternatives ?? []) as Array<{
    ceoId?: string;
    reason?: string;
  }>;
  const alts = altsRaw
    .map((a) => buildSuggestion(byId.get(a.ceoId ?? ''), a.reason))
    .filter((x): x is TriageSuggestion => x !== null && (!top || x.ceoId !== top.ceoId))
    .slice(0, 2);
  return { topSuggestion: top, alternatives: alts };
}

/** Load (or reuse) the CEO + coach catalog with a 60s TTL. */
async function getCatalog(): Promise<{
  ceoIndex: CeoWithAliases[];
  coachNames: string[];
}> {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return { ceoIndex: catalogCache.ceoIndex, coachNames: catalogCache.coachNames };
  }
  const [ceoIndex, coachNames] = await Promise.all([loadCeoIndex(), loadCoachNames()]);
  catalogCache = { ceoIndex, coachNames, expiresAt: now + CATALOG_TTL_MS };
  return { ceoIndex, coachNames };
}

/**
 * Run an async mapper over a list with a fixed concurrency. Used by
 * the triage queue so we don't slam Anthropic with N parallel calls
 * and trip the per-minute rate limit. Order of results matches input.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export { loadCoachNames };

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
  return (await getCatalog()).ceoIndex;
}

export async function loadCoachNamesCached(): Promise<string[]> {
  return (await getCatalog()).coachNames;
}
