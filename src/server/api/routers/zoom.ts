import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { cycles, ceos } from '@/db/schema';
import { listRecordings, fetchTranscript } from '@/lib/zoom/client';

export const zoomRouter = createTRPCRouter({
  listRecordings: protectedProcedure
    .input(z.object({ ceoId: z.string().uuid() }))
    .query(async ({ ctx }) => {
      const zoomEmail = ctx.coach.zoomUserEmail;
      if (!zoomEmail) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Set your Zoom email in Settings before importing transcripts.',
        });
      }

      try {
        const meetings = await listRecordings(zoomEmail);
        return meetings.map((m) => ({
          id: m.id,
          uuid: m.uuid,
          topic: m.topic,
          startTime: m.start_time,
          duration: m.duration,
          hasTranscript: m.recording_files?.some(
            (f) => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
          ) ?? false,
        }));
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to fetch Zoom recordings.',
        });
      }
    }),

  importTranscript: protectedProcedure
    .input(
      z.object({
        cycleId: z.string().uuid(),
        meetingId: z.union([z.string(), z.number()]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const zoomEmail = ctx.coach.zoomUserEmail;
      if (!zoomEmail) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Set your Zoom email in Settings first.',
        });
      }

      // Verify ownership of cycle
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

      // Fetch transcript from Zoom
      const result = await fetchTranscript(input.meetingId, zoomEmail);
      if (!result) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No transcript found for this meeting. Ensure cloud recording with transcription is enabled.',
        });
      }

      // Save to cycle
      const [updated] = await ctx.db
        .update(cycles)
        .set({
          zoomTranscript: result.transcript,
          zoomMeetingId: String(input.meetingId),
        })
        .where(eq(cycles.id, input.cycleId))
        .returning();

      return { cycle: updated, meetingTopic: result.meetingTopic };
    }),
});
