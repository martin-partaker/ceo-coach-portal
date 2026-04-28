import { eq, asc, and, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import {
  ceos,
  ceoEmailAliases,
  coaches,
  cycles,
  journalEntries,
  transcripts as transcriptsTable,
  actionItems,
  reports,
  rawInputs,
} from '@/db/schema';
import { buildPrefillPrompt } from '@/lib/prompts/prefill';
import {
  actionItemEffectiveDate,
  inputBelongsToCycle,
  journalEffectiveDate,
  rawInputEffectiveDate,
  transcriptEffectiveDate,
} from '@/lib/cycles/membership';

const anthropic = new Anthropic();

export type RosterPhase = 'gathering' | 'ready' | 'generated' | 'sent' | 'idle';

export interface RosterReadiness {
  tenx: { done: boolean; ai: boolean };
  goals: { done: boolean; ai: boolean };
  reflect: { done: boolean; ai: boolean };
  weekly: { done: boolean; ai: boolean };
  tx: { done: boolean; ai: boolean };
  actions: { done: boolean; ai: boolean };
}

export interface RosterSubmission {
  rawInputId: string;
  occurredAt: string; // ISO date
  type: string; // content_type
  source: string;
  status: string; // 'attached' | 'unconfirmed' | 'unconfirmed-group'
}

export interface RosterCycle {
  id: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  phase: RosterPhase;
  readiness: RosterReadiness;
  submissions: RosterSubmission[];
  hasReport: boolean;
  generatedAt: string | null;
}

export interface RosterCeoSummary {
  ceo: {
    id: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
    tenXGoal: string | null;
    coachId: string;
  };
  coach: {
    id: string;
    name: string;
    email: string;
    zoomUserEmail: string | null;
    isSuperAdmin: boolean;
    neonAuthUserId: string | null;
  };
  aliasEmails: string[];
  cycles: RosterCycle[]; // oldest → newest
}

const SENT_AGE_DAYS = 7;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

function deriveReadiness(args: {
  ceoTenXGoal: string | null;
  cycle: typeof cycles.$inferSelect;
  weeklyCount: number;
  transcriptCount: number;
  actionCount: number;
  actionAiCount: number;
  actionReviewedCount: number;
}): RosterReadiness {
  const {
    ceoTenXGoal,
    cycle,
    weeklyCount,
    transcriptCount,
    actionCount,
    actionAiCount,
    actionReviewedCount,
  } = args;
  const goals = !!cycle.monthlyGoals?.trim();
  const reflect = !!cycle.monthlyReflection?.trim();
  // Empty list counts as auto-reviewed; otherwise every item must be reviewed.
  const actionsDone = actionCount === 0 || actionReviewedCount >= actionCount;
  return {
    tenx: { done: !!ceoTenXGoal?.trim(), ai: false },
    goals: { done: goals, ai: !!cycle.monthlyGoalsAiSuggested },
    reflect: { done: reflect, ai: !!cycle.monthlyReflectionAiSuggested },
    weekly: { done: weeklyCount >= 3, ai: false },
    tx: { done: transcriptCount > 0, ai: false },
    actions: { done: actionsDone, ai: actionCount > 0 && actionAiCount > 0 },
  };
}

/**
 * Coach-scope rule for the roster.* procedures.
 *
 * - **Unscoped (`true`)**: a real super admin who is *not* impersonating a
 *   coach. They see/operate on every CEO across the platform — the original
 *   admin behaviour these procedures were built for.
 * - **Scoped (`false`)**: everyone else, including (a) regular coaches and
 *   (b) super admins who have actively chosen to impersonate a coach. In
 *   both cases `ctx.coach.id` is the coach whose roster should be visible
 *   and writable; queries must add `ceos.coachId = ctx.coach.id` and writes
 *   must verify the resolved CEO belongs to that coach.
 *
 * Until Phase 1 of the coach-dashboard refactor these procedures used
 * `adminProcedure`, so this scope distinction is a recent change — every
 * `roster.*` mutation now needs an ownership check before it touches a
 * cycle/CEO row.
 */
function isUnscopedAdmin(ctx: {
  realCoach: { isSuperAdmin: boolean } | null;
  isImpersonating: boolean;
}): boolean {
  return !!ctx.realCoach?.isSuperAdmin && !ctx.isImpersonating;
}

function derivePhase(args: {
  readiness: RosterReadiness;
  hasReport: boolean;
  reportGeneratedAt: Date | null;
  now: Date;
}): RosterPhase {
  const { readiness, hasReport, reportGeneratedAt, now } = args;
  if (hasReport) {
    if (reportGeneratedAt && daysBetween(now, reportGeneratedAt) >= SENT_AGE_DAYS) {
      return 'sent';
    }
    return 'generated';
  }
  const states = Object.values(readiness);
  const allDone = states.every((s) => s.done);
  if (allDone) return 'ready';
  const anyDone = states.some((s) => s.done);
  if (anyDone) return 'gathering';
  return 'idle';
}

export const rosterRouter = createTRPCRouter({
  /**
   * Cycle-aware roster summary for the new Roster v2 page. Returns every CEO
   * with all their cycles, each cycle augmented with a derived `phase`,
   * `readiness` checklist, and an ordered `submissions` array (one per
   * matched raw_input). The client uses this to render the inline timeline,
   * the readiness fraction pill, and the expanded cycle workspace.
   */
  cycleSummary: protectedProcedure.query(async ({ ctx }): Promise<RosterCeoSummary[]> => {
    const now = new Date();
    const unscoped = isUnscopedAdmin(ctx);

    // 1. CEOs + coach. Regular coaches (and impersonating admins) see only
    //    the CEOs assigned to ctx.coach.id; unscoped admins see everyone.
    const ceoRows = await ctx.db
      .select({ ceo: ceos, coach: coaches })
      .from(ceos)
      .innerJoin(coaches, eq(ceos.coachId, coaches.id))
      .where(unscoped ? undefined : eq(ceos.coachId, ctx.coach.id));

    if (ceoRows.length === 0) return [];

    const ceoIds = ceoRows.map((r) => r.ceo.id);

    // 2. Cycles for these CEOs
    const allCycles = await ctx.db
      .select()
      .from(cycles)
      .where(inArray(cycles.ceoId, ceoIds))
      .orderBy(asc(cycles.periodStart), asc(cycles.createdAt));

    // 3. Per-CEO inputs joined with their parent cycle so we can compute
    //    each input's effective date and apply derived (date-range)
    //    membership downstream. We only fetch primary-cycle ownership
    //    here — derived membership is computed in step 4.
    const journalRows = await ctx.db
      .select({
        primaryCycleId: journalEntries.cycleId,
        weekNumber: journalEntries.weekNumber,
        entryDate: journalEntries.entryDate,
        createdAt: journalEntries.createdAt,
        parentPeriodStart: cycles.periodStart,
        ceoId: cycles.ceoId,
      })
      .from(journalEntries)
      .innerJoin(cycles, eq(journalEntries.cycleId, cycles.id))
      .where(inArray(cycles.ceoId, ceoIds));

    const txRows = await ctx.db
      .select({
        primaryCycleId: transcriptsTable.cycleId,
        recordedAt: transcriptsTable.recordedAt,
        createdAt: transcriptsTable.createdAt,
        ceoId: cycles.ceoId,
      })
      .from(transcriptsTable)
      .innerJoin(cycles, eq(transcriptsTable.cycleId, cycles.id))
      .where(inArray(cycles.ceoId, ceoIds));

    const actionRows = await ctx.db
      .select({
        primaryCycleId: actionItems.cycleId,
        dueAt: actionItems.dueAt,
        createdAt: actionItems.createdAt,
        aiSuggested: actionItems.aiSuggested,
        reviewed: actionItems.reviewed,
        ceoId: cycles.ceoId,
      })
      .from(actionItems)
      .innerJoin(cycles, eq(actionItems.cycleId, cycles.id))
      .where(inArray(cycles.ceoId, ceoIds));

    const reportRows = await ctx.db
      .select()
      .from(reports)
      .where(inArray(reports.cycleId, allCycles.map((c) => c.id)));

    // raw_inputs already carries ceoId directly — no join needed.
    const rawForCycles = await ctx.db
      .select()
      .from(rawInputs)
      .where(
        and(
          inArray(rawInputs.ceoId, ceoIds),
          eq(rawInputs.matchStatus, 'matched')
        )
      );

    // Group inputs by CEO so each cycle only iterates its own CEO's items.
    const journalsByCeo = new Map<string, typeof journalRows>();
    for (const j of journalRows) {
      const list = journalsByCeo.get(j.ceoId) ?? [];
      list.push(j);
      journalsByCeo.set(j.ceoId, list);
    }
    const txByCeo = new Map<string, typeof txRows>();
    for (const t of txRows) {
      const list = txByCeo.get(t.ceoId) ?? [];
      list.push(t);
      txByCeo.set(t.ceoId, list);
    }
    const actionsByCeo = new Map<string, typeof actionRows>();
    for (const a of actionRows) {
      const list = actionsByCeo.get(a.ceoId) ?? [];
      list.push(a);
      actionsByCeo.set(a.ceoId, list);
    }
    const rawByCeo = new Map<string, typeof rawForCycles>();
    for (const r of rawForCycles) {
      if (!r.ceoId) continue;
      const list = rawByCeo.get(r.ceoId) ?? [];
      list.push(r);
      rawByCeo.set(r.ceoId, list);
    }
    const reportByCycle = new Map<string, typeof reports.$inferSelect>();
    for (const r of reportRows) reportByCycle.set(r.cycleId, r);

    // 4. Group cycles by ceoId and assemble final shape, applying derived
    //    membership: an input belongs to a cycle if its primary cycleId
    //    matches OR its effective date sits inside the cycle's window.
    const cyclesByCeo = new Map<string, RosterCycle[]>();
    for (const cy of allCycles) {
      const ceo = ceoRows.find((r) => r.ceo.id === cy.ceoId)?.ceo;
      const ceoTenXGoal = ceo?.tenXGoal ?? null;

      const ceoJournals = journalsByCeo.get(cy.ceoId) ?? [];
      const weeklyCount = ceoJournals.filter((j) =>
        inputBelongsToCycle(
          {
            primaryCycleId: j.primaryCycleId,
            effectiveDate: journalEffectiveDate({
              entryDate: j.entryDate,
              weekNumber: j.weekNumber,
              parentPeriodStart: j.parentPeriodStart,
              createdAt: j.createdAt,
            }),
          },
          cy,
        )
      ).length;

      const ceoTx = txByCeo.get(cy.ceoId) ?? [];
      const transcriptCount = ceoTx.filter((t) =>
        inputBelongsToCycle(
          {
            primaryCycleId: t.primaryCycleId,
            effectiveDate: transcriptEffectiveDate({
              recordedAt: t.recordedAt,
              createdAt: t.createdAt,
            }),
          },
          cy,
        )
      ).length;

      const ceoActions = actionsByCeo.get(cy.ceoId) ?? [];
      const matchedActions = ceoActions.filter((a) =>
        inputBelongsToCycle(
          {
            primaryCycleId: a.primaryCycleId,
            effectiveDate: actionItemEffectiveDate({
              dueAt: a.dueAt,
              createdAt: a.createdAt,
            }),
          },
          cy,
        )
      );
      const actions = {
        total: matchedActions.length,
        ai: matchedActions.filter((a) => a.aiSuggested).length,
        reviewed: matchedActions.filter((a) => a.reviewed).length,
      };

      const ceoRaw = rawByCeo.get(cy.ceoId) ?? [];
      const submissions: RosterSubmission[] = ceoRaw
        .filter((r) =>
          inputBelongsToCycle(
            {
              primaryCycleId: r.cycleId ?? '__none__',
              effectiveDate: rawInputEffectiveDate({ occurredAt: r.occurredAt }),
            },
            cy,
          )
        )
        .map((r) => ({
          rawInputId: r.id,
          occurredAt: r.occurredAt.toISOString(),
          type: r.contentType,
          source: r.source,
          status:
            r.matchConfidence != null && r.matchConfidence < 100
              ? 'unconfirmed'
              : 'attached',
        }))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));

      const report = reportByCycle.get(cy.id) ?? null;

      const readiness = deriveReadiness({
        ceoTenXGoal,
        cycle: cy,
        weeklyCount,
        transcriptCount,
        actionCount: actions.total,
        actionAiCount: actions.ai,
        actionReviewedCount: actions.reviewed,
      });

      const phase = derivePhase({
        readiness,
        hasReport: !!report,
        reportGeneratedAt: report?.generatedAt ?? null,
        now,
      });

      const list = cyclesByCeo.get(cy.ceoId) ?? [];
      list.push({
        id: cy.id,
        label: cy.label,
        periodStart: cy.periodStart,
        periodEnd: cy.periodEnd,
        phase,
        readiness,
        submissions,
        hasReport: !!report,
        generatedAt: report?.generatedAt?.toISOString() ?? null,
      });
      cyclesByCeo.set(cy.ceoId, list);
    }

    // 5. Aliases batched
    const allAliases = await ctx.db
      .select()
      .from(ceoEmailAliases)
      .where(inArray(ceoEmailAliases.ceoId, ceoIds));
    const aliasesByCeo = new Map<string, string[]>();
    for (const a of allAliases) {
      const list = aliasesByCeo.get(a.ceoId) ?? [];
      list.push(a.email);
      aliasesByCeo.set(a.ceoId, list);
    }

    return ceoRows
      .map((r) => ({
        ceo: {
          id: r.ceo.id,
          name: r.ceo.name,
          email: r.ceo.email,
          avatarUrl: r.ceo.avatarUrl,
          tenXGoal: r.ceo.tenXGoal,
          coachId: r.ceo.coachId,
        },
        coach: {
          id: r.coach.id,
          name: r.coach.name,
          email: r.coach.email,
          zoomUserEmail: r.coach.zoomUserEmail,
          isSuperAdmin: r.coach.isSuperAdmin,
          neonAuthUserId: r.coach.neonAuthUserId,
        },
        aliasEmails: aliasesByCeo.get(r.ceo.id) ?? [],
        cycles: cyclesByCeo.get(r.ceo.id) ?? [],
      }))
      .sort((a, b) => {
        const c = a.coach.name.localeCompare(b.coach.name);
        if (c !== 0) return c;
        return a.ceo.name.localeCompare(b.ceo.name);
      });
  }),

  /**
   * Full content of a single cycle for the inline workspace expansion in
   * Roster v2. Admin-scoped (no per-coach filtering). Returns the cycle
   * row, the CEO row, every projected input (journal entries, transcripts),
   * action items, and the latest report. The page mirrors what the standalone
   * cycle page shows but in a denser inline panel.
   */
  cycleDetail: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, cycle.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Coach-scope guard: a regular coach (or impersonating admin) can only
      // read cycles owned by their assigned CEOs. Unscoped admins bypass.
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, ceo.coachId))
        .limit(1);

      // Pull every input that belongs to this CEO joined with its parent
      // cycle so we can compute the input's effective date for derived
      // (date-range) membership. Each list is then filtered down to "this
      // cycle" using inputBelongsToCycle: direct cycleId match wins, and
      // for cycles with a [start, end] window, sibling cycle inputs whose
      // effective date falls inside the window also surface here.
      const [journalJoined, txJoined, actionJoined, latestReport, rawJoined] =
        await Promise.all([
          ctx.db
            .select({
              row: journalEntries,
              parentPeriodStart: cycles.periodStart,
              parentPeriodEnd: cycles.periodEnd,
              parentCycleLabel: cycles.label,
            })
            .from(journalEntries)
            .innerJoin(cycles, eq(journalEntries.cycleId, cycles.id))
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(asc(journalEntries.weekNumber)),
          ctx.db
            .select({ row: transcriptsTable })
            .from(transcriptsTable)
            .innerJoin(cycles, eq(transcriptsTable.cycleId, cycles.id))
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(desc(transcriptsTable.recordedAt)),
          ctx.db
            .select({ row: actionItems })
            .from(actionItems)
            .innerJoin(cycles, eq(actionItems.cycleId, cycles.id))
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(asc(actionItems.createdAt)),
          ctx.db
            .select()
            .from(reports)
            .where(eq(reports.cycleId, input.cycleId))
            .orderBy(desc(reports.generatedAt))
            .limit(1),
          ctx.db
            .select()
            .from(rawInputs)
            .where(
              and(
                eq(rawInputs.ceoId, ceo.id),
                eq(rawInputs.matchStatus, 'matched')
              )
            )
            .orderBy(asc(rawInputs.occurredAt)),
        ]);

      // Lookup of raw_input occurredAt by id so we can attach the actual
      // submission timestamp to each projected journal/transcript row.
      // Multiple journals can fall in the same week (e.g. two Tally
      // submissions a few days apart), and the synthetic week-range
      // collapses them to the same label. The real submittedAt makes
      // each row distinguishable.
      const submittedAtByRawInputId = new Map<string, Date>();
      for (const r of rawJoined) {
        submittedAtByRawInputId.set(r.id, r.occurredAt);
      }

      // Enrich each journal with its calendar week (start + clamped end)
      // and the parent cycle's label so the workspace can render dates
      // and indicate which cycle a borrowed entry was originally filed
      // under. Sort chronologically by submission timestamp when we have
      // it (Tally-sourced rows do); fall back to effective date.
      const journals = journalJoined
        .filter(({ row, parentPeriodStart }) =>
          inputBelongsToCycle(
            {
              primaryCycleId: row.cycleId,
              effectiveDate: journalEffectiveDate({
                entryDate: row.entryDate,
                weekNumber: row.weekNumber,
                parentPeriodStart,
                createdAt: row.createdAt,
              }),
            },
            cycle,
          )
        )
        .map(({ row, parentPeriodStart, parentPeriodEnd, parentCycleLabel }) => {
          const effectiveDate = journalEffectiveDate({
            entryDate: row.entryDate,
            weekNumber: row.weekNumber,
            parentPeriodStart,
            createdAt: row.createdAt,
          });
          // Day-precise entries collapse start/end to the same day; legacy
          // week-based entries get a 7-day range clamped to the parent's
          // periodEnd so the last week doesn't spill past the cycle.
          let effectiveEndDate: string;
          if (row.entryDate) {
            effectiveEndDate = effectiveDate;
          } else {
            const startMs = new Date(`${effectiveDate}T00:00:00Z`).getTime();
            const endRawMs = startMs + 6 * 86_400_000;
            const parentEndMs = parentPeriodEnd
              ? new Date(`${parentPeriodEnd}T00:00:00Z`).getTime()
              : null;
            const endMs = parentEndMs !== null && endRawMs > parentEndMs ? parentEndMs : endRawMs;
            effectiveEndDate = new Date(endMs).toISOString().slice(0, 10);
          }
          const submittedAt = row.sourceRawInputId
            ? submittedAtByRawInputId.get(row.sourceRawInputId) ?? null
            : null;
          return {
            ...row,
            effectiveDate,
            effectiveEndDate,
            submittedAt,
            parentCycleId: row.cycleId,
            parentCycleLabel,
            parentPeriodStart,
            parentPeriodEnd,
          };
        })
        .sort((a, b) => {
          const aMs = a.submittedAt
            ? a.submittedAt.getTime()
            : new Date(a.effectiveDate).getTime();
          const bMs = b.submittedAt
            ? b.submittedAt.getTime()
            : new Date(b.effectiveDate).getTime();
          return aMs - bMs;
        });

      const cycleTranscripts = txJoined
        .filter(({ row }) =>
          inputBelongsToCycle(
            {
              primaryCycleId: row.cycleId,
              effectiveDate: transcriptEffectiveDate({
                recordedAt: row.recordedAt,
                createdAt: row.createdAt,
              }),
            },
            cycle,
          )
        )
        .map(({ row }) => row);

      const cycleActionItems = actionJoined
        .filter(({ row }) =>
          inputBelongsToCycle(
            {
              primaryCycleId: row.cycleId,
              effectiveDate: actionItemEffectiveDate({
                dueAt: row.dueAt,
                createdAt: row.createdAt,
              }),
            },
            cycle,
          )
        )
        .map(({ row }) => row);

      const cycleRawInputs = rawJoined.filter((r) =>
        inputBelongsToCycle(
          {
            primaryCycleId: r.cycleId ?? '__none__',
            effectiveDate: rawInputEffectiveDate({ occurredAt: r.occurredAt }),
          },
          cycle,
        )
      );

      const actionsBucketed = {
        open: cycleActionItems.filter((a) => a.status === 'open').length,
        done: cycleActionItems.filter((a) => a.status === 'done').length,
        dropped: cycleActionItems.filter((a) => a.status === 'dropped').length,
        reviewed: cycleActionItems.filter((a) => a.reviewed).length,
        total: cycleActionItems.length,
      };

      const unconfirmed = cycleRawInputs.filter(
        (r) => r.matchConfidence != null && r.matchConfidence < 100
      );

      return {
        cycle,
        ceo,
        coach: coach ?? null,
        journals,
        transcripts: cycleTranscripts,
        actionItems: cycleActionItems,
        actionsBucketed,
        rawInputs: cycleRawInputs,
        unconfirmedCount: unconfirmed.length,
        report: latestReport[0] ?? null,
      };
    }),

  /**
   * Update one or more fields on a cycle. Used by the inline workspace for
   * editing the date range, label, and additionalContext (the "Extra Notes
   * & Context" textarea).
   */
  updateCycle: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        label: z.string().min(1).optional(),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        additionalContext: z.string().nullable().optional(),
        monthlyGoals: z.string().nullable().optional(),
        monthlyReflection: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      // Coach-scope guard: only the owning coach (or unscoped admin) can
      // mutate a cycle. We resolve the owning CEO to check coachId.
      if (!isUnscopedAdmin(ctx)) {
        const [ceo] = await ctx.db
          .select({ coachId: ceos.coachId })
          .from(ceos)
          .where(eq(ceos.id, cycle.ceoId))
          .limit(1);
        if (!ceo || ceo.coachId !== ctx.coach.id) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
      }

      const set: Partial<typeof cycles.$inferInsert> = {};
      if (input.label !== undefined) set.label = input.label;
      if (input.periodStart !== undefined) set.periodStart = input.periodStart;
      if (input.periodEnd !== undefined) set.periodEnd = input.periodEnd;
      if (input.additionalContext !== undefined) set.additionalContext = input.additionalContext;
      // When the user edits the body, the field is no longer purely AI —
      // clear the suggested flag so the badge / undo affordance go away.
      if (input.monthlyGoals !== undefined) {
        set.monthlyGoals = input.monthlyGoals;
        set.monthlyGoalsAiSuggested = false;
      }
      if (input.monthlyReflection !== undefined) {
        set.monthlyReflection = input.monthlyReflection;
        set.monthlyReflectionAiSuggested = false;
      }

      // Sanity: if both dates supplied, end must be ≥ start
      if (set.periodStart && set.periodEnd && set.periodStart > set.periodEnd) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cycle end date must be on or after the start date.',
        });
      }

      const [updated] = await ctx.db
        .update(cycles)
        .set(set)
        .where(eq(cycles.id, input.cycleId))
        .returning();
      return updated;
    }),

  /**
   * Create a new cycle for a CEO from inside the inline workspace. Triggered
   * when the operator clicks "+ New cycle" in the cycle tab strip.
   */
  createCycle: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        label: z.string().min(1),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Coach-scope guard: only the owning coach (or unscoped admin) can
      // create a cycle for the target CEO.
      const [ceo] = await ctx.db
        .select({ id: ceos.id, coachId: ceos.coachId })
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND', message: 'CEO not found' });
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'CEO not found' });
      }

      if (
        input.periodStart &&
        input.periodEnd &&
        input.periodStart > input.periodEnd
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cycle end date must be on or after the start date.',
        });
      }

      const [created] = await ctx.db
        .insert(cycles)
        .values({
          ceoId: input.ceoId,
          label: input.label,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
        })
        .returning();
      return created;
    }),

  /**
   * Re-generate a single AI-prefillable field on a cycle. Returns the
   * previous value so the caller can offer a per-session Undo.
   */
  prefillCycleField: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        field: z.enum(['monthlyGoals', 'monthlyReflection']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, cycle.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Coach-scope guard: only the owning coach (or unscoped admin) can
      // trigger AI prefill on this CEO's cycle.
      if (!isUnscopedAdmin(ctx) && ceo.coachId !== ctx.coach.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Pick up transcripts via derived membership so a stretched cycle
      // can prefill from a sibling cycle's recording when no transcript
      // is directly attached to this cycle.
      const txJoined = await ctx.db
        .select({ row: transcriptsTable })
        .from(transcriptsTable)
        .innerJoin(cycles, eq(transcriptsTable.cycleId, cycles.id))
        .where(eq(cycles.ceoId, ceo.id));

      const cycleTranscripts = txJoined
        .filter(({ row }) =>
          inputBelongsToCycle(
            {
              primaryCycleId: row.cycleId,
              effectiveDate: transcriptEffectiveDate({
                recordedAt: row.recordedAt,
                createdAt: row.createdAt,
              }),
            },
            cycle,
          )
        )
        .map(({ row }) => row);

      if (cycleTranscripts.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Import a transcript first before re-generating.',
        });
      }

      const transcriptText = cycleTranscripts.map((t) => t.content).join('\n\n---\n\n');

      const { systemPrompt, userPrompt } = await buildPrefillPrompt({
        cycle,
        ceo,
        transcriptText,
        additionalContext: cycle.additionalContext ?? undefined,
      });

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No AI response' });
      }

      let parsed: { monthlyGoals: string; monthlyReflection: string };
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to parse AI response' });
      }

      const previousValue =
        input.field === 'monthlyGoals' ? cycle.monthlyGoals : cycle.monthlyReflection;
      const nextValue =
        input.field === 'monthlyGoals' ? parsed.monthlyGoals : parsed.monthlyReflection;

      const set: Partial<typeof cycles.$inferInsert> = {};
      if (input.field === 'monthlyGoals') {
        set.monthlyGoals = nextValue;
        set.monthlyGoalsAiSuggested = true;
      } else {
        set.monthlyReflection = nextValue;
        set.monthlyReflectionAiSuggested = true;
      }
      await ctx.db.update(cycles).set(set).where(eq(cycles.id, input.cycleId));

      return { value: nextValue, previousValue };
    }),
});
