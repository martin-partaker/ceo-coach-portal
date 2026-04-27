import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';
import { cycles, ceos, transcripts, rawInputs } from '@/db/schema';
import {
  listRecordings,
  fetchTranscript,
  fetchParticipants,
  type ZoomParticipant,
} from '@/lib/zoom/client';
import { projectRawInput } from '@/lib/ingestion/project';
import { isInternalEmail } from '@/lib/ingestion/identity';

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
        meetingUuid: z.string().optional(),
        meetingTopic: z.string().optional(),
        meetingDuration: z.number().optional(),
        meetingStartTime: z.string().optional(),
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
          message:
            'No transcript found for this meeting. Ensure cloud recording with transcription is enabled.',
        });
      }

      // Fetch participants — best effort. If meetingUuid wasn't passed,
      // skip (Zoom API requires UUID for past_meetings/{uuid}/participants).
      let participants: ZoomParticipant[] = [];
      if (input.meetingUuid) {
        try {
          participants = await fetchParticipants(input.meetingUuid);
          participants = participants.map((p) => ({
            ...p,
            internal_user:
              p.internal_user === true ||
              (p.user_email ? isInternalEmail(p.user_email) : false),
          }));
        } catch (err) {
          console.warn('zoom.importTranscript: participants fetch failed', err);
        }
      }

      const occurredAt = input.meetingStartTime ? new Date(input.meetingStartTime) : new Date();
      const externalId = input.meetingUuid ?? `manual:${input.meetingId}`;
      const payloadJson = {
        meeting: {
          uuid: input.meetingUuid,
          id: input.meetingId,
          topic: input.meetingTopic ?? result.meetingTopic,
          start_time: input.meetingStartTime,
          duration: input.meetingDuration,
        },
        participants,
        // No classification — coach explicitly chose this meeting,
        // so include-in-monthly-summary is implicit. Cron may add classification later.
        manualImport: true,
      };

      // Upsert raw_inputs: if a previous cron run already ingested this
      // meeting (as discarded / pending_ceo / etc.), promote it to matched
      // and re-attach to this cycle/CEO. Otherwise insert fresh.
      const [existing] = await ctx.db
        .select({ id: rawInputs.id })
        .from(rawInputs)
        .where(eq(rawInputs.externalId, externalId))
        .limit(1);

      let rawInputId: string;
      if (existing) {
        await ctx.db
          .update(rawInputs)
          .set({
            ceoId: ceo.id,
            cycleId: input.cycleId,
            coachId: ctx.coach.id,
            occurredAt,
            payloadJson,
            textContent: result.transcript,
            matchStatus: 'matched',
            matchConfidence: 100,
            matchCandidates: null,
            resolvedAt: new Date(),
            resolvedBy: ctx.coach.id,
          })
          .where(eq(rawInputs.id, existing.id));
        rawInputId = existing.id;
      } else {
        const [inserted] = await ctx.db
          .insert(rawInputs)
          .values({
            ceoId: ceo.id,
            cycleId: input.cycleId,
            coachId: ctx.coach.id,
            source: 'zoom',
            contentType: 'transcript',
            externalId,
            occurredAt,
            payloadJson,
            textContent: result.transcript,
            matchStatus: 'matched',
            matchConfidence: 100,
          })
          .returning({ id: rawInputs.id });
        rawInputId = inserted.id;
      }

      // Project to typed transcripts table (idempotent via sourceRawInputId)
      await projectRawInput(rawInputId);

      const [created] = await ctx.db
        .select()
        .from(transcripts)
        .where(eq(transcripts.sourceRawInputId, rawInputId))
        .limit(1);

      return { transcript: created };
    }),
});
