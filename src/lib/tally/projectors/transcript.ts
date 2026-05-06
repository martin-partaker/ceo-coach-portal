import { eq, and, notInArray } from 'drizzle-orm';
import { db } from '@/db';
import { transcripts, rawInputCeos } from '@/db/schema';
import { ensureCycleForCeoAndDate } from '@/lib/ingestion/match-cycle';
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
 * Multi-CEO aware: fans out one row per (sourceRawInputId, cycleId) so the
 * same recording shows up under every CEO it was assigned to.
 *
 * Membership = `raw_input_ceos` ∪ `{rawInput.ceoId}` (the primary CEO is
 * always implied even if not explicitly in the join table). For each CEO
 * we resolve their own monthly cycle for the meeting date — different
 * CEOs can have different cycle calendars.
 *
 * Skips when the classifier flagged the meeting as not-summary-worthy.
 * Idempotent — re-running cleans up rows for CEOs that have since been
 * removed from the assignment.
 */
export const projectTranscript: Projector = async ({ rawInput }) => {
  if (!rawInput.textContent) return;
  if (!rawInput.ceoId) return;

  const classification = (rawInput.classification ?? null) as ClassificationLite | null;
  if (classification && classification.includeInMonthlySummary === false) return;

  const payload = (rawInput.payloadJson ?? {}) as TranscriptPayload;
  const title = payload.meeting?.topic ?? 'Untitled meeting';
  const duration = payload.meeting?.duration ?? null;
  const zoomMeetingId =
    payload.meeting?.id != null ? String(payload.meeting.id) : null;

  // Source of truth for membership: join table ∪ primary ceoId.
  const linkRows = await db
    .select({ ceoId: rawInputCeos.ceoId })
    .from(rawInputCeos)
    .where(eq(rawInputCeos.rawInputId, rawInput.id));
  const memberCeoIds = new Set<string>([rawInput.ceoId]);
  for (const r of linkRows) memberCeoIds.add(r.ceoId);

  // Resolve a cycle per CEO for the meeting date (creates a monthly default
  // when none covers the date — same logic the matcher uses).
  const targetCycleIds: string[] = [];
  for (const ceoId of memberCeoIds) {
    const match = await ensureCycleForCeoAndDate({
      ceoId,
      occurredAt: rawInput.occurredAt,
    });
    targetCycleIds.push(match.cycleId);
  }

  // Upsert per (sourceRawInputId, cycleId). Lookup existing rows in one
  // query, update those, insert the rest.
  const existing = await db
    .select({ id: transcripts.id, cycleId: transcripts.cycleId })
    .from(transcripts)
    .where(eq(transcripts.sourceRawInputId, rawInput.id));
  const existingByCycle = new Map(existing.map((e) => [e.cycleId, e.id]));

  for (const cycleId of targetCycleIds) {
    const existingId = existingByCycle.get(cycleId);
    if (existingId) {
      await db
        .update(transcripts)
        .set({
          title,
          content: rawInput.textContent,
          zoomMeetingId,
          duration,
          recordedAt: rawInput.occurredAt,
        })
        .where(eq(transcripts.id, existingId));
    } else {
      await db.insert(transcripts).values({
        cycleId,
        title,
        content: rawInput.textContent,
        zoomMeetingId,
        duration,
        recordedAt: rawInput.occurredAt,
        sourceRawInputId: rawInput.id,
      });
    }
  }

  // Always clean up transcripts whose cycleId is no longer a target.
  // Handles CEO removal on re-assignment AND — critically — moving a
  // rawInput from one cycle to another for the same CEO. The previous
  // `existing.length > targetCycleIds.length` guard skipped cleanup
  // when the counts matched, leaving orphan rows pointing at the old
  // cycle.
  if (targetCycleIds.length > 0) {
    await db
      .delete(transcripts)
      .where(
        and(
          eq(transcripts.sourceRawInputId, rawInput.id),
          notInArray(transcripts.cycleId, targetCycleIds),
        ),
      );
  }
};
