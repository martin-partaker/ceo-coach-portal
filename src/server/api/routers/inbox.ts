import { z } from 'zod';
import { eq, desc, and, or, sql, inArray, isNotNull, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure, protectedProcedure } from '@/server/api/trpc';
import {
  rawInputs,
  rawInputCeos,
  ceos,
  coaches,
  cycles,
  tallyForms,
  ceoEmailAliases,
  ingestionCursors,
  journalEntries,
  transcripts,
} from '@/db/schema';
import { ensureAlias, normalizeEmail } from '@/lib/ingestion/identity';
import { ensureCycleForCeoAndDate } from '@/lib/ingestion/match-cycle';
import { projectRawInput } from '@/lib/ingestion/project';
import { rematchPendingRows } from '@/lib/ingestion/rematch';
import {
  suggestCycleFor,
  loadCeoIndexCached,
  loadCoachNamesCached,
  mapWithConcurrency,
  computeAndStoreSuggestion,
  invalidatePendingSuggestions,
  suggestionFromRow,
  type PendingRowSuggestions,
} from '@/lib/ingestion/triage-suggest';
import { coaches as coachesTbl } from '@/db/schema';
import { listForms, getFormQuestions, listSubmissionsSince } from '@/lib/tally/client';
import { upsertTallyForm, getActiveTallyForms } from '@/lib/tally/registry';
import { inferIdentityFields } from '@/lib/tally/heuristics';
import { ingestTallySubmission } from '@/lib/ingestion/ingest-tally';
import { listAllRecordingsForCoach } from '@/lib/zoom/client';
import { ingestZoomMeeting } from '@/lib/ingestion/ingest-zoom';

/**
 * When a Tally form is deactivated/ignored, archive any pending raw_inputs
 * that came from it so they stop cluttering the triage queue. Recoverable
 * via the inbox (status = 'archived', not 'discarded').
 */
async function archivePendingFromForm(
  db: typeof import('@/db').db,
  formId: string
): Promise<number> {
  const result = await db
    .update(rawInputs)
    .set({ matchStatus: 'archived' })
    .where(
      and(
        eq(rawInputs.source, 'tally'),
        inArray(rawInputs.matchStatus, ['pending_ceo', 'pending_cycle']),
        sql`${rawInputs.payloadJson} ->> 'formId' = ${formId}`
      )
    )
    .returning({ id: rawInputs.id });
  return result.length;
}

function extractFromTallyPayload(payload: unknown): { email: string | null; name: string | null } {
  if (!payload || typeof payload !== 'object') return { email: null, name: null };
  const responses = (payload as { responses?: Array<{ questionId?: string; answer?: unknown }> }).responses;
  if (!Array.isArray(responses)) return { email: null, name: null };

  let email: string | null = null;
  // Heuristic: first answer that looks like an email wins.
  for (const r of responses) {
    const a = r.answer;
    if (typeof a !== 'string') continue;
    const trimmed = a.trim();
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      email = trimmed.toLowerCase();
      break;
    }
  }
  // Name extraction is too unreliable without form metadata; skip.
  return { email, name: null };
}

const STATUS_VALUES = [
  'matched',
  'pending_ceo',
  'pending_cycle',
  'pending_classification',
  'discarded',
  'archived',
  // Internal coach meetings (e.g. mentoring / training sessions between
  // two coaches). Off the triage queue, not projected, but distinct from
  // 'archived' so we can browse them separately.
  'internal',
] as const;

const CONTENT_TYPES = [
  'intake',
  'goal_worksheet',
  'monthly_journal',
  'weekly_journal',
  'self_assessment',
  'support_feedback',
  'transcript',
  'coach_note',
  'fallback_doc',
  'unknown',
] as const;

export const inboxRouter = createTRPCRouter({
  listPending: adminProcedure
    .input(
      z.object({
        status: z.enum(STATUS_VALUES).default('pending_ceo'),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          rawInput: rawInputs,
          ceo: ceos,
          coach: coaches,
        })
        .from(rawInputs)
        .leftJoin(ceos, eq(rawInputs.ceoId, ceos.id))
        .leftJoin(coaches, eq(rawInputs.coachId, coaches.id))
        .where(eq(rawInputs.matchStatus, input.status))
        .orderBy(desc(rawInputs.occurredAt))
        .limit(input.limit);
      return rows;
    }),

  /**
   * Returns every assigned input for a CEO (matched + archived) so super
   * admins can inspect what's actually in the system. Used by the per-CEO
   * data drawer in the Roster.
   */
  listForCeo: adminProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        search: z.string().trim().optional(),
        limit: z.number().min(1).max(500).default(200),
      })
    )
    .query(async ({ ctx, input }) => {
      const filters = [
        eq(rawInputs.ceoId, input.ceoId),
        inArray(rawInputs.matchStatus, ['matched', 'archived']),
      ];
      if (input.search && input.search.length > 0) {
        const needle = `%${input.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
        filters.push(sql`${rawInputs.textContent} ILIKE ${needle}`);
      }

      const rows = await ctx.db
        .select({
          rawInput: rawInputs,
          cycleId: cycles.id,
          cycleLabel: cycles.label,
        })
        .from(rawInputs)
        .leftJoin(cycles, eq(rawInputs.cycleId, cycles.id))
        .where(and(...filters))
        .orderBy(desc(rawInputs.occurredAt))
        .limit(input.limit);

      if (rows.length === 0) {
        return { items: [], totalCycles: 0 };
      }

      const ids = rows.map((r) => r.rawInput.id);
      const [projectedJournals, projectedTranscripts, cycleCount] =
        await Promise.all([
          ctx.db
            .select({ id: journalEntries.sourceRawInputId })
            .from(journalEntries)
            .where(inArray(journalEntries.sourceRawInputId, ids)),
          ctx.db
            .select({ id: transcripts.sourceRawInputId })
            .from(transcripts)
            .where(inArray(transcripts.sourceRawInputId, ids)),
          ctx.db
            .select({ count: sql<number>`count(*)` })
            .from(cycles)
            .where(eq(cycles.ceoId, input.ceoId)),
        ]);

      const projectedSet = new Set<string>();
      for (const p of projectedJournals) if (p.id) projectedSet.add(p.id);
      for (const p of projectedTranscripts) if (p.id) projectedSet.add(p.id);

      return {
        items: rows.map((r) => ({
          rawInput: r.rawInput,
          cycle: r.cycleId
            ? { id: r.cycleId, label: r.cycleLabel ?? '' }
            : null,
          projected: projectedSet.has(r.rawInput.id),
        })),
        totalCycles: Number(cycleCount[0]?.count ?? 0),
      };
    }),

  triageQueue: adminProcedure.query(async ({ ctx }): Promise<PendingRowSuggestions[]> => {
    const rows = await ctx.db
      .select()
      .from(rawInputs)
      .where(inArray(rawInputs.matchStatus, ['pending_ceo', 'pending_cycle']))
      .orderBy(desc(rawInputs.occurredAt));

    if (rows.length === 0) return [];

    // Load coach map for rows that have a coachId
    const coachIds = [...new Set(rows.map((r) => r.coachId).filter(Boolean) as string[])];
    const coachRows =
      coachIds.length > 0
        ? await ctx.db
            .select({ id: coachesTbl.id, name: coachesTbl.name })
            .from(coachesTbl)
            .where(inArray(coachesTbl.id, coachIds))
        : [];
    const coachById = new Map(coachRows.map((c) => [c.id, c.name]));

    // Pre-load the CEO + coach indexes once (avoids N round-trips
    // inside the loop and lets every row reuse the same catalog).
    const [ceoIndex] = await Promise.all([
      loadCeoIndexCached(),
      loadCoachNamesCached(),
    ]);

    // Read suggestions from the row columns (`suggested_*`). For rows
    // without a stored suggestion (`suggested_at` is null — newly ingested
    // before the suggester ran, or invalidated by a CEO/alias change),
    // lazy-fill: compute + persist now, then read back the row.
    //
    // Lazy fan-out has bounded concurrency so a stale-suggestion stampede
    // doesn't trip Anthropic's per-minute input-token limit. After a
    // catalog invalidation everyone hitting the page would otherwise race
    // to recompute every row in parallel.
    const missingIds = rows.filter((r) => !r.suggestedAt).map((r) => r.id);
    if (missingIds.length > 0) {
      await mapWithConcurrency(missingIds, 4, (id) => computeAndStoreSuggestion(id));
      // Re-fetch the rows we just filled so the column reads pick up the
      // freshly-written suggestion. Cheap since we only refetch the rows
      // that actually changed.
      const refreshed = await ctx.db
        .select()
        .from(rawInputs)
        .where(inArray(rawInputs.id, missingIds));
      const refreshedById = new Map(refreshed.map((r) => [r.id, r]));
      for (let i = 0; i < rows.length; i++) {
        const fresh = refreshedById.get(rows[i].id);
        if (fresh) rows[i] = fresh;
      }
    }

    const suggestions = rows.map(
      (r) => suggestionFromRow(r, ceoIndex) ?? { topSuggestion: null, alternatives: [] },
    );

    // Cycle suggestions are tiny DB reads; do them in parallel too.
    const cycleSuggestions = await Promise.all(
      rows.map((r, i) => {
        const top = suggestions[i].topSuggestion;
        return top
          ? suggestCycleFor({ ceoId: top.ceoId, occurredAt: r.occurredAt })
          : Promise.resolve(null);
      })
    );

    const out: PendingRowSuggestions[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const candidates = r.matchCandidates as { email?: string; name?: string } | null;
      const fuzzyArr =
        Array.isArray(r.matchCandidates) && (r.matchCandidates as Array<{ candidateName?: string; candidateEmail?: string | null }>)[0]
          ? (r.matchCandidates as Array<{ candidateName?: string; candidateEmail?: string | null }>)
          : null;

      const payloadFallback = extractFromTallyPayload(r.payloadJson);
      const submitterEmail =
        candidates?.email ?? fuzzyArr?.[0]?.candidateEmail ?? payloadFallback.email ?? null;
      const submitterName =
        candidates?.name ?? fuzzyArr?.[0]?.candidateName ?? payloadFallback.name ?? null;
      const submittedByCoach =
        (candidates as { submittedByCoach?: { email: string; name: string | null } } | null)
          ?.submittedByCoach ?? null;

      const classification = (r.classification ?? null) as {
        participantsSummary?: string;
      } | null;
      const payload = (r.payloadJson ?? null) as {
        meeting?: { topic?: string };
      } | null;

      out.push({
        rawInputId: r.id,
        source: r.source,
        contentType: r.contentType,
        occurredAt: r.occurredAt,
        coachId: r.coachId,
        coachName: r.coachId ? coachById.get(r.coachId) ?? null : null,
        submitterEmail,
        submitterName,
        submittedByCoach,
        textSnippet: (r.textContent ?? '').slice(0, 8000),
        meetingTopic: payload?.meeting?.topic ?? null,
        participantsSummary: classification?.participantsSummary ?? null,
        // Classifier verdict isn't surfaced in the simplified card, but
        // we keep it on the row so future debugging / future UIs can
        // still reach it without a re-ingest.
        classification: (r.classification ?? null) as {
          meetingType?: string;
          includeInMonthlySummary?: boolean;
          includeReason?: string;
        } | null,
        matchStatus: r.matchStatus,
        topSuggestion: suggestions[i].topSuggestion,
        alternatives: suggestions[i].alternatives,
        cycleSuggestion: cycleSuggestions[i],
      });
    }

    return out;
  }),

  /**
   * Browse every raw_input with arbitrary filters. Powers the All-data
   * tab on the Data admin page — full ad-hoc query over the ingestion
   * layer. Joins ceos/coaches once so the table can render the assigned
   * CEO + coach without N+1 lookups. Returns total count alongside the
   * page so the UI can paginate.
   */
  dataView: adminProcedure
    .input(
      z.object({
        statuses: z.array(z.enum(STATUS_VALUES)).optional(),
        source: z.enum(['zoom', 'tally']).optional(),
        contentType: z.enum(CONTENT_TYPES).optional(),
        // 'unassigned' = ceo_id IS NULL (rows that have no CEO yet —
        // pending_ceo, internal, or any newly-arrived row).
        ceoId: z.union([z.string().uuid(), z.literal('unassigned')]).optional(),
        search: z.string().trim().optional(),
        limit: z.number().min(1).max(500).default(100),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters = [];
      if (input.statuses && input.statuses.length > 0) {
        filters.push(inArray(rawInputs.matchStatus, input.statuses));
      }
      if (input.source) filters.push(eq(rawInputs.source, input.source));
      if (input.contentType) filters.push(eq(rawInputs.contentType, input.contentType));
      if (input.ceoId === 'unassigned') filters.push(isNull(rawInputs.ceoId));
      else if (input.ceoId) filters.push(eq(rawInputs.ceoId, input.ceoId));
      if (input.search && input.search.length > 0) {
        const needle = `%${input.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
        filters.push(sql`${rawInputs.textContent} ILIKE ${needle}`);
      }
      const where = filters.length > 0 ? and(...filters) : undefined;

      const [items, totalRow] = await Promise.all([
        ctx.db
          .select({
            rawInput: rawInputs,
            ceo: { id: ceos.id, name: ceos.name, email: ceos.email },
            coach: { id: coachesTbl.id, name: coachesTbl.name },
          })
          .from(rawInputs)
          .leftJoin(ceos, eq(rawInputs.ceoId, ceos.id))
          .leftJoin(coachesTbl, eq(rawInputs.coachId, coachesTbl.id))
          .where(where)
          .orderBy(desc(rawInputs.occurredAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(rawInputs)
          .where(where),
      ]);

      return {
        items,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),

  pendingCounts: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ status: rawInputs.matchStatus, count: sql<number>`count(*)` })
      .from(rawInputs)
      .groupBy(rawInputs.matchStatus);
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = Number(r.count);
    return map;
  }),

  listDiscoveredForms: adminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(tallyForms)
      .orderBy(desc(tallyForms.updatedAt));
  }),

  /**
   * Latest "we successfully ran the Tally cron" timestamp, surfaced on
   * the Integrations page so the operator can tell at a glance whether
   * data is current. Returns the newest lastSuccessAt across every
   * tally:* cursor row plus any error messages still on those rows.
   */
  lastTallySync: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(ingestionCursors)
      .where(sql`${ingestionCursors.source} like 'tally:%'`);
    let lastRunAt: Date | null = null;
    let lastSuccessAt: Date | null = null;
    const errors: Array<{ source: string; message: string }> = [];
    for (const r of rows) {
      if (!lastRunAt || r.lastRunAt > lastRunAt) lastRunAt = r.lastRunAt;
      if (r.lastSuccessAt && (!lastSuccessAt || r.lastSuccessAt > lastSuccessAt)) {
        lastSuccessAt = r.lastSuccessAt;
      }
      if (r.lastError) errors.push({ source: r.source, message: r.lastError });
    }
    return { lastRunAt, lastSuccessAt, errors };
  }),

  /**
   * Manual "Sync now" trigger used by the Integrations page. Mirrors what
   * the /api/cron/tally-discover and /api/cron/tally jobs do, in order:
   *   1. List every form on Tally and upsert into the registry. New forms
   *      land in `pending_review` so the operator can decide what to do.
   *   2. For every active form, fetch new submissions since the cursor
   *      and run them through the same ingestion pipeline as the cron.
   *
   * Failures in one form don't fail the whole sync — per-form errors are
   * collected and returned so the UI can surface them.
   */
  syncTally: adminProcedure.mutation(async ({ ctx }) => {
    const errors: Array<{ formId: string; phase: 'discover' | 'ingest'; message: string }> = [];

    // 1. Discover (pulls every form from Tally, upserts into registry).
    let discovered = 0;
    let newForms = 0;
    try {
      const forms = await listForms();
      discovered = forms.length;
      for (const form of forms) {
        try {
          const questions = await getFormQuestions(form.id);
          const { isNew } = await upsertTallyForm({ form, questionsSnapshot: questions });
          if (isNew) newForms += 1;
        } catch (err) {
          errors.push({
            formId: form.id,
            phase: 'discover',
            message: err instanceof Error ? err.message : 'unknown error',
          });
        }
      }
    } catch (err) {
      errors.push({
        formId: '*',
        phase: 'discover',
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }

    // 2. Ingest new submissions for every active form, mirroring the cron.
    const activeForms = await getActiveTallyForms();
    let ingested = 0;
    let matched = 0;
    let pendingCeo = 0;
    let pendingCycle = 0;
    let duplicates = 0;
    let discarded = 0;

    for (const form of activeForms) {
      try {
        const cursorSource = `tally:${form.formId}`;
        const [cursorRow] = await ctx.db
          .select()
          .from(ingestionCursors)
          .where(eq(ingestionCursors.source, cursorSource))
          .limit(1);

        const sinceId = cursorRow?.cursor ?? null;
        const { submissions, questions } = await listSubmissionsSince(form.formId, sinceId);

        const heuristic = inferIdentityFields(questions);
        const emailQid = form.emailQuestionId ?? heuristic.emailQuestionId;
        const nameQid = form.nameQuestionId ?? heuristic.nameQuestionId;

        // Process oldest first so the cursor advances correctly if we
        // crash mid-loop.
        const orderedSubs = [...submissions].reverse();
        for (const sub of orderedSubs) {
          try {
            const outcome = await ingestTallySubmission({
              formRow: form,
              submission: sub,
              questions,
              emailQid,
              nameQid,
            });
            ingested += 1;
            if (outcome === 'duplicate') duplicates += 1;
            else if (outcome === 'matched') matched += 1;
            else if (outcome === 'pending_ceo') pendingCeo += 1;
            else if (outcome === 'pending_cycle') pendingCycle += 1;
            else if (outcome === 'discarded') discarded += 1;
          } catch (err) {
            errors.push({
              formId: form.formId,
              phase: 'ingest',
              message: err instanceof Error ? err.message : 'unknown error',
            });
          }
        }

        // Advance cursor to newest submission seen.
        const newestId = submissions[0]?.id ?? sinceId;
        if (newestId) {
          await ctx.db
            .insert(ingestionCursors)
            .values({
              source: cursorSource,
              cursor: newestId,
              lastRunAt: new Date(),
              lastSuccessAt: new Date(),
              lastError: null,
            })
            .onConflictDoUpdate({
              target: ingestionCursors.source,
              set: {
                cursor: newestId,
                lastRunAt: new Date(),
                lastSuccessAt: new Date(),
                lastError: null,
              },
            });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push({ formId: form.formId, phase: 'ingest', message: msg });
        await ctx.db
          .insert(ingestionCursors)
          .values({
            source: `tally:${form.formId}`,
            cursor: '',
            lastRunAt: new Date(),
            lastError: msg,
          })
          .onConflictDoUpdate({
            target: ingestionCursors.source,
            set: { lastRunAt: new Date(), lastError: msg },
          });
      }
    }

    return {
      discovered,
      newForms,
      activeForms: activeForms.length,
      ingested,
      matched,
      pendingCeo,
      pendingCycle,
      duplicates,
      discarded,
      errors,
    };
  }),

  /**
   * Latest "we successfully ran the Zoom cron" timestamp, surfaced on
   * the Integrations page. Aggregates across every coach's
   * `zoom:coach:*` cursor row plus any error messages still on those rows.
   */
  lastZoomSync: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(ingestionCursors)
      .where(sql`${ingestionCursors.source} like 'zoom:%'`);
    let lastRunAt: Date | null = null;
    let lastSuccessAt: Date | null = null;
    const errors: Array<{ source: string; message: string }> = [];
    for (const r of rows) {
      if (!lastRunAt || r.lastRunAt > lastRunAt) lastRunAt = r.lastRunAt;
      if (r.lastSuccessAt && (!lastSuccessAt || r.lastSuccessAt > lastSuccessAt)) {
        lastSuccessAt = r.lastSuccessAt;
      }
      if (r.lastError) errors.push({ source: r.source, message: r.lastError });
    }
    return { lastRunAt, lastSuccessAt, errors };
  }),

  /**
   * Manual "Sync now" trigger for Zoom. Unlike the cron (which only
   * walks the cursor-based overlap window), this pulls the full 12-month
   * window for every coach with a Zoom email so the operator can backfill
   * anything that was missed. Idempotent — duplicates are skipped at the
   * `(source, externalId)` unique constraint in `ingestZoomMeeting`.
   *
   * Per-coach errors don't fail the whole run; they're collected and
   * returned so the UI can surface them.
   */
  syncZoom: adminProcedure.mutation(async ({ ctx }) => {
    const errors: Array<{ coachId: string; phase: 'list' | 'ingest'; message: string }> = [];

    const coachRows = await ctx.db
      .select({ id: coaches.id, zoomUserEmail: coaches.zoomUserEmail })
      .from(coaches)
      .where(isNotNull(coaches.zoomUserEmail));

    let totalMeetings = 0;
    let ingested = 0;
    let matched = 0;
    let pendingCeo = 0;
    let duplicates = 0;
    let discarded = 0;

    // Manual sync deliberately overrides the cursor and pulls the full
    // 12 months. Zoom's API caps each request at a 30-day window, but
    // listAllRecordingsForCoach walks the range internally.
    const now = new Date();
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

    for (const coach of coachRows) {
      const zoomEmail = coach.zoomUserEmail!;
      const cursorSource = `zoom:coach:${coach.id}`;

      try {
        const meetings = await listAllRecordingsForCoach(zoomEmail, twelveMonthsAgo, now);
        totalMeetings += meetings.length;

        for (const meeting of meetings) {
          try {
            const outcome = await ingestZoomMeeting({
              coachId: coach.id,
              zoomEmail,
              meeting,
            });
            ingested += 1;
            if (outcome === 'duplicate') duplicates += 1;
            else if (outcome === 'matched') matched += 1;
            else if (outcome === 'pending_ceo') pendingCeo += 1;
            else if (outcome === 'discarded') discarded += 1;
          } catch (err) {
            errors.push({
              coachId: coach.id,
              phase: 'ingest',
              message: err instanceof Error ? err.message : 'unknown error',
            });
          }
        }

        await ctx.db
          .insert(ingestionCursors)
          .values({
            source: cursorSource,
            cursor: now.toISOString(),
            lastRunAt: now,
            lastSuccessAt: now,
            lastError: null,
          })
          .onConflictDoUpdate({
            target: ingestionCursors.source,
            set: {
              cursor: now.toISOString(),
              lastRunAt: now,
              lastSuccessAt: now,
              lastError: null,
            },
          });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push({ coachId: coach.id, phase: 'list', message: msg });
        await ctx.db
          .insert(ingestionCursors)
          .values({
            source: cursorSource,
            cursor: '',
            lastRunAt: new Date(),
            lastError: msg,
          })
          .onConflictDoUpdate({
            target: ingestionCursors.source,
            set: { lastRunAt: new Date(), lastError: msg },
          });
      }
    }

    return {
      coaches: coachRows.length,
      meetings: totalMeetings,
      ingested,
      matched,
      pendingCeo,
      duplicates,
      discarded,
      errors,
    };
  }),

  registerForm: adminProcedure
    .input(
      z.object({
        formId: z.string(),
        contentType: z.enum(CONTENT_TYPES),
        projectionEnabled: z.boolean().default(false),
        emailQuestionId: z.string().optional(),
        nameQuestionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(tallyForms)
        .set({
          status: 'active',
          contentType: input.contentType,
          projectionEnabled: input.projectionEnabled,
          emailQuestionId: input.emailQuestionId ?? null,
          nameQuestionId: input.nameQuestionId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(tallyForms.formId, input.formId))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' });
      return updated;
    }),

  ignoreForm: adminProcedure
    .input(z.object({ formId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(tallyForms)
        .set({ status: 'ignored', updatedAt: new Date() })
        .where(eq(tallyForms.formId, input.formId))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' });
      const archived = await archivePendingFromForm(ctx.db, input.formId);
      return { ...updated, archivedRows: archived };
    }),

  deactivateForm: adminProcedure
    .input(z.object({ formId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(tallyForms)
        .set({ status: 'pending_review', updatedAt: new Date() })
        .where(eq(tallyForms.formId, input.formId))
        .returning();
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND' });
      const archived = await archivePendingFromForm(ctx.db, input.formId);
      return { ...updated, archivedRows: archived };
    }),

  assignToCeo: adminProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        // First entry is the "primary" CEO — sets ceoId/cycleId/coachId on
        // the raw_inputs row for backwards compat. Every entry is mirrored
        // into raw_input_ceos so the projector can fan out into each CEO's
        // own cycle. Group sessions, two-CEO kickoffs, etc. all flow through
        // here. Single-CEO assignments are just `ceoIds: [id]`.
        ceoIds: z.array(z.string().uuid()).min(1),
        addAliasFromSubmission: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      // De-dupe while preserving order. The first remaining entry is the
      // primary CEO (drives raw_inputs.ceoId/coachId/cycleId).
      const uniqueCeoIds = Array.from(new Set(input.ceoIds));

      const ceoRows = await ctx.db
        .select()
        .from(ceos)
        .where(inArray(ceos.id, uniqueCeoIds));
      if (ceoRows.length !== uniqueCeoIds.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'One or more CEOs not found' });
      }
      const ceoById = new Map(ceoRows.map((c) => [c.id, c]));
      const primaryCeo = ceoById.get(uniqueCeoIds[0])!;

      // Optionally add submission's email as a new alias on the primary CEO.
      // Aliases are 1:1 with email→CEO; no sensible meaning to attach the
      // same email to multiple CEOs, so primary-only is correct here.
      let addedAlias = false;
      if (input.addAliasFromSubmission && raw.matchCandidates) {
        const candidates = raw.matchCandidates as { email?: string };
        if (candidates?.email) {
          await ensureAlias(primaryCeo.id, candidates.email);
          addedAlias = true;
        }
      }

      // Resolve the primary CEO's cycle for the meeting date. The projector
      // will resolve cycles for the additional CEOs internally when it
      // fans out into the typed transcripts table.
      const primaryCycle = await ensureCycleForCeoAndDate({
        ceoId: primaryCeo.id,
        occurredAt: raw.occurredAt,
      });

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: primaryCeo.id,
          coachId: primaryCeo.coachId,
          cycleId: primaryCycle.cycleId,
          matchStatus: 'matched',
          matchConfidence: primaryCycle.confident ? 100 : 75,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      // Replace raw_input_ceos membership for this row. Wiping first keeps
      // the join table consistent if the operator changed their picks on
      // re-assignment; the projector also cleans up orphan transcripts.
      await ctx.db.delete(rawInputCeos).where(eq(rawInputCeos.rawInputId, input.rawInputId));
      if (uniqueCeoIds.length > 0) {
        await ctx.db
          .insert(rawInputCeos)
          .values(uniqueCeoIds.map((ceoId) => ({ rawInputId: input.rawInputId, ceoId })))
          .onConflictDoNothing();
      }

      // Trigger projection — fans out into one transcripts row per linked
      // CEO/cycle.
      await projectRawInput(input.rawInputId);

      // If a new alias was added, other pending rows may now resolve to a
      // different CEO via the deterministic short-circuit. Invalidate
      // their cached suggestions so the next triage page recomputes.
      if (addedAlias) {
        await invalidatePendingSuggestions();
      }

      // Sweep other pending rows — the new alias may unlock more matches.
      const { resolved } = await rematchPendingRows({
        coachId: primaryCeo.coachId ?? undefined,
      });
      return { ok: true, autoResolved: resolved };
    }),

  createCeoFromInput: adminProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        name: z.string().min(1),
        email: z.string().email(),
        coachId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const normalizedEmail = normalizeEmail(input.email);

      // Check email isn't already aliased to another CEO
      const [existingAlias] = await ctx.db
        .select()
        .from(ceoEmailAliases)
        .where(eq(ceoEmailAliases.email, normalizedEmail))
        .limit(1);
      if (existingAlias) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Email already linked to a different CEO (${existingAlias.ceoId}).`,
        });
      }

      const [createdCeo] = await ctx.db
        .insert(ceos)
        .values({
          coachId: input.coachId,
          name: input.name,
          email: normalizedEmail,
        })
        .returning();

      await ensureAlias(createdCeo.id, normalizedEmail);

      // Read the row's occurredAt before we update it, then auto-attach a
      // cycle (creating a monthly default for this brand-new CEO).
      const [rowForDate] = await ctx.db
        .select({ occurredAt: rawInputs.occurredAt })
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      const cycleMatch = rowForDate
        ? await ensureCycleForCeoAndDate({
            ceoId: createdCeo.id,
            occurredAt: rowForDate.occurredAt,
          })
        : null;

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: createdCeo.id,
          coachId: input.coachId,
          cycleId: cycleMatch?.cycleId ?? null,
          matchStatus: 'matched',
          matchConfidence: cycleMatch?.confident ? 100 : 75,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      await projectRawInput(input.rawInputId);

      // New CEO + alias → existing pending suggestions may now resolve to
      // this CEO. Invalidate so the next triage view recomputes.
      await invalidatePendingSuggestions();

      // Sweep other pending rows — they may now match by email or by name
      // under this coach's roster.
      const { resolved } = await rematchPendingRows({ coachId: input.coachId });

      return { ceo: createdCeo, autoResolved: resolved };
    }),

  archive: adminProcedure
    .input(z.object({ rawInputId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      await ctx.db
        .update(rawInputs)
        .set({
          matchStatus: 'archived',
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));
      return { ok: true };
    }),

  /**
   * Mark a raw input as an internal coach meeting (mentoring / training
   * between two coaches, no CEO involved). Off the triage queue and never
   * projected. Recoverable via the inbox if it was a mistake.
   */
  markInternal: adminProcedure
    .input(z.object({ rawInputId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      await ctx.db
        .update(rawInputs)
        .set({
          matchStatus: 'internal',
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));
      return { ok: true };
    }),

  discard: adminProcedure
    .input(z.object({ rawInputId: z.string().uuid(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      const newPayload = {
        ...((raw.payloadJson as Record<string, unknown> | null) ?? {}),
        discardReason: input.reason ?? 'admin_discarded',
        discardedBy: ctx.coach.id,
      };

      await ctx.db
        .update(rawInputs)
        .set({
          matchStatus: 'discarded',
          payloadJson: newPayload,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      return { ok: true };
    }),

  /**
   * Generic status changer used by the Data admin table. Unlike the
   * focused mutations (archive, markInternal, discard), this lets the
   * operator set ANY status from the dropdown, including moving a row
   * back to a pending bucket for re-triage.
   *
   * Side effects:
   *   - Resolved statuses (matched, archived, internal, discarded) stamp
   *     resolved_at / resolved_by.
   *   - Pending statuses clear those stamps and invalidate the cached AI
   *     suggestion so the next triage view recomputes.
   *   - Moving away from `matched` clears any projected rows in the
   *     typed tables (transcripts, journal_entries) — otherwise the row
   *     would still show up under a CEO it's no longer matched to.
   */
  setStatus: adminProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        status: z.enum(STATUS_VALUES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      const isPending =
        input.status === 'pending_ceo' ||
        input.status === 'pending_cycle' ||
        input.status === 'pending_classification';

      // Leaving 'matched' means the row should no longer surface in the
      // CEO's typed views. Clearing the projected rows is the safest way
      // to keep the typed layer in sync with raw_inputs.matchStatus.
      if (raw.matchStatus === 'matched' && input.status !== 'matched') {
        await ctx.db
          .delete(journalEntries)
          .where(eq(journalEntries.sourceRawInputId, input.rawInputId));
        await ctx.db
          .delete(transcripts)
          .where(eq(transcripts.sourceRawInputId, input.rawInputId));
      }

      await ctx.db
        .update(rawInputs)
        .set({
          matchStatus: input.status,
          resolvedAt: isPending ? null : new Date(),
          resolvedBy: isPending ? null : ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      if (isPending) {
        await invalidatePendingSuggestions({ rawInputIds: [input.rawInputId] });
      } else if (input.status === 'matched' && raw.ceoId) {
        // Moving INTO matched (from archived etc.) re-projects so the
        // typed tables come back in sync.
        await projectRawInput(input.rawInputId);
      }

      return { ok: true };
    }),

  reproject: adminProcedure
    .input(z.object({ rawInputId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await projectRawInput(input.rawInputId);
      return { ok: true };
    }),

  /**
   * Sweep all pending_cycle rows: for each, ensure a cycle exists (creating
   * a monthly default if needed) and mark the row matched. Used as a one-shot
   * cleanup after the auto-create-cycle change shipped, so existing rows
   * don't get stuck in triage.
   */
  resolveAllPendingCycle: adminProcedure.mutation(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(rawInputs)
      .where(eq(rawInputs.matchStatus, 'pending_cycle'));

    let resolved = 0;
    for (const r of rows) {
      if (!r.ceoId) continue;
      const cycle = await (await import('@/lib/ingestion/match-cycle')).ensureCycleForCeoAndDate({
        ceoId: r.ceoId,
        occurredAt: r.occurredAt,
      });
      await ctx.db
        .update(rawInputs)
        .set({
          cycleId: cycle.cycleId,
          matchStatus: 'matched',
          matchConfidence: cycle.confident ? 100 : 75,
        })
        .where(eq(rawInputs.id, r.id));
      await projectRawInput(r.id);
      resolved++;
    }

    return { scanned: rows.length, resolved };
  }),

  /**
   * Revert a row to a prior state. Used by triage Back/Undo. The caller
   * passes the snapshot of values to restore. Server clears any projected
   * journal_entry / transcript that pointed to this row to keep things tidy.
   */
  restore: adminProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        matchStatus: z.enum(STATUS_VALUES),
        ceoId: z.string().uuid().nullable(),
        cycleId: z.string().uuid().nullable(),
        coachId: z.string().uuid().nullable(),
        matchConfidence: z.number().nullable(),
        matchCandidates: z.unknown().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      // Clear projected rows that point at this raw_input
      await ctx.db
        .delete(journalEntries)
        .where(eq(journalEntries.sourceRawInputId, input.rawInputId));
      await ctx.db
        .delete(transcripts)
        .where(eq(transcripts.sourceRawInputId, input.rawInputId));

      await ctx.db
        .update(rawInputs)
        .set({
          matchStatus: input.matchStatus,
          ceoId: input.ceoId,
          cycleId: input.cycleId,
          coachId: input.coachId,
          matchConfidence: input.matchConfidence,
          matchCandidates: (input.matchCandidates ?? null) as object | null,
          resolvedAt: null,
          resolvedBy: null,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      return { ok: true };
    }),

  assignCycle: adminProcedure
    .input(z.object({ rawInputId: z.string().uuid(), cycleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw || !raw.ceoId) throw new TRPCError({ code: 'BAD_REQUEST' });

      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(and(eq(cycles.id, input.cycleId), eq(cycles.ceoId, raw.ceoId)))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cycle not found for that CEO' });

      await ctx.db
        .update(rawInputs)
        .set({
          cycleId: cycle.id,
          matchStatus: 'matched',
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      await projectRawInput(input.rawInputId);
      return { ok: true };
    }),

  // ──────────────────────────────────────────────────────────────────
  // Coach-scoped triage hooks. These power the "untriaged content
  // might be this CEO's" guard rail that fires before the generate
  // pipeline. Each procedure scopes to a CEO the coach actually owns
  // (super admins bypass the check), so it's safe to call from the
  // coach-facing roster workspace where adminProcedure can't reach.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Pending raw_inputs the triage suggester thinks might belong to
   * `ceoId`, bucketed by confidence + match kind. Drives the modal
   * that gates `generateV2` so a coach can confirm or dismiss likely
   * matches inline before kicking off a report.
   *
   * Buckets:
   *   - highConfidence — `pending_ceo` rows where the AI's primary
   *     guess IS this CEO and match_confidence ≥ 85.
   *   - lowConfidence  — same, but match_confidence < 85.
   *   - alternative    — `pending_ceo` rows where this CEO is a
   *     suggested alternative (AI's top pick was a different CEO).
   *   - pendingCycle   — already matched to this CEO but no cycle
   *     could be resolved (rare after the strict-matcher fix; the
   *     coach has to pick which cycle they live in).
   */
  pendingForCeo: protectedProcedure
    .input(z.object({ ceoId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await ensureCoachOwnsCeo(ctx, input.ceoId);

      const HIGH_CONF = 85;

      // Single query covers all three buckets. The `@>` JSONB
      // containment operator lets us check if `ceoId` appears
      // anywhere inside the suggestedAlternatives array.
      const rows = await ctx.db
        .select()
        .from(rawInputs)
        .where(
          or(
            and(
              eq(rawInputs.matchStatus, 'pending_ceo'),
              eq(rawInputs.suggestedCeoId, input.ceoId),
            ),
            and(
              eq(rawInputs.matchStatus, 'pending_ceo'),
              sql`${rawInputs.suggestedAlternatives}::jsonb @> ${JSON.stringify([
                { ceoId: input.ceoId },
              ])}::jsonb`,
            ),
            and(
              eq(rawInputs.matchStatus, 'pending_cycle'),
              eq(rawInputs.ceoId, input.ceoId),
            ),
          ),
        )
        .orderBy(desc(rawInputs.occurredAt));

      type Item = {
        rawInputId: string;
        contentType: string;
        occurredAt: Date;
        suggestedReason: string | null;
        matchConfidence: number | null;
        textPreview: string;
      };

      const buckets = {
        highConfidence: [] as Item[],
        lowConfidence: [] as Item[],
        alternative: [] as Item[],
        pendingCycle: [] as Item[],
      };

      for (const r of rows) {
        const item: Item = {
          rawInputId: r.id,
          contentType: r.contentType,
          occurredAt: r.occurredAt,
          suggestedReason: r.suggestedReason,
          matchConfidence: r.matchConfidence,
          textPreview: (r.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        };

        if (r.matchStatus === 'pending_cycle') {
          buckets.pendingCycle.push(item);
          continue;
        }
        if (r.suggestedCeoId === input.ceoId) {
          if ((r.matchConfidence ?? 0) >= HIGH_CONF) {
            buckets.highConfidence.push(item);
          } else {
            buckets.lowConfidence.push(item);
          }
          continue;
        }
        // Otherwise the query matched because ceoId is inside
        // suggestedAlternatives.
        buckets.alternative.push(item);
      }

      const total =
        buckets.highConfidence.length +
        buckets.lowConfidence.length +
        buckets.alternative.length +
        buckets.pendingCycle.length;

      return { ...buckets, total };
    }),

  /**
   * Confirm that a single `pending_ceo` row really belongs to `ceoId`.
   * Mirrors the core of admin `assignToCeo` but scoped to a single
   * CEO and gated by coach ownership. Resolves a cycle, flips to
   * `matched`, replaces raw_input_ceos membership, and re-projects.
   */
  confirmPendingForCeo: protectedProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        ceoId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ceo = await ensureCoachOwnsCeo(ctx, input.ceoId);

      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      const cycleMatch = await ensureCycleForCeoAndDate({
        ceoId: input.ceoId,
        occurredAt: raw.occurredAt,
      });

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: input.ceoId,
          coachId: ceo.coachId,
          cycleId: cycleMatch.cycleId,
          matchStatus: 'matched',
          matchConfidence: cycleMatch.confident ? 100 : 75,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      await ctx.db
        .delete(rawInputCeos)
        .where(eq(rawInputCeos.rawInputId, input.rawInputId));
      await ctx.db
        .insert(rawInputCeos)
        .values({ rawInputId: input.rawInputId, ceoId: input.ceoId })
        .onConflictDoNothing();

      await projectRawInput(input.rawInputId);
      return { ok: true };
    }),

  /**
   * "Not this CEO". Doesn't try to guess who it actually belongs to —
   * the row stays in pending_ceo for the admin inbox to triage. We
   * just remove the suggestion pointer(s) for this CEO so it stops
   * surfacing in their workspace dialog.
   */
  dismissPendingForCeo: protectedProcedure
    .input(
      z.object({
        rawInputId: z.string().uuid(),
        ceoId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureCoachOwnsCeo(ctx, input.ceoId);

      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND' });

      const update: { suggestedCeoId?: null; suggestedReason?: null; suggestedAlternatives?: unknown } = {};

      if (raw.suggestedCeoId === input.ceoId) {
        update.suggestedCeoId = null;
        update.suggestedReason = null;
      }
      const alts = raw.suggestedAlternatives as
        | Array<{ ceoId: string; reason: string }>
        | null;
      if (Array.isArray(alts)) {
        const filtered = alts.filter((a) => a.ceoId !== input.ceoId);
        if (filtered.length !== alts.length) {
          update.suggestedAlternatives = filtered;
        }
      }
      if (Object.keys(update).length === 0) return { ok: true, changed: false };

      await ctx.db
        .update(rawInputs)
        .set(update)
        .where(eq(rawInputs.id, input.rawInputId));
      return { ok: true, changed: true };
    }),

  /**
   * Bulk-confirm the "high-confidence" set in one shot. Used by the
   * dialog's "Confirm all" button so the coach doesn't have to click
   * each green-light item individually.
   */
  bulkConfirmPendingForCeo: protectedProcedure
    .input(
      z.object({
        rawInputIds: z.array(z.string().uuid()).min(1).max(50),
        ceoId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ceo = await ensureCoachOwnsCeo(ctx, input.ceoId);

      let confirmed = 0;
      for (const rawInputId of input.rawInputIds) {
        const [raw] = await ctx.db
          .select()
          .from(rawInputs)
          .where(eq(rawInputs.id, rawInputId))
          .limit(1);
        if (!raw) continue;

        const cycleMatch = await ensureCycleForCeoAndDate({
          ceoId: input.ceoId,
          occurredAt: raw.occurredAt,
        });

        await ctx.db
          .update(rawInputs)
          .set({
            ceoId: input.ceoId,
            coachId: ceo.coachId,
            cycleId: cycleMatch.cycleId,
            matchStatus: 'matched',
            matchConfidence: cycleMatch.confident ? 100 : 75,
            resolvedAt: new Date(),
            resolvedBy: ctx.coach.id,
          })
          .where(eq(rawInputs.id, rawInputId));

        await ctx.db
          .delete(rawInputCeos)
          .where(eq(rawInputCeos.rawInputId, rawInputId));
        await ctx.db
          .insert(rawInputCeos)
          .values({ rawInputId, ceoId: input.ceoId })
          .onConflictDoNothing();

        await projectRawInput(rawInputId);
        confirmed += 1;
      }

      return { confirmed };
    }),

  /**
   * Batched pending-triage counts for the roster row badges. Returns a
   * map of `ceoId -> count` covering every CEO the calling coach owns
   * (super admins get every CEO with > 0). One query, no per-row N+1.
   *
   * "Count" mirrors `pendingForCeo.total`: high+low confidence primary
   * suggestions, alternative suggestions, and pending_cycle rows.
   */
  triagePendingCounts: protectedProcedure.query(async ({ ctx }) => {
    // Build the CEO scope. Coaches see only their own roster; super
    // admins are unscoped so they can spot triage backlog org-wide.
    const ownedCeos = ctx.realCoach?.isSuperAdmin
      ? await ctx.db.select({ id: ceos.id }).from(ceos)
      : await ctx.db
          .select({ id: ceos.id })
          .from(ceos)
          .where(eq(ceos.coachId, ctx.coach.id));

    if (ownedCeos.length === 0) return {} as Record<string, number>;
    const ownedSet = new Set(ownedCeos.map((c) => c.id));

    // Pull every pending row that could match any owned CEO. We do the
    // bucketing client-side (here) rather than four separate SQL
    // group-bys, because the alternative bucket needs a JSONB scan and
    // a single fetch + in-memory grouping is simpler and faster in
    // practice (pending volume is small).
    const primarySuggestions = await ctx.db
      .select({
        suggestedCeoId: rawInputs.suggestedCeoId,
      })
      .from(rawInputs)
      .where(
        and(
          eq(rawInputs.matchStatus, 'pending_ceo'),
          isNotNull(rawInputs.suggestedCeoId),
          inArray(rawInputs.suggestedCeoId, Array.from(ownedSet)),
        ),
      );

    const pendingCycleRows = await ctx.db
      .select({ ceoId: rawInputs.ceoId })
      .from(rawInputs)
      .where(
        and(
          eq(rawInputs.matchStatus, 'pending_cycle'),
          isNotNull(rawInputs.ceoId),
          inArray(rawInputs.ceoId, Array.from(ownedSet)),
        ),
      );

    // Alternatives: scan all pending_ceo rows with a non-empty alternatives
    // array, walk the array, and increment counts for owned CEOs that appear.
    const altRows = await ctx.db
      .select({ suggestedAlternatives: rawInputs.suggestedAlternatives })
      .from(rawInputs)
      .where(
        and(
          eq(rawInputs.matchStatus, 'pending_ceo'),
          sql`jsonb_array_length(coalesce(${rawInputs.suggestedAlternatives}::jsonb, '[]'::jsonb)) > 0`,
        ),
      );

    const counts: Record<string, number> = {};
    for (const r of primarySuggestions) {
      if (r.suggestedCeoId) counts[r.suggestedCeoId] = (counts[r.suggestedCeoId] ?? 0) + 1;
    }
    for (const r of pendingCycleRows) {
      if (r.ceoId) counts[r.ceoId] = (counts[r.ceoId] ?? 0) + 1;
    }
    for (const r of altRows) {
      const alts = r.suggestedAlternatives as
        | Array<{ ceoId: string; reason?: string }>
        | null;
      if (!Array.isArray(alts)) continue;
      for (const a of alts) {
        if (a?.ceoId && ownedSet.has(a.ceoId)) {
          counts[a.ceoId] = (counts[a.ceoId] ?? 0) + 1;
        }
      }
    }

    return counts;
  }),
});

/** Throws unless the calling coach owns `ceoId` (or is a super admin).
 *  Returns the CEO row so the caller can use it without re-querying. */
async function ensureCoachOwnsCeo(
  ctx: {
    db: typeof import('@/db').db;
    coach: { id: string };
    realCoach: { isSuperAdmin: boolean } | null;
  },
  ceoId: string,
) {
  const filter = ctx.realCoach?.isSuperAdmin
    ? eq(ceos.id, ceoId)
    : and(eq(ceos.id, ceoId), eq(ceos.coachId, ctx.coach.id));
  const [ceo] = await ctx.db.select().from(ceos).where(filter).limit(1);
  if (!ceo) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'CEO not found or not owned by this coach',
    });
  }
  return ceo;
}
