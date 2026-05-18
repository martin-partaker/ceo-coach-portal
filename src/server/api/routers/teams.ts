import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import {
  actionItems,
  ceos,
  ceoKpiDefinitions,
  coachingTeams,
  coaches,
  cycleFacts,
  cycleKpiValues,
  cycles,
  journalEntries,
  rawInputs,
  rawInputCeos,
  reportGenerationJobs,
  reports,
  transcripts,
} from '@/db/schema';
import type { db as dbInstance } from '@/db';
import { projectRawInput } from '@/lib/ingestion/project';

/**
 * Backfill helper — run whenever a CEO becomes part of a team.
 *
 * The team-aware prompt builder reads three flags that, on rows
 * created BEFORE the CEO was in a team, sit at NULL:
 *  - cycles.teamId      → null means the cycle is "solo" → the
 *                          context fetcher won't fan out across team
 *                          members.
 *  - journal_entries.authoredByCeoId → null means the byline renderer
 *                          can't say "David's Week 2" vs "Dave's".
 *  - transcripts.authoredByCeoId → same as above.
 *  - ceo_kpi_definitions.teamId → company KPIs need to be dedupable
 *                          across members.
 *
 * This helper backfills all four for the given ceoIds. For author
 * fields it uses the original `cycle.ceoId` (the cycle's pre-team
 * owner = the original author of every input on it). Idempotent —
 * uses IS NULL guards so re-running is a no-op once the data is
 * stamped.
 */
async function backfillCeoInputsForTeam(
  db: typeof dbInstance,
  teamId: string,
  ceoIds: string[],
): Promise<void> {
  if (ceoIds.length === 0) return;

  // 1. Tag every existing cycle for these CEOs with teamId.
  await db
    .update(cycles)
    .set({ teamId })
    .where(and(inArray(cycles.ceoId, ceoIds), isNull(cycles.teamId)));

  // 2. Stamp authoredByCeoId on every journal entry / transcript whose
  //    parent cycle belongs to one of these CEOs. Author = the cycle's
  //    pre-team owner (which is the rawInput.ceoId that originally
  //    routed the input here).
  //
  //    Drizzle doesn't expose `UPDATE … FROM` cleanly, so we use a raw
  //    SQL update with a subquery.
  await db.execute(sql`
    UPDATE journal_entries
       SET authored_by_ceo_id = c.ceo_id
      FROM cycles c
     WHERE journal_entries.cycle_id = c.id
       AND c.ceo_id IN (${sql.join(ceoIds.map((id) => sql`${id}`), sql`, `)})
       AND journal_entries.authored_by_ceo_id IS NULL
  `);

  await db.execute(sql`
    UPDATE transcripts
       SET authored_by_ceo_id = c.ceo_id
      FROM cycles c
     WHERE transcripts.cycle_id = c.id
       AND c.ceo_id IN (${sql.join(ceoIds.map((id) => sql`${id}`), sql`, `)})
       AND transcripts.authored_by_ceo_id IS NULL
  `);

  // 3. Tag every active KPI definition for these CEOs with teamId so
  //    the context fetcher dedupes them as company-level metrics.
  //    Archived defs are left alone — they're historical.
  await db
    .update(ceoKpiDefinitions)
    .set({ teamId })
    .where(
      and(
        inArray(ceoKpiDefinitions.ceoId, ceoIds),
        isNull(ceoKpiDefinitions.teamId),
        isNull(ceoKpiDefinitions.archivedAt),
      ),
    );
}

/**
 * Merge parallel team cycles into one canonical cycle per (team,
 * period). Pre-team CEOs each had their own monthly cycle; after
 * formation the team has N parallel cycles for the same period, which
 * means:
 *
 *  - The workspace UI shows duplicate tabs ("Mar 2026" twice).
 *  - Generation can produce multiple reports for the same period.
 *  - Scalar fields (monthlyGoals / monthlyReflection / additionalContext)
 *    only live on one of the cycles even though both should be merged.
 *
 * For each (team, period) group with >1 cycle:
 *
 *  1. Pick a canonical cycle — the one with the most aggregated inputs
 *     (journals + transcripts + action_items). Tiebreak: earliest
 *     createdAt.
 *  2. For every other cycle in the group, repoint EVERY child input
 *     row (journals, transcripts, action_items, kpi_values, raw_inputs,
 *     reports, cycle_facts, report_generation_jobs) at the canonical
 *     cycle's id. Honor unique constraints by dropping the duplicate
 *     child rather than failing the update.
 *  3. Merge scalars onto canonical: prefer canonical's existing values
 *     when non-empty; otherwise copy from the duplicate.
 *  4. Delete the duplicate cycle. ON DELETE CASCADE only fires after
 *     children are repointed/dropped.
 *
 * Idempotent — runs to completion as a no-op once cycles are merged.
 */
async function mergeParallelTeamCycles(
  db: typeof dbInstance,
  teamId: string,
): Promise<{ groupsProcessed: number; cyclesDeleted: number }> {
  const allTeamCycles = await db
    .select()
    .from(cycles)
    .where(eq(cycles.teamId, teamId));

  // Group by (period_start, period_end). Cycles without dates can't be
  // safely merged — they have no period identity — so we skip them.
  const groups = new Map<string, typeof allTeamCycles>();
  for (const c of allTeamCycles) {
    if (!c.periodStart || !c.periodEnd) continue;
    const key = `${c.periodStart}|${c.periodEnd}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  let groupsProcessed = 0;
  let cyclesDeleted = 0;

  for (const [, list] of groups) {
    if (list.length < 2) continue;
    groupsProcessed += 1;

    // Score each cycle by input count; tiebreak on createdAt (earlier
    // wins, stable across reruns).
    const ids = list.map((c) => c.id);
    const journalCounts = await db
      .select({ cycleId: journalEntries.cycleId, n: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(inArray(journalEntries.cycleId, ids))
      .groupBy(journalEntries.cycleId);
    const txCounts = await db
      .select({ cycleId: transcripts.cycleId, n: sql<number>`count(*)::int` })
      .from(transcripts)
      .where(inArray(transcripts.cycleId, ids))
      .groupBy(transcripts.cycleId);
    const aiCounts = await db
      .select({ cycleId: actionItems.cycleId, n: sql<number>`count(*)::int` })
      .from(actionItems)
      .where(inArray(actionItems.cycleId, ids))
      .groupBy(actionItems.cycleId);

    const scoreById = new Map<string, number>();
    for (const r of journalCounts) scoreById.set(r.cycleId, (scoreById.get(r.cycleId) ?? 0) + r.n);
    for (const r of txCounts) scoreById.set(r.cycleId, (scoreById.get(r.cycleId) ?? 0) + r.n);
    for (const r of aiCounts) scoreById.set(r.cycleId, (scoreById.get(r.cycleId) ?? 0) + r.n);

    const sorted = [...list].sort((a, b) => {
      const sa = scoreById.get(a.id) ?? 0;
      const sb = scoreById.get(b.id) ?? 0;
      if (sa !== sb) return sb - sa; // higher score first
      return a.createdAt.getTime() - b.createdAt.getTime(); // older first
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);
    const dupIds = duplicates.map((d) => d.id);

    // ── Repoint child tables with no unique constraint on cycle_id.
    await db
      .update(journalEntries)
      .set({ cycleId: canonical.id })
      .where(inArray(journalEntries.cycleId, dupIds));
    await db
      .update(transcripts)
      .set({ cycleId: canonical.id })
      .where(inArray(transcripts.cycleId, dupIds));
    await db
      .update(actionItems)
      .set({ cycleId: canonical.id })
      .where(inArray(actionItems.cycleId, dupIds));
    await db
      .update(reports)
      .set({ cycleId: canonical.id })
      .where(inArray(reports.cycleId, dupIds));
    await db
      .update(reportGenerationJobs)
      .set({ cycleId: canonical.id })
      .where(inArray(reportGenerationJobs.cycleId, dupIds));
    await db
      .update(rawInputs)
      .set({ cycleId: canonical.id })
      .where(inArray(rawInputs.cycleId, dupIds));

    // ── cycle_kpi_values has UNIQUE (cycle_id, definition_id). If
    // canonical already has a value for a given definition, the
    // duplicate's value can't be moved — drop it (canonical's wins,
    // matching the "higher-input-count cycle is canonical" rule).
    const canonicalKpiDefs = await db
      .select({ definitionId: cycleKpiValues.definitionId })
      .from(cycleKpiValues)
      .where(eq(cycleKpiValues.cycleId, canonical.id));
    const blockedDefIds = new Set(canonicalKpiDefs.map((r) => r.definitionId));
    if (blockedDefIds.size > 0) {
      await db
        .delete(cycleKpiValues)
        .where(
          and(
            inArray(cycleKpiValues.cycleId, dupIds),
            inArray(cycleKpiValues.definitionId, [...blockedDefIds]),
          ),
        );
    }
    await db
      .update(cycleKpiValues)
      .set({ cycleId: canonical.id })
      .where(inArray(cycleKpiValues.cycleId, dupIds));

    // ── cycle_facts has UNIQUE (cycle_id). If canonical already has a
    // facts row, drop the duplicate's. Otherwise move it.
    const canonicalFacts = await db
      .select({ id: cycleFacts.id })
      .from(cycleFacts)
      .where(eq(cycleFacts.cycleId, canonical.id))
      .limit(1);
    if (canonicalFacts.length > 0) {
      await db
        .delete(cycleFacts)
        .where(inArray(cycleFacts.cycleId, dupIds));
    } else {
      // Pick whichever duplicate's facts to keep (newest), drop others.
      const dupFacts = await db
        .select()
        .from(cycleFacts)
        .where(inArray(cycleFacts.cycleId, dupIds))
        .orderBy(desc(cycleFacts.generatedAt));
      if (dupFacts.length > 1) {
        await db
          .delete(cycleFacts)
          .where(
            inArray(
              cycleFacts.id,
              dupFacts.slice(1).map((f) => f.id),
            ),
          );
      }
      if (dupFacts.length >= 1) {
        await db
          .update(cycleFacts)
          .set({ cycleId: canonical.id })
          .where(eq(cycleFacts.id, dupFacts[0].id));
      }
    }

    // ── Merge scalars: prefer canonical's existing value; copy from
    // any duplicate when canonical's is empty.
    const scalarPatch: {
      monthlyGoals?: string;
      monthlyReflection?: string;
      additionalContext?: string;
    } = {};
    if (!canonical.monthlyGoals?.trim()) {
      const v = duplicates.find((d) => d.monthlyGoals?.trim())?.monthlyGoals;
      if (v) scalarPatch.monthlyGoals = v;
    }
    if (!canonical.monthlyReflection?.trim()) {
      const v = duplicates.find((d) => d.monthlyReflection?.trim())?.monthlyReflection;
      if (v) scalarPatch.monthlyReflection = v;
    }
    if (!canonical.additionalContext?.trim()) {
      const v = duplicates.find((d) => d.additionalContext?.trim())?.additionalContext;
      if (v) scalarPatch.additionalContext = v;
    }
    if (Object.keys(scalarPatch).length > 0) {
      await db
        .update(cycles)
        .set(scalarPatch)
        .where(eq(cycles.id, canonical.id));
    }

    // ── Finally drop the duplicate cycle rows. All children have been
    // repointed; cascades won't trigger.
    await db.delete(cycles).where(inArray(cycles.id, dupIds));
    cyclesDeleted += dupIds.length;
  }

  return { groupsProcessed, cyclesDeleted };
}

/**
 * Refuse to mutate team membership while any member has a non-terminal
 * generation job. The merge/backfill can repoint or delete a cycle the
 * workflow is mid-step on; stages already written would land on a
 * deleted row. Cleaner to make the operator cancel or wait. Throws a
 * BAD_REQUEST with the offending cycle so the UI can deep-link.
 */
async function assertNoActiveGenerationsForCeos(
  db: typeof dbInstance,
  ceoIds: string[],
): Promise<void> {
  if (ceoIds.length === 0) return;
  const active = await db
    .select({
      jobId: reportGenerationJobs.id,
      cycleId: reportGenerationJobs.cycleId,
      status: reportGenerationJobs.status,
    })
    .from(reportGenerationJobs)
    .innerJoin(cycles, eq(cycles.id, reportGenerationJobs.cycleId))
    .where(
      and(
        inArray(cycles.ceoId, ceoIds),
        ne(reportGenerationJobs.status, 'complete'),
        ne(reportGenerationJobs.status, 'error'),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Cannot change team membership while a report is being generated. Wait for the run to finish or cancel it first.',
    });
  }
}

/**
 * Split-on-dissolve: when CEOs leave a team (single removeMember or
 * full archive), reconstruct per-CEO solo cycles from their authored
 * inputs. Without this, the previous merge step destructively deleted
 * each CEO's parallel pre-team cycles — so dissolving the team would
 * leave the non-canonical members with NO cycle history at all.
 *
 * Mechanism: re-trigger the ingestion projectors for every raw_input
 * touching these CEOs. The projectors are team-aware via
 * `match-cycle.ts`, so once the CEO's team link has been cleared they
 * route to per-CEO solo cycles (creating them as needed). Journal /
 * transcript / KPI rows get upserted to the right cycle automatically,
 * and joint transcripts get fanned out to each attendee's solo cycle
 * via the existing raw_input_ceos linkage.
 *
 * Must be called AFTER `ceos.teamId` has been nulled for the leaving
 * members (the projectors read the live state).
 */
async function reprojectInputsForLeavingMembers(
  db: typeof dbInstance,
  ceoIds: string[],
): Promise<{ reprojected: number }> {
  if (ceoIds.length === 0) return { reprojected: 0 };

  // Collect every raw_input whose primary ceoId is one of the leavers
  // OR whose raw_input_ceos linkage includes one of them (covers
  // multi-attendee transcripts).
  const direct = await db
    .select({ id: rawInputs.id })
    .from(rawInputs)
    .where(inArray(rawInputs.ceoId, ceoIds));
  const linked = await db
    .select({ id: rawInputCeos.rawInputId })
    .from(rawInputCeos)
    .where(inArray(rawInputCeos.ceoId, ceoIds));
  const allIds = Array.from(
    new Set<string>([...direct.map((r) => r.id), ...linked.map((r) => r.id)]),
  );

  for (const id of allIds) {
    try {
      await projectRawInput(id);
    } catch (e) {
      // One bad input shouldn't block the rest of the dissolution.
      // The orphan will be visible in triage; coaches can re-route
      // manually if needed.
      console.error('[reprojectInputsForLeavingMembers] failed for', id, e);
    }
  }
  return { reprojected: allIds.length };
}

/**
 * Reverse of `backfillCeoInputsForTeam` — runs when a CEO leaves a
 * team (`removeMember`) or the whole team is dissolved (`archive`).
 *
 * Goal: restore the "this row was never team-stamped" state so the
 * v2 prompt builder treats the data as solo again and the workspace
 * UI shows it as such.
 *
 * What we DO revert:
 *  - `cycles.teamId` → null for cycles whose ceoId matches the CEOs
 *    leaving. Without this the cycle becomes orphaned: teamId points
 *    at a team with no members, the context fetcher resolves
 *    `members = []`, and queries like `inArray(cycles.ceoId, memberIds)`
 *    match nothing — generation would see an empty cycle. Critical.
 *  - `ceo_kpi_definitions.teamId` → null on this CEO's defs.
 *
 * What we DON'T revert:
 *  - `journal_entries.authoredByCeoId` / `transcripts.authoredByCeoId`
 *    stay stamped. They were ALSO stamped at ingestion time for any
 *    inputs received post-formation, and we have no marker to tell
 *    backfill-stamped apart from ingestion-stamped. The byline only
 *    renders when isTeam=true (cycle.teamId set), so leftover values
 *    are inert once the cycle is solo again.
 */
async function revertTeamStampingForCeos(
  db: typeof dbInstance,
  teamId: string,
  ceoIds: string[],
): Promise<void> {
  if (ceoIds.length === 0) return;

  await db
    .update(cycles)
    .set({ teamId: null })
    .where(and(eq(cycles.teamId, teamId), inArray(cycles.ceoId, ceoIds)));

  await db
    .update(ceoKpiDefinitions)
    .set({ teamId: null })
    .where(
      and(
        eq(ceoKpiDefinitions.teamId, teamId),
        inArray(ceoKpiDefinitions.ceoId, ceoIds),
      ),
    );
}

/**
 * Coaching teams — co-founder / co-CEO pairings (or trios). Each team
 * has one coach (inherited from its members), 1..N CEO members, a
 * shared 10x goal, and produces ONE joint monthly report per cycle.
 *
 * The data shape keeps cycles per-CEO at the schema level (cycle.ceoId
 * points at the team's lead member for backwards-compat); the v2
 * prompt builder fans out at read time to merge every member's inputs
 * into one team context. See `src/lib/prompts/v2/context.ts`.
 */

/** Auth helper: caller must own the team's coach or be a super-admin. */
async function loadTeamForCaller(
  ctx: {
    db: typeof import('@/db').db;
    coach: { id: string };
    realCoach: { isSuperAdmin: boolean } | null;
  },
  teamId: string,
) {
  const [team] = await ctx.db
    .select()
    .from(coachingTeams)
    .where(eq(coachingTeams.id, teamId))
    .limit(1);
  if (!team) throw new TRPCError({ code: 'NOT_FOUND' });
  if (
    !ctx.realCoach?.isSuperAdmin &&
    team.coachId !== ctx.coach.id
  ) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return team;
}

export const teamsRouter = createTRPCRouter({
  /** List every team visible to the caller, with member previews and
   *  basic counts so the roster can render team rows. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const coachFilter = ctx.realCoach?.isSuperAdmin
      ? undefined
      : eq(coachingTeams.coachId, ctx.coach.id);

    const teams = await ctx.db
      .select()
      .from(coachingTeams)
      .where(coachFilter ?? sql`true`)
      .orderBy(asc(coachingTeams.name));

    if (teams.length === 0) return [];

    const teamIds = teams.map((t) => t.id);
    const members = await ctx.db
      .select()
      .from(ceos)
      .where(inArray(ceos.teamId, teamIds))
      .orderBy(asc(ceos.createdAt));

    const membersByTeam = new Map<string, typeof members>();
    for (const m of members) {
      if (!m.teamId) continue;
      const list = membersByTeam.get(m.teamId) ?? [];
      list.push(m);
      membersByTeam.set(m.teamId, list);
    }

    return teams.map((t) => ({
      ...t,
      members: membersByTeam.get(t.id) ?? [],
    }));
  }),

  /** Single team with full member list. */
  get: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      const members = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.teamId, team.id))
        .orderBy(asc(ceos.createdAt));
      return { ...team, members };
    }),

  /** Form a team from 2+ existing CEOs. All members must already share
   *  one coach (we'd otherwise have to pick whose coach "wins" which
   *  is a policy call we don't want to make implicitly).
   *
   *  Sets team.tenXGoal from the most recent member's tenXGoal as a
   *  starting point — the coach can edit it after. Cycles are NOT
   *  retroactively re-linked to the team; future cycles created with
   *  team awareness will carry teamId. */
  formFromMembers: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        companyName: z.string().trim().max(120).optional(),
        memberCeoIds: z
          .array(z.string().uuid())
          .min(2, { message: 'A team needs at least 2 members.' })
          .max(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Load all candidate members.
      const memberRows = await ctx.db
        .select()
        .from(ceos)
        .where(inArray(ceos.id, input.memberCeoIds));
      if (memberRows.length !== input.memberCeoIds.length) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'One or more selected CEOs no longer exist.',
        });
      }

      // Auth check: caller must be allowed to manage every member.
      // Super-admins skip; coach-scope requires every member to be on
      // this coach's roster.
      if (!ctx.realCoach?.isSuperAdmin) {
        const notMine = memberRows.find((m) => m.coachId !== ctx.coach.id);
        if (notMine) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `${notMine.name} is not on your roster.`,
          });
        }
      }

      // All members must already share a coach. If they don't, we
      // refuse rather than re-assign silently — that's a separate
      // explicit decision the coach should make first.
      const distinctCoachIds = new Set(
        memberRows.map((m) => m.coachId).filter((id): id is string => !!id),
      );
      if (distinctCoachIds.size > 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'These CEOs are assigned to different coaches. Reassign them to a single coach before forming a team.',
        });
      }
      if (distinctCoachIds.size === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'At least one selected CEO must already have a coach assigned. Assign a coach first.',
        });
      }
      const coachId = [...distinctCoachIds][0];

      // None of the members can already be in another team.
      const alreadyInTeam = memberRows.find((m) => m.teamId);
      if (alreadyInTeam) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${alreadyInTeam.name} is already in a team — remove them first.`,
        });
      }

      // Refuse if any member has a running v2 generation job — the
      // merge step would repoint cycles the workflow is mid-step on.
      await assertNoActiveGenerationsForCeos(ctx.db, input.memberCeoIds);

      // Seed the team's 10x goal from whichever member has one (prefer
      // the most recently updated). Coach edits after.
      const withGoal = memberRows
        .filter((m) => m.tenXGoal?.trim())
        .sort((a, b) => {
          const at = a.tenXGoalUpdatedAt?.getTime() ?? 0;
          const bt = b.tenXGoalUpdatedAt?.getTime() ?? 0;
          return bt - at;
        });
      const seedGoal = withGoal[0]?.tenXGoal ?? null;
      const seedGoalAt = withGoal[0]?.tenXGoalUpdatedAt ?? null;

      const [team] = await ctx.db
        .insert(coachingTeams)
        .values({
          coachId,
          name: input.name,
          companyName: input.companyName?.trim() || null,
          tenXGoal: seedGoal,
          tenXGoalUpdatedAt: seedGoalAt,
        })
        .returning();

      // Link every member to the new team AND sync each member's
      // coachId to the resolved team coach. Without the coach sync,
      // a member whose coachId was null (unassigned) would join the
      // team but stay invisible to coach-scoped queries (where
      // `ceo.coachId = X` filters them out). The team's coach is the
      // one source of truth from this point forward.
      await ctx.db
        .update(ceos)
        .set({ teamId: team.id, coachId })
        .where(inArray(ceos.id, input.memberCeoIds));

      // Backfill: every existing cycle / journal / transcript / KPI
      // for these members gets stamped with the team and the original
      // author. Without this, generation on pre-team cycles still
      // looks "solo" and the workspace / report renderer can't show
      // bylines. See helper docs for details.
      await backfillCeoInputsForTeam(ctx.db, team.id, input.memberCeoIds);

      // Merge parallel cycles into one per (team, period). Pre-team
      // each member had their own cycle for the same month; after
      // formation that's redundant. Inputs are repointed at the
      // canonical cycle and scalars merged. See helper docs.
      await mergeParallelTeamCycles(ctx.db, team.id);

      return { team };
    }),

  /** Add an existing CEO to an existing team. The CEO must share the
   *  team's coach and not already be in another team. */
  addMember: protectedProcedure
    .input(
      z.object({
        teamId: z.string().uuid(),
        ceoId: z.string().uuid(),
        memberRole: z.string().trim().max(60).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (ceo.teamId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${ceo.name} is already in a team.`,
        });
      // If the CEO has a different coach, refuse — separating "join
      // team" from "transfer coach" keeps the policy explicit. If they
      // have NO coach assigned, the join is fine; we sync them to the
      // team's coach so the row becomes visible in coach-scoped views.
      if (ceo.coachId && ceo.coachId !== team.coachId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${ceo.name} is on a different coach. Reassign them first.`,
        });
      }

      // Refuse if the joining CEO has a running generation job — the
      // merge could repoint cycles the workflow is mid-step on.
      await assertNoActiveGenerationsForCeos(ctx.db, [ceo.id]);

      await ctx.db
        .update(ceos)
        .set({
          teamId: team.id,
          memberRole: input.memberRole ?? null,
          coachId: team.coachId, // sync if previously null
        })
        .where(eq(ceos.id, ceo.id));

      // Same backfill rules as formFromMembers — the joining member's
      // existing cycles / journals / transcripts / KPIs need to roll
      // up to the team so generation fans out correctly.
      await backfillCeoInputsForTeam(ctx.db, team.id, [ceo.id]);

      // The joining member's existing cycles likely overlap the
      // team's existing cycles by period — merge them so the team
      // ends up with one canonical cycle per period.
      await mergeParallelTeamCycles(ctx.db, team.id);

      return { ok: true };
    }),

  /** Remove a CEO from a team. The CEO becomes solo again; their team
   *  membership is cleared. The team itself stays (1-member teams are
   *  allowed — coach can delete via `archive` if they want).
   *
   *  Also reverses the backfill so the leaving member's cycles + KPIs
   *  return to their pre-team state. Without this revert, those rows
   *  would still point at the team and generation on them would
   *  resolve `members = []` (the CEO is no longer linked to the team),
   *  producing empty context. */
  removeMember: protectedProcedure
    .input(z.object({ ceoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!ceo.teamId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This CEO is not in a team.',
        });
      await loadTeamForCaller(ctx, ceo.teamId);

      const teamId = ceo.teamId;

      // Refuse during an active generation — see helper.
      await assertNoActiveGenerationsForCeos(ctx.db, [ceo.id]);

      await ctx.db
        .update(ceos)
        .set({ teamId: null, memberRole: null })
        .where(eq(ceos.id, ceo.id));

      // Revert cycle / KPI tagging for just this CEO.
      await revertTeamStampingForCeos(ctx.db, teamId, [ceo.id]);

      // Reconstruct per-CEO cycles from the leaving member's authored
      // inputs. Without this, the post-merge state means the leaver
      // walks away with zero cycle history (their original cycles
      // were deleted during the merge). The projectors fan inputs back
      // out into solo cycles via match-cycle.ts.
      const splitResult = await reprojectInputsForLeavingMembers(ctx.db, [ceo.id]);

      return { ok: true, ...splitResult };
    }),

  /** Update the team's shared fields — name, company name, 10x goal,
   *  member role assignments. Keep this as one mutation so the form UI
   *  can save everything in a single round-trip. */
  update: protectedProcedure
    .input(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        companyName: z.string().trim().max(120).nullable().optional(),
        tenXGoal: z.string().trim().max(4000).nullable().optional(),
        memberRoles: z
          .array(
            z.object({
              ceoId: z.string().uuid(),
              role: z.string().trim().max(60).nullable(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      const patch: Partial<typeof coachingTeams.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.companyName !== undefined) patch.companyName = input.companyName;
      if (input.tenXGoal !== undefined) {
        patch.tenXGoal = input.tenXGoal;
        patch.tenXGoalUpdatedAt = new Date();
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db
          .update(coachingTeams)
          .set(patch)
          .where(eq(coachingTeams.id, team.id));
      }
      if (input.memberRoles && input.memberRoles.length > 0) {
        for (const r of input.memberRoles) {
          await ctx.db
            .update(ceos)
            .set({ memberRole: r.role })
            .where(and(eq(ceos.id, r.ceoId), eq(ceos.teamId, team.id)));
        }
      }
      return { ok: true };
    }),

  /** Eligible candidates for the "Form team" picker — CEOs assigned to
   *  the calling coach (or any coach for admins) who aren't already in
   *  a team. */
  listFormCandidates: protectedProcedure.query(async ({ ctx }) => {
    const filter = ctx.realCoach?.isSuperAdmin
      ? isNull(ceos.teamId)
      : and(isNull(ceos.teamId), eq(ceos.coachId, ctx.coach.id));
    const rows = await ctx.db
      .select({
        id: ceos.id,
        name: ceos.name,
        email: ceos.email,
        avatarUrl: ceos.avatarUrl,
        coachId: ceos.coachId,
        tenXGoal: ceos.tenXGoal,
      })
      .from(ceos)
      .where(filter ?? sql`true`)
      .orderBy(asc(ceos.name));
    return rows;
  }),

  /** Re-run backfill + parallel-cycle merge on an existing team. Use
   *  when data has drifted (e.g. a member was added before the merge
   *  logic existed, or a one-off SQL form-team skipped the backfill).
   *  Idempotent — a team in clean state returns zero work done. */
  resync: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      const memberRows = await ctx.db
        .select({ id: ceos.id })
        .from(ceos)
        .where(eq(ceos.teamId, team.id));
      const memberIds = memberRows.map((m) => m.id);
      if (memberIds.length === 0) return { backfilled: false, merged: { groupsProcessed: 0, cyclesDeleted: 0 } };

      await backfillCeoInputsForTeam(ctx.db, team.id, memberIds);
      const merged = await mergeParallelTeamCycles(ctx.db, team.id);
      return { backfilled: true, merged };
    }),

  /** Archive a team — fully reverses formation so every member's data
   *  returns to its pre-team state. Each member's ceos.teamId,
   *  cycles.teamId, and ceo_kpi_definitions.teamId get cleared, and
   *  the per-CEO inputs get re-projected so each former member ends up
   *  with their own solo cycles (not just the canonical lead). */
  archive: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);

      // Capture the member ids BEFORE we null their teamId, so the
      // revert helper has something to match against.
      const memberRows = await ctx.db
        .select({ id: ceos.id })
        .from(ceos)
        .where(eq(ceos.teamId, team.id));
      const memberIds = memberRows.map((m) => m.id);

      // Refuse during any active generation across the team. The merge
      // and split paths both touch cycles the workflow may be on.
      await assertNoActiveGenerationsForCeos(ctx.db, memberIds);

      await ctx.db
        .update(ceos)
        .set({ teamId: null, memberRole: null })
        .where(eq(ceos.teamId, team.id));

      if (memberIds.length > 0) {
        await revertTeamStampingForCeos(ctx.db, team.id, memberIds);
      }

      // Split-on-dissolve: reconstruct per-CEO solo cycles from each
      // former member's authored inputs. Without this, only the
      // canonical-lead's cycles survive — the other members walk away
      // with no history because their original cycles were deleted
      // during the formation-time merge.
      let splitResult = { reprojected: 0 };
      if (memberIds.length > 0) {
        splitResult = await reprojectInputsForLeavingMembers(ctx.db, memberIds);
      }

      await ctx.db
        .update(coachingTeams)
        .set({ archivedAt: new Date() })
        .where(eq(coachingTeams.id, team.id));
      return { ok: true, ...splitResult };
    }),

  /** Transfer a team to a new coach. Updates the team's coachId AND
   *  every member's coachId atomically so coach-scoped queries route
   *  correctly. Caller must currently own the team (or be a super
   *  admin); the new coach doesn't need to exist for the caller's
   *  scope. */
  transferCoach: protectedProcedure
    .input(
      z.object({
        teamId: z.string().uuid(),
        newCoachId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      const [newCoach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.newCoachId))
        .limit(1);
      if (!newCoach) throw new TRPCError({ code: 'NOT_FOUND', message: 'Coach not found.' });
      if (team.coachId === newCoach.id) {
        return { ok: true, noop: true };
      }

      // Update the team and every current member in lockstep.
      await ctx.db
        .update(coachingTeams)
        .set({ coachId: newCoach.id })
        .where(eq(coachingTeams.id, team.id));
      await ctx.db
        .update(ceos)
        .set({ coachId: newCoach.id })
        .where(eq(ceos.teamId, team.id));
      return { ok: true, noop: false };
    }),
});

// Silence unused-import warnings for symbols pulled in for future
// queries (recent cycles + reports endpoints). Keeps the import list
// stable so adding endpoints later is a one-line change.
void coaches;
void cycles;
void reports;
void desc;
void ne;
