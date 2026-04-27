import { z } from 'zod';
import { eq, desc, and, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import {
  rawInputs,
  ceos,
  coaches,
  cycles,
  tallyForms,
  ceoEmailAliases,
} from '@/db/schema';
import { ensureAlias, normalizeEmail } from '@/lib/ingestion/identity';
import { projectRawInput } from '@/lib/ingestion/project';
import { rematchPendingRows } from '@/lib/ingestion/rematch';
import {
  suggestForPendingRow,
  suggestCycleFor,
  loadCeoIndexCached,
  type PendingRowSuggestions,
} from '@/lib/ingestion/triage-suggest';
import { coaches as coachesTbl } from '@/db/schema';
import { inArray } from 'drizzle-orm';

const STATUS_VALUES = [
  'matched',
  'pending_ceo',
  'pending_cycle',
  'pending_classification',
  'discarded',
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

    // Pre-load the CEO index once (avoids N round-trips inside the loop).
    const ceoIndex = await loadCeoIndexCached();

    const out: PendingRowSuggestions[] = [];
    for (const r of rows) {
      const candidates = r.matchCandidates as { email?: string; name?: string } | null;
      const fuzzyArr =
        Array.isArray(r.matchCandidates) && (r.matchCandidates as Array<{ candidateName?: string; candidateEmail?: string | null }>)[0]
          ? (r.matchCandidates as Array<{ candidateName?: string; candidateEmail?: string | null }>)
          : null;

      const submitterEmail = candidates?.email ?? fuzzyArr?.[0]?.candidateEmail ?? null;
      const submitterName = candidates?.name ?? fuzzyArr?.[0]?.candidateName ?? null;

      const classification = (r.classification ?? null) as {
        participantsSummary?: string;
      } | null;
      const payload = (r.payloadJson ?? null) as {
        meeting?: { topic?: string };
      } | null;

      const { topSuggestion, alternatives } = await suggestForPendingRow(r, ceoIndex);

      let cycleSuggestion = null;
      if (topSuggestion) {
        cycleSuggestion = await suggestCycleFor({
          ceoId: topSuggestion.ceoId,
          occurredAt: r.occurredAt,
        });
      }

      out.push({
        rawInputId: r.id,
        source: r.source,
        contentType: r.contentType,
        occurredAt: r.occurredAt,
        coachId: r.coachId,
        coachName: r.coachId ? coachById.get(r.coachId) ?? null : null,
        submitterEmail,
        submitterName,
        textSnippet: (r.textContent ?? '').slice(0, 600),
        meetingTopic: payload?.meeting?.topic ?? null,
        participantsSummary: classification?.participantsSummary ?? null,
        matchStatus: r.matchStatus,
        topSuggestion,
        alternatives,
        cycleSuggestion,
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
      return updated;
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

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: ceo.id,
          coachId: ceo.coachId,
          matchStatus: 'matched',
          matchConfidence: 100,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      // Trigger projection
      await projectRawInput(input.rawInputId);

      // Sweep other pending rows — the new alias may unlock more matches
      const { resolved } = await rematchPendingRows({ coachId: ceo.coachId });
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

      await ctx.db
        .update(rawInputs)
        .set({
          ceoId: createdCeo.id,
          coachId: input.coachId,
          matchStatus: 'matched',
          matchConfidence: 100,
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
