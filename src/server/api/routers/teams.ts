import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import {
  ceos,
  coachingTeams,
  coaches,
  cycles,
  reports,
} from '@/db/schema';

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

      // Link every member to the new team in one update.
      await ctx.db
        .update(ceos)
        .set({ teamId: team.id })
        .where(inArray(ceos.id, input.memberCeoIds));

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
      if (ceo.coachId !== team.coachId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${ceo.name} is on a different coach. Reassign them first.`,
        });
      await ctx.db
        .update(ceos)
        .set({ teamId: team.id, memberRole: input.memberRole ?? null })
        .where(eq(ceos.id, ceo.id));
      return { ok: true };
    }),

  /** Remove a CEO from a team. The CEO becomes solo again; their team
   *  membership is cleared. The team itself stays (1-member teams are
   *  allowed — coach can delete via `archive` if they want). */
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
      await ctx.db
        .update(ceos)
        .set({ teamId: null, memberRole: null })
        .where(eq(ceos.id, ceo.id));
      return { ok: true };
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

  /** Archive a team — clears members and marks the team archived.
   *  Cycles already generated against the team stay attached to their
   *  cycle.teamId (historical record), but no new cycles will roll up
   *  to the team. */
  archive: protectedProcedure
    .input(z.object({ teamId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeamForCaller(ctx, input.teamId);
      await ctx.db
        .update(ceos)
        .set({ teamId: null, memberRole: null })
        .where(eq(ceos.teamId, team.id));
      await ctx.db
        .update(coachingTeams)
        .set({ archivedAt: new Date() })
        .where(eq(coachingTeams.id, team.id));
      return { ok: true };
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
