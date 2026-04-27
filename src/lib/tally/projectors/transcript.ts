import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { transcripts } from '@/db/schema';
import type { Projector } from './types';

interface TranscriptPayload {
  meeting?: {
    id?: number | string;
    topic?: string;
    duration?: number;
  };
}

interface ClassificationLite {
  includeInMonthlySummary?: boolean;
}

/**
 * Project a Zoom transcript raw_input into the typed `transcripts` table.
 * Skips when the classifier flagged the meeting as not-summary-worthy.
 * Idempotent via sourceRawInputId.
 */
export const projectTranscript: Projector = async ({ rawInput, cycle }) => {
  if (!cycle || !rawInput.cycleId) return;
  if (!rawInput.textContent) return;

  const classification = (rawInput.classification ?? null) as ClassificationLite | null;
  if (classification && classification.includeInMonthlySummary === false) return;

  const payload = (rawInput.payloadJson ?? {}) as TranscriptPayload;
  const title = payload.meeting?.topic ?? 'Untitled meeting';
  const duration = payload.meeting?.duration ?? null;
  const zoomMeetingId =
    payload.meeting?.id != null ? String(payload.meeting.id) : null;

  const [existing] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.sourceRawInputId, rawInput.id))
    .limit(1);

  if (existing) {
    await db
      .update(transcripts)
      .set({
        cycleId: rawInput.cycleId,
        title,
        content: rawInput.textContent,
        zoomMeetingId,
        duration,
        recordedAt: rawInput.occurredAt,
      })
      .where(eq(transcripts.id, existing.id));
    return;
  }

  await db.insert(transcripts).values({
    cycleId: rawInput.cycleId,
    title,
    content: rawInput.textContent,
    zoomMeetingId,
    duration,
    recordedAt: rawInput.occurredAt,
    sourceRawInputId: rawInput.id,
  });
};
