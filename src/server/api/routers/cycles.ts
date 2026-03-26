import { z } from 'zod';
import { eq, desc, and, asc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import Anthropic from '@anthropic-ai/sdk';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { ceos, cycles, journalEntries, transcripts } from '@/db/schema';
import { buildPrefillPrompt } from '@/lib/prompts/prefill';

const anthropic = new Anthropic();

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

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const journals = await ctx.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.cycleId, cycle.id))
        .orderBy(asc(journalEntries.weekNumber));

      const cycleTranscripts = await ctx.db
        .select()
        .from(transcripts)
        .where(eq(transcripts.cycleId, cycle.id))
        .orderBy(desc(transcripts.createdAt));

      return { cycle, ceo, journals, transcripts: cycleTranscripts };
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

      // Auto-seed journal entries based on session dates
      if (input.periodStart && input.periodEnd) {
        const start = new Date(input.periodStart);
        const end = new Date(input.periodEnd);
        const weeks = Math.min(Math.ceil((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)), 8);
        const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        for (let i = 0; i < weeks; i++) {
          const weekStart = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
          const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
          await ctx.db.insert(journalEntries).values({
            cycleId: created.id,
            weekNumber: i + 1,
            title: `Week ${i + 1} — ${fmt(weekStart)} to ${fmt(weekEnd)}`,
            content: '',
          });
        }
      }

      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1).optional(),
        monthlyGoals: z.string().nullable().optional(),
        monthlyReflection: z.string().nullable().optional(),
        transcriptSkipped: z.boolean().optional(),
        monthlyGoalsAiSuggested: z.boolean().optional(),
        monthlyReflectionAiSuggested: z.boolean().optional(),
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

  // Journal entries
  addJournal: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        weekNumber: z.number().min(1).max(8),
        title: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select().from(cycles).where(eq(cycles.id, input.cycleId)).limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });
      const [ceo] = await ctx.db
        .select().from(ceos).where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id))).limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const [created] = await ctx.db
        .insert(journalEntries)
        .values({ cycleId: input.cycleId, weekNumber: input.weekNumber, title: input.title, content: '' })
        .returning();
      return created;
    }),

  updateJournal: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).optional(),
        content: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [journal] = await ctx.db
        .select().from(journalEntries).where(eq(journalEntries.id, input.id)).limit(1);
      if (!journal) throw new TRPCError({ code: 'NOT_FOUND' });

      const [cycle] = await ctx.db
        .select().from(cycles).where(eq(cycles.id, journal.cycleId)).limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });
      const [ceo] = await ctx.db
        .select().from(ceos).where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id))).limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      const updates: Record<string, unknown> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.content !== undefined) updates.content = input.content;

      const [updated] = await ctx.db
        .update(journalEntries).set(updates).where(eq(journalEntries.id, input.id)).returning();
      return updated;
    }),

  deleteJournal: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [journal] = await ctx.db
        .select().from(journalEntries).where(eq(journalEntries.id, input.id)).limit(1);
      if (!journal) throw new TRPCError({ code: 'NOT_FOUND' });

      const [cycle] = await ctx.db
        .select().from(cycles).where(eq(cycles.id, journal.cycleId)).limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });
      const [ceo] = await ctx.db
        .select().from(ceos).where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id))).limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      await ctx.db.delete(journalEntries).where(eq(journalEntries.id, input.id));
      return { success: true };
    }),

  // Add transcript
  addTranscript: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        title: z.string().min(1),
        content: z.string().min(1),
        zoomMeetingId: z.string().nullable().optional(),
        duration: z.number().nullable().optional(),
        recordedAt: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
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

      const [created] = await ctx.db
        .insert(transcripts)
        .values({
          cycleId: input.cycleId,
          title: input.title,
          content: input.content,
          zoomMeetingId: input.zoomMeetingId ?? null,
          duration: input.duration ?? null,
          recordedAt: input.recordedAt ? new Date(input.recordedAt) : null,
        })
        .returning();
      return created;
    }),

  deleteTranscript: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [transcript] = await ctx.db
        .select()
        .from(transcripts)
        .where(eq(transcripts.id, input.id))
        .limit(1);
      if (!transcript) throw new TRPCError({ code: 'NOT_FOUND' });

      // Verify ownership via cycle -> ceo -> coach
      const [cycle] = await ctx.db
        .select()
        .from(cycles)
        .where(eq(cycles.id, transcript.cycleId))
        .limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      await ctx.db.delete(transcripts).where(eq(transcripts.id, input.id));
      return { success: true };
    }),

  prefill: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
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

      // Get transcripts for this cycle
      const cycleTranscripts = await ctx.db
        .select()
        .from(transcripts)
        .where(eq(transcripts.cycleId, input.cycleId));

      if (cycleTranscripts.length === 0 && !cycle.transcriptSkipped) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Import a transcript first before pre-filling.',
        });
      }

      const transcriptText = cycleTranscripts.map((t) => t.content).join('\n\n---\n\n');

      const { systemPrompt, userPrompt } = await buildPrefillPrompt({
        cycle,
        ceo,
        transcriptText,
      });

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No AI response' });
      }

      let parsed: { monthlyGoals: string; monthlyReflection: string };
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to parse AI response' });
      }

      const [updated] = await ctx.db
        .update(cycles)
        .set({
          monthlyGoals: parsed.monthlyGoals,
          monthlyReflection: parsed.monthlyReflection,
          monthlyGoalsAiSuggested: true,
          monthlyReflectionAiSuggested: true,
        })
        .where(eq(cycles.id, input.cycleId))
        .returning();

      return {
        monthlyGoals: parsed.monthlyGoals,
        monthlyReflection: parsed.monthlyReflection,
      };
    }),
});
