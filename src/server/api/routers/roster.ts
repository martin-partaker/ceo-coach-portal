import { eq, asc, and, inArray, sql } from 'drizzle-orm';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
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
}): RosterReadiness {
  const { ceoTenXGoal, cycle, weeklyCount, transcriptCount, actionCount, actionAiCount } = args;
  const goals = !!cycle.monthlyGoals?.trim();
  const reflect = !!cycle.monthlyReflection?.trim();
  return {
    tenx: { done: !!ceoTenXGoal?.trim(), ai: false },
    goals: { done: goals, ai: !!cycle.monthlyGoalsAiSuggested },
    reflect: { done: reflect, ai: !!cycle.monthlyReflectionAiSuggested },
    weekly: { done: weeklyCount >= 3, ai: false },
    tx: { done: transcriptCount > 0, ai: false },
    actions: { done: actionCount > 0, ai: actionCount > 0 && actionAiCount > 0 },
  };
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
  cycleSummary: adminProcedure.query(async ({ ctx }): Promise<RosterCeoSummary[]> => {
    const now = new Date();

    // 1. CEOs + coach
    const ceoRows = await ctx.db
      .select({ ceo: ceos, coach: coaches })
      .from(ceos)
      .innerJoin(coaches, eq(ceos.coachId, coaches.id));

    if (ceoRows.length === 0) return [];

    const ceoIds = ceoRows.map((r) => r.ceo.id);

    // 2. Cycles for these CEOs
    const allCycles = await ctx.db
      .select()
      .from(cycles)
      .where(inArray(cycles.ceoId, ceoIds))
      .orderBy(asc(cycles.periodStart), asc(cycles.createdAt));

    // 3. Per-cycle counts and signals — single batched query each.
    const journalCounts = await ctx.db
      .select({ cycleId: journalEntries.cycleId, count: sql<number>`count(*)` })
      .from(journalEntries)
      .where(inArray(journalEntries.cycleId, allCycles.map((c) => c.id)))
      .groupBy(journalEntries.cycleId);

    const txCounts = await ctx.db
      .select({ cycleId: transcriptsTable.cycleId, count: sql<number>`count(*)` })
      .from(transcriptsTable)
      .where(inArray(transcriptsTable.cycleId, allCycles.map((c) => c.id)))
      .groupBy(transcriptsTable.cycleId);

    const actionRows = await ctx.db
      .select()
      .from(actionItems)
      .where(inArray(actionItems.cycleId, allCycles.map((c) => c.id)));

    const reportRows = await ctx.db
      .select()
      .from(reports)
      .where(inArray(reports.cycleId, allCycles.map((c) => c.id)));

    const rawForCycles = await ctx.db
      .select()
      .from(rawInputs)
      .where(
        and(
          inArray(rawInputs.cycleId, allCycles.map((c) => c.id)),
          eq(rawInputs.matchStatus, 'matched')
        )
      );

    // Build lookup maps
    const journalByCycle = new Map<string, number>();
    for (const r of journalCounts) {
      if (r.cycleId) journalByCycle.set(r.cycleId, Number(r.count));
    }
    const txByCycle = new Map<string, number>();
    for (const r of txCounts) {
      if (r.cycleId) txByCycle.set(r.cycleId, Number(r.count));
    }
    const actionsByCycle = new Map<string, { total: number; ai: number }>();
    for (const a of actionRows) {
      if (!a.cycleId) continue;
      const cur = actionsByCycle.get(a.cycleId) ?? { total: 0, ai: 0 };
      cur.total += 1;
      if (a.aiSuggested) cur.ai += 1;
      actionsByCycle.set(a.cycleId, cur);
    }
    const reportByCycle = new Map<string, typeof reports.$inferSelect>();
    for (const r of reportRows) reportByCycle.set(r.cycleId, r);

    const rawByCycle = new Map<string, RosterSubmission[]>();
    for (const r of rawForCycles) {
      if (!r.cycleId) continue;
      const list = rawByCycle.get(r.cycleId) ?? [];
      const status =
        r.matchConfidence != null && r.matchConfidence < 100
          ? 'unconfirmed'
          : 'attached';
      list.push({
        rawInputId: r.id,
        occurredAt: r.occurredAt.toISOString(),
        type: r.contentType,
        source: r.source,
        status,
      });
      rawByCycle.set(r.cycleId, list);
    }
    // Sort each submissions list by occurredAt (oldest → newest)
    for (const list of rawByCycle.values()) {
      list.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
    }

    // 4. Group cycles by ceoId and assemble final shape
    const cyclesByCeo = new Map<string, RosterCycle[]>();
    for (const cy of allCycles) {
      const ceo = ceoRows.find((r) => r.ceo.id === cy.ceoId)?.ceo;
      const ceoTenXGoal = ceo?.tenXGoal ?? null;
      const weeklyCount = journalByCycle.get(cy.id) ?? 0;
      const transcriptCount = txByCycle.get(cy.id) ?? 0;
      const actions = actionsByCycle.get(cy.id) ?? { total: 0, ai: 0 };
      const report = reportByCycle.get(cy.id) ?? null;

      const readiness = deriveReadiness({
        ceoTenXGoal,
        cycle: cy,
        weeklyCount,
        transcriptCount,
        actionCount: actions.total,
        actionAiCount: actions.ai,
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
        submissions: rawByCycle.get(cy.id) ?? [],
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
});
