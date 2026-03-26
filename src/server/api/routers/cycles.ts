import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { ceos, cycles, actionItems } from '@/db/schema';

export const cyclesRouter = createTRPCRouter({
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.id))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      // Verify coach owns the parent CEO
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const items = await ctx.db
        .select()
        .from(actionItems)
        .where(eq(actionItems.cycleId, cycle.id))
        .orderBy(desc(actionItems.createdAt));

      return { cycle, ceo, actionItems: items };
    }),

  create: protectedProcedure
    .input(
      z.object({
        ceoId: z.string().uuid(),
        label: z.string().min(1),
        periodStart: z.string().nullable().optional(),
        periodEnd: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, input.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

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

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1).optional(),
        monthlyGoals: z.string().nullable().optional(),
        weeklyJournal1: z.string().nullable().optional(),
        weeklyJournal2: z.string().nullable().optional(),
        weeklyJournal3: z.string().nullable().optional(),
        weeklyJournal4: z.string().nullable().optional(),
        weeklyJournal5: z.string().nullable().optional(),
        monthlyReflection: z.string().nullable().optional(),
        zoomTranscript: z.string().nullable().optional(),
        zoomMeetingId: z.string().nullable().optional(),
        transcriptSkipped: z.boolean().optional(),
        previousActionItemsReviewed: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;

      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, id))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Only update provided fields
      const updatePayload = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined)
      );

      const [updated] = await ctx.db
        .update(cycles)
        .set(updatePayload)
        .where(eq(cycles.id, id))
        .returning();
      return updated;
    }),

  listForCeo: protectedProcedure
    .input(z.object({ ceoId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, input.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      return ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.ceoId, input.ceoId))
        .orderBy(desc(cycles.createdAt));
    }),
});
