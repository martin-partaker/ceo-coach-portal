import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import { coaches, ceos, cycles, reports, ceoEmailAliases } from '@/db/schema';

export const adminRouter = createTRPCRouter({
  listCoaches: adminProcedure.query(async ({ ctx }) => {
    const allCoaches = await ctx.db
      .select()
      .from(coaches)
      .orderBy(desc(coaches.createdAt));

    const enriched = await Promise.all(
      allCoaches.map(async (coach) => {
        const [countResult] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(ceos)
          .where(eq(ceos.coachId, coach.id));

        return {
          ...coach,
          ceoCount: Number(countResult?.count ?? 0),
        };
      })
    );

    return enriched;
  }),

  getCoachDetail: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const coachCeos = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.coachId, coach.id))
        .orderBy(desc(ceos.createdAt));

      const enriched = await Promise.all(
        coachCeos.map(async (ceo) => {
          const [latestCycle] = await ctx.db
            .select()
            .from(cycles)
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(desc(cycles.createdAt))
            .limit(1);

          let hasReport = false;
          if (latestCycle) {
            const [report] = await ctx.db
              .select({ id: reports.id })
              .from(reports)
              .where(eq(reports.cycleId, latestCycle.id))
              .limit(1);
            hasReport = !!report;
          }

          return { ceo, latestCycle: latestCycle ?? null, hasReport };
        })
      );

      return { coach, ceos: enriched };
    }),

  createCoach: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        isSuperAdmin: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.email, input.email))
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A coach with this email already exists.',
        });
      }

      // Create coach slot — neonAuthUserId is null until they sign up
      // Default zoom email to their regular email
      const [created] = await ctx.db
        .insert(coaches)
        .values({
          name: input.name,
          email: input.email,
          zoomUserEmail: input.email,
          isSuperAdmin: input.isSuperAdmin ?? false,
        })
        .returning();

      return created;
    }),

  toggleAdmin: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      if (coach.id === ctx.coach.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot change your own admin status.',
        });
      }

      const [updated] = await ctx.db
        .update(coaches)
        .set({ isSuperAdmin: !coach.isSuperAdmin })
        .where(eq(coaches.id, input.coachId))
        .returning();

      return updated;
    }),

  updateCoachZoomEmail: adminProcedure
    .input(
      z.object({
        coachId: z.string().uuid(),
        zoomUserEmail: z.string().email().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const [updated] = await ctx.db
        .update(coaches)
        .set({ zoomUserEmail: input.zoomUserEmail })
        .where(eq(coaches.id, input.coachId))
        .returning();

      return updated;
    }),

  // Flat list of every CEO across all coaches — for /admin/ceos
  listAllCeos: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        ceo: ceos,
        coach: coaches,
      })
      .from(ceos)
      .innerJoin(coaches, eq(ceos.coachId, coaches.id))
      .orderBy(desc(ceos.createdAt));

    const enriched = await Promise.all(
      rows.map(async ({ ceo, coach }) => {
        const [cycleCountRow] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(cycles)
          .where(eq(cycles.ceoId, ceo.id));

        const [latestCycle] = await ctx.db
          .select({ id: cycles.id, label: cycles.label, periodEnd: cycles.periodEnd })
          .from(cycles)
          .where(eq(cycles.ceoId, ceo.id))
          .orderBy(desc(cycles.periodStart))
          .limit(1);

        let hasReport = false;
        if (latestCycle) {
          const [r] = await ctx.db
            .select({ id: reports.id })
            .from(reports)
            .where(eq(reports.cycleId, latestCycle.id))
            .limit(1);
          hasReport = !!r;
        }

        const aliases = await ctx.db
          .select({ email: ceoEmailAliases.email })
          .from(ceoEmailAliases)
          .where(eq(ceoEmailAliases.ceoId, ceo.id));

        return {
          ceo,
          coach,
          cycleCount: Number(cycleCountRow?.count ?? 0),
          latestCycle: latestCycle ?? null,
          hasReport,
          aliasEmails: aliases.map((a) => a.email),
        };
      })
    );

    return enriched;
  }),

  /* ───────────────────── CEO management ───────────────────── */

  createCeo: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email().nullable().optional(),
        coachId: z.string().uuid(),
        tenXGoal: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND', message: 'Coach not found' });

      const normalizedEmail = input.email ? input.email.toLowerCase().trim() : null;

      // Email collision check (against alias table)
      if (normalizedEmail) {
        const [clash] = await ctx.db
          .select()
          .from(ceoEmailAliases)
          .where(eq(ceoEmailAliases.email, normalizedEmail))
          .limit(1);
        if (clash) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Email already linked to a different CEO.',
          });
        }
      }

      const [created] = await ctx.db
        .insert(ceos)
        .values({
          coachId: input.coachId,
          name: input.name,
          email: normalizedEmail,
          tenXGoal: input.tenXGoal ?? null,
          tenXGoalUpdatedAt: input.tenXGoal ? new Date() : null,
        })
        .returning();

      // Mirror into alias table for the lookup path
      if (normalizedEmail) {
        await ctx.db
          .insert(ceoEmailAliases)
          .values({ ceoId: created.id, email: normalizedEmail })
          .onConflictDoNothing({ target: ceoEmailAliases.email });
      }

      return created;
    }),

  updateCeo: adminProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        name: z.string().min(1).optional(),
        email: z.string().email().nullable().optional(),
        tenXGoal: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const set: Partial<typeof ceos.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.email !== undefined) {
        set.email = input.email ? input.email.toLowerCase().trim() : null;
      }
      if (input.tenXGoal !== undefined) {
        set.tenXGoal = input.tenXGoal;
        set.tenXGoalUpdatedAt = new Date();
      }

      const [updated] = await ctx.db
        .update(ceos)
        .set(set)
        .where(eq(ceos.id, input.ceoId))
        .returning();

      // If email changed, ensure it's in the aliases table
      if (input.email !== undefined && set.email) {
        await ctx.db
          .insert(ceoEmailAliases)
          .values({ ceoId: updated.id, email: set.email })
          .onConflictDoNothing({ target: ceoEmailAliases.email });
      }

      return updated;
    }),

  reassignCeo: adminProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        newCoachId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const [coach] = await ctx.db
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.id, input.newCoachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND', message: 'Coach not found' });

      if (ceo.coachId === input.newCoachId) {
        return ceo;
      }

      const [updated] = await ctx.db
        .update(ceos)
        .set({ coachId: input.newCoachId })
        .where(eq(ceos.id, input.ceoId))
        .returning();

      return updated;
    }),

  deleteCeo: adminProcedure
    .input(z.object({ ceoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.id, input.ceoId))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Cascade: aliases, cycles, journal_entries, transcripts, action_items,
      // reports, raw_inputs all reference ceos with onDelete: 'cascade'.
      await ctx.db.delete(ceos).where(eq(ceos.id, input.ceoId));
      return { ok: true };
    }),

  /* ───────────────────── Coach management ───────────────────── */

  updateCoach: adminProcedure
    .input(
      z.object({
        coachId: z.string().uuid(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        zoomUserEmail: z.string().email().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const set: Partial<typeof coaches.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.email !== undefined) set.email = input.email.toLowerCase().trim();
      if (input.zoomUserEmail !== undefined) {
        set.zoomUserEmail = input.zoomUserEmail
          ? input.zoomUserEmail.toLowerCase().trim()
          : null;
      }

      const [updated] = await ctx.db
        .update(coaches)
        .set(set)
        .where(eq(coaches.id, input.coachId))
        .returning();
      return updated;
    }),

  deleteCoach: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      // Refuse to delete a coach who still has CEOs — operator must
      // reassign or delete them first to avoid surprise cascades.
      const [{ count }] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(ceos)
        .where(eq(ceos.coachId, input.coachId));
      const ceoCount = Number(count);
      if (ceoCount > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Coach has ${ceoCount} CEO${ceoCount === 1 ? '' : 's'}. Reassign or delete them first.`,
        });
      }

      if (coach.id === ctx.coach.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You cannot delete your own coach account.',
        });
      }

      await ctx.db.delete(coaches).where(eq(coaches.id, input.coachId));
      return { ok: true };
    }),

  // View-as: get a coach's dashboard data (CEOs with status)
  viewAsCoach: adminProcedure
    .input(z.object({ coachId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [coach] = await ctx.db
        .select()
        .from(coaches)
        .where(eq(coaches.id, input.coachId))
        .limit(1);
      if (!coach) throw new TRPCError({ code: 'NOT_FOUND' });

      const coachCeos = await ctx.db
        .select()
        .from(ceos)
        .where(eq(ceos.coachId, coach.id))
        .orderBy(desc(ceos.createdAt));

      const enriched = await Promise.all(
        coachCeos.map(async (ceo) => {
          const [latestCycle] = await ctx.db
            .select()
            .from(cycles)
            .where(eq(cycles.ceoId, ceo.id))
            .orderBy(desc(cycles.createdAt))
            .limit(1);

          let hasReport = false;
          if (latestCycle) {
            const [report] = await ctx.db
              .select({ id: reports.id })
              .from(reports)
              .where(eq(reports.cycleId, latestCycle.id))
              .limit(1);
            hasReport = !!report;
          }

          return { ceo, latestCycle: latestCycle ?? null, hasReport };
        })
      );

      return { coach, ceos: enriched };
    }),
});
