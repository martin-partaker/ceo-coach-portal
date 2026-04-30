import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/db';
import { ceos, ceoEmailAliases, coaches, cycles, type RawInput } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { INGESTION_CONFIG } from './config';

const anthropic = new Anthropic();

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
 * Ask Haiku which CEO from the roster this raw input belongs to. The
 * model sees: content excerpt, submitter email/name, Zoom participants
 * + topic when present, and the full roster (id + name + email +
 * aliases + coach). It returns one CEO id + a short prose reason, plus
 * up to two alternatives if there's reasonable ambiguity. Cheap by
 * design — small prompt, small max_tokens.
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

  const userPrompt = `Match this content to ONE CEO from the roster.

Coaches on the platform (NOT candidates — never return a coach as the match):
${coachListLine}

CEO roster (uuid · name · email · coach):
${catalog}

Content
- Source: ${rawInput.source}
- Type: ${rawInput.contentType}
- Submitter: ${submitterName ?? '(no name)'}${submitterEmail ? ` <${submitterEmail}>` : ''}
${topic ? `- Meeting topic: ${topic}\n` : ''}${participantsLine ? `- Participants: ${participantsLine}\n` : ''}
Excerpt (truncated):
"""
${excerpt || '(no text content)'}
"""

How to decide:
1. **Participants beat topic.** If a CEO appears in the participants list (annotated "(CEO)"), match to that CEO. The meeting topic can be misleading or stale.
2. **A name in the topic is NOT a participant.** If the topic says "Check-in: Jane Doe" but Jane Doe is not in the participants list, the coaches are *discussing* Jane, not coaching her — return ceoId: null. Coach-to-coach supervision and peer check-ins frequently use a CEO's name as the meeting label.
3. **Coach mismatch is a red flag.** If the meeting is hosted by Coach A but the candidate CEO's assigned coach is Coach B, that's almost never a coaching session for that CEO — at most an alternative, never the top match.
4. **For Tally submissions**, look for "Q: name / A: <name>" or "Q: email / A: <email>" patterns in the excerpt, and use the submitter line above.
5. **Return ceoId: null** when (a) all participants are coaches, (b) no CEO from the roster is named as a participant or in the dialogue, or (c) the content is fully ambiguous. Don't guess from a topic alone.
6. Pick exactly one top match. Add up to 2 alternatives only if there's genuine ambiguity.

Return ONLY JSON, no markdown fences:
{ "ceoId": "<uuid from roster or null>", "reason": "≤25 words why", "alternatives": [{ "ceoId": "<uuid>", "reason": "≤20 words" }] }`;

  let parsed: {
    ceoId?: string | null;
    reason?: string;
    alternatives?: Array<{ ceoId?: string; reason?: string }>;
  };
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 384,
      messages: [{ role: 'user', content: userPrompt }],
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

  const names = coachNames ?? (await loadCoachNames());
  return aiSuggestCeoForRawInput(rawInput, idx, names);
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
  return loadCeoIndex();
}
