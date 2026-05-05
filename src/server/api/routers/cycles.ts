import { z } from 'zod';
import { eq, desc, and, asc, lt, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import Anthropic from '@anthropic-ai/sdk';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { actionItems, ceos, cycles, journalEntries, transcripts, rawInputs } from '@/db/schema';
import { buildPrefillPrompt } from '@/lib/prompts/prefill';
import { refreshAiActionItems } from '@/lib/cycles/ai-action-items';
import { MODELS } from '@/lib/anthropic/models';

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
          const weekEndRaw = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
          const weekEnd = weekEndRaw > end ? end : weekEndRaw;
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
        additionalContext: z.string().nullable().optional(),
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
        // Day the journal refers to (preferred — feeds derived membership
        // and chronological sort). When supplied without weekNumber, we
        // derive weekNumber from the cycle's periodStart so the legacy
        // column stays consistent.
        entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        weekNumber: z.number().min(1).max(52).optional(),
        title: z.string().min(1).optional(),
        content: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [cycle] = await ctx.db
        .select().from(cycles).where(eq(cycles.id, input.cycleId)).limit(1);
      if (!cycle) throw new TRPCError({ code: 'NOT_FOUND' });
      const ceoFilter = ctx.realCoach?.isSuperAdmin
        ? eq(ceos.id, cycle.ceoId)
        : and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id));
      const [ceo] = await ctx.db.select().from(ceos).where(ceoFilter).limit(1);
      if (!ceo) throw new TRPCError({ code: 'NOT_FOUND' });

      // Derive weekNumber from entryDate when caller didn't pass one. Falls
      // back to 1 if the cycle has no periodStart to anchor against.
      let weekNumber = input.weekNumber;
      if (weekNumber === undefined) {
        if (input.entryDate && cycle.periodStart) {
          const startMs = new Date(`${cycle.periodStart}T00:00:00Z`).getTime();
          const dayMs = new Date(`${input.entryDate}T00:00:00Z`).getTime();
          weekNumber = Math.max(1, Math.floor((dayMs - startMs) / (7 * 86_400_000)) + 1);
        } else {
          weekNumber = 1;
        }
      }

      // Build a sensible default title from the date when caller omits it.
      let title = input.title?.trim();
      if (!title) {
        if (input.entryDate) {
          const [y, m, d] = input.entryDate.split('-').map(Number);
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          title = `${months[m - 1]} ${d}, ${y}`;
        } else {
          title = `Week ${weekNumber}`;
        }
      }

      const [created] = await ctx.db
        .insert(journalEntries)
        .values({
          cycleId: input.cycleId,
          weekNumber,
          entryDate: input.entryDate ?? null,
          title,
          content: input.content ?? '',
        })
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

      const ceoFilter = ctx.realCoach?.isSuperAdmin
        ? eq(ceos.id, cycle.ceoId)
        : and(eq(ceos.id, cycle.ceoId), eq(ceos.coachId, ctx.coach.id));
      const [ceo] = await ctx.db.select().from(ceos).where(ceoFilter).limit(1);
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

      // Pull both transcripts and weekly journals — both are valid prefill
      // sources. We accept either alone; the CEO often journals what they
      // didn't say out loud in the call.
      const [cycleTranscripts, cycleJournals] = await Promise.all([
        ctx.db.select().from(transcripts).where(eq(transcripts.cycleId, input.cycleId)),
        ctx.db
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.cycleId, input.cycleId))
          .orderBy(asc(journalEntries.weekNumber)),
      ]);

      const hasTranscript = cycleTranscripts.length > 0;
      const hasJournals = cycleJournals.some((j) => (j.content ?? '').trim().length > 0);

      if (!hasTranscript && !hasJournals && !cycle.transcriptSkipped) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Add a transcript or weekly journal before pre-filling.',
        });
      }

      const transcriptText = cycleTranscripts.map((t) => t.content).join('\n\n---\n\n');

      const { systemPrompt, userPrompt } = await buildPrefillPrompt({
        cycle,
        ceo,
        transcriptText,
        journals: cycleJournals,
        additionalContext: cycle.additionalContext ?? undefined,
      });

      const message = await anthropic.messages.create({
        model: MODELS.draft,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = message.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No AI response' });
      }

      let parsed: {
        monthlyGoals: string;
        monthlyReflection: string;
        actionItems?: Array<{ owner?: string; item?: string; dueAt?: string | null }>;
      };
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to parse AI response' });
      }

      await ctx.db
        .update(cycles)
        .set({
          monthlyGoals: parsed.monthlyGoals,
          monthlyReflection: parsed.monthlyReflection,
          monthlyGoalsAiSuggested: true,
          monthlyReflectionAiSuggested: true,
        })
        .where(eq(cycles.id, input.cycleId));

      // Refresh AI-suggested action items: drop the prior batch (only those
      // the coach hasn't already manually edited or marked done) and replace
      // with whatever the model returned this time. Manual items and any
      // AI item the coach has reviewed/done/dropped are left alone.
      const writtenActionItems = await refreshAiActionItems(
        ctx.db,
        input.cycleId,
        parsed.actionItems ?? [],
      );

      return {
        monthlyGoals: parsed.monthlyGoals,
        monthlyReflection: parsed.monthlyReflection,
        actionItems: writtenActionItems,
      };
    }),

  unconfirmedAttachments: protectedProcedure
    .input(z.object({ cycleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
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

      const rows = await ctx.db
        .select()
        .from(rawInputs)
        .where(
          and(
            eq(rawInputs.cycleId, input.cycleId),
            eq(rawInputs.matchStatus, 'matched'),
            or(
              lt(rawInputs.matchConfidence, 100),
              sql`${rawInputs.classification} ->> 'meetingType' = 'coaching_group'`
            )
          )
        )
        .orderBy(desc(rawInputs.occurredAt));

      return rows;
    }),

  confirmAttachment: protectedProcedure
    .input(z.object({ rawInputId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw || !raw.ceoId) throw new TRPCError({ code: 'NOT_FOUND' });

      // Verify the CEO belongs to this coach
      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, raw.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'FORBIDDEN' });

      await ctx.db
        .update(rawInputs)
        .set({
          matchConfidence: 100,
          resolvedAt: new Date(),
          resolvedBy: ctx.coach.id,
        })
        .where(eq(rawInputs.id, input.rawInputId));

      return { ok: true };
    }),

  detachAttachment: protectedProcedure
    .input(z.object({ rawInputId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [raw] = await ctx.db
        .select()
        .from(rawInputs)
        .where(eq(rawInputs.id, input.rawInputId))
        .limit(1);
      if (!raw || !raw.ceoId) throw new TRPCError({ code: 'NOT_FOUND' });

      const [ceo] = await ctx.db
        .select()
        .from(ceos)
        .where(and(eq(ceos.id, raw.ceoId), eq(ceos.coachId, ctx.coach.id)))
        .limit(1);
      if (!ceo) throw new TRPCError({ code: 'FORBIDDEN' });

      await ctx.db
        .update(rawInputs)
        .set({
          cycleId: null,
          matchStatus: 'pending_cycle',
        })
        .where(eq(rawInputs.id, input.rawInputId));

      return { ok: true };
    }),
});
