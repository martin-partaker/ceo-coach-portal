import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, adminProcedure } from '@/server/api/trpc';
import { coaches, ceos, cycles, reports } from '@/db/schema';

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
      const [created] = await ctx.db
        .insert(coaches)
        .values({
          name: input.name,
          email: input.email,
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
