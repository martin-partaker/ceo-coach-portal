import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { coaches } from '@/db/schema';

export const coachesRouter = createTRPCRouter({
  getMe: protectedProcedure.query(({ ctx }) => {
    return ctx.coach;
  }),

  update: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(coaches)
        .set({
          ...(input.name !== undefined && { name: input.name }),
        })
        .where(eq(coaches.id, ctx.coach.id))
        .returning();
      return updated;
    }),
});
