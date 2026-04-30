import { z } from 'zod';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import {
  rawInputs,
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
  suggestForPendingRow,
  suggestCycleFor,
  loadCeoIndexCached,
  loadCoachNames,
  mapWithConcurrency,
  type PendingRowSuggestions,
} from '@/lib/ingestion/triage-suggest';
import { coaches as coachesTbl } from '@/db/schema';
import { listForms, getFormQuestions, listSubmissionsSince } from '@/lib/tally/client';
import { upsertTallyForm, getActiveTallyForms } from '@/lib/tally/registry';
import { inferIdentityFields } from '@/lib/tally/heuristics';
import { ingestTallySubmission } from '@/lib/ingestion/ingest-tally';

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
    // inside the loop and lets every row pass the same coach list to
    // the AI matcher).
    const [ceoIndex, coachNames] = await Promise.all([
      loadCeoIndexCached(),
      loadCoachNames(),
    ]);

    // Run AI suggestions with bounded concurrency — Anthropic enforces
    // a 50k input-token-per-minute limit on this org and a fully
    // parallel fan-out trips it on big triage queues. 4 in flight at a
    // time gives us most of the speedup with no rate-limit drops.
    const suggestions = await mapWithConcurrency(rows, 4, (r) =>
      suggestForPendingRow(r, ceoIndex, coachNames),
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
        ceoId: z.string().uuid(),
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

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND', message: 'CEO not found' });

      // Optionally add submission's email as a new alias
      if (input.addAliasFromSubmission && raw.matchCandidates) {
        const candidates = raw.matchCandidates as { email?: string };
        if (candidates?.email) {
          await ensureAlias(ceo.id, candidates.email);
        }
      }

      // Auto-attach a cycle for the row's date — exact CEO match means we
      // can resolve the cycle deterministically (creating a monthly default
      // when none covers the date). Without this, projection silently no-ops
      // and the row never reaches the typed transcripts / journal_entries
      // tables, so it doesn't show up on the roster's cycle strip.
      const cycleMatch = await ensureCycleForCeoAndDate({
        ceoId: ceo.id,
        occurredAt: raw.occurredAt,
      });

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: ceo.id,
          coachId: ceo.coachId,
          cycleId: cycleMatch.cycleId,
          matchStatus: 'matched',
          matchConfidence: cycleMatch.confident ? 100 : 75,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      // Trigger projection
      await projectRawInput(input.rawInputId);

      // Sweep other pending rows — the new alias may unlock more matches
      const { resolved } = await rematchPendingRows({
        coachId: ceo.coachId ?? undefined,
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
});
