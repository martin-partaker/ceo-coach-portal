import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { ceos, cycles, reports, transcripts } from '@/db/schema';
import { sql } from 'drizzle-orm';

export const ceosRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const coachCeos = await ctx.db
      .select()
      .from(ceos)
      .where(eq(ceos.coachId, ctx.coach.id))
      .orderBy(desc(ceos.createdAt));

    // Fetch latest cycle + report status for each CEO
    const enriched = await Promise.all(
      coachCeos.map(async (ceo) => {
        const [latestCycle] = await ctx.db
          .select()
          .from(cycles)
          .where(eq(cycles.ceoId, ceo.id))
          .orderBy(desc(cycles.createdAt))
          .limit(1);

        let hasReport = false;
        let hasTranscripts = false;
        if (latestCycle) {
          const [report] = await ctx.db
            .select({ id: reports.id })
            .from(reports)
            .where(eq(reports.cycleId, latestCycle.id))
            .limit(1);
          hasReport = !!report;

          const [tCount] = await ctx.db
            .select({ count: sql<number>`count(*)` })
            .from(transcripts)
            .where(eq(transcripts.cycleId, latestCycle.id));
          hasTranscripts = Number(tCount?.count ?? 0) > 0;
        }

        return { ceo, latestCycle: latestCycle ?? null, hasReport, hasTranscripts };
      })
    );

    return enriched;
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, input.id), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);

      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const coachCycles = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.ceoId, ceo.id))
        .orderBy(desc(cycles.createdAt));

      return { ceo, cycles: coachCycles };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, 'Name is required'),
        email: z.string().email().optional().or(z.literal('')),
        tenXGoal: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [created] = await ctx.db
        .insert(ceos)
        .values({
          coachId: ctx.coach.id,
          name: input.name,
          email: input.email || null,
          tenXGoal: input.tenXGoal || null,
          tenXGoalUpdatedAt: input.tenXGoal ? new Date() : null,
        })
        .returning();
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).optional(),
        email: z.string().email().nullable().optional(),
        tenXGoal: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, input.id), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const isTenXUpdated =
        input.tenXGoal !== undefined && input.tenXGoal !== ceo.tenXGoal;

      const [updated] = await ctx.db
        .update(ceos)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.tenXGoal !== undefined && { tenXGoal: input.tenXGoal }),
          ...(isTenXUpdated && { tenXGoalUpdatedAt: new Date() }),
        })
        .where(eq(ceos.id, input.id))
        .returning();
      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, input.id), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      await ctx.db.delete(ceos).where(eq(ceos.id, input.id));
      return { success: true };
    }),
});
