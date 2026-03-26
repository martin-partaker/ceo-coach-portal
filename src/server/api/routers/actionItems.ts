import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { actionItems, cycles, ceos } from '@/db/schema';

async function verifyCycleOwnership(db: any, cycleId: string, coachId: string) {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

  const [ceo] = await db
    .select()
    .from(ceos)
    .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, coachId)))
    .limit(1);
  if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

  return { cycle, ceo };
}

export const actionItemsRouter = createTRPCRouter({
  listForCycle: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await verifyCycleOwnership(ctx.db, input.cycleId, ctx.coach.id);

      return ctx.db
        .select()
        .from(actionItems)
        .where(eq(actionItems.cycleId, input.cycleId))
        .orderBy(desc(actionItems.createdAt));
    }),

  // Get open items from previous cycle (for carry-forward)
  listPreviousOpen: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { cycle } = await verifyCycleOwnership(ctx.db, input.cycleId, ctx.coach.id);

      // Find the previous cycle for this CEO
      const previousCycles = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.ceoId, cycle.ceoId))
        .orderBy(desc(cycles.createdAt));

      const currentIndex = previousCycles.findIndex((c) => c.id === input.cycleId);
      const previousCycle = previousCycles[currentIndex + 1];
      if (!previousCycle) return [];

      const items = await ctx.db
        .select()
        .from(actionItems)
        .where(and(eq(actionItems.cycleId, previousCycle.id), eq(actionItems.status, 'open')))
        .orderBy(desc(actionItems.createdAt));

      return items.map((item) => ({ ...item, fromCycleLabel: previousCycle.label }));
    }),

  create: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        owner: z.enum(['CEO', 'Coach', 'Other']),
        item: z.string().min(1),
        dueAt: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await verifyCycleOwnership(ctx.db, input.cycleId, ctx.coach.id);

      const [created] = await ctx.db
        .insert(actionItems)
        .values({
          cycleId: input.cycleId,
          owner: input.owner,
          item: input.item,
          dueAt: input.dueAt ?? null,
        })
        .returning();
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        owner: z.enum(['CEO', 'Coach', 'Other']).optional(),
        item: z.string().min(1).optional(),
        dueAt: z.string().nullable().optional(),
        status: z.enum(['open', 'done', 'dropped']).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(actionItems)
        .where(eq(actionItems.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' });

      await verifyCycleOwnership(ctx.db, existing.cycleId, ctx.coach.id);

      const { id, ...fields } = input;
      const updatePayload = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined)
      );

      const [updated] = await ctx.db
        .update(actionItems)
        .set(updatePayload)
        .where(eq(actionItems.id, id))
        .returning();
      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(actionItems)
        .where(eq(actionItems.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' });

      await verifyCycleOwnership(ctx.db, existing.cycleId, ctx.coach.id);

      await ctx.db.delete(actionItems).where(eq(actionItems.id, input.id));
      return { success: true };
    }),

  // Carry forward an item from previous cycle to current
  carryForward: protectedProcedure
    .input(
      z.object({
        fromItemId: z.string().uuid(),
        toCycleId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [sourceItem] = await ctx.db
        .select()
        .from(actionItems)
        .where(eq(actionItems.id, input.fromItemId))
        .limit(1);
      if (!sourceItem) throw new TRPCError({ code: 'NOT_FOUND' });

      await verifyCycleOwnership(ctx.db, input.toCycleId, ctx.coach.id);

      // Create copy in new cycle
      const [created] = await ctx.db
        .insert(actionItems)
        .values({
          cycleId: input.toCycleId,
          owner: sourceItem.owner,
          item: sourceItem.item,
          dueAt: sourceItem.dueAt,
        })
        .returning();

      // Mark original as done
      await ctx.db
        .update(actionItems)
        .set({ status: 'done' })
        .where(eq(actionItems.id, input.fromItemId));

      return created;
    }),
});
