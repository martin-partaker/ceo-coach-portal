import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import Anthropic from '@anthropic-ai/sdk';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { cycles, ceos, reports } from '@/db/schema';
import { buildPrompt } from '@/lib/prompts/builder';

const anthropic = new Anthropic();

const EMAIL_SECTIONS = [
  'subject_line',
  'opening',
  'wins_and_progress',
  'honest_feedback',
  'key_insight',
  'commitments',
  'closing',
] as const;

function contentJsonToRawText(json: Record<string, string>): string {
  // Build a copy-pasteable email
  const parts: string[] = [];
  if (json.opening) parts.push(json.opening);
  if (json.wins_and_progress) parts.push(json.wins_and_progress);
  if (json.honest_feedback) parts.push(json.honest_feedback);
  if (json.key_insight) parts.push(json.key_insight);
  if (json.commitments) parts.push(json.commitments);
  if (json.closing) parts.push(json.closing);
  return parts.join('\n\n');
}

export const reportsRouter = createTRPCRouter({
  getForCycle: protectedProcedure
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
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const [report] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.cycleId, input.cycleId))
        .orderBy(desc(reports.generatedAt))
        .limit(1);

      return report ?? null;
    }),

  generate: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, input.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Get previous report for pattern observations
      const allCycles = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.ceoId, ceo.id))
        .orderBy(desc(cycles.createdAt));

      const currentIndex = allCycles.findIndex((c) => c.id === input.cycleId);
      const previousCycle = allCycles[currentIndex + 1];

      let previousReport = null;
      if (previousCycle) {
        const [prev] = await ctx.db
          .select()
          .from(reports)
          .where(eq(reports.cycleId, previousCycle.id))
          .orderBy(desc(reports.generatedAt))
          .limit(1);
        previousReport = prev ?? null;
      }

      // Build prompt
      const { systemPrompt, userPrompt, missing } = await buildPrompt({
        cycle,
        ceo,
        coachName: ctx.coach.name,
        previousReport,
      });

      // Call Claude
      const modelId = 'claude-sonnet-4-20250514';
      const message = await anthropic.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      // Extract text response
      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No text response from AI',
        });
      }

      // Parse JSON
      let contentJson: Record<string, string>;
      try {
        contentJson = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to parse AI response as JSON. Raw response saved.',
        });
      }

      const rawText = contentJsonToRawText(contentJson);

      // Store report
      const [report] = await ctx.db
        .insert(reports)
        .values({
          cycleId: input.cycleId,
          contentJson,
          rawText,
          modelUsed: modelId,
          promptVersion: 1,
        })
        .returning();

      return { report, missing };
    }),
});
